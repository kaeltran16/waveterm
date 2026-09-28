# Orchestrator findings 48 and 49 Implementation Plan

**Verify:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" node scripts/verify.mjs ./pkg/orchestrate/... ./pkg/jarvis/... ./pkg/wshrpc/...`
**Setup:** `node scripts/worktree-junctions.mjs prepare`
**Check:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go vet ./pkg/orchestrate/... ./pkg/jarvis/... ./pkg/wshrpc/... ./cmd/server/...`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close findings 48 (a merge Verify fails on an unprepared landing tree when the plan has no Setup line) and 49 (a child's outcome times out behind a merge's cleanup, which holds the dag lock), and record both in the findings doc.

**Architecture:** 48: a checked-in `.arc/setup` is the project's default Setup, taken into the dag at submit when the plan names none, so every existing tree-preparation path uses it unchanged. 49a: tree removal (reap + git remove) moves out of the dag mutation lock into one `removeTaskTree`, serialized per tree by a keyed mutex, whose result is recorded per task under a short dag lock. 49b: `HandleChildOutcome` detaches from the exit hook's 10 s deadline, and `OnWorkerExit` resolves the dispatch channel before calling the hook.

**Tech Stack:** Go (`pkg/orchestrate`, `pkg/jarvis`, `pkg/wshrpc/wshserver`), SQLite-backed `wstore` in tests, Git Bash for plan commands on Windows.

**Spec:** `docs/superpowers/specs/2026-09-28-orchestrator-findings-48-49-design.md`

## Global Constraints

- Go tests touching sqlite need `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu"`. Run single tests with `go test ./pkg/orchestrate/ -run '<Name>' -count=1` under that env.
- No wshrpc/waveobj/wconfig type changes are planned, so `task generate` is not needed. If you find you must change one, run `task generate` and never hand-edit its outputs.
- `gofmt -l` only the files you touched; never `--write` the tree.
- The dag mutation lock is not reentrant: never call `WithDagMutation`/`withDagMutation` for a dag from code already holding it.
- A plan's own Setup line wins over `.arc/setup`; the file is a default, not an addition.
- `.arc/setup` holds one command: more than one non-empty line is refused with `.arc/setup must hold one command, found N lines`.
- Comments explain why, lower case, only where needed; match the surrounding comment style.
- Commit messages: `type(scope): description`, with no attribution or co-author trailers.

## Review Focus

- A `.arc/setup` with a trailing newline, CRLF line endings or surrounding blank lines is one command, not several: `ProjectSetup` trims and counts only non-empty lines (Task 1 test covers `"\r\n  cmd arg \r\n\r\n"`).
- A merge RPC whose client gives up (cancelled ctx) must still finish the tree removal it started: removal runs on `context.WithoutCancel` (Task 3 test cancels the merge's ctx while the removal blocks).
- Two lanes merged in one batch are both removed, and neither's recorded result is reverted by the other's (Task 3 `TestRemovingOneTreeKeepsAnotherTreesRecordedResult`, and the batch test).
- A cancelled dag with a tree that fails to remove still returns that error from `Cancel` (the existing `TestCancel…` test expecting `locked` keeps passing).
- A task whose removal already finished while another caller waited on the tree lock is not removed twice (Task 3 `TestTheTickSkipsATreeAnotherCallerIsRemoving`, and the fresh re-read under the tree lock).

---

### Task 1: A project default Setup (`.arc/setup`) for plans with no Setup line
**Depends on:** none

**Files:**
- Modify: `pkg/orchestrate/plancmd.go` (add `ProjectSetup`)
- Test: `pkg/orchestrate/plancmd_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (`DagSubmitCommand`, right after the plan is loaded, before `proposed.Verify, proposed.Setup, … = plan.Verify, plan.Setup, …` near line 241)
- Test: `pkg/wshrpc/wshserver/wshserver_landing_test.go`
- Modify: `pkg/jarvis/plan.go` (`PlanFormat`'s Setup sentence)
- Modify: `AGENTS.md` ("Plans the engine runs" bullet)
- Create: `.arc/setup`

**Interfaces:**
- Produces: `func ProjectSetup(dir string) (string, error)` in package `orchestrate`; constant `ProjectSetupFile = ".arc/setup"` (relative path, joined with `filepath.Join(dir, filepath.FromSlash(ProjectSetupFile))`).

- [ ] **Step 1: Write the failing unit test** in `pkg/orchestrate/plancmd_test.go`:

```go
func TestProjectSetupReadsTheCheckedInDefault(t *testing.T) {
	write := func(t *testing.T, body string) string {
		t.Helper()
		dir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(dir, ".arc"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, ".arc", "setup"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	t.Run("no file is no default", func(t *testing.T) {
		got, err := ProjectSetup(t.TempDir())
		if err != nil || got != "" {
			t.Fatalf("ProjectSetup = %q, %v; want empty, nil", got, err)
		}
	})
	t.Run("one line, trimmed", func(t *testing.T) {
		got, err := ProjectSetup(write(t, "\r\n  cmd arg \r\n\r\n"))
		if err != nil || got != "cmd arg" {
			t.Fatalf("ProjectSetup = %q, %v; want %q", got, err, "cmd arg")
		}
	})
	t.Run("two commands are refused", func(t *testing.T) {
		_, err := ProjectSetup(write(t, "a\nb\n"))
		if err == nil || !strings.Contains(err.Error(), ".arc/setup must hold one command, found 2 lines") {
			t.Fatalf("err = %v, want the one-command refusal", err)
		}
	})
}
```

- [ ] **Step 2: Run it and see it fail**

Run: `go test ./pkg/orchestrate/ -run TestProjectSetupReadsTheCheckedInDefault -count=1`
Expected: FAIL to compile, `undefined: ProjectSetup`.

- [ ] **Step 3: Implement `ProjectSetup`** in `pkg/orchestrate/plancmd.go` beside `RunSetup`:

```go
// ProjectSetupFile is where a project checks in its default Setup: the command every tree the engine makes runs
// when the plan names none, so a lead that leaves Setup out still gets prepared trees.
const ProjectSetupFile = ".arc/setup"

// ProjectSetup reads dir's default Setup command. No file is no default.
func ProjectSetup(dir string) (string, error) {
	b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(ProjectSetupFile)))
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", ProjectSetupFile, err)
	}
	var lines []string
	for _, line := range strings.Split(string(b), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) > 1 {
		return "", fmt.Errorf("%s must hold one command, found %d lines", ProjectSetupFile, len(lines))
	}
	if len(lines) == 0 {
		return "", nil
	}
	return lines[0], nil
}
```

Add the imports it needs (`errors`, `io/fs`, `os`, `path/filepath`, `strings`) only if absent.

- [ ] **Step 4: Run it and see it pass**

Run: `go test ./pkg/orchestrate/ -run TestProjectSetupReadsTheCheckedInDefault -count=1`
Expected: PASS.

- [ ] **Step 5: Write the failing submit tests** in `pkg/wshrpc/wshserver/wshserver_landing_test.go`, as two more subtests of `TestDagSubmitRunsSetupInTheLandingTree` (they reuse its `newRun`; note `newRun` writes the plan with a Setup line, so add a `newRunPlan(t, landPath, planBody string)` variant, or give `newRun` a way to omit the Setup line when `setup == ""`, and use it for the first subtest):

```go
	// c84aa179: a plan with no Setup line left the landing tree without node_modules
	t.Run("a plan with no Setup line runs the project's default", func(t *testing.T) {
		tree, _ := newLandingRepo(t)
		writeProjectSetup(t, tree, "echo ok > default.txt")
		_, do := newRun(t, tree, "") // plan body has no **Setup:** line
		if err := do(ctx); err != nil {
			t.Fatalf("submit: %v", err)
		}
		if _, err := os.Stat(filepath.Join(tree, "default.txt")); err != nil {
			t.Fatalf("the default Setup did not run in the landing tree: %v", err)
		}
		// and the dag carries it, so worker, bisect, base-check and final trees run it too
		if g := dagOfLatestRun(t); g.Setup != "echo ok > default.txt" {
			t.Fatalf("dag Setup = %q, want the project default", g.Setup)
		}
	})

	t.Run("the plan's Setup line wins over the project default", func(t *testing.T) {
		tree, _ := newLandingRepo(t)
		writeProjectSetup(t, tree, "echo ok > default.txt")
		_, do := newRun(t, tree, "echo ok > plan.txt")
		if err := do(ctx); err != nil {
			t.Fatalf("submit: %v", err)
		}
		if _, err := os.Stat(filepath.Join(tree, "plan.txt")); err != nil {
			t.Fatalf("the plan's Setup did not run: %v", err)
		}
		if _, err := os.Stat(filepath.Join(tree, "default.txt")); err == nil {
			t.Fatal("the project default ran although the plan names a Setup")
		}
	})

	t.Run("a malformed default fails the submit", func(t *testing.T) {
		tree, _ := newLandingRepo(t)
		writeProjectSetup(t, tree, "a\nb\n")
		_, do := newRun(t, tree, "")
		if err := do(ctx); err == nil || !strings.Contains(err.Error(), "must hold one command") {
			t.Fatalf("submit err = %v, want the one-command refusal", err)
		}
	})
```

with helpers in the same file:

```go
func writeProjectSetup(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, ".arc"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".arc", "setup"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
```

`dagOfLatestRun` stands for reading the submitted dag: have `newRun` also return the run id and channel, then `wstore.GetRun` → `wstore.GetDag(ctx, run.DagORef)`. Shape it to fit `newRun`'s return values. The existing subtests must keep their current behavior.

- [ ] **Step 6: Run them and see the first and third fail**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestDagSubmitRunsSetupInTheLandingTree -count=1`
Expected: FAIL on "the default Setup did not run in the landing tree" and on the malformed-default subtest; the "plan's Setup wins" subtest passes already.

- [ ] **Step 7: Apply the default at submit.** In `DagSubmitCommand`, once `plan` is loaded (after `loadDagPlan`, or its zero value for a JSON-tasks submit) and `run` is loaded, before `proposed.Verify, proposed.Setup, … = plan.Verify, plan.Setup, …`:

```go
	// a plan written without a Setup line still gets prepared trees: the project's checked-in default fills it,
	// read from the landing tree, which is at the commit the run builds from
	if plan.Setup == "" {
		setup, err := orchestrate.ProjectSetup(jarvis.LandPath(run))
		if err != nil {
			return nil, err
		}
		plan.Setup = setup
	}
```

The landing-tree Setup at line ~254 (`if run.LandPath != "" && run.DagORef == "" && plan.Setup != ""`) and `proposed.Setup` then carry it with no other change. If `plan` or `run` is loaded after that point in the current code, place the block right after both exist and before the first read of `plan.Setup`.

- [ ] **Step 8: Run the submit tests and see them pass**

Run: `go test ./pkg/wshrpc/wshserver/ -run 'TestDagSubmit' -count=1`
Expected: PASS.

- [ ] **Step 9: Name the file in the plan format and AGENTS.md.**
  - `pkg/jarvis/plan.go` `PlanFormat`: in the sentence that introduces Verify, Setup and Check as optional, add after it: `"Left out, Setup is the project's checked-in .arc/setup command, if it has one. "` Keep the string's existing style (concatenated sentences). Run `go test ./pkg/jarvis/ ./pkg/orchestrate/ -run 'PlanFormat|LeadPrompt|OrchestrationRules' -count=1` and update any test that pins the exact text.
  - `AGENTS.md`, "Plans the engine runs" bullet: after the sentence naming the optional `**Verify:**`, `**Setup:**`, `**Check:**` and `**Final:**` commands, add: `A plan with no Setup line runs the project's checked-in \`.arc/setup\` (one command) instead; this repo's junctions the main checkout's \`node_modules\`, \`src-tauri/target\` and \`dist/bin\`.`

- [ ] **Step 10: Check in this repo's default.** Create `.arc/setup` containing exactly one line:

```
node scripts/worktree-junctions.mjs prepare
```

Confirm it is not ignored: `git check-ignore -v .arc/setup` prints nothing.

- [ ] **Step 11: Run the touched packages**

Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/orchestrate/ ./pkg/jarvis/ ./pkg/wshrpc/wshserver/ -count=1`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add .arc/setup AGENTS.md pkg/orchestrate/plancmd.go pkg/orchestrate/plancmd_test.go pkg/wshrpc/wshserver/wshserver_dag.go pkg/wshrpc/wshserver/wshserver_landing_test.go pkg/jarvis/plan.go
git commit -m "feat(orchestrate): a checked-in .arc/setup is the default Setup for a plan with none"
```

### Task 2: A child's outcome survives any dag-lock hold
**Depends on:** none

**Files:**
- Modify: `pkg/orchestrate/outcome.go` (`HandleChildOutcome`)
- Test: `pkg/orchestrate/outcome_test.go`
- Modify: `pkg/jarvis/onexit.go` (`OnWorkerExit`, a new `exitReadTimeout` var)
- Test: `pkg/jarvis/onexit_test.go`

**Interfaces:**
- Produces: `var exitReadTimeout = 10 * time.Second` in package `jarvis` (test seam).

- [ ] **Step 1: Write the failing orchestrate test** in `pkg/orchestrate/outcome_test.go` (uses the existing `newChildOutcomeHarness`):

```go
// c84aa179: a merge's cleanup held the dag lock 22-39 s and the exit's 10 s context expired while the outcome waited
func TestHandleChildOutcomeOutlivesTheExitDeadline(t *testing.T) {
	h := newChildOutcomeHarness(t, 1)
	held := make(chan struct{})
	release := make(chan struct{})
	go WithDagMutation(h.dagID, func() error {
		close(held)
		<-release
		return nil
	})
	<-held
	time.AfterFunc(200*time.Millisecond, func() { close(release) })
	short, cancel := context.WithTimeout(h.ctx, 50*time.Millisecond)
	defer cancel()
	if err := HandleChildOutcome(short, h.workers[0], jarvis.OutcomeData{Status: "failed", Summary: "tool call errored: invalid input", ExitCode: 2}); err != nil {
		t.Fatalf("outcome lost behind the lock: %v", err)
	}
	if task := h.loadDag(t).Tasks[0]; task.Attempts != 1 || task.LastFailureKind != FailureKindToolError {
		t.Fatalf("outcome not recorded: attempts %d kind %q", task.Attempts, task.LastFailureKind)
	}
}
```

- [ ] **Step 2: Run it and see it fail**

Run: `go test ./pkg/orchestrate/ -run TestHandleChildOutcomeOutlivesTheExitDeadline -count=1`
Expected: FAIL with `loading dag for child outcome: context deadline exceeded` (or `resolving owner…` if the owner lookup already hits the deadline — either way the error names the expired context).

- [ ] **Step 3: Detach the outcome.** At the top of `HandleChildOutcome`, before `workerRunIds`:

```go
	// the exit's context bounds its own reads; this waits on the dag lock, which a merge's cleanup or a spawn's
	// Setup can hold for longer, and an outcome lost there leaves a failed worker running until the stall watchdog
	ctx = context.WithoutCancel(ctx)
```

- [ ] **Step 4: Run it and see it pass**, plus the file's other tests.

Run: `go test ./pkg/orchestrate/ -run 'TestHandleChildOutcome|TestChildOutcome' -count=1`
Expected: PASS.

- [ ] **Step 5: Write the failing jarvis test** in `pkg/jarvis/onexit_test.go`. Build a worker that was dispatched from a channel, so `resolveDispatchChannelForWorker` finds it: a tab with `session:agent` meta and a block whose `MetaKey_AgentTranscriptPath` points at a transcript that parses as a finished session, plus a channel that `ResolveDispatchChannel` maps to that worker. Grep `ResolveDispatchChannel` and `alreadyHasFreshOutcome` in `pkg/jarvis` and their tests for how a dispatch message ties a channel to a worker oref, and reuse that fixture; for the transcript, reuse whatever `TestOnWorkerExit*` or `agentsessions` tests already write for a done claude session. Then:

```go
func TestOnWorkerExitPostsTheOutcomeWhenTheHookOutlivesTheDeadline(t *testing.T) {
	blockOID, channelOID := seedDispatchedWorker(t) // the fixture described above
	oldTimeout := exitReadTimeout
	exitReadTimeout = 50 * time.Millisecond
	t.Cleanup(func() { exitReadTimeout = oldTimeout })
	oldHook := ChildOutcomeHook
	t.Cleanup(func() { ChildOutcomeHook = oldHook })
	ChildOutcomeHook = func(context.Context, string, OutcomeData) error {
		time.Sleep(4 * exitReadTimeout) // a dag lock held past the exit's deadline
		return nil
	}

	OnWorkerExit(blockOID, 0)

	if !channelHasOutcome(t, channelOID) {
		t.Fatal("the outcome was not posted to the dispatch channel")
	}
}
```

`channelHasOutcome` loads the channel (`wstore.DBMustGet[*waveobj.Channel]`) and reports whether a message of type `"outcome"` for the worker is in it.

- [ ] **Step 6: Run it and see it fail**

Run: `go test ./pkg/jarvis/ -run TestOnWorkerExitPostsTheOutcomeWhenTheHookOutlivesTheDeadline -count=1`
Expected: FAIL to compile (`undefined: exitReadTimeout`); after adding only the var (Step 7's first half), FAIL on "the outcome was not posted".

- [ ] **Step 7: Resolve the channel before the hook.** In `pkg/jarvis/onexit.go`:

```go
// exitReadTimeout bounds an exit's own reads. The child-outcome hook runs past it: it can wait on a dag lock.
var exitReadTimeout = 10 * time.Second
```

In `OnWorkerExit`, use `exitReadTimeout` for the `context.WithTimeout`, and move `ch := resolveDispatchChannelForWorker(ctx, workerORef)` above `notifyChildOutcome(ctx, workerORef, data)`:

```go
	// resolved before the hook, which can wait on a dag lock past this context's deadline
	ch := resolveDispatchChannelForWorker(ctx, workerORef)
	notifyChildOutcome(ctx, workerORef, data)
	if ch == nil {
		log.Printf("jarvis onexit: no dispatch channel for worker %s; outcome not posted", workerORef)
		return
	}
	PostOutcome(ch, workerORef, runtime, data)
```

`PostOutcome` makes its own context, so nothing else changes.

- [ ] **Step 8: Run the jarvis and orchestrate tests**

Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/jarvis/ ./pkg/orchestrate/ -count=1`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add pkg/orchestrate/outcome.go pkg/orchestrate/outcome_test.go pkg/jarvis/onexit.go pkg/jarvis/onexit_test.go
git commit -m "fix(orchestrate): a child's outcome waits out the dag lock instead of the exit's deadline"
```

### Task 3: Tree removal runs outside the dag lock
**Depends on:** none

**Files:**
- Modify: `pkg/orchestrate/cleanup.go` (new `treeRemovals`, `removeTaskTree`, `RetryCleanupDebt`, per-task persist; `RetryCleanup`; drop `RetryPendingCleanup` once unused)
- Modify: `pkg/orchestrate/mergetask.go` (`FinishMergedTask`, `CleanupMergedTask` removed, `mergeTaskLocked`, `mergeTaskEntry`, `continueBlockedMerge`, `ContinueMerge`, `mergeBatch`)
- Modify: `pkg/orchestrate/engine.go` (`Schedule`, `scheduleLocked`)
- Modify: `pkg/orchestrate/mutation.go` (`WithDagMutation` doc, `Cancel`/`cancelLocked`)
- Modify: `cmd/server/main-server.go` (`retryCleanupDebtAtStartup` calls `RetryCleanupDebt`)
- Test: `pkg/orchestrate/cleanup_test.go`, `pkg/orchestrate/mergetask_test.go`, and the existing tests in `engine_test.go`/`mutation_test.go` that call `RetryPendingCleanup`, `CleanupMergedTask` or `FinishMergedTask`

**Interfaces:**
- Produces (package `orchestrate`; all unexported but `RetryCleanupDebt`, which the startup sweep in `cmd/server` calls):
  - `var treeRemovals = keyedmutex.New()`
  - `func removeTaskTree(ctx context.Context, dagID, taskID string, wait bool) error`. The caller must not hold the dag lock. `wait=false` returns nil at once when another caller is removing that tree.
  - `func RetryCleanupDebt(ctx context.Context, dagID string)`
  - `func persistTaskCleanupLocked(ctx context.Context, dagID string, done *waveobj.TaskNode) error`
- `FinishMergedTask(ctx, channelID, dagID, childRunID, taskID, sha string) (string, error)` keeps its signature but no longer removes the tree.

- [ ] **Step 1: Write the failing lock test** in `pkg/orchestrate/mergetask_test.go`:

```go
// c84aa179: the tree's removal held the dag lock 22-39 s, and every exit it caused waited on that lock
func TestMergeRemovesTheTreeWithoutHoldingTheDagLock(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.finish(t, "t-0")
	stubMerge(t, func(context.Context, string, string, string) (string, error) { return "sha-1", nil })
	entered, release := make(chan struct{}), make(chan struct{})
	stubCleanupRemover(t, func(context.Context, string, string) error {
		close(entered)
		<-release
		return nil
	})
	stubStopRunWorkers(t)
	done := make(chan error, 1)
	go func() { done <- MergeTask(f.ctx, f.channel, f.ownerID, "t-0") }()
	<-entered
	ran, err := TryWithDagMutation(f.dagID, func() error { return nil })
	close(release)
	if err != nil || !ran {
		t.Fatalf("the dag lock was held while the tree was removed (ran=%v err=%v)", ran, err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if task := f.dag(t).Tasks[0]; task.CleanupPending || task.CleanupError != "" || !task.Merged {
		t.Fatalf("after removal: merged %v pending %v error %q", task.Merged, task.CleanupPending, task.CleanupError)
	}
}
```

(`stubStopRunWorkers` exists in the cleanup tests; if its signature differs, stub `stopRunWorkers` the same way it does.)

- [ ] **Step 2: Run it and see it fail**

Run: `go test ./pkg/orchestrate/ -run TestMergeRemovesTheTreeWithoutHoldingTheDagLock -count=1`
Expected: FAIL with "the dag lock was held while the tree was removed (ran=false …)".

- [ ] **Step 3: Write the remaining failing tests** in `pkg/orchestrate/cleanup_test.go`:

```go
// the tick's debt retry must neither remove a tree a merge is removing nor wait for it
func TestTheTickSkipsATreeAnotherCallerIsRemoving(t *testing.T) {
	// under the retry cap: seedCleanupDebt sets MaxCleanupAttempts, which the retry skips before any tree lock
	ctx, dag := seedCleanupDebtOn(t, "t-0")
	var calls atomic.Int32
	entered, release := make(chan struct{}), make(chan struct{})
	stubCleanupRemover(t, func(context.Context, string, string) error {
		if calls.Add(1) == 1 {
			close(entered)
			<-release
		}
		return nil
	})
	first := make(chan error, 1)
	go func() { first <- removeTaskTree(ctx, dag.OID, "t-0", true) }()
	<-entered
	tick := make(chan struct{})
	go func() { RetryCleanupDebt(ctx, dag.OID); close(tick) }()
	select {
	case <-tick:
	case <-time.After(2 * time.Second):
		t.Fatal("the tick waited on a tree another caller is removing")
	}
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("remover called %d times, want 1", n)
	}
}

// each removal records only its own task: a stale snapshot must not revert another tree's recorded result
func TestRemovingOneTreeKeepsAnotherTreesRecordedResult(t *testing.T) {
	ctx, dag := seedCleanupDebtOn(t, "t-0", "t-1") // both merged with CleanupPending, separate lanes
	entered, release := make(chan struct{}), make(chan struct{})
	stubCleanupRemover(t, func(_ context.Context, _, key string) error {
		if strings.HasSuffix(key, "-t-0") {
			close(entered)
			<-release
		}
		return nil
	})
	slow := make(chan error, 1)
	go func() { slow <- removeTaskTree(ctx, dag.OID, "t-0", true) }()
	<-entered
	if err := removeTaskTree(ctx, dag.OID, "t-1", true); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-slow; err != nil {
		t.Fatal(err)
	}
	g, err := wstore.GetDag(ctx, dag.OID)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"t-0", "t-1"} {
		if task := taskByID(g, id); task.CleanupPending || task.CleanupError != "" {
			t.Fatalf("%s: pending %v error %q, want cleared", id, task.CleanupPending, task.CleanupError)
		}
	}
}

```

and in `mergetask_test.go`:

```go
// a merge RPC whose client gave up still finishes the removal it started
func TestRemovalFinishesAfterTheMergeCallerCancels(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.finish(t, "t-0")
	stubMerge(t, func(context.Context, string, string, string) (string, error) { return "sha-1", nil })
	stubStopRunWorkers(t)
	caller, cancel := context.WithCancel(f.ctx)
	entered, release := make(chan struct{}), make(chan struct{})
	stubCleanupRemover(t, func(ctx context.Context, _, _ string) error {
		close(entered)
		<-release
		return ctx.Err() // a removal on the caller's context would fail here
	})
	done := make(chan error, 1)
	go func() { done <- MergeTask(caller, f.channel, f.ownerID, "t-0") }()
	<-entered
	cancel()
	close(release)
	<-done
	if task := f.dag(t).Tasks[0]; task.CleanupPending || task.CleanupError != "" {
		t.Fatalf("the removal failed with its caller: pending %v error %q", task.CleanupPending, task.CleanupError)
	}
}
```

Add `seedCleanupDebtOn(t, ids...)` beside the existing `seedCleanupDebt`. Seed the same way (`seedPendingDag`, `stubStopRunWorkers`), but for each named independent task set `State = TaskState_Done`, `Merged = true`, `CleanupPending = true`, `CleanupError = ""`, `CleanupAttempts = 0`: debt under the retry cap, so `RetryCleanupDebt` does not skip it. If `seedPendingDag` has fewer tasks than named, seed a dag with enough independent tasks. Also write the spec's c84aa179 case in `mergetask_test.go`:

```go
// c84aa179: an outcome that arrives while a merge's tree is being removed is recorded, not timed out
func TestAChildOutcomeLandsWhileAMergesTreeIsRemoved(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}, {ID: "t-1", Label: "second"}})
	allowWorkerHarnessForTest(t)
	oldSpawn := spawnWorker
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		tabID, blockID := uuid.NewString(), uuid.NewString()
		worker := waveobj.MakeORef(waveobj.OType_Tab, tabID).String()
		if err := wstore.DBInsert(f.ctx, &waveobj.Tab{OID: tabID, BlockIds: []string{blockID}, Meta: waveobj.MetaMapType{}}); err != nil {
			return "", err
		}
		if err := wstore.DBInsert(f.ctx, &waveobj.Block{OID: blockID, ParentORef: worker, Meta: waveobj.MetaMapType{}}); err != nil {
			return "", err
		}
		return worker, nil
	}
	t.Cleanup(func() { spawnWorker = oldSpawn })
	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	// t-1's worker: its child run's roster names it
	run, err := wstore.GetRun(f.ctx, f.channel, f.dag(t).Tasks[1].RunID)
	if err != nil {
		t.Fatal(err)
	}
	worker := run.Phases[jarvis.RunningPhaseIndex(*run)].WorkerOrefs[0]
	f.finish(t, "t-0")
	stubMerge(t, func(context.Context, string, string, string) (string, error) { return "sha-1", nil })
	stubStopRunWorkers(t)
	entered, release := make(chan struct{}), make(chan struct{})
	stubCleanupRemover(t, func(context.Context, string, string) error {
		close(entered)
		<-release
		return nil
	})
	merged := make(chan error, 1)
	go func() { merged <- MergeTask(f.ctx, f.channel, f.ownerID, "t-0") }()
	<-entered
	outcome := make(chan error, 1)
	go func() {
		// the exit's real deadline, so this fails only if the removal holds the lock, whether or not Task 2 landed
		exitCtx, cancel := context.WithTimeout(f.ctx, 10*time.Second)
		defer cancel()
		outcome <- HandleChildOutcome(exitCtx, worker, jarvis.OutcomeData{Status: "failed", Summary: "tool call errored: invalid input", ExitCode: 2})
	}()
	select {
	case err := <-outcome:
		if err != nil {
			t.Fatalf("outcome lost while the tree was removed: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the outcome waited on the tree's removal")
	}
	close(release)
	if err := <-merged; err != nil {
		t.Fatal(err)
	}
	if task := f.dag(t).Tasks[1]; task.Attempts != 1 {
		t.Fatalf("t-1's failure not recorded: attempts %d", task.Attempts)
	}
}
```

If a task run's roster is not read through `RunningPhaseIndex`, read t-1's worker the way `HandleChildOutcome`'s owner lookup (`workerOwnerOf`) maps a worker to a run: the tab whose owner is t-1's run.

- [ ] **Step 4: Run them and see them fail**

Run: `go test ./pkg/orchestrate/ -run 'TestTheTickSkips|TestRemovingOneTree|TestRemovalFinishes|TestAChildOutcomeLands' -count=1`
Expected: FAIL to compile (`undefined: removeTaskTree`, `RetryCleanupDebt`).

- [ ] **Step 5: Implement `removeTaskTree` and the per-task persist** in `pkg/orchestrate/cleanup.go`:

```go
// treeRemovals serializes removals of one tree. The merge path, the tick's debt retry, cancel and retry-cleanup
// can each reach the same tree, and none of them holds the dag lock while it removes.
var treeRemovals = keyedmutex.New()

// removeTaskTree removes one task's tree and records the result. The caller must not hold the dag lock: reaping
// and removing take tens of seconds on Windows, and each worker the reap stops exits into HandleChildOutcome,
// which takes that lock. wait=false skips a tree another caller is removing.
func removeTaskTree(ctx context.Context, dagID, taskID string, wait bool) error {
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		return fmt.Errorf("loading dag: %w", err)
	}
	project, err := cleanupProjectPath(ctx, g)
	if err != nil {
		return err
	}
	tree := worktreeDir(project, LaneWorktreeKey(g, taskID))
	if wait {
		treeRemovals.Lock(tree)
	} else if !treeRemovals.TryLock(tree) {
		return nil
	}
	defer treeRemovals.Unlock(tree)
	// re-read under the tree lock: a removal that finished while this one waited leaves no debt
	if g, err = wstore.GetDag(ctx, dagID); err != nil {
		return fmt.Errorf("loading dag: %w", err)
	}
	task := taskByID(g, taskID)
	if task == nil {
		return fmt.Errorf("no task %q", taskID)
	}
	if !task.CleanupPending && task.CleanupError == "" {
		return nil
	}
	cleanupErr := CleanupTaskWorktree(ctx, g, taskID)
	if err := withDagMutation(dagID, func() error { return persistTaskCleanupLocked(ctx, dagID, task) }); err != nil {
		return errors.Join(cleanupErr, err)
	}
	if cleanupErr != nil {
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskCleanupFailed, nil, map[string]any{"taskid": taskID, "error": cleanupErr.Error()})
		return cleanupErr
	}
	appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskCleanupCompleted, nil, map[string]any{"taskid": taskID})
	if !task.Merged || task.RunID == "" {
		return nil
	}
	child, err := wstore.GetRun(ctx, g.ChannelId, task.RunID)
	if err != nil {
		return fmt.Errorf("loading child run: %w", err)
	}
	return jarvis.SealEvidence(ctx, child)
}

// persistTaskCleanupLocked writes one task's cleanup fields onto the stored dag, leaving every other task's as
// stored. The caller holds the dag lock.
func persistTaskCleanupLocked(ctx context.Context, dagID string, done *waveobj.TaskNode) error {
	if err := wstore.UpdateDag(ctx, dagID, func(cur *waveobj.TaskGroup) error {
		t := taskByID(cur, done.ID)
		if t == nil {
			return fmt.Errorf("no task %q", done.ID)
		}
		t.CleanupPending, t.CleanupError, t.CleanupAttempts = done.CleanupPending, done.CleanupError, done.CleanupAttempts
		RecomputeDagStatus(cur)
		cur.UpdatedTs = time.Now().UnixMilli()
		return nil
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, dagID))
	return nil
}

// RetryCleanupDebt retries every tree still owed a removal, under the retry cap. A stuck tree never blocks
// scheduling, and a tree another caller is removing is skipped, not waited on.
func RetryCleanupDebt(ctx context.Context, dagID string) {
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil || !HasCleanupDebt(g) {
		return
	}
	for _, task := range PendingCleanupTasks(g) {
		if cleanupGivenUp(task) {
			continue
		}
		if err := removeTaskTree(ctx, dagID, task.ID, false); err != nil {
			log.Printf("dag %s task %s: retrying cleanup: %v", dagID, task.ID, err)
		}
	}
}
```

`task` points into `g.Tasks`, so `CleanupTaskWorktree`'s writes are visible through it. Check `RetryPendingCleanup`'s body for any skip condition beyond `cleanupGivenUp` and keep it in `RetryCleanupDebt`. Its deletion, and the startup sweep that still calls it, are Step 7.

- [ ] **Step 6: Move the merge path's removal out of the lock** in `pkg/orchestrate/mergetask.go`:
  - `FinishMergedTask`: end with `return g.Verify, nil` after its two `appendRunEvent` calls; update its doc comment ("stamps a landed merge; the caller removes the tree after releasing the lock").
  - Delete `CleanupMergedTask`.
  - `mergeTaskLocked`, the `if task.Merged` branch: `return "", nil` in both arms (the caller removes the tree).
  - Add a helper beside `mergeTaskEntry`:

```go
// removeLaneTree removes the tree of the lane holding taskID once the dag lock is released: its debt is recorded
// on the lane's tip. The removal outlives the caller's context, as the merge it finishes did.
func removeLaneTree(ctx context.Context, dagID, taskID string) error {
	ctx = context.WithoutCancel(ctx)
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		return fmt.Errorf("loading dag: %w", err)
	}
	tip := laneTip(g, laneOf(g, taskID))
	if tip == nil {
		return nil
	}
	return removeTaskTree(ctx, dagID, tip.ID, true)
}
```

  - `mergeTaskEntry`: after `landAfterMerge(channelID, owner, verify, l)`:

```go
	// after the lock: removal takes tens of seconds, and the workers it stops exit into that lock
	if rerr := removeLaneTree(ctx, owner.DagORef, taskID); err == nil {
		err = rerr
	}
	return err
```

  - `continueBlockedMerge`: the same after its `landAfterMerge`, with `task.ID`.
  - `ContinueMerge`, `case task.Merged:` → `return removeLaneTree(ctx, owner.DagORef, taskID)` (keep the no-debt early return).
  - `mergeBatch`: after the claim is handed off (`startVerify`) or released, remove every merged tip's tree. Restructure its tail so both exits reach the loop:

```go
	if verify == "" || errors.Is(err, ErrMergeConflict) {
		releaseProject(jarvis.LandPath(owner), l)
	} else {
		startVerify(channelID, owner.DagORef, owner.ID, jarvis.LandPath(owner), verify, l)
	}
	// after the claim moves on, so the batch's Verify does not wait on its cleanups
	for _, id := range batch {
		if rerr := removeLaneTree(ctx, owner.DagORef, id); rerr != nil {
			log.Printf("dag %s task %s: removing its tree: %v", owner.DagORef, id, rerr)
		}
	}
	return len(batch), err
```

  The removal error is logged, not returned. It is recorded on the task as cleanup debt, and `AutoMergeReady`'s `switch` reads `err` only for merge outcomes.

- [ ] **Step 7: Move the tick's retry before the lock** in `pkg/orchestrate/engine.go`:
  - `Schedule`: after `AutoMergeReady(ctx, dagID)`, add `RetryCleanupDebt(ctx, dagID)`, with a comment: `// before the lock, like the merge: a removal holds no dag lock, and a tree held open must not stall the tick`.
  - `scheduleLocked`: delete the `if HasCleanupDebt(g) { … RetryPendingCleanup … PersistCleanupState … }` block and its comment.
  - `cmd/server/main-server.go` `retryCleanupDebtAtStartup` (line ~126): replace the loop body's `orchestrate.RetryPendingCleanup(ctx, g)` and `orchestrate.PersistCleanupState(ctx, g)` calls with `orchestrate.RetryCleanupDebt(ctx, g.OID)`, which records its own results. Keep its doc comment's meaning ("through the same idempotent helper the merge path uses"). After this, `git grep -n 'RetryPendingCleanup\|PersistCleanupState' -- pkg cmd` finds no caller outside tests: delete `RetryPendingCleanup`, and `PersistCleanupState` if it is unused too, with the tests that only exercised them (`TestPersistCleanupStateRecomputesDag`, `TestRetryPendingCleanup…`). Port any behavior those tests pinned (the retry cap skip, status recompute) onto `RetryCleanupDebt`/`persistTaskCleanupLocked` tests.

- [ ] **Step 8: `RetryCleanup` and `Cancel`** in `cleanup.go` and `mutation.go`:
  - `RetryCleanup(ctx, dagID, taskID)`: under `withDagMutation`, load the dag, refuse a task with no debt with the existing error, set `CleanupAttempts = 0` and persist it with `persistTaskCleanupLocked`. After the lock is released, `return removeTaskTree(context.WithoutCancel(ctx), dagID, taskID, true)`. Its old event appends are now `removeTaskTree`'s.
  - `Cancel`: split `cancelLocked` so the lock covers the state write, `stopDagVerify`/`stopDagFinal`, the worker stops and the final-tree release, and returns what the removal needs (the dag snapshot, `projectPath`, `landOwner`, and the errors so far). `Cancel` then runs, after `withDagMutation` returns, the loop that was the tail of `cancelLocked`: for each task, `DumpRecoveryPatch` (on `context.WithoutCancel(ctx)`) and then `removeTaskTree(context.WithoutCancel(ctx), dagID, taskID, true)`, then the run/channel `SendWaveObjUpdate`s, and returns `errors.Join` of every error. The 10 s `cleanupCtx` bounds only the worker stops. `PersistCleanupState` is no longer called here.
  - `WithDagMutation`'s doc comment gains: `Work on a tree or a process (a Setup aside) runs outside it, and only its result is recorded under it: a hold of tens of seconds makes every exit it causes wait.`

- [ ] **Step 9: Run the package**

Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/orchestrate/ -count=1`
Expected: PASS, including the new tests and the existing cleanup, cancel (`locked` error), tick-retry (`pending`, `failed`, `clear` publications) and merge tests. Fix any existing test that called `CleanupMergedTask`, `RetryPendingCleanup` or asserted cleanup inside `FinishMergedTask`: it now calls `removeTaskTree`/`RetryCleanupDebt`, or reads the result after `MergeTask`/`Schedule` returns.

- [ ] **Step 10: Run the server package**, which calls `RetryCleanup` and the merge entry points:

Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/wshrpc/wshserver/ -count=1 && go vet ./cmd/server/...`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add cmd/server/main-server.go pkg/orchestrate/cleanup.go pkg/orchestrate/mergetask.go pkg/orchestrate/engine.go pkg/orchestrate/mutation.go pkg/orchestrate/*_test.go
git commit -m "fix(orchestrate): remove a merged tree outside the dag lock"
```

### Task 4: Record findings 48 and 49
**Depends on:** Task 1, Task 2, Task 3

**Files:**
- Modify: `docs/orchestrator-findings-2026-09-25.md`

- [ ] **Step 1: Summary rows.** After row 47 in the Summary table, add:

```
| 48 | A merge Verify fails on an unprepared landing tree: no plan Setup line, so no tree is prepared (c84aa179 t-1) | medium | fixed: a project default Setup in `.arc/setup` |
| 49 | A child's outcome times out behind a merge's cleanup, which holds the dag lock 22-39 s (c84aa179) | medium | fixed: removal outside the lock; outcomes detached from the exit deadline |
```

- [ ] **Step 2: Tag the live-check bullets.** Under "Also seen in this run" in the c84aa179 live check (the section before "## Re-validation: run 33880f82"):
  - the "Verify failed on an unprepared landing tree" bullet: end its bold lead with ` (48)`, and replace `Not checked: whether a Setup line would have prepared the landing tree.` with `A Setup line would have prepared it: \`DagSubmitCommand\` runs the plan's Setup in the landing tree at the first submit.`
  - the "Outcome lookup timed out during cleanup" bullet: end its bold lead with ` (49)`.

- [ ] **Step 3: A Fixes section.** After the "## Fixes: run 33880f82" table, add `## Fixes: run c84aa179` with a `| # | Fix | Test |` table, one row for 48 and one for 49, written like rows 37 to 47: what changed, in the code's names, and the tests that prove it. Read the landed diffs (`git log --oneline -5`, `git show <sha> --stat`) and use the real function and test names. The content:
  - 48: every tree the engine makes is prepared only by Setup, and c84aa179 had none. `ProjectSetup` reads a checked-in `.arc/setup` (one command; more lines are refused), and `DagSubmitCommand` takes it into the plan when the plan names no Setup. So the landing tree runs it at submit, and worker, bisect, base-check and final trees run it from `g.Setup`. A plan's own line wins. This repo's is `node scripts/worktree-junctions.mjs prepare`. Tests: `TestProjectSetupReadsTheCheckedInDefault`, the three new `TestDagSubmitRunsSetupInTheLandingTree` subtests.
  - 49: `FinishMergedTask` reaped the lane's workers and removed the tree under the dag lock (22-39 s). Each reaped worker's exit ran `HandleChildOutcome` on `OnWorkerExit`'s 10 s context, which expired while it waited on that lock, and the channel lookup after it failed on the same context. Removal now runs outside the lock in `removeTaskTree`, one tree at a time under `treeRemovals`, recorded per task by `persistTaskCleanupLocked`. The merge, batch (after Verify starts), continue, tick retry (before the lock, skipping a tree in flight), retry-cleanup and cancel paths all use it. `HandleChildOutcome` runs on `context.WithoutCancel`, and `OnWorkerExit` resolves the channel before the hook. Tests: `TestMergeRemovesTheTreeWithoutHoldingTheDagLock`, `TestAChildOutcomeLandsWhileAMergesTreeIsRemoved`, `TestTheTickSkipsATreeAnotherCallerIsRemoving`, `TestRemovingOneTreeKeepsAnotherTreesRecordedResult`, `TestRemovalFinishesAfterTheMergeCallerCancels`, `TestHandleChildOutcomeOutlivesTheExitDeadline`, `TestOnWorkerExitPostsTheOutcomeWhenTheHookOutlivesTheDeadline`.

- [ ] **Step 4: Check the names.** For every function and test named in the new rows, `git grep -n '<name>' -- pkg` finds it.

- [ ] **Step 5: Commit**

```bash
git add docs/orchestrator-findings-2026-09-25.md
git commit -m "docs(orchestrate): record findings 48 and 49 and their fixes"
```
