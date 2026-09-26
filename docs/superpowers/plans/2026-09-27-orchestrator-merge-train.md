# Orchestrator merge train and sharded Go tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Verify:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" node scripts/verify.mjs ./pkg/orchestrate/... ./pkg/jarvis/... ./pkg/wshrpc/... ./cmd/wsh/...`
**Setup:** `task worktree:prepare`
**Check:** `go vet ./pkg/orchestrate/... && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /dev/null ./cmd/wsh/`

**Goal:** Land several reviewed lanes per Verify and bisect a failing batch to the lane that broke it, and cut the per-merge Verify's Go test time by sharding the slow packages.

**Architecture:** The engine keeps merge-then-verify: `AutoMergeReady` merges every ready lane under one project claim, and one Verify judges every `verifying` lane tip (the batch), scoped from the oldest tip's squash commit to `HEAD`. A failed batch of two or more is bisected over its prefixes in a detached worktree. `scripts/verify.mjs` builds each large Go test package once and runs its tests in 4 processes. No new task state, run-event kind, wshrpc type or generated file.

**Tech Stack:** Go (`pkg/orchestrate`), Node ESM script plus vitest (`scripts/verify.mjs`), git worktrees.

**Spec:** `docs/superpowers/specs/2026-09-27-orchestrator-merge-train-design.md`

## Global Constraints

- Do not edit `pkg/orchestrate/engine.go`, `wake.go`, `liveness.go`, `digest.go`, `review.go` or `scheduler.go`: run 5952d714 is changing them.
- No new task state, run-event kind, wshrpc type, waveobj field or generated file. Events gain the data keys `batch` (tip ids in merge order, only when more than one) and `bisect` (number of extra Verify runs).
- The existing command surface stays: `wsh jarvis dag merge <task>` and `--continue`, and the lead's instructions do not change.
- `SHARD_MIN_TESTS = 100`, `SHARDS = 4`, `-test.timeout=10m`.
- Wake text goes through the existing `verifyFailedWake(taskID, reason)` (`queue.go`); the bisect reason is `"<reason>; bisected from t-0, t-1, t-2"`.
- Go tests in `pkg/orchestrate` need cgo: run them with `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu"`. No `CGO_CFLAGS`.
- Comments say why, lower case, only where needed. Match the surrounding code's naming and idiom.
- Commit messages: `type(scope): description`, no attribution trailers.

## Review Focus

- A batch whose squash commits cannot be read (a stubbed merge, a missing `EndCommit`): it must still get one Verify (unscoped), and a failure blames the oldest tip without bisecting. Task 1 tests it with stubbed shas; Task 2 tests that no bisect step runs.
- A conflict in the middle of a batch: the lanes merged before it must not be verified over a tree that is mid-merge, and `AutoMergeReady` must not resume their Verify until `--continue`. Task 1 test.
- A lane whose dependency merged earlier in the same batch: it is refused (its dependency is verifying) and skipped, and the rest of the batch still merges. Task 1 test.
- A bisect that cannot run (Setup fails in the bisect tree) must never mark a lane done that no Verify passed. Task 2 test.
- The sharded run's output must still let the engine's `firstFailureExcerpt` find `--- FAIL`, and a failing shard must fail the script. Task 3 test.

---

### Task 1: One Verify judges every verifying lane, and ready lanes merge as a batch
**Depends on:** none

**Files:**
- Modify: `pkg/orchestrate/verify.go` (the `startVerify` runner, `verifyScopeEnv`, `recordVerifyLocked`, `recordVerifyProgressLocked`, `resumeVerify`, `rerunVerify`)
- Modify: `pkg/orchestrate/mergetask.go` (`AutoMergeReady`, `mergeTaskLocked`'s guard, `landAfterMerge`)
- Test: `pkg/orchestrate/verifybatch_test.go` (new)
- Existing tests that must stay green: `verify_test.go`, `landing_test.go`, `mergetask_test.go`, `digestverify_test.go`

**Interfaces:**
- Produces (Task 2 builds on these; keep the names):
  - `type batchTip struct { id, commit string }`: a verifying lane tip and its squash commit (`EndCommit` of the tip's child run, `""` if unknown).
  - `func verifyBatch(ctx context.Context, g *waveobj.TaskGroup, tree string) (batch []batchTip, ordered bool)`: every tip in `TaskState_Verifying`, oldest squash commit first. `ordered` is true only when every commit is known and `git merge-base --is-ancestor` ordered them in `tree`. Otherwise it falls back to `VerifyStartedTs`, then plan index, and returns `ordered == false`.
  - `type batchOutcome struct { batch, passed []string; failed string; held []string; output string; err error; reason string; bisect int }`: `passed` go done, `failed` goes verify-failed (`""` on a pass), and `held` stay verifying with the held line. `output` and `err` come from the run that judged `failed`, or from the batch's run on a pass. `reason` replaces the wake reason when it is not empty.
  - `func judgeBatch(ctx context.Context, batch []batchTip, ordered bool, output string, verr error, run batchRunner) batchOutcome`: in this task a pass puts all tips in `passed`; a failure puts `batch[0]` in `failed` and the rest in `held`. Task 2 adds the bisect inside it. `type batchRunner struct { channelID, dagID, runID, project, tree, setup, command string; progress planProgress }`.
  - `func recordBatchVerifyLocked(ctx context.Context, dagID string, out batchOutcome, ms int64) error`
  - `func tipIDs(batch []batchTip) []string`: the ids, in order.
  - `func heldLine(failedID string) string`: returns `"held: task " + failedID + "'s Verify failed; verified with its fix"`.
  - `startVerify(channelID, dagID, runID, projectPath, command string, l *landing)`: the `taskID` parameter goes, since the batch is read when the run starts. `verifyFinished(dagID, taskID)` is still called once per Verify, with the batch's oldest tip id.

- [ ] **Step 1: Write the failing tests** in `pkg/orchestrate/verifybatch_test.go`. Use the fixtures from `mergetask_test.go`, `landing_test.go`, `setup_test.go` and `verify_test.go`: `newMergeFixture`, `f.land`, `f.finish`, `f.laneCommit`, `stubMerge`, `stubPlanCommand`, `awaitVerify`, `newFakeLead`, `envValue`, `readFile`, `continueMerge`. Two independent tasks are two lanes.

```go
// two reviewed lanes land in one claim and share one Verify, scoped to both squash commits
func TestReadyLanesMergeAsOneBatchWithOneVerify(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "a"}, {ID: "t-1", Label: "b"}})
	f.setPlanCommands(t, verifyCmd, "")
	effort := f.effortFor(t, "#1 a's", "#2 b's")
	f.taskChunks(t, "t-0", "#1 a's")
	f.taskChunks(t, "t-1", "#2 b's")
	f.land(t)
	for _, id := range []string{"t-0", "t-1"} {
		f.finish(t, id)
		f.laneCommit(t, id, id+".txt")
	}
	calls := stubPlanCommand(t, func(context.Context, string, string) error { return nil })
	await := awaitVerify(t)

	AutoMergeReady(f.ctx, f.dagID)
	await()

	g := f.dag(t)
	for _, task := range g.Tasks {
		if task.State != TaskState_Done || !task.Merged {
			t.Fatalf("%s: want merged and done, got %s merged=%v", task.ID, task.State, task.Merged)
		}
	}
	for _, label := range []string{"#1 a's", "#2 b's"} {
		if c := chunkOf(t, f.ctx, effort, label); c.Status != "done" {
			t.Fatalf("a passing batch closes every lane's chunks: %q is %q", label, c.Status)
		}
	}
	got := calls.list()
	if len(got) != 1 {
		t.Fatalf("want one Verify for the batch, got %d", len(got))
	}
	lines := strings.Fields(readFile(t, envValue(got[0].env, verifyChangedEnv)))
	slices.Sort(lines)
	if !reflect.DeepEqual(lines, []string{"t-0.txt", "t-1.txt"}) {
		t.Fatalf("the Verify is scoped to both lanes, got %q", lines)
	}
}

// merges that cannot be read in git (stubbed shas) still get one Verify; a failure blames the oldest and holds the rest
func TestAFailedBatchBlamesTheOldestAndHoldsTheRest(t *testing.T) {
	lead := newFakeLead(t)
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "a"}, {ID: "t-1", Label: "b"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	f.finish(t, "t-1")
	stubMerge(t, func(_ context.Context, _, _, title string) (string, error) { return "sha-" + title, nil })
	calls := stubPlanCommand(t, func(context.Context, string, string) error {
		return &planCommandError{exitCode: 1, output: "--- FAIL: TestX"}
	})
	await := awaitVerify(t)

	AutoMergeReady(f.ctx, f.dagID)
	await()

	g := f.dag(t)
	if g.Tasks[0].State != TaskState_VerifyFailed {
		t.Fatalf("the oldest lane is blamed, got %s", g.Tasks[0].State)
	}
	if g.Tasks[1].State != TaskState_Verifying || g.Tasks[1].VerifyOutput != heldLine("t-0") {
		t.Fatalf("the later lane is held, got %s %q", g.Tasks[1].State, g.Tasks[1].VerifyOutput)
	}
	if n := len(calls.list()); n != 1 {
		t.Fatalf("unordered merges are not bisected, want 1 Verify, got %d", n)
	}
	if len(lead.sends) != 1 || !strings.Contains(lead.sends[0], "Verify failed after merging task t-0") {
		t.Fatalf("one wake for the blamed lane, got %q", lead.sends)
	}
	// the tick holds while a Verify failed: nothing resumes the held lane
	AutoMergeReady(f.ctx, f.dagID)
	if n := len(calls.list()); n != 1 {
		t.Fatalf("a held lane waits for --continue, got %d Verify runs", n)
	}
}

// --continue on the blamed lane runs one Verify that also judges the held lanes
func TestContinueVerifiesTheFailedLaneWithTheHeldOnes(t *testing.T) {
	// arrange exactly as TestAFailedBatchBlamesTheOldestAndHoldsTheRest, with a stub that fails the
	// first call and passes after; then:
	//   ContinueMerge(f.ctx, f.channel, f.ownerID, "t-0"); await()
	// want: t-0 and t-1 done, 2 Verify calls in all.
}

// a conflict mid-batch leaves the tree mid-merge: the lanes before it wait, unverified, for --continue
func TestAConflictMidBatchDefersTheBatchVerifyToTheContinue(t *testing.T) {
	// stubMerge: "sha-a" for t-0's lane title, ("", ErrMergeConflict) for t-1's.
	// after AutoMergeReady: t-0 verifying, t-1 blocked-merge, 0 Verify calls; a second AutoMergeReady
	// still makes 0 calls (conflictAwaitingContinue holds the resume).
	// stub continueMerge (orig := continueMerge; continueMerge = func(...) (string, error) { return "sha-b", nil };
	// t.Cleanup restores) then ContinueMerge(f.ctx, f.channel, f.ownerID, "t-1"); await():
	// want 1 Verify call, and t-0 and t-1 both done.
}

// a lane whose dependency merged earlier in the same batch is skipped, and the rest of the batch still lands
func TestALaneWaitingOnABatchMateIsSkippedNotTheBatch(t *testing.T) {
	// tasks: t-0; t-1 depends on t-0 and t-2 depends on t-0 (so t-0, t-1, t-2 are lanes of their own); t-3 independent.
	// finish t-0, t-1 and t-3 by hand (f.finish): laneMergeReady (lane.go:50) does not check deps, so t-1 is
	// merge-ready while t-0 is not yet merged, which is the case this test needs. stubMerge returns "sha-"+title;
	// Verify blocks (stubBlockingVerify); stub spawns with stubSpawn.
	// AutoMergeReady merges t-0 first (waitingOn: t-2 is pending behind it), then t-1 is refused because its
	// dependency t-0 is now verifying, and t-3 still merges.
	// want, while the Verify runs: t-0 and t-3 merged and verifying; t-1 not merged and still done, not
	// blocked-merge and with no MergeError; exactly one Verify started (calls.list() has 1 entry).
	// open the Verify and await it before the test ends.
}

// a lost claim resumes the whole batch's Verify, not one lane's
func TestResumeReverifiesTheWholeBatch(t *testing.T) {
	// set t-0 and t-1 merged + verifying by hand (wstore.UpdateDag, with VerifyStartedTs), give each child
	// run an EndCommit, then AutoMergeReady: want one Verify call, and after await both done.
}
```

Write out the four sketched tests in full, the same way as the first two.

- [ ] **Step 2: Run them and see them fail**

Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/orchestrate/ -run 'Batch|MidBatch|BatchMate|WithTheHeldOnes' -count=1`
Expected: FAIL. `heldLine` is undefined, and the second lane merges only after the first Verify.

- [ ] **Step 3: Implement the batch in `verify.go`**

`verifyBatch` orders the tips and reports whether git could:

```go
type batchTip struct{ id, commit string }

// verifyBatch lists every verifying lane tip, oldest squash commit first. ordered is false when a commit is unknown
// or git cannot order them (a stubbed merge): the order then falls back to when each merged, and nothing may bisect it.
func verifyBatch(ctx context.Context, g *waveobj.TaskGroup, tree string) ([]batchTip, bool) {
	var batch []batchTip
	ordered := true
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.State != TaskState_Verifying {
			continue
		}
		tip := batchTip{id: t.ID}
		if t.RunID != "" {
			if child, err := wstore.GetRun(ctx, g.ChannelId, t.RunID); err == nil {
				tip.commit = child.EndCommit
			}
		}
		ordered = ordered && tip.commit != ""
		batch = append(batch, tip)
	}
	started := func(id string) int64 { return taskByID(g, id).VerifyStartedTs }
	slices.SortStableFunc(batch, func(a, b batchTip) int { return cmp.Compare(started(a.id), started(b.id)) })
	if !ordered {
		return batch, false
	}
	var gitErr error
	slices.SortStableFunc(batch, func(a, b batchTip) int {
		if a.commit == b.commit {
			return 0
		}
		if _, err := git(ctx, tree, "merge-base", "--is-ancestor", a.commit, b.commit); err == nil {
			return -1
		}
		if _, err := git(ctx, tree, "merge-base", "--is-ancestor", b.commit, a.commit); err == nil {
			return 1
		}
		gitErr = fmt.Errorf("%s and %s are not on one line", a.commit, b.commit)
		return 0
	})
	return batch, gitErr == nil
}
```

The scope replaces `verifyScopeEnv`:

```go
// batchScopeEnv scopes Verify to everything from the batch's oldest squash commit to HEAD, which also takes in a fix
// committed on top before a --continue.
func batchScopeEnv(ctx context.Context, dagID, tree string, batch []batchTip) []string {
	if len(batch) == 0 || batch[0].commit == "" {
		return unscopedEnv
	}
	return changedFilesEnv(ctx, tree, batch[0].commit+"^", "HEAD", dagID+"/"+batch[0].id)
}
```

`startVerify(channelID, dagID, runID, projectPath, command string, l *landing)` loads the dag in its goroutine, takes `verifyBatch`, and runs Verify with `batchScopeEnv`. Progress goes to every batch tip. It then calls `judgeBatch(ctx, ...)` with the claim's context, and records the result under `WithDagMutation` with `recordBatchVerifyLocked`, then releases the claim and calls `Schedule` as today. Today `startVerify` calls `cancel()` right after the command returns (`verify.go:157`). Move that call to after `judgeBatch` returns: Task 2's bisect runs inside `judgeBatch` on that context, and a context cancelled early would make every bisect step see `ctx.Err()` and record nothing. `stopDagVerify` still cancels it for a cancelled dag. `judgeBatch` in this task:

```go
func judgeBatch(ctx context.Context, batch []batchTip, ordered bool, output string, verr error, run batchRunner) batchOutcome {
	out := batchOutcome{batch: tipIDs(batch), output: output, err: verr}
	if verr == nil {
		out.passed = out.batch
		return out
	}
	out.failed, out.held = out.batch[0], out.batch[1:]
	return out
}
```

`recordVerifyProgressLocked(ctx, dagID string, taskIDs []string, tail string)` writes the tail to each listed task that is still verifying. It returns `errVerifyProgressStale` only when none is.

`recordBatchVerifyLocked` replaces `recordVerifyLocked`:
- If the dag is cancelled, record nothing.
- Only tips still `verifying` are touched.
- Each `passed` tip: `TaskState_Done`, `VerifyError` cleared, `VerifyOutput = out.output`. Then one `task-verify-passed` event per tip with `taskid` and `ms`, plus `batch` when `len(out.batch) > 1` and `bisect: true` when `out.bisect > 0`. Then `closeLandedChunks(ctx, g, tipID)`.
- The `failed` tip: `TaskState_VerifyFailed`, `VerifyError = out.err.Error()`, `VerifyOutput = out.output`, and one `task-verify-failed` event with `taskid`, `reason`, `detail` (`failureDetail(out.err)`), `batch` when there is more than one tip, and `bisect: out.bisect` when it is more than 0. Then one wake: `PostWake(ctx, g.ChannelId, g.RunID, verifyFailedWake(out.failed, reason))`, where `reason` is `out.reason` when set, else the plan-command reason as today.
- Each `held` tip: stays `verifying`, `VerifyOutput = heldLine(out.failed)`.
- One `RecomputeDagStatus`, one `UpdateDag`, one `SendWaveObjUpdate`.

`resumeVerify(ctx, g)` claims the project with the first verifying id. It rereads the dag under the claim, and starts only when the dag has a `verifying` task, no `verify-failed` task and no `conflictAwaitingContinue(g, "")`. `rerunVerify` keeps its checks, flips the task to `verifying`, and calls `startVerify` without a task id.

- [ ] **Step 4: Implement the batch merge in `mergetask.go`**

`AutoMergeReady` becomes:

```go
	if len(tasksInState(g, TaskState_VerifyFailed)) > 0 || conflictAwaitingContinue(g, "") != "" {
		return
	}
	if len(tasksInState(g, TaskState_Verifying)) > 0 {
		resumeVerify(ctx, g)
		return
	}
	ready := autoMergeable(g)
	// unchanged: the empty case and loading owner
	merged, err := mergeBatch(ctx, g.ChannelId, owner, ready)
	switch {
	case errors.Is(err, errIndexNotClean):
		log.Printf("dag %s: holding %d merge(s), project index is not clean", g.ID, len(ready)-merged)
		noteMergesHeld(ctx, g, len(ready)-merged)
	case err == nil, errors.Is(err, ErrMergeConflict), errors.Is(err, errProjectBusy):
		noteMergesHeld(ctx, g, 0)
	}
```

Here `errProjectBusy` means the claim was taken. A merge that lands while that other Verify runs is ticked when the Verify finishes.

```go
// mergeBatch lands each ready lane in order under one project claim, then hands the claim to one Verify for all of
// them. A conflict leaves the tree mid-merge, so no Verify starts: the continue's Verify takes the whole batch.
func mergeBatch(ctx context.Context, channelID string, owner *waveobj.Run, ready []string) (int, error) {
	l, err := claimProject(jarvis.LandPath(owner), owner.DagORef, ready[0])
	if err != nil {
		return 0, err
	}
	var batch []string
	verify := ""
	for _, taskID := range ready {
		var v string
		err = withDagMutation(owner.DagORef, func() error {
			var lerr error
			v, lerr = mergeTaskLocked(ctx, channelID, owner, taskID, true, batch)
			return lerr
		})
		if errors.Is(err, ErrMergeConflict) || errors.Is(err, errIndexNotClean) {
			break
		}
		if err != nil {
			// git refused this lane, or its dependency is verifying (maybe merged earlier in this batch): the rest can still land
			log.Printf("dag %s: auto-merging task %s: %v", owner.DagORef, taskID, err)
			err = nil
			continue
		}
		batch = append(batch, taskID)
		if v != "" {
			verify = v
		}
	}
	if verify == "" || errors.Is(err, ErrMergeConflict) {
		releaseProject(jarvis.LandPath(owner), l)
		return len(batch), err
	}
	startVerify(channelID, owner.DagORef, owner.ID, jarvis.LandPath(owner), verify, l)
	return len(batch), err
}
```

`mergeTaskLocked(ctx, channelID, owner, taskID, requireCleanIndex bool, batch []string)`: the `verifying`/`verify-failed` guard under `requireCleanIndex` ignores a `verifying` task whose id is in `batch`. Every other caller passes `nil`. `mergeTaskEntry` (the manual `dag merge`) keeps its own claim and one lane. `landAfterMerge` calls the new `startVerify` signature. `batch` holds the ids the caller named, and `mergeTaskLocked` stamps the lane tip, so compare against `laneTip(g, laneOf(g, id)).ID`. The simplest way: `mergeBatch` appends the tip id, which `autoMergeable` already returns.

- [ ] **Step 5: Run the new and existing Verify, merge and digest tests**

Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/orchestrate/ -count=1`
Expected: PASS, including the whole package. Existing single-lane tests keep their behavior, because a batch of one is today's path. A test that called `startVerify` or `recordVerifyLocked` directly moves to the new names. Keep what it asserts.

Two existing tests finish two lanes before the first merge, so the batch now lands both with one Verify. Rewrite them to keep what they test, a second lane arriving while a Verify runs:
- `TestNextMergeWaitsForRunningVerify` (`verify_test.go:373`): call `f.finish(t, "t-1")` only after `verify.waitStarted(t)`. The watchdog tick while t-0's Verify runs must still make no second merge (`*merges == 1`). After `verify.open()`, the two `await()`s are t-0's Verify, whose tick lands t-1, and then t-1's. Both end done with 2 merges.
- `TestManualMergeRefusesWhileVerifyRuns` (`verify_test.go:494`): call `f.finish(t, "t-1")` after `verify.waitStarted(t)`, then `MergeTask(..., "t-1")` must still fail with `errProjectBusy` naming t-0. After `verify.open()`, the two `await()`s are t-0's Verify and then t-1's, which its tick merges.

- [ ] **Step 6: Commit**

```bash
git add pkg/orchestrate/verify.go pkg/orchestrate/mergetask.go pkg/orchestrate/verifybatch_test.go pkg/orchestrate/*_test.go
git commit -m "feat(orchestrate): merge every ready lane and judge them with one Verify"
```

### Task 2: Bisect a failed batch in a detached tree
**Depends on:** Task 1

**Files:**
- Modify: `pkg/orchestrate/basecheck.go` (move the detached-tree steps of `runBaseCheck` into a helper)
- Modify: `pkg/orchestrate/verify.go` (`judgeBatch` bisects)
- Test: `pkg/orchestrate/verifybisect_test.go` (new); `basecheck_test.go` stays green unchanged

**Interfaces:**
- Consumes: `batchTip`, `verifyBatch`, `batchOutcome`, `judgeBatch`, `batchRunner`, `heldLine`, `recordBatchVerifyLocked` from Task 1.
- Produces:
  - `type treeStepError struct{ step string; err error }` (`Error()` returns `step + ": " + err.Error()`, plus `Unwrap`): a step of a detached tree that could not run.
  - `func withDetachedTree(ctx context.Context, project, name, label, commit, setup string, fn func(wt string) error) error`: creates `worktreeDir(project, name)` detached at `commit`, first removing a stale one; runs `setup` there; calls `fn`; removes the tree. It returns a `*treeStepError` for `"removing a stale " + label`, `"creating the " + label` or `"Setup failed in the " + label` (with `failureDetail(err)`), else `fn`'s error.

- [ ] **Step 1: Write the failing tests** in `pkg/orchestrate/verifybisect_test.go`. They use real git (`f.land`, `f.laneCommit`: three lanes t-0, t-1 and t-2 committing `t-0.txt`, `t-1.txt` and `t-2.txt`) and a Verify stub that fails exactly when the changed list names the breaking file:

```go
// stubVerifyBreaksOn fails Verify when ARC_VERIFY_CHANGED lists file, and passes the plan's Setup.
func stubVerifyBreaksOn(t *testing.T, file, setup string, setupErr error) *planCalls {
	t.Helper()
	p := &planCalls{}
	orig := runPlanCommand
	runPlanCommand = func(ctx context.Context, dir, command string, env []string, _ time.Duration, _ planProgress) (string, error) {
		p.mu.Lock()
		p.calls = append(p.calls, planCall{dir, command, env})
		p.mu.Unlock()
		if command == setup {
			return "", setupErr
		}
		list := envValue(env, verifyChangedEnv)
		if list == "" {
			return "", fmt.Errorf("want a scoped Verify, env %q", env)
		}
		if slices.Contains(strings.Fields(readFile(t, list)), file) {
			return "--- FAIL: TestBroken (" + file + ")", &planCommandError{exitCode: 1, output: "--- FAIL: TestBroken (" + file + ")"}
		}
		return "ok", nil
	}
	t.Cleanup(func() { runPlanCommand = orig })
	return p
}

func threeLaneBatch(t *testing.T, setup string) *mergeFixture {
	t.Helper()
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "a"}, {ID: "t-1", Label: "b"}, {ID: "t-2", Label: "c"}})
	f.setPlanCommands(t, verifyCmd, setup)
	f.land(t)
	for _, id := range []string{"t-0", "t-1", "t-2"} {
		f.finish(t, id)
		f.laneCommit(t, id, id+".txt")
	}
	return f
}

func states(g *waveobj.TaskGroup) []string {
	var out []string
	for _, t := range g.Tasks {
		out = append(out, t.State)
	}
	return out
}

func TestBisectFindsTheMiddleLaneAndLandsTheOneBefore(t *testing.T) {
	lead := newFakeLead(t)
	f := threeLaneBatch(t, "")
	calls := stubVerifyBreaksOn(t, "t-1.txt", "", nil)
	await := awaitVerify(t)

	AutoMergeReady(f.ctx, f.dagID)
	await()

	g := f.dag(t)
	want := []string{TaskState_Done, TaskState_VerifyFailed, TaskState_Verifying}
	if got := states(g); !reflect.DeepEqual(got, want) {
		t.Fatalf("states = %v, want %v", got, want)
	}
	if !strings.Contains(g.Tasks[1].VerifyOutput, "t-1.txt") || g.Tasks[2].VerifyOutput != heldLine("t-1") {
		t.Fatalf("the blamed lane keeps its failing run's output, the later one is held: %q / %q", g.Tasks[1].VerifyOutput, g.Tasks[2].VerifyOutput)
	}
	got := calls.list()
	if len(got) != 3 {
		t.Fatalf("one batch run and two bisect steps, got %d", len(got))
	}
	bisectTree := worktreeDir(f.projectPath(t), f.ownerID+"-bisect")
	if got[1].dir != bisectTree || got[2].dir != bisectTree {
		t.Fatalf("bisect steps run in %s, got %s and %s", bisectTree, got[1].dir, got[2].dir)
	}
	if _, err := os.Stat(bisectTree); !os.IsNotExist(err) {
		t.Fatalf("the bisect tree is removed, stat err %v", err)
	}
	if len(lead.sends) != 1 || !strings.Contains(lead.sends[0], "task t-1 (exit 1; bisected from t-0, t-1, t-2)") {
		t.Fatalf("one wake naming the bisect, got %q", lead.sends)
	}
}

func TestBisectBlamesTheLastLaneWhenOnlyItBreaks(t *testing.T) {
	// threeLaneBatch(t, ""), stubVerifyBreaksOn(t, "t-2.txt", "", nil):
	// want states done, done, verify-failed; 3 calls.
}

// a bisect that cannot run passes nothing it did not verify
func TestABisectWhoseSetupFailsBlamesTheOldestUnverifiedLane(t *testing.T) {
	// threeLaneBatch(t, "task setup"), stubVerifyBreaksOn(t, "t-2.txt", "task setup", errors.New("no node_modules")):
	// want states verify-failed, verifying, verifying (t-0 blamed, since no prefix was verified);
	// the wake's reason contains "Setup failed in the bisect tree".
}

// after --continue with a fix commit on top, HEAD is past the newest lane: no bisect, the continued lane is blamed
func TestAFailureAfterAFixCommitIsNotBisected(t *testing.T) {
	// threeLaneBatch(t, ""), stubVerifyBreaksOn(t, "t-1.txt", "", nil); AutoMergeReady; await.
	// commit fix.txt in the landing tree (the tree f.land returned: write, git add, git commit).
	// ContinueMerge(f.ctx, f.channel, f.ownerID, "t-1"); await.
	// want: exactly one more Verify call (4 in all), t-1 verify-failed again, t-2 verifying.
}

func TestCancellingTheDagStopsTheBisect(t *testing.T) {
	// threeLaneBatch(t, ""); a runPlanCommand stub: the first call fails with a planCommandError; the
	// second (the first bisect step) sets the dag cancelled (wstore.UpdateDag Status = DagStatus_Cancelled),
	// calls stopDagVerify(f.dagID), and returns ctx.Err() after <-ctx.Done().
	// want: 2 calls, no wake, and no task verify-failed.
}
```

Write out the sketched tests in full.

- [ ] **Step 2: Run them and see them fail**

Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/orchestrate/ -run 'Bisect|AfterAFixCommit' -count=1`
Expected: FAIL. Task 1's `judgeBatch` blames `t-0` with one call.

- [ ] **Step 3: Move the detached tree into `withDetachedTree`**

```go
// treeStepError is a step of a detached tree that could not run, as against the command run in it failing.
type treeStepError struct {
	step string
	err  error
}

func (e *treeStepError) Error() string { return e.step + ": " + e.err.Error() }
func (e *treeStepError) Unwrap() error { return e.err }

// withDetachedTree runs fn in a tree detached at commit, never in a tree anyone works in, after the plan's Setup, and
// removes the tree.
func withDetachedTree(ctx context.Context, project, name, label, commit, setup string, fn func(wt string) error) error {
	wt := worktreeDir(project, name)
	if _, err := os.Stat(wt); err == nil {
		if err := removeWorktreeDir(ctx, project, wt); err != nil {
			return &treeStepError{"removing a stale " + label, err}
		}
	}
	if _, err := git(ctx, project, "worktree", "add", "--detach", wt, commit); err != nil {
		return &treeStepError{"creating the " + label, err}
	}
	defer func() {
		if err := removeWorktreeDir(context.Background(), project, wt); err != nil {
			log.Printf("removing the %s %s: %v", label, wt, err)
		}
	}()
	if setup != "" {
		if _, err := runPlanCommand(ctx, wt, setup, nil, SetupTimeout, nil); err != nil {
			return &treeStepError{"Setup failed in the " + label, errors.New(failureDetail(err))}
		}
	}
	return fn(wt)
}
```

`runBaseCheck` calls it with `name = runID+"-base"` and `label = "base tree"`. A `*treeStepError` maps to `BaseCheckState_Skipped` with `err.Error()` as its detail, which keeps today's texts. The Check's own `*planCommandError` maps to `Failed` with `failureDetail`, and any other error maps to `Skipped` with `"running Check: "`.

- [ ] **Step 4: Bisect in `judgeBatch`**

The `ctx` here is the claim's context, which Task 1 cancels only after `judgeBatch` returns. Check that in `startVerify` before relying on it: if the run's context were already cancelled, every step would stop at `ctx.Err()`. On a failure, bisect when `ordered`, `len(batch) >= 2`, and `git rev-parse HEAD` in `run.tree` equals `batch[len(batch)-1].commit`. Otherwise keep Task 1's result.

```go
	lo, hi := 0, len(batch) // prefix i is the tree at batch[i-1].commit; prefix 0 passed its own Verify, prefix n just failed
	failOut, failErr := output, verr
	steps := 0
	first := batch[len(batch)/2-1].commit
	stepErr := withDetachedTree(ctx, run.project, run.runID+"-bisect", "bisect tree", first, run.setup, func(wt string) error {
		for hi-lo > 1 {
			if err := ctx.Err(); err != nil {
				return err
			}
			mid := (lo + hi) / 2
			commit := batch[mid-1].commit
			if _, err := git(ctx, wt, "checkout", "--detach", "--force", commit); err != nil {
				return &treeStepError{"moving the bisect tree to " + commit, err}
			}
			if run.progress != nil {
				run.progress(fmt.Sprintf("verify: bisecting: testing %s at %.8s", strings.Join(tipIDs(batch[:mid]), ", "), commit))
			}
			env := changedFilesEnv(ctx, wt, batch[0].commit+"^", commit, run.dagID+"/bisect")
			out, err := runPlanCommand(ctx, wt, run.command, env, VerifyTimeout, run.progress)
			steps++
			if err == nil {
				lo = mid
				continue
			}
			var pe *planCommandError
			if !errors.As(err, &pe) {
				return &treeStepError{"running Verify in the bisect tree", err}
			}
			hi, failOut, failErr = mid, out, err
		}
		return nil
	})
```

After the loop:
- `ctx.Err() != nil` (cancelled): return an outcome that records nothing. Give `batchOutcome` a `cancelled bool` that `recordBatchVerifyLocked` honors. A cancelled dag already records nothing.
- `stepErr != nil`: `passed = batch[:lo]`, `failed = batch[lo]`, `held = batch[lo+1:]`, output and err from the batch's run. The reason is `"<batch reason>; bisect stopped: <stepErr>"`.
- otherwise: `passed = batch[:hi-1]`, `failed = batch[hi-1]`, `held = batch[hi:]`, output and err `failOut` and `failErr`. The reason is `"<failErr reason>; bisected from " + strings.Join(ids, ", ")`.
- `bisect = steps` in both non-cancelled cases.

`batchRunner` gets `project = owner.ProjectPath` (where `git worktree add` runs, as for the base Check), `tree = jarvis.LandPath(owner)`, `setup = g.Setup`, `command = g.Verify`, and the progress sink that writes to every batch tip.

- [ ] **Step 5: Run the package**

Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/orchestrate/ -count=1`
Expected: PASS, including `basecheck_test.go` unchanged and Task 1's tests.

- [ ] **Step 6: Commit**

```bash
git add pkg/orchestrate/basecheck.go pkg/orchestrate/verify.go pkg/orchestrate/verifybisect_test.go
git commit -m "feat(orchestrate): bisect a failed merge batch to the lane that broke it"
```

### Task 3: Shard the slow Go test packages in verify.mjs, and fix the order-dependent watchdog tests
**Depends on:** none

**Files:**
- Modify: `scripts/verify.mjs`
- Modify: `scripts/verify.test.mjs`
- Modify: `pkg/orchestrate/watchdogscope_test.go` (`silentSiblingDag`'s spawn stub only)

**Interfaces:**
- Produces (exported from `scripts/verify.mjs` for its test): `SHARD_MIN_TESTS`, `SHARDS`, `countTopLevelTests(source: string): number`, `dealShards(names: string[], n: number): string[][]`, `runPattern(names: string[]): string`, `goSummary(pkg: string, ok: boolean, seconds: number): string`.

- [ ] **Step 1: Fix the watchdog helper.** In `silentSiblingDag`, count a spawn only for this test's own project. A dag another test left in the store is still ticked, but it isn't this test's spawn.

```go
	spawnWorker = func(_ context.Context, _ runroute.Capability, _, _, cwd, _ string, _ jarvis.RunWorkerOptions) (string, error) {
		// watchdogTick also ticks dags other tests left in the store; only this dag's spawns break the rule
		if strings.HasPrefix(filepath.Clean(cwd), filepath.Clean(ch.ProjectPath)) {
			spawns++
		}
		return "tab:worker", nil
	}
```

Check it: build the test binary (`CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test -c -o orch.test.exe ./pkg/orchestrate/`, to a temp path). From `pkg/orchestrate`, list the tests with `-test.list .`, split them round robin into 4 groups, and run each group with `-test.run '^(...)$'`. All four must pass. Before this step, one or two groups failed `TestWatchdogTickDetectsStallIn*` every time. Delete the binary afterwards.

- [ ] **Step 2: Write the failing JS tests** in `scripts/verify.test.mjs`:

```js
import { SHARDS, countTopLevelTests, dealShards, goSummary, runPattern } from "./verify.mjs";

describe("sharding", () => {
    it("counts top-level tests, not TestMain, helpers or methods", () => {
        const src = [
            "func TestMain(m *testing.M) {}",
            "func TestA(t *testing.T) {}",
            "func Test_b(t *testing.T) {}",
            "func Testhelper(t *testing.T) {}",
            "func (s *suite) TestC(t *testing.T) {}",
            "  func TestIndented(t *testing.T) {}",
            "func TestD (t *testing.T) {}",
        ].join("\n");
        expect(countTopLevelTests(src)).toBe(3);
    });
    it("deals names round robin and keeps order within a shard", () => {
        expect(dealShards(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "c", "e"], ["b", "d"]]);
    });
    it("makes no empty shard when there are fewer names than shards", () => {
        expect(dealShards(["a", "b"], SHARDS)).toEqual([["a"], ["b"]]);
    });
    it("anchors the run pattern so TestA does not also run TestAB", () => {
        expect(runPattern(["TestA", "TestB"])).toBe("^(TestA|TestB)$");
    });
    it("summarizes a package like go test, so the engine's excerpt finds FAIL", () => {
        expect(goSummary("example.com/m/pkg/a", true, 1.5)).toBe("ok  \texample.com/m/pkg/a\t1.500s");
        expect(goSummary("example.com/m/pkg/a", false, 2)).toBe("FAIL\texample.com/m/pkg/a\t2.000s");
    });
});
```

Run: `node node_modules/vitest/vitest.mjs run scripts/verify.test.mjs`
Expected: FAIL, since the exports don't exist yet.

- [ ] **Step 3: Implement the sharding in `scripts/verify.mjs`.** Keep the file's 4-space, hand-formatted style, and never run prettier on it.

```js
// a package with at least this many top-level tests is split across processes: here those take 2.6 to 110 s, and
// below it all but one run in seconds
export const SHARD_MIN_TESTS = 100;
// pkg/orchestrate took ~100 s in one process, 37-52 s in 4, and 33 s in 6
export const SHARDS = 4;
const TOP_LEVEL_TEST = /^func (Test[A-Z0-9_]\w*)\s*\(/gm;

export function countTopLevelTests(source) {
    return [...source.matchAll(TOP_LEVEL_TEST)].filter((m) => m[1] !== "TestMain").length;
}

export function dealShards(names, n) {
    const shards = Array.from({ length: Math.min(n, names.length) }, () => []);
    names.forEach((name, i) => shards[i % shards.length].push(name));
    return shards;
}

export function runPattern(names) {
    return `^(${names.join("|")})$`;
}

export function goSummary(pkg, ok, seconds) {
    return `${ok ? "ok  " : "FAIL"}\t${pkg}\t${seconds.toFixed(3)}s`;
}
```

Wiring, all in `verify.mjs`:
- `goPackages(args)`: `go list -e -f '{{.ImportPath}}\t{{.Dir}}' <args>` gives `[{importPath, dir}]`. It serves both the scoped `goPkgs` and the unscoped `patterns`.
- Split them: `countTopLevelTests` over the concatenated `*_test.go` files in `dir` (`readdirSync`) `>= SHARD_MIN_TESTS` means sharded, the rest plain.
- Plain: `run("go", ["test", ...plain])`, as today. Skip it when `plain` is empty.
- Sharded, one package after another:
  1. `go test -c -o <tmp>/<i>.test[.exe] <importPath>` via `spawnSync`, with `stdio: "inherit"`. `<tmp>` comes from `mkdtempSync(join(tmpdir(), "arc-verify-"))`, and `.exe` is added on `win32`. A build failure prints and fails the script.
  2. Names: `spawnSync(bin, ["-test.list", "."], { cwd: dir, encoding: "utf8" })`. Keep the stdout lines matching `/^(Test|Example|Fuzz)\w*$/`; a `TestMain` logs to stderr.
  3. `dealShards(names, SHARDS)`. Run every shard at once with async `spawn(bin, ["-test.run", runPattern(shard), "-test.timeout=10m"], { cwd: dir })`, collecting stdout and stderr per shard. Await all of them (`Promise.all`) and time the package.
  4. Print each shard's collected output in shard order, then `goSummary(importPath, allPassed, seconds)`. Remember a failure, and go on to the next package.
- After every sharded package ran: remove `<tmp>` (`rmSync(tmp, { recursive: true, force: true })`), and `process.exit(1)` if any failed, before tsc and vitest run. Like today, a Go failure stops the script.
- `main` becomes `async`, and the script entry calls `main(...).catch((e) => { console.error(`verify: ${e.stack ?? e}`); process.exit(1); })`.
- The child processes inherit `process.env`, so the Verify line's `CGO_ENABLED`/`CC` reach `go test -c`. If `goTestEnv` from run 5952d714 is on this branch when you start, pass its result to the `go test -c` build as `run` does.

- [ ] **Step 4: Run the JS tests and the sharded Verify for real**

Run: `node node_modules/vitest/vitest.mjs run scripts/verify.test.mjs`
Expected: PASS.

Run: `printf 'pkg/orchestrate/wake.go\n' > "$TEMP/changed.txt" && CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" ARC_VERIFY_CHANGED="$TEMP/changed.txt" node scripts/verify.mjs ./pkg/orchestrate/... ./pkg/jarvis/... ./pkg/wshrpc/... ./cmd/wsh/...`
Expected: exit 0. It prints `ok` summaries for `pkg/orchestrate`, `pkg/wshrpc/wshserver` and `cmd/wsh/cmd` from the sharded path, and `pkg/orchestrate` runs in well under the ~100 s one process takes. Note the seconds its summary line printed: they go in the commit body (Step 5), where Task 4 reads them.

Run a failing shard once to see it end to end: add a `func TestZZFails(t *testing.T) { t.Fatal("boom") }` to `pkg/orchestrate/zz_test.go` and run the command again. Expected: exit nonzero, and the output shows `--- FAIL: TestZZFails` followed by `FAIL\tgithub.com/.../pkg/orchestrate`. Delete `zz_test.go`.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify.mjs scripts/verify.test.mjs pkg/orchestrate/watchdogscope_test.go
git commit -m "perf(verify): shard the slow Go test packages; count only a watchdog test's own spawns"   -m "Sharded pkg/orchestrate: <N> s in 4 processes (one process: ~100 s).""
```

### Task 4: Record the fixes and the dropped items
**Depends on:** Task 2, Task 3

**Files:**
- Modify: `docs/orchestrator-findings-2026-09-25.md`
- Modify: `docs/orchestrator-guide.md`

- [ ] **Step 1: The guide.** In `docs/orchestrator-guide.md`, where it describes merges and the per-merge Verify, say the following in the guide's own voice:
  - Ready lanes merge together, each as its own squash commit, and one Verify, scoped from the oldest to `HEAD`, judges them all. Dependents still start at their dependency's merge.
  - A failed batch of two or more is bisected in a detached tree (`<project>/.waveterm/worktrees/<run>-bisect`, with the plan's Setup). The lanes before the breaking one land. The breaking one is verify-failed, and the lead is woken. The ones after it stay verifying ("held"), and the Verify after the lead's fix and `dag merge <task> --continue` judges them together.
  - No bisect after a fix commit or for a single lane. A bisect that cannot run blames the oldest lane not known good.

- [ ] **Step 2: The findings doc.** Add a section `## Fixes: merge train and Go test shards` after "Fixes after the handoff". Its table has the same columns as the earlier fix sections (`| # | Fix | Test |`). Rows:
  - `23, 27`, the merge train. Tests: the Task 1 test names.
  - `23, 27`, the bisect. Tests: the Task 2 test names.
  - `23`, sharding. Tests: `scripts/verify.test.mjs`. Put in the `pkg/orchestrate` wall time Task 3 wrote in its commit body. Read it with `git log --grep="shard the slow Go test packages" --format=%B`.
  - `23`, the watchdog test isolation. Test: the sharded `pkg/orchestrate` run.
  - Three rows `27 (dropped)`, one each for the automatic retry, targeted worker checks and incremental tsc, each with a one-sentence reason taken from spec section 4.

  After the table, one line pointing to `docs/superpowers/specs/2026-09-27-orchestrator-merge-train-design.md` for the measurements, CPU contention included. In the Handoff section's item 1, change "Still deferred: the merge train with bisect, the automatic Verify retry, and targeted worker checks with an incremental tsc." to point at the new section. Run 5952d714 also appends to this doc, so add a section and change nothing else.

- [ ] **Step 3: Commit**

```bash
git add docs/orchestrator-findings-2026-09-25.md docs/orchestrator-guide.md
git commit -m "docs: record the merge train, the Go test shards and the dropped speed items"
```
