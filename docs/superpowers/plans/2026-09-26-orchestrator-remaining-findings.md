# Orchestrator remaining findings Implementation Plan

**Verify:** `node scripts/verify.mjs ./pkg/orchestrate/... ./pkg/wstore/... ./pkg/wshrpc/... ./pkg/agentask/... ./pkg/waveobj/... ./cmd/wsh/...`
**Setup:** `task worktree:prepare`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go vet ./pkg/orchestrate/... ./pkg/wstore/... ./pkg/wshrpc/... ./cmd/wsh/... && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /dev/null ./cmd/wsh/`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement your task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix orchestrator findings 20, 22, 26 and 28 and three test-hygiene defects from `docs/orchestrator-findings-2026-09-25.md`, and record each fix in that doc.

**Architecture:**

- The engine tick (`pkg/orchestrate/engine.go` `scheduleLocked`) stamps each spawn event at its own spawn time.
- The same tick samples each running worker's CPU and latest tool call, and flags a worker that is active but not progressing, by a worktree fingerprint and a scan of its transcript tail. It wakes the lead once per episode.
- The wake composer (`wake.go`) orders a wake: action, then questions, then unverified caveats, then recaps.
- The CLI's `dag status` renders the new digest fields.

**Tech Stack:** Go (wavesrv, wsh), SQLite store (`pkg/wstore`), TypeScript (one timeline label), vitest.

**Spec:** `C:\Users\cktra\Projects\waveterm\.waveterm\worktrees\5952d714-f850-44d0-9f23-1074657a6e19\docs\superpowers\specs\2026-09-26-orchestrator-remaining-findings-design.md`. Read your task's section of it before starting.

## Global Constraints

- Never hand-edit generated files (`frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `pkg/waveobj/metaconsts.go`). After changing a `waveobj` or `wshrpc` type, run `task generate`, and commit what it writes.
- Go tests that touch the store need CGO: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ...` if plain `go test` fails with a sqlite stub error.
- `gofmt -l` only the files you touched; HEAD is not formatter-clean, so never format the tree.
- Comments: lower case, only for "why", matching the surrounding code's density.
- Constants named in the spec, with these exact values:
  - `CPUSampleEvery` = 20 s;
  - `BusyWindow` = 2 × `CPUSampleEvery`;
  - `StagnationThreshold` = 20 min;
  - `ActiveWindow` = 5 min;
  - `RepeatedFailureMin` = 3;
  - `ProgressCheckEvery` = 1 min;
  - `LatestTool` bounded to 80 characters;
  - the transcript tail is 256 KB;
  - the error key hashes the result's last 400 characters.
- Commit messages are `type(scope): description`, with no `Co-Authored-By` or other attribution trailer.
- Finish with your report written to the file the engine names, then `wsh jarvis complete --commit $(git rev-parse HEAD) --report <file>`.

## Review Focus

- A long, legitimate test run with no edits (a 20+ min suite) can cross `StagnationThreshold` while CPU is busy. It must produce at most one wake, and the reason must say what the worker is running, so the lead can tell a slow test from a loop. Task 5 includes the latest tool in the reason and tests the single wake.
- A worktree that git cannot read (deleted, mid-rebase, locked index) must neither flag nor re-arm, and must not fail the tick. Task 5 tests a probe error.
- A transcript tail whose first line is cut, or a single line longer than the tail, must scan to "no finding", not panic or misparse. Task 5 tests both.
- A retried task must start clean: no carried-over `BusyTs`, `LatestTool`, suspect flag or progress seed from the previous attempt. Tasks 4 and 5 test `dag retry` through `MarkRunning`.
- A wake that holds only quiet lines and caveats must still never be sent on its own. Task 2 tests that `PostCaveat` starts no wake.

---

### Task 1: Stamp each task-spawned event at its own spawn time (finding 20)
**Depends on:** none

**Files:**
- Modify: `pkg/wstore/wstore_runevent.go` (`AppendRunEvent`)
- Modify: `pkg/orchestrate/engine.go` (the `appendRunEvent` var near :881; the spawn loop's `task-spawned` closure near :571-575)
- Test: `pkg/orchestrate/engine_test.go`

**Interfaces:**
- Produces: `wstore.AppendRunEventAt(ctx context.Context, ts int64, channelId, runId, kind string, phaseIdx *int, detail any) (waveobj.RunEvent, error)`
- Produces: `var appendRunEventAt func(ctx context.Context, ts int64, channelId, runId, kind string, phaseIdx *int, detail any)` in `pkg/orchestrate`. `appendRunEvent` keeps its signature and delegates to it with `time.Now().UnixMilli()`.

- [ ] **Step 1: Write the failing test** in `engine_test.go`. Build a dag with two independent ready tasks and parallelism 2. Use `seedDispatchDag` in `hardening_test.go` as the model, and read `NewTaskGroup`'s signature for the parallelism argument. Stub `spawnWorker` to sleep 50 ms before returning a fake oref, and record `time.Now().UnixMilli()` after each sleep:

```go
func TestTaskSpawnedCarriesEachTasksOwnSpawnTime(t *testing.T) {
	allowWorkerHarnessForTest(t)
	// two ready tasks, parallelism 2 (mirror seedDispatchDag with a second TaskNode {ID: "t-1", Label: "b"})
	ctx, g, channelID, runID := seedTwoTaskDispatchDag(t, "spawn-stamps")
	var returned []int64
	old := spawnWorker
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		time.Sleep(50 * time.Millisecond)
		returned = append(returned, time.Now().UnixMilli())
		return "block:" + uuid.NewString(), nil
	}
	t.Cleanup(func() { spawnWorker = old })

	if err := ScheduleOnce(ctx, g); err != nil {
		t.Fatal(err)
	}
	var stamps []int64
	for _, ev := range lifecycleEvents(t, channelID, runID) {
		if ev.Kind == waveobj.RunEventKindTaskSpawned {
			stamps = append(stamps, ev.Ts)
		}
	}
	if len(stamps) != 2 || len(returned) != 2 {
		t.Fatalf("want two spawns, got stamps %v returned %v", stamps, returned)
	}
	sort.Slice(stamps, func(i, j int) bool { return stamps[i] < stamps[j] })
	for i := range stamps {
		if stamps[i] != returned[i] {
			t.Fatalf("task-spawned %d stamped %d, want its spawn return %d", i, stamps[i], returned[i])
		}
	}
}
```

  If `lifecycleEvents` returns events newest-first, the sort handles it. Put `seedTwoTaskDispatchDag` beside `seedDispatchDag` in `hardening_test.go`.

- [ ] **Step 2: Run it and see it fail.** `go test ./pkg/orchestrate/ -run TestTaskSpawnedCarriesEachTasksOwnSpawnTime -count=1`. Expected: FAIL, both stamps after the second return.

- [ ] **Step 3: Implement.** In `wstore_runevent.go`:

```go
// AppendRunEvent appends one lifecycle event stamped now. See AppendRunEventAt.
func AppendRunEvent(ctx context.Context, channelId, runId, kind string, phaseIdx *int, detail any) (waveobj.RunEvent, error) {
	return AppendRunEventAt(ctx, time.Now().UnixMilli(), channelId, runId, kind, phaseIdx, detail)
}
```

  Rename the existing body to `AppendRunEventAt`, move the existing doc comment onto it, and use the `ts` argument in place of `time.Now().UnixMilli()`. Add one line to the comment: a caller that records an event after the fact passes the time it happened.

  In `engine.go`, replace the `appendRunEvent` var with:

```go
var appendRunEventAt = func(ctx context.Context, ts int64, channelId, runId, kind string, phaseIdx *int, detail any) {
	if ev, err := wstore.AppendRunEventAt(ctx, ts, channelId, runId, kind, phaseIdx, detail); err != nil {
		log.Printf("appendRunEvent(%s): %v", kind, err)
	} else {
		wps.Broker.Publish(wps.WaveEvent{
			Event:  wps.Event_RunEvent,
			Scopes: []string{waveobj.MakeORef(waveobj.OType_Run, runId).String()},
			Data:   wshrpc.RunEventData{ChannelId: channelId, RunId: runId, Event: ev},
		})
	}
}

var appendRunEvent = func(ctx context.Context, channelId, runId, kind string, phaseIdx *int, detail any) {
	appendRunEventAt(ctx, time.Now().UnixMilli(), channelId, runId, kind, phaseIdx, detail)
}
```

  Keep the existing comment above them. In the spawn loop, right after `spawnMs := time.Since(spawnStart).Milliseconds()`, add `spawnedAt := time.Now().UnixMilli()`. The closure becomes:

```go
		afterCommit = append(afterCommit, func() {
			publishDagEvent(DagEventTaskSpawned, g, spawnedTaskID)
			// the append waits for the whole batch's commit, and a serial batch takes seconds per task
			appendRunEventAt(ctx, spawnedAt, g.ChannelId, g.RunID, waveobj.RunEventKindTaskSpawned, nil, map[string]any{"taskid": spawnedTaskID, "worktreems": worktreeMs, "setupms": setupMs, "spawnms": spawnMs})
		})
```

- [ ] **Step 4: Run the new test and the package.** `go test ./pkg/orchestrate/ ./pkg/wstore/ -count=1`. Expected: PASS. Existing tests that stub `appendRunEvent` still see every other event, because only `task-spawned` bypasses it. If a test asserted `task-spawned` through an `appendRunEvent` stub, move that stub to `appendRunEventAt`.

- [ ] **Step 5: Commit.** `fix(orchestrate): stamp each task-spawned at its own spawn, not batch end`

### Task 2: Wakes lead with the action; caveats before recaps (finding 26)
**Depends on:** none

**Files:**
- Modify: `pkg/orchestrate/wake.go` (`runWake`, `PostQuiet` neighbourhood, `withQuiet`, `flushLocked`, `launchLocked`)
- Modify: `pkg/orchestrate/review.go:231-245` (the pass branch in `advanceReviews`)
- Test: `pkg/orchestrate/wake_test.go`, `pkg/orchestrate/review_test.go`

**Interfaces:**
- Produces: `func PostCaveat(ctx context.Context, channelId, runId, line string)`
- Produces: `func composeWake(lines []string, questions string, caveats, quiet []string) string`, which replaces `withQuiet`.

- [ ] **Step 1: Write the failing tests** in `wake_test.go`, using `newFakeLead`:

```go
func TestWakeLeadsWithTheActionThenCaveatsThenRecaps(t *testing.T) {
	f := newFakeLead(t)
	f.state.State = baseds.AgentState_Working // hold everything until the lead is back at its prompt
	ctx := context.Background()
	PostQuiet(ctx, wakeChannel, wakeRun, "t-1 passed review: recap one")
	PostCaveat(ctx, wakeChannel, wakeRun, "t-2: the CDP screenshot was not taken")
	PostQuiet(ctx, wakeChannel, wakeRun, "t-2 passed review: recap two")
	PostWake(ctx, wakeChannel, wakeRun, "wake: merge conflict in t-3")
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Idle))
	if len(f.sends) != 1 {
		t.Fatalf("want one wake, got %q", f.sends)
	}
	want := strings.Join([]string{
		"wake: merge conflict in t-3",
		"Unverified:",
		"t-2: the CDP screenshot was not taken",
		"Since your last wake:",
		"t-1 passed review: recap one",
		"t-2 passed review: recap two",
	}, "\n")
	if f.sends[0] != want {
		t.Fatalf("wake order:\n%s\nwant:\n%s", f.sends[0], want)
	}
}

func TestWakePutsTheQuestionsLineRightAfterTheAction(t *testing.T) {
	f := newFakeLead(t)
	ctx := context.Background()
	PostQuiet(ctx, wakeChannel, wakeRun, "t-1 passed review: recap")
	seedLeadAsk("block:child", "ask-1", 1)
	PostWake(ctx, wakeChannel, wakeRun, finishedLine)
	lines := strings.Split(f.sends[0], "\n")
	if lines[0] != strings.Split(finishedLine, "\n")[0] || !strings.Contains(f.sends[0], "question") {
		t.Fatalf("action first, then questions: %q", f.sends[0])
	}
	if strings.Index(f.sends[0], "question") > strings.Index(f.sends[0], "Since your last wake:") {
		t.Fatalf("the questions line comes before the recaps: %q", f.sends[0])
	}
}

func TestACaveatAloneStartsNoWake(t *testing.T) {
	f := newFakeLead(t)
	PostCaveat(context.Background(), wakeChannel, wakeRun, "t-1: not verified")
	tickWakes(context.Background())
	if len(f.sends) != 0 {
		t.Fatalf("a caveat rides on the next wake, got %q", f.sends)
	}
}
```

  Also add a launch-order case. Find the existing `launchLocked` test (grep `launchLeadFn` in `wake_test.go`) and copy its setup: a quiet line, a caveat and an action line, then assert the launched text has the same order. Check `questionsLine`'s exact wording (`wake.go:486`) and adjust the `"question"` substring if needed.

- [ ] **Step 2: Run them and see them fail.** `go test ./pkg/orchestrate/ -run 'TestWakeLeads|TestWakePuts|TestACaveat' -count=1`. Expected: FAIL (`PostCaveat` undefined).

- [ ] **Step 3: Implement** in `wake.go`:
  - Add `caveats []string` to `runWake`, commented: what a passed review could not verify; it rides like quiet but reads ahead of the recaps.
  - Add `PostCaveat`, shaped like `PostQuiet` (drop the line if `rw.dead`, else append to `rw.caveats`).
  - Replace `withQuiet` with:

```go
// composeWake orders a wake by what the lead must act on: its own lines, then the questions, then what passed
// unverified, and the recaps last, where a long run of them cannot push the action out of sight.
func composeWake(lines []string, questions string, caveats, quiet []string) string {
	out := append([]string{}, lines...)
	if questions != "" {
		out = append(out, questions)
	}
	if len(caveats) > 0 {
		out = append(append(out, "Unverified:"), caveats...)
	}
	if len(quiet) > 0 {
		out = append(append(out, "Since your last wake:"), quiet...)
	}
	return strings.Join(out, "\n")
}
```

  - In `flushLocked`, the early return gains nothing: caveats never start a wake, just like quiet. Build `questions := ""`, and `if untold { questions = questionsLine(asks) }`. Set `text := composeWake(rw.lines, questions, rw.caveats, rw.quiet)`, and clear `rw.caveats` wherever `rw.quiet` is cleared.
  - `launchLocked` does the same. Its `onlyRunFinished` early return clears `rw.caveats` too.

  In `review.go`'s pass branch:

```go
		line := fmt.Sprintf("%s passed review: %s", taskID, truncateNote(note, handoffMaxSummaryLen))
		*afterCommit = append(*afterCommit, func() {
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskReviewPassed, nil, map[string]any{"taskid": taskID, "note": note, "downstream": downstream, "unverified": unverified})
			// the caveat is what the lead must act on, so it travels whole and apart from the recap's cut
			if unverified != "" {
				PostCaveat(ctx, g.ChannelId, g.RunID, fmt.Sprintf("%s: %s", taskID, flatLine(unverified)))
			}
			PostQuiet(ctx, g.ChannelId, g.RunID, line)
		})
```

  Remove the old combined `passed review. unverified:` format. Grep `passed review. unverified` in `pkg/` and update any test that asserted it: it now expects the caveat under `Unverified:` and the plain recap.

- [ ] **Step 4: Run the package.** `go test ./pkg/orchestrate/ -count=1`. Expected: PASS.

- [ ] **Step 5: Commit.** `fix(orchestrate): lead each wake with its action, recaps last`

### Task 3: Test hygiene and the dag answer timeout
**Depends on:** none

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_ctx_test.go`
- Modify: `pkg/wshrpc/wshserver/maintest_test.go`
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` (the `dagAnswerCmd` RunE, near :600-618; Task 4 edits `taskSignal` near :254 in the same file, a distinct hunk)
- Create: `cmd/wsh/cmd/wshcmd-jarvisdag_answer_test.go`. This is a new file, so Task 4's additions to `wshcmd-jarvisdag_test.go` cannot collide with it.

**Interfaces:**
- Produces: `func dagAnswerTimeoutMs(answers []baseds.AgentAnswerItem) int64` in package `cmd`.

- [ ] **Step 1: Fixed ids.** In `wshserver_ctx_test.go`, replace every literal UUID with values minted per test: `ownerID := uuid.NewString()`, `tabOref := "tab:" + uuid.NewString()`, `blockID := uuid.NewString()`. Use them in `owner.ID`, `WorkerOrefs`, `Block.OID`, `ParentORef`, the `BlockORef` argument and the assertions. In the two-run test, both tab orefs are minted. Run `go test ./pkg/wshrpc/wshserver/ -run JarvisCtx -count=3`. Expected: PASS (before the change it fails with "UNIQUE constraint failed: db_block.oid").

- [ ] **Step 2: Failing vault test.** Add to `maintest_test.go`:

```go
// every run the package creates captures a dossier into the vault; a test must never write the user's
func TestVaultIsTheTestsOwn(t *testing.T) {
	if !strings.HasPrefix(filepath.Clean(memroots.VaultRoot()), filepath.Clean(testVaultDir)) {
		t.Fatalf("vault root %q is outside the test vault %q", memroots.VaultRoot(), testVaultDir)
	}
}
```

  Run `go test ./pkg/wshrpc/wshserver/ -run TestVaultIsTheTestsOwn -count=1`. Expected: FAIL to compile (`testVaultDir` undefined), then FAIL on the path once it is declared.

- [ ] **Step 3: Point the vault at a temp dir** in `TestMain`, before `wstore.InitWStore()`:

```go
	configDir := filepath.Join(dir, "config")
	testVaultDir = filepath.Join(dir, "vault")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		panic(err)
	}
	settings, err := json.Marshal(map[string]any{"memory:vaultpath": testVaultDir})
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "settings.json"), settings, 0o644); err != nil {
		panic(err)
	}
	wavebase.ConfigHome_VarCache = configDir
	// the config is read only when the watcher starts; without it VaultRoot falls back to ~/.waveterm/vault
	wconfig.GetWatcher().Start()
```

  Declare `var testVaultDir string` at file level. Check that the settings key constant is `memory:vaultpath` (grep `MemoryVaultPath` in `pkg/wconfig/settingsconfig.go` for its json tag) and use the constant if one exists. Then grep the other test packages for `CaptureRunDispatch` or `CreateRunCommand` (`grep -rln "CreateRunCommand\|CaptureRunDispatch" pkg --include=*_test.go`). Any package outside `wshserver` that reaches it gets the same setup in its `TestMain`. Run `go test ./pkg/wshrpc/wshserver/ -count=1`. Expected: PASS, and `git -C ~/.waveterm/vault log --oneline | head -1` (if that vault exists) shows no new commit.

- [ ] **Step 4: Failing timeout test** in the new `wshcmd-jarvisdag_answer_test.go`:

```go
func TestDagAnswerTimeoutCoversTheTypedText(t *testing.T) {
	if got := dagAnswerTimeoutMs([]baseds.AgentAnswerItem{{SelectedIndexes: []int{0}}}); got != 10_000 {
		t.Fatalf("a picked option needs no typing time, got %d", got)
	}
	long := strings.Repeat("é", 800) // runes, not bytes, are typed
	if got := dagAnswerTimeoutMs([]baseds.AgentAnswerItem{{Text: long}}); got != 10_000+800*60*2 {
		t.Fatalf("800 typed characters, got %d", got)
	}
}
```

  Run `go test ./cmd/wsh/cmd/ -run TestDagAnswerTimeout -count=1`. Expected: FAIL (undefined).

- [ ] **Step 5: Implement** beside `dagAnswerCmd`:

```go
// dagAnswerBaseTimeoutMs is the answer's budget before any typing.
const dagAnswerBaseTimeoutMs = 10_000

// dagAnswerTimeoutMs covers the server typing a free-text answer one key per character, KeystrokeDelay apart,
// twice over for a loaded machine: a fixed budget expired on long answers that then landed anyway.
func dagAnswerTimeoutMs(answers []baseds.AgentAnswerItem) int64 {
	runes := 0
	for _, a := range answers {
		runes += utf8.RuneCountInString(a.Text)
	}
	return dagAnswerBaseTimeoutMs + int64(runes)*agentask.KeystrokeDelay.Milliseconds()*2
}
```

  In `dagAnswerCmd`, pass `&wshrpc.RpcOpts{Timeout: dagAnswerTimeoutMs(answers)}`. Check the type of `RpcOpts.Timeout` (`pkg/wshrpc`) and convert if it is not `int64`. `wsh` may already import `pkg/agentask`; if the import adds a dependency cycle or pulls in CGO, copy the value into a local const with a comment naming `agentask.KeystrokeDelay`, and test against the literal 60. Run the test and `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /dev/null ./cmd/wsh/`. Expected: PASS, and a clean build.

- [ ] **Step 6: Commit.** `test(wshserver): repeatable ctx tests, a temp vault; scale dag answer's timeout`

### Task 4: Busy vs quiet and the latest tool call in dag status (finding 28)
**Depends on:** Task 1

**Files:**
- Modify: `pkg/waveobj/wtype.go` (`TaskNode`, near :332-347)
- Modify: `pkg/orchestrate/liveness.go` (`childStillWorking` → `sampleWorkerCPU`; a latest-tool seam)
- Modify: `pkg/orchestrate/engine.go` (the liveness loop, :290-370; `autoRetryStalled` :180)
- Modify: `pkg/orchestrate/scheduler.go` (`MarkRunning`)
- Modify: `pkg/orchestrate/digest.go` (`buildTaskDigest` gains `now`)
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` (`DagTaskDigest`)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` (`taskSignal`)
- Generated: `task generate`
- Test: `pkg/orchestrate/liveness_test.go`, `pkg/orchestrate/digest_test.go`, `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`

**Interfaces:**
- Produces, on `TaskNode`: `BusyTs int64 \`json:"busyts,omitempty"\``, `LatestTool string \`json:"latesttool,omitempty"\``
- Produces, on `DagTaskDigest`: `Busy bool \`json:"busy,omitempty"\``, `LatestTool string \`json:"latesttool,omitempty"\``
- Produces, in `pkg/orchestrate`:
  - `var cpuSampleEvery = 20 * time.Second` (a var so tests that tick back to back can zero it);
  - `BusyWindow = 2 * 20 * time.Second` (a const);
  - `MaxLatestToolLen = 80`;
  - `type cpuVerdict int` with `cpuNone, cpuSkipped, cpuBaseline, cpuBusy, cpuIdle`;
  - `func sampleWorkerCPU(ctx context.Context, t *waveobj.TaskNode, run *waveobj.Run, now int64) cpuVerdict`;
  - `var workerLatestTool = func(ctx context.Context, run *waveobj.Run) string`.
- Task 5 consumes `BusyTs`, `LatestTool` and the `cpuSampleEvery` test pattern.

- [ ] **Step 1: Update and add the liveness tests.**
  - Add a helper in `liveness_test.go`:

```go
func noCPUThrottle(t *testing.T) {
	t.Helper()
	prev := cpuSampleEvery
	cpuSampleEvery = 0
	t.Cleanup(func() { cpuSampleEvery = prev })
}
```

  - `seedQuietChild` calls it.
  - Change `TestBusyChildIsNotStalled`'s last assertion. Busy CPU sets `BusyTs >= before` and leaves `LastActivity == quiet`, because `LastActivity` stays transcript-only.
  - Add:

```go
// finding 28: a worker in a long foreground command is seen as busy long before StallThreshold
func TestCPUIsSampledWellInsideTheStallThreshold(t *testing.T) {
	ctx, g, _ := seedFreshChild(t, "fresh-busy") // like seedQuietChild, but lastWrite = now - 2m
	noCPUThrottle(t)
	stubChildCPU(t, func(call int) (int64, bool) { return int64(call) * 5000, true })
	tick(t, ctx, g)
	task := tick(t, ctx, g)
	if task.BusyTs == 0 || task.State != TaskState_Running {
		t.Fatalf("a fresh busy worker gets BusyTs, got %+v", task)
	}
}

func TestCPUSampleIsThrottled(t *testing.T) {
	ctx, g, _ := seedFreshChild(t, "throttled")
	calls := 0
	stubChildCPU(t, func(int) (int64, bool) { calls++; return int64(calls) * 5000, true })
	tick(t, ctx, g)
	tick(t, ctx, g)
	if calls != 1 {
		t.Fatalf("two ticks inside cpuSampleEvery sample once, got %d", calls)
	}
}

func TestLatestToolComesFromTheWorkersStatus(t *testing.T) {
	ctx, g, _ := seedFreshChild(t, "latest-tool")
	prev := workerLatestTool
	workerLatestTool = func(context.Context, *waveobj.Run) string { return "running go test ./pkg/x" }
	t.Cleanup(func() { workerLatestTool = prev })
	if task := tick(t, ctx, g); task.LatestTool != "running go test ./pkg/x" {
		t.Fatalf("LatestTool = %q", task.LatestTool)
	}
}

func TestRetryClearsTheCPUReadings(t *testing.T) {
	g := &waveobj.TaskGroup{Tasks: []waveobj.TaskNode{{ID: "t-0", CPUSample: 9, CPUSampleTs: 9, BusyTs: 9, LatestTool: "x"}}}
	if err := MarkRunning(g, "t-0", "run-2"); err != nil {
		t.Fatal(err)
	}
	n := g.Tasks[0]
	if n.CPUSample != 0 || n.CPUSampleTs != 0 || n.BusyTs != 0 || n.LatestTool != "" {
		t.Fatalf("a new attempt starts with no readings, got %+v", n)
	}
}
```

  - `seedFreshChild` goes beside `seedQuietChild`, sharing its body through a `lastWrite` parameter.
  - Keep `TestIdleChildStillStalls` and `TestNoCPUReadingLeavesTheMtimeRule` as they are: they must still pass.
  - Replace the direct unit test of `childStillWorking` (`TestIdleHarnessCPUTrickleIsNotWork`) with the same table against `sampleWorkerCPU`, asserting `cpuBusy`/`cpuIdle`.

- [ ] **Step 2: Run and see them fail.** `go test ./pkg/orchestrate/ -run 'CPU|Busy|Idle|LatestTool|Retry' -count=1`. Expected: FAIL to compile.

- [ ] **Step 3: Implement the fields and the sampler.**
  - Add the `TaskNode` fields with comments:
    - `BusyTs`: the last CPU sample that showed the worker's tree working. It is kept apart from `LastActivity`, which is the transcript's, so status can tell a long command from silence.
    - `LatestTool`: the worker's in-progress tool call from its status hook, "" between calls.
  - Update the `CPUSample` comment: it is now read on every tick, not only when quiet.
  - In `liveness.go`, replace `childStillWorking` with `sampleWorkerCPU`:

```go
// sampleWorkerCPU reads the worker's process-tree CPU at most once per cpuSampleEvery and says what it showed.
// cpuSkipped means too soon since the last reading; cpuBaseline, a first reading with nothing to compare; cpuNone,
// no worker or no reading. A total that fell counts as busy, because a child that finished and exited lowers the
// tree's sum; a rise counts only above IdleCPUShare, because an idle harness at its prompt still ticks.
func sampleWorkerCPU(ctx context.Context, t *waveobj.TaskNode, run *waveobj.Run, now int64) cpuVerdict {
	if t.CPUSampleTs > 0 && now-t.CPUSampleTs < cpuSampleEvery.Milliseconds() {
		return cpuSkipped
	}
	blockId, alive := workerBlockFn(ctx, run)
	if !alive {
		return cpuNone
	}
	cpu, ok := childCPUTime(blockId)
	if !ok {
		return cpuNone
	}
	prev, prevTs := t.CPUSample, t.CPUSampleTs
	t.CPUSample, t.CPUSampleTs = cpu, now
	if prevTs == 0 {
		return cpuBaseline
	}
	if delta := cpu - prev; delta < 0 || (delta > 0 && float64(delta) >= IdleCPUShare*float64(now-prevTs)) {
		t.BusyTs = now
		return cpuBusy
	}
	return cpuIdle
}
```

  - Keep the old doc comment's reasoning where it still applies.
  - Add the latest-tool seam:

```go
// workerLatestTool is the tool call a worker has in progress, from its latest status: the PreToolUse hook (claude)
// and the status extension (pi) report working with a detail, and PostToolUse reports working without one.
var workerLatestTool = func(ctx context.Context, run *waveobj.Run) string {
	blockId, alive := workerBlockFn(ctx, run)
	if blockId == "" || !alive {
		return ""
	}
	st := latestAgentStatus(blockId, runTabID(run))
	if st.State != baseds.AgentState_Working {
		return ""
	}
	return truncateText(st.Detail, MaxLatestToolLen)
}
```

  Check that `truncateText` in `digest.go` has this shape, and use it.

- [ ] **Step 4: Wire the tick** in `engine.go`'s liveness loop:
  - Right after the `workerControllerGone` check, and before `lastActivityForRun`, so an untracked runtime is sampled too:

```go
		verdict := cpuNone
		if t.State == TaskState_Running || t.State == TaskState_Stalled {
			verdict = sampleWorkerCPU(ctx, t, runs[t.RunID], now)
			t.LatestTool = workerLatestTool(ctx, runs[t.RunID])
		}
```

  - Replace the stall block (:356-360) with:

```go
		// silence is the transcript's and the CPU's together: a busy sample restarts it as a write would. Only a
		// fresh idle sample, or none at all, lets a quiet task stall; a skipped or first reading defers a tick
		quiet := t.LastActivity > 0 && now-max(t.LastActivity, t.BusyTs) > StallThreshold.Milliseconds()
		if t.State == TaskState_Running && (quiet || turnEndedPast(ctx, runs[t.RunID], now)) &&
			(verdict == cpuIdle || verdict == cpuNone) {
			t.State = TaskState_Stalled
		}
```

  - In `MarkRunning` (`scheduler.go`), reset `CPUSample`, `CPUSampleTs`, `BusyTs` and `LatestTool` on the task, and delete the now-redundant reset in `autoRetryStalled` (`engine.go:180`).
  - Grep for any other `childStillWorking` caller (`grep -rn childStillWorking pkg`) and move it to `sampleWorkerCPU` the same way.

  Run `go test ./pkg/orchestrate/ -count=1`. Expected: PASS. A stall test that ticks back to back and expects a CPU-driven outcome needs `noCPUThrottle(t)`; add it where one fails for that reason, and only there.

- [ ] **Step 5: Digest and wire types.**
  - Add to `DagTaskDigest`:
    - `Busy bool \`json:"busy,omitempty"\`` (the worker's tree was using CPU within BusyWindow);
    - `LatestTool string \`json:"latesttool,omitempty"\`` (its in-progress tool call).
  - Change `buildTaskDigest(g, t, askByTask, retried)` to take `now int64`, pass `sn.Now.UnixMilli()` from `BuildDigest`, and set:

```go
	if t.State == TaskState_Running || t.State == TaskState_Stalled {
		td.Busy = t.BusyTs > 0 && now-t.BusyTs <= BusyWindow.Milliseconds()
		td.LatestTool = t.LatestTool
	}
```

  - Add `const BusyWindow = 2 * 20 * time.Second` beside `IdleCPUShare`, commented as two sample intervals, so one skipped sample doesn't flip a busy worker to idle. Update every `buildTaskDigest` caller.
  - Add a `digest_test.go` case: `BusyTs` = now - 30 s gives `Busy`; now - 60 s does not; a done task never does.
  - Run `task generate`, then `go test ./pkg/orchestrate/ -run Digest -count=1`. Expected: PASS.

- [ ] **Step 6: CLI signal.** Add a table test in `wshcmd-jarvisdag_test.go`:

```go
func TestTaskSignalTellsBusyFromIdle(t *testing.T) {
	now := int64(10_000_000)
	quiet := now - 4*60_000
	cases := []struct {
		td   wshrpc.DagTaskDigest
		want string
	}{
		{wshrpc.DagTaskDigest{FreshnessTs: quiet, Busy: true, LatestTool: "running go test ./pkg/x"}, "running a command 4m · running go test ./pkg/x"},
		{wshrpc.DagTaskDigest{FreshnessTs: quiet}, "idle 4m"},
		{wshrpc.DagTaskDigest{FreshnessTs: quiet, LatestTool: "editing a.go"}, "idle 4m · editing a.go"},
	}
	for _, c := range cases {
		if got := taskSignal(orchestrate.TaskState_Running, c.td, now); got != c.want {
			t.Fatalf("taskSignal = %q, want %q", got, c.want)
		}
	}
}
```

  Then change the `FreshnessTs` case in `taskSignal`:

```go
	case td.FreshnessTs > 0 && (state == orchestrate.TaskState_Running || state == orchestrate.TaskState_Stalled):
		return workerSignal(td, now)
```

```go
// workerSignal is how long the worker has been silent, and whether it is running a command meanwhile: a foreground
// test writes no transcript, so silence alone read as "idle" while the worker was busy.
func workerSignal(td wshrpc.DagTaskDigest, now int64) string {
	head := "idle " + compactDur(now-td.FreshnessTs)
	if td.Busy {
		head = "running a command " + compactDur(now-td.FreshnessTs)
	}
	if td.LatestTool != "" {
		head += " · " + compactText(td.LatestTool, 60)
	}
	return head
}
```

  Run `go test ./cmd/wsh/cmd/ -count=1`. Expected: PASS.

- [ ] **Step 7: Commit.** `feat(orchestrate): tell a busy worker from an idle one in dag status`

### Task 5: Flag a worker that is active but not progressing (finding 22)
**Depends on:** Task 4

**Files:**
- Create: `pkg/orchestrate/progress.go` (the worktree fingerprint and the transcript-tail failure scan, pure where possible)
- Create: `pkg/orchestrate/progress_test.go`
- Modify: `pkg/waveobj/wtype.go` (`TaskNode`), `pkg/waveobj/runevent.go` (`RunEventKindTaskSuspect`)
- Modify: `pkg/orchestrate/engine.go` (the liveness loop, after Task 4's sampling), `pkg/orchestrate/scheduler.go` (`MarkRunning`), `pkg/orchestrate/queue.go` (the wake text)
- Modify: `pkg/orchestrate/digest.go`, `pkg/wshrpc/wshrpctypes_dag.go` (`DagTaskDigest.Suspect`), `cmd/wsh/cmd/wshcmd-jarvisdag.go` (`taskSignal`)
- Modify: `frontend/app/view/agents/runtimeline.ts`, `frontend/app/view/orchestrate/timelinefilter.ts` (label, colour and filter group for `task-suspect`)
- Generated: `task generate`
- Test: `progress_test.go`, `engine_test.go` (or a new `suspect_test.go`), `digest_test.go`, `wshcmd-jarvisdag_test.go`, the existing timeline test files

**Interfaces:**
- Consumes: `TaskNode.BusyTs`, `TaskNode.LatestTool`, `cpuSampleEvery` (Task 4); `PostWake` (`wake.go`); `transcriptForRun` (`liveness.go`)
- Produces, in `pkg/orchestrate`:
  - `const StagnationThreshold = 20 * time.Minute`, `ActiveWindow = 5 * time.Minute`, `RepeatedFailureMin = 3`, `transcriptTailBytes = 256 << 10`, `failureKeyTail = 400`;
  - `var progressCheckEvery = time.Minute` (a var for tests);
  - `func worktreeFingerprint(ctx context.Context, dir string) (string, error)`, a var `progressFingerprint` pointing at it for tests;
  - `type repeatedFailure struct{ Command string; Count int }`;
  - `func scanRepeatedFailure(lines []string) repeatedFailure`, which is zero when none reaches `RepeatedFailureMin`;
  - `func readTranscriptTail(path string, n int64) []string`;
  - `func suspectReason(unchangedMs int64, stagnant bool, rf repeatedFailure, latestTool string) string`;
  - `func taskSuspectWake(taskID, reason string) string` in `queue.go`.
- Produces, on `TaskNode`: `ProgressHash string`, `ProgressTs int64`, `ProgressCheckTs int64`, `SuspectTs int64`, `SuspectReason string` (json tags lower-case, `omitempty`).
- Produces, on `DagTaskDigest`: `Suspect string \`json:"suspect,omitempty"\``.

- [ ] **Step 1: Failing tests for the fingerprint** in `progress_test.go`. Use a temp git repo: `git init`, a committed file, and a `.gitignore` holding `out/`.

```go
func TestFingerprintSeesCommitsEditsAndNewFiles(t *testing.T) {
	dir := initRepoWithIgnore(t) // commits a.txt and .gitignore ("out/")
	ctx := context.Background()
	fp := func() string {
		s, err := worktreeFingerprint(ctx, dir)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	base := fp()
	writeFile(t, dir, "a.txt", "one")
	edited := fp()
	if edited == base {
		t.Fatal("an edit is progress")
	}
	writeFile(t, dir, "a.txt", "one two") // already modified: status text alone would not change
	if fp() == edited {
		t.Fatal("a further edit to a modified file is progress")
	}
	before := fp()
	writeFile(t, dir, "out/log.txt", "artifact")
	if fp() != before {
		t.Fatal("an ignored file is not progress")
	}
	writeFile(t, dir, "new.txt", "x")
	withNew := fp()
	if withNew == before {
		t.Fatal("a new untracked file is progress")
	}
	gitRun(t, dir, "add", "-A")
	gitRun(t, dir, "commit", "-qm", "c")
	if fp() == withNew {
		t.Fatal("a commit is progress")
	}
}

func TestFingerprintErrorsOutsideARepo(t *testing.T) {
	if _, err := worktreeFingerprint(context.Background(), filepath.Join(t.TempDir(), "gone")); err == nil {
		t.Fatal("an unreadable tree is an error, not a fingerprint")
	}
}
```

  For `initRepoWithIgnore`, `writeFile` and `gitRun`, grep `pkg/orchestrate/*_test.go` for an existing temp-repo helper (e.g. `initRepo`), reuse it, and add the ignore file. An edit within the same second may keep the size and mtime; `writeFile` writes a different length each time, as above, so size changes.

- [ ] **Step 2: Failing tests for the scan.**

```go
func claudeCall(id, cmd string) string {
	return fmt.Sprintf(`{"type":"assistant","message":{"content":[{"type":"tool_use","id":%q,"name":"Bash","input":{"command":%q}}]}}`, id, cmd)
}
func claudeResult(id, out string, isErr bool) string {
	return fmt.Sprintf(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":%q,"is_error":%t,"content":%q}]}}`, id, isErr, out)
}
func piCall(id, cmd string) string {
	return fmt.Sprintf(`{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":%q,"name":"bash","arguments":{"command":%q}}]}}`, id, cmd)
}
func piResult(id, out string, isErr bool) string {
	return fmt.Sprintf(`{"type":"message","message":{"role":"toolResult","toolCallId":%q,"toolName":"bash","isError":%t,"content":[{"type":"text","text":%q}]}}`, id, isErr, out)
}

func TestScanFindsTheSameFailureRepeated(t *testing.T) {
	var lines []string
	for i := 0; i < 4; i++ {
		id := fmt.Sprint("c", i)
		lines = append(lines, claudeCall(id, "go test ./pkg/x"), claudeResult(id, "--- FAIL: TestX\n want 2 got 3", true))
	}
	if rf := scanRepeatedFailure(lines); rf.Count != 4 || rf.Command != "go test ./pkg/x" {
		t.Fatalf("got %+v", rf)
	}
}

func TestScanReadsPiToo(t *testing.T) {
	var lines []string
	for i := 0; i < 3; i++ {
		id := fmt.Sprint("p", i)
		lines = append(lines, piCall(id, "npm test"), piResult(id, "1 failed", true))
	}
	if rf := scanRepeatedFailure(lines); rf.Count != 3 {
		t.Fatalf("got %+v", rf)
	}
}

func TestScanIgnoresProgressingFailuresAndSuccesses(t *testing.T) {
	var lines []string
	for i := 0; i < 4; i++ {
		id := fmt.Sprint("c", i)
		// red-green work: the same test, a different failure each run
		lines = append(lines, claudeCall(id, "go test ./pkg/x"), claudeResult(id, fmt.Sprintf("want %d got 0", i), true))
		ok := fmt.Sprint("ok", i)
		lines = append(lines, claudeCall(ok, "git status"), claudeResult(ok, "clean", false))
	}
	if rf := scanRepeatedFailure(lines); rf.Count != 0 {
		t.Fatalf("a changing failure is not a loop, got %+v", rf)
	}
}

func TestScanSurvivesACutOrGarbledTail(t *testing.T) {
	if rf := scanRepeatedFailure([]string{`{"type":"assistant","mess`, "not json", ""}); rf.Count != 0 {
		t.Fatalf("got %+v", rf)
	}
	path := filepath.Join(t.TempDir(), "s.jsonl")
	huge := strings.Repeat("x", 300<<10)
	if err := os.WriteFile(path, []byte(huge+"\n"+claudeCall("a", "ls")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	lines := readTranscriptTail(path, transcriptTailBytes)
	if len(lines) != 1 || !strings.Contains(lines[0], `"ls"`) {
		t.Fatalf("the cut first line is dropped, got %d lines", len(lines))
	}
	if readTranscriptTail(filepath.Join(t.TempDir(), "missing"), transcriptTailBytes) != nil {
		t.Fatal("a missing transcript reads as nothing")
	}
}
```

  Check the pi line shape against a real session file (`~/.pi/agent/sessions/*/*.jsonl`: `"role":"toolResult","toolCallId":…,"isError":…`, and `"type":"toolCall","id":…,"arguments":{"command":…}`) and fix the fixtures if the envelope differs.

- [ ] **Step 3: Run and see them fail.** `go test ./pkg/orchestrate/ -run 'Fingerprint|Scan' -count=1`. Expected: FAIL (undefined).

- [ ] **Step 4: Implement `progress.go`.**
  - `worktreeFingerprint` runs `git -C dir status --porcelain=v2 -z --branch --untracked-files=all` through the package's existing git exec helper (grep `exec.CommandContext(ctx, "git"` in `pkg/orchestrate` and reuse whichever wraps it). It hashes the output with sha256, then, for every entry's path, `os.Lstat` size and mtime (a missing path hashes as "gone"). Return hex. Porcelain v2 `-z` records:
    - `1 <xy> … <path>` (ordinary changed);
    - `2 … <path>\0<origPath>` (renamed/copied: the next NUL field is the orig path, skip it);
    - `u …` (unmerged, path last);
    - `? <path>` (untracked);
    - `# branch.oid <sha>` (kept in the hashed output).
  - Take the path as the text after the last field separator for types 1, 2 and u (split with `strings.SplitN` on the fixed field count: 9 for `1`, 10 for `2`, 11 for `u`), and after `? ` for untracked.
  - `readTranscriptTail` opens the file, seeks to `max(0, size-n)`, reads the rest, splits on `\n`, drops the first element when the read started mid-file, and drops empty lines. Any error returns nil. Mirror `tailLines` in `cmd/wsh/cmd/wshcmd-agenthook.go`.
  - `scanRepeatedFailure` walks the lines once:
    - It records each tool call's `id → command` (claude `tool_use` with `input.command`, pi `toolCall` with `arguments.command`; the tool name when there is no command).
    - For each failed result (claude `tool_result` with `is_error`, pi `role: toolResult` with `isError`), it keys `command + "\x00" + sha256(last failureKeyTail chars of the result text)`.
    - Result content may be a string or an array of `{type:"text",text}` blocks; join the texts.
    - It returns the largest group, with `Command` cut to 80 characters, when its count is ≥ `RepeatedFailureMin`, else the zero value.
  - `suspectReason` joins the parts that fired with "; ":
    - "worktree unchanged <compact minutes>m while active";
    - "`<command>` failed the same way <n>x";
    - and, when `latestTool` is set, "now: <latestTool>".

  Run the Step 1–2 tests. Expected: PASS.

- [ ] **Step 5: Failing engine tests** (new file `pkg/orchestrate/suspect_test.go`). Seed a running task the way `seedQuietChild` does (a tracked session with a recent write), then stub:
  - `progressFingerprint` to return a fixed string;
  - `progressCheckEvery = 0`;
  - `cpuSampleEvery = 0` and `stubChildCPU` rising (busy).

  Set the task's `ProgressTs` to now - 21 min through `wstore.UpdateDag`. Capture wakes with `newFakeLead(t)` (its `sends`, and its `rows` for `task-suspect`). Cases:
  - Stagnant and active: one tick sets `SuspectTs`, `SuspectReason` contains "worktree unchanged 21m" and "now: " when `workerLatestTool` is stubbed. There is one `task-suspect` row and one wake sent, starting "wake: task t-0 may be stuck". A second tick sends no new wake.
  - Re-arm: the fingerprint stub returns a new value; the tick clears `SuspectTs` and resets `ProgressTs` to now; no wake.
  - Quiet (CPU flat, `LastActivity` older than `ActiveWindow`): no flag.
  - A pending ask on the worker's block (`agentask.GlobalRegistry.Set(block oref, …)`): no flag.
  - A probe error (the stub returns an error): no flag, `ProgressHash` unchanged, no tick failure.
  - Repeated failure: write a claude transcript with 3 identical failures into the stubbed sessions root (`writeClaudeSession` or the pi equivalent the liveness tests use), with the fingerprint fresh (`ProgressTs` = now): flagged, with the reason naming the command.
  - A retry (`MarkRunning`) zeroes all five progress fields and seeds `ProgressTs`.

  Run `go test ./pkg/orchestrate/ -run Suspect -count=1`. Expected: FAIL.

- [ ] **Step 6: Implement the tick.**
  - Add the `TaskNode` fields, with comments that say why.
  - `MarkRunning` zeroes them and sets `ProgressTs = time.Now().UnixMilli()`.
  - Add `RunEventKindTaskSuspect = "task-suspect"` beside `RunEventKindTaskStalled`, and grep `task-lead-told` across `pkg/` and `frontend/` for any list of kinds it must also join.
  - In `engine.go`'s liveness loop, after Task 4's sampling and the stall rule, for `t.State == TaskState_Running`:

```go
		if reason, flagged := checkProgress(ctx, t, runs[t.RunID], now); flagged {
			taskID, detail := t.ID, suspectDetail(t, now)
			afterCommit = append(afterCommit, func() {
				appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskSuspect, nil, detail)
				PostWake(ctx, g.ChannelId, g.RunID, taskSuspectWake(taskID, reason))
			})
		}
```

  `checkProgress` lives in `progress.go`:
  - Return false when `now - t.ProgressCheckTs < progressCheckEvery`, when the run has no worktree (`run.ProjectPath == ""`), or when the worker's block has a pending ask (`agentask.GlobalRegistry.Get(block oref)`, as `hungWake` does).
  - Set `ProgressCheckTs = now`.
  - Fingerprint the tree. On error, `log.Printf` with the dag/task and return false without touching the other fields.
  - If the hash differs from `ProgressHash`, store it, set `ProgressTs = now`, clear `SuspectTs`/`SuspectReason`, and return false.
  - `active := now - max(t.LastActivity, t.BusyTs) <= ActiveWindow`;
    `stagnant := active && now - t.ProgressTs >= StagnationThreshold`.
  - `rf := scanRepeatedFailure(readTranscriptTail(path, transcriptTailBytes))`, with the path from `transcriptForRun`, skipped when untracked.
  - If `(stagnant || rf.Count > 0) && t.SuspectTs == 0`: set `SuspectTs = now`, set `SuspectReason = suspectReason(now-t.ProgressTs, stagnant, rf, t.LatestTool)`, and return the reason and true.

  `suspectDetail` returns `map[string]any{"taskid", "unchangedms", "command", "count"}`. In `queue.go`:

```go
// taskSuspectWake hands the lead a worker that is busy but not getting anywhere; the engine does not act on it,
// because only the lead can tell a stuck worker from a hard task.
func taskSuspectWake(taskID, reason string) string {
	return fmt.Sprintf("wake: task %s may be stuck: %s. Tell it (`wsh jarvis dag tell %s \"…\"`), retry, escalate, or let it run. wsh jarvis dag status", taskID, reason, taskID)
}
```

  Run `go test ./pkg/orchestrate/ -count=1`. Expected: PASS.

- [ ] **Step 7: Digest, CLI, timeline.**
  - Add `Suspect string \`json:"suspect,omitempty"\`` to `DagTaskDigest`. `buildTaskDigest` sets it from `t.SuspectReason` when `t.SuspectTs > 0` and the task is running.
  - `task generate`.
  - In `taskSignal`, add a case after the ask and Verify cases:

```go
	case td.Suspect != "":
		return "stuck? " + compactText(td.Suspect, 80)
```

    with a test row: `{Suspect: "worktree unchanged 22m while active"}` gives `"stuck? worktree unchanged 22m while active"`.
  - Add a `digest_test.go` case: `Suspect` is set only while flagged.
  - In `runtimeline.ts`, add `"task-suspect"` to the kind list, the label `"Task may be stuck"`, and a warning-tone class. Pick whatever class the file uses for `task-stalled`: colours come from theme tokens, never raw hex.
  - In `timelinefilter.ts`, map `"task-suspect": "worker"`.
  - Extend the existing tests beside those files (`npx vitest run frontend/app/view/agents/runtimeline frontend/app/view/orchestrate/timelinefilter`), following their pattern for `task-stalled`.

  Run `go test ./pkg/orchestrate/ ./cmd/wsh/cmd/ -count=1` and the vitest command. Expected: PASS.

- [ ] **Step 8: Commit.** `feat(orchestrate): flag a worker that is active but not progressing`

### Task 6: Record the fixes in the findings doc and the guide
**Depends on:** Task 1, Task 2, Task 3, Task 4, Task 5

**Files:**
- Modify: `docs/orchestrator-findings-2026-09-25.md` (append a section after "Fixes after the handoff")
- Modify: `docs/orchestrator-guide.md` (the wake table near :427; the `dag status` signal text)

- [ ] **Step 1: Read what landed.** Run `git log --oneline -8` and read each task's commit, so every row names the real function and test names, not this plan's guesses.

- [ ] **Step 2: Append the fix section**, in the same form as "Fixes after the handoff":

```markdown
## Fixes: 20, 22, 26, 28 and test hygiene

| # | Fix | Test |
|---|---|---|
| 20 | <what Task 1 changed, naming AppendRunEventAt and the spawn stamp> | `TestTaskSpawnedCarriesEachTasksOwnSpawnTime` |
| 28 | <sampling every tick, BusyTs/LatestTool, the dag status wording> | <Task 4's test names> |
| 26 | <composeWake order, PostCaveat> | <Task 2's test names> |
| 22 | <fingerprint + repeated-failure scan, one wake per episode, task-suspect, `stuck?`> | <Task 5's test names> |
| test hygiene | <ctx tests' fresh ids; TestMain's temp vault> | `TestVaultIsTheTestsOwn`, `-count=3` |
| dag answer | <the timeout that scales with typed length, and why: 60 ms per typed character> | `TestDagAnswerTimeoutCoversTheTypedText` |
```

  Fill each `<…>` with one or two sentences in the doc's plain style, from the commits. Then add a paragraph, "Not verified live":
  - none of this has run in an orchestrator run yet;
  - the next run after an Arc rebuild should show staggered `task-spawned` stamps, "running a command" in `dag status` during a long test, and no false `stuck?`;
  - the 22 thresholds (20 min, 3x, 5 min active) are unmeasured, set from 9 healthy transcripts on one machine, none of which looped.

  Leave the Summary table as it is; the earlier fix sections don't edit it.

- [ ] **Step 3: Guide.**
  - In `docs/orchestrator-guide.md`'s wake table, add after the "Worker hung" row: `| **Worker may be stuck** (worktree unchanged 20 min while active, or the same failure 3x) | \`dag tell\`, \`dag retry\`, \`dag escalate\`, or lets it run | same |`.
  - Where the guide describes `dag status` task signals (grep `idle` in that file), say that a busy worker reads "running a command Nm · <tool>" and a flagged one "stuck? <reason>". If no such passage exists, add one sentence under the wake table.

- [ ] **Step 4: Commit.** `docs(orchestrator): record fixes for findings 20, 22, 26, 28 and test hygiene`
