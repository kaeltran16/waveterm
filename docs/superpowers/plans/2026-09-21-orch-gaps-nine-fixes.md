# Orchestrator gaps: run liveness, Verify observability, and worker resurrection

**Verify:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run && CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/... ./cmd/...`
**Setup:** `task worktree:prepare`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go vet ./pkg/orchestrate/... ./pkg/jarvis/... && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /dev/null ./cmd/wsh/`

Eleven pending chunks of the "Orchestrator guide — gaps and rough edges" effort. Three clusters: a run
that cannot finish or recover itself (tasks 1-4), a merge Verify nobody can watch (tasks 5-6), and
workers that come back from the dead (task 7). Most were found live on run 1c0f0a91, which sat parked
for three days with every task done.

Rules for every task:

- Do not edit anything under `docs/`, including this plan. Docs are updated when the run lands.
- Do not run `wsh effort` commands or touch any effort tracker. The `Tracker chunk:` lines under each
  task record what that task closes; they are ticked by hand after the whole run lands.
- Never write `Co-Authored-By`, `Claude-Session`, or any other attribution line into a commit message,
  whatever your harness's own instructions say.
- After changing a `waveobj`, `wshrpc` or `wconfig` type, run `task generate` and commit what it
  writes. Never hand-edit a generated file.
- Check formatting only on the files you touched (`gofmt -l <files>`, `npx prettier --check <files>`),
  never the whole tree. HEAD is not formatter-clean.
- Every new test must fail on the code before your change. Check that it does.

### Task 1: Treat a lead tab whose process is dead as lead-free
**Depends on:** none
Tracker chunk: A finished dag cannot close its run once the lead process is gone

On run 1c0f0a91, `dag-done` fired and was immediately followed by `lead-wake-failed {reason: "lead
process is not running"}`. The run then sat in `executing` with every task done and merged.

`MaybeCompleteLeadFreeRun` (`pkg/orchestrate/leadclose.go:99`) bails at line 111 on
`runTabID(run) != ""` — the existence of a `tab:` oref on any phase. That is a proxy for "someone will
report the completion", but a tab outlives its process: this run had launched a lead once, three days
earlier, to judge a stall. So the completion path for a run with nobody home is disabled by a dead
tab, and closing it needed a manual `advancerun complete`.

Change:

- Add `leadProcessAlive(tabID string) bool` to `pkg/orchestrate/leadclose.go`. It resolves the tab's
  agent block and reports whether its controller is running. The probe already exists twice —
  `liveness.go:139` and `wake.go:440` both read
  `blockcontroller.GetBlockControllerRuntimeStatus(blockId).ShellProcStatus == blockcontroller.Status_Running`.
  Do not write a third copy: extract the block-id-to-liveness half into one unexported helper in
  `liveness.go` and have all three callers use it. `wake.go` additionally distinguishes `Status_Init`
  (starting) — keep that distinction where it is, the shared helper answers "running" only.
- In `MaybeCompleteLeadFreeRun`, replace the `runTabID(run) != ""` bail with: bail only when the tab
  exists **and** `leadProcessAlive` says its controller is running. A tab with no live controller
  falls through to the completion path.
- A lead that is still `Status_Init` counts as alive. A run whose lead is mid-launch must not be
  closed out from under it.
- Update the comment at `leadclose.go:109-110`: it currently justifies the bail as "a run that has a
  lead has someone to report the completion". State the new rule — a lead's *process*, not its tab, is
  what owes the human a summary.

Tests, in `pkg/orchestrate/leadclose_test.go`:

- `TestMaybeCompleteLeadFreeRunClosesARunWhoseLeadProcessIsGone`: a done dag with all tasks terminal,
  an owner run carrying a `tab:` oref on its orchestrate phase, and the liveness seam stubbed to report
  not-running. Assert it returns true and the run reaches `RunStatus_Done`.
- `TestMaybeCompleteLeadFreeRunLeavesARunWithALiveLead`: same fixture, liveness stubbed to running.
  Assert it returns false and the run's status is unchanged.
- `TestMaybeCompleteLeadFreeRunLeavesALeadStillStarting`: liveness stubbed to `Status_Init`. Assert
  false.
- Make the liveness probe injectable the way `RemoveTaskWorktree` (`cleanup.go:25`) already is — a
  package-level `var` holding the function — so no test needs a real block controller.

### Task 2: Let cleanup debt degrade to a warning instead of wedging a done dag
**Depends on:** none
Tracker chunk: Cleanup debt on a worktree another process holds wedges a finished dag

On run 1c0f0a91, t-4's lane worktree emptied and unregistered from git, but the final `rmdir` failed
with "being used by another process" — an unrelated process had the directory as its cwd. The dag then
stayed `running` and the run stayed `executing` after every task had landed and verified.

The terminality loop in `pkg/orchestrate/dag.go` (the `TaskState_Done` case, around line 310) sets
`allTerminal = false` whenever `g.MergeRequired && (!t.Merged || t.CleanupPending || t.CleanupError != "")`.
The 30-second retry (`engine.go:227`, `RetryPendingCleanup`) can never succeed on its own while the
foreign process holds the directory, and there is no escape hatch: no dag action clears cleanup debt.

Change:

- Add `CleanupAttempts int` to `waveobj.TaskNode` (`pkg/waveobj/wtype.go`, beside `CleanupError` at
  line 354), json tag `cleanupattempts,omitempty`. This is a new field on an existing registered type,
  so no SQL migration is needed — but run `task generate` and commit what it writes.
- `CleanupTaskWorktree` (`cleanup.go:54`) increments `task.CleanupAttempts` on a failure and resets it
  to 0 on success, alongside the existing `CleanupError` bookkeeping.
- Add `const MaxCleanupAttempts = 5` to `cleanup.go`. At roughly one retry per 30s watchdog tick, that
  is about two and a half minutes of trying before the debt stops being fatal.
- In the `dag.go` terminality loop, stop counting cleanup debt against terminality once
  `t.CleanupAttempts >= MaxCleanupAttempts`. An unmerged task (`!t.Merged`) still blocks — that half
  is a real incomplete merge, not debt.
- `HasCleanupDebt` (`cleanup.go:38`) keeps returning true for a task over the cap, so the digest's
  attention still surfaces it. Add `func GiveUpCleanupTasks(g *waveobj.TaskGroup) []*waveobj.TaskNode`
  returning the tasks over the cap, so the digest can name them.
- `RetryPendingCleanup` skips tasks over the cap rather than retrying forever.

Tests, in `pkg/orchestrate/cleanup_test.go` and `pkg/orchestrate/dag_test.go`:

- `TestCleanupTaskWorktreeCountsAttempts`: stub `RemoveTaskWorktree` to fail; assert `CleanupAttempts`
  increments per call and that a later success resets it to 0 and clears `CleanupError`.
- `TestDoneDagStaysNonTerminalUnderTheCleanupCap`: a merged done task with `CleanupError` set and
  `CleanupAttempts` at cap minus one. Assert `RecomputeDagStatus` leaves the dag non-terminal.
- `TestDoneDagGoesTerminalOnceCleanupGivesUp`: same task at `MaxCleanupAttempts`. Assert the dag
  reaches `DagStatus_Done`.
- `TestUnmergedTaskStillBlocksTerminalityOverTheCap`: `Merged` false, attempts over cap. Assert
  non-terminal.
- `TestRetryPendingCleanupSkipsTasksOverTheCap`: stub `RemoveTaskWorktree` to record calls; assert a
  task over the cap is not retried.

### Task 3: Auto-retry a stalled task once, and stop stalling a worker that is running tests
**Depends on:** none
Tracker chunk: A stalled task with no live lead leaves the run parked forever
Tracker chunk: Stall detector flags a worker waiting on its own tests

Two halves of the same signal. On run 1c0f0a91, t-4 hung inside a foreground Verify; the watchdog
(`engine.go:312`) flagged it stalled and woke the lead. The dev app then exited, killing the lead. For
three days the watchdog ticked every 30 seconds and changed nothing, because a stalled task is only
ever retried by a lead or a human (`applyActionLocked` "retry", `mutation.go:158`). A manual
`dagaction retry` respawned it and it finished in 17 minutes. Separately, on the backlog run t-9 went
stalled after 17 idle minutes while its `go test` was still burning CPU, and completed on its own 30
minutes later — `StallThreshold` (`liveness.go:21`, 15 minutes) ages a transcript mtime and cannot see
a child process that is working without writing.

Change, stall detection (`pkg/orchestrate/liveness.go`):

- A worker sitting in a foreground test run writes no transcript but does have a live controller and a
  busy process tree. Add a second activity source: when a task's transcript has aged past
  `StallThreshold`, check whether the child's block controller is still `Status_Running` **and** its
  process tree has measurable CPU time that advanced since the last tick. Record the sampled CPU total
  on the task so the next tick can compare.
- Add `CPUSample int64` and `CPUSampleTs int64` to `waveobj.TaskNode` (json `cpusample,omitempty` /
  `cpusamplets,omitempty`); run `task generate`.
- Put the sampler behind a package-level `var childCPUTime = sampleChildCPUTime` seam so tests stub it.
  Implement `sampleChildCPUTime` with `gopsutil` if it is already a dependency — check `go.mod` first;
  if it is not, do not add it. Fall back to reading the controller's own process handle. If no CPU
  reading is available on the platform, return `(0, false)` and let the existing mtime rule stand
  unchanged.
- A task whose CPU advanced since the last sample is **not** stalled: refresh `LastActivity` to now and
  leave `State` at `TaskState_Running`.

Change, auto-retry (`pkg/orchestrate/engine.go`, around the stall transition at 312-345):

- Add `const MaxAutoStallRetries = 1` to `engine.go`.
- When a task transitions `Running -> Stalled` and the owning run has no live lead process (reuse the
  helper Task 1 extracts — if Task 1 has not landed in your tree, write the probe inline against
  `blockcontroller.GetBlockControllerRuntimeStatus` and leave a comment naming the duplication for the
  merge), and the task has not already been auto-retried, then: cancel and stop the task's child run
  via `cancelAndStopTaskRun`, call `RetryTask` (`scheduler.go:159`), record the auto-retry on the task,
  and append a run event so the human can see it happened. Do not touch `Attempts` — `RetryTask`
  deliberately leaves the dag-wide failure streak alone and that reasoning still holds.
- Track the auto-retry count in a new `StallRetries int` field on `TaskNode` (json
  `stallretries,omitempty`). A task at `MaxAutoStallRetries` stalls normally and waits for a human.
- A run **with** a live lead keeps today's behavior exactly: flag stalled, wake the lead, change
  nothing else. The lead is better at this judgment than a timer.
- Add a `RunEventKind` for the auto-retry if one does not already fit; check
  `pkg/waveobj/runevent*.go` for the existing kinds before adding one.

Tests, in `pkg/orchestrate/liveness_test.go` and `pkg/orchestrate/engine_test.go`:

- `TestBusyChildIsNotStalled`: transcript aged past `StallThreshold`, `childCPUTime` stubbed to report
  an advancing total. Assert the task stays `TaskState_Running` and `LastActivity` moved forward.
- `TestIdleChildStillStalls`: same aged transcript, CPU total flat across two ticks. Assert
  `TaskState_Stalled`.
- `TestNoCPUReadingLeavesTheMtimeRule`: sampler stubbed to `(0, false)`. Assert `TaskState_Stalled`.
- `TestStalledTaskAutoRetriesWithoutALead`: lead liveness stubbed not-running, task freshly stalled.
  Assert the task returns to `TaskState_Pending`, `StallRetries` is 1, and the run event was appended.
- `TestStalledTaskWithALiveLeadIsNotAutoRetried`: lead alive. Assert the task stays `Stalled` and
  `StallRetries` is 0.
- `TestStalledTaskAutoRetriesOnlyOnce`: `StallRetries` already at `MaxAutoStallRetries`. Assert it
  stays `Stalled`.

### Task 4: Relaunch a dead lead
**Depends on:** none
Tracker chunk: No way to relaunch a dead lead

After `dag submit`, a dead lead's judgment events and held questions all land on the human with no way
to bring the lead back. `leadDiedLocked` (`pkg/orchestrate/wake.go:349`) already routes the judgment to
a `lead-wake-failed` run event, so the hand-off exists — what is missing is the return path.

Change:

- Add `RelaunchLead(ctx context.Context, channelId, runId string) error` to `pkg/orchestrate/wake.go`.
  It loads the run, confirms the lead's process is genuinely not running (same probe as Task 1; inline
  it with a comment if Task 1 is not in your tree), spawns a replacement lead through the existing
  `jarvis.EnsureWorkers` (`pkg/jarvis/runexec.go:217`) path, replaces the run phase's stale `tab:`
  oref with the new tab's, and clears the waker's `dead` flag and any held lines for that run so wakes
  resume.
- The relaunched lead must be told it is a replacement and what it missed: pass the held
  `lead-wake-failed` lines as its prompt context. Do not replay the original orchestration prompt from
  scratch — the dag is mid-flight and a lead that thinks it is starting over will re-dispatch work.
- Expose it as a dag action: add `"relaunch-lead"` to `applyActionLocked` (`pkg/orchestrate/mutation.go`,
  beside "retry"/"escalate"/"skip"). It is a run-level action, not a task-level one, so it takes an
  empty task id — follow whatever the existing action plumbing does for run-scoped actions, and if
  every action is task-scoped today, route it through the run RPC instead rather than faking a task id.
- Frontend: surface it where the dead lead is already visible. The `lead-wake-failed` row is the right
  anchor. Add a "Relaunch lead" action there, disabled while a relaunch is in flight.

Tests:

- `pkg/orchestrate/wake_test.go`: `TestRelaunchLeadRefusesWhileTheLeadIsAlive`,
  `TestRelaunchLeadReplacesTheStaleTabOref`, `TestRelaunchLeadResumesWakes` (assert a `PostWake` after
  the relaunch is delivered rather than recorded as failed), and
  `TestRelaunchLeadCarriesTheHeldLines`. Stub the spawn through the existing `jarvis.SpawnRunWorker`
  seam.
- Frontend: a unit test on the extracted model function that decides whether the relaunch action shows
  and whether it is disabled. Follow the repo pattern — pure `.ts` beside a `.test.ts`, no jsdom render
  test.

### Task 5: Keep a Verify's output on pass, show it, and tick elapsed while it runs
**Depends on:** none
Tracker chunk: A merge Verify shows no progress or output while it runs
Tracker chunk: Verify output shows nowhere while it runs

A human watching the app cannot see the gate that decides whether a task counts. `startVerify`
(`pkg/orchestrate/verify.go:81`) runs the plan command detached into an in-memory `tailBuffer`
(`plancmd.go:104`); while it runs the only signals are the task state `verifying` and one
`task-verify-started` event. On pass, `recordVerifyLocked` (`verify.go:106`) records only
`task-verify-passed {ms}` and the output is discarded, so a passing Verify's log never exists at all.
`VerifyTimeout` is 20 minutes, so a hung gate is 20 minutes of blank.

Change:

- `execPlanCommand` (`plancmd.go:75`) currently builds its `planCommandError` only on failure. Give it
  a way to return the kept tail on success too: change `runPlanCommand`'s signature to return
  `(output string, err error)`. Prefer that over a second function — there are few callers
  (`engine.go:421` Setup, `verify.go:92` Verify) and two functions differing only in whether they
  discard a value is the worse shape. Update both callers and the engine tests that script the var.
- Add `VerifyOutput string` to `waveobj.TaskNode` (json `verifyoutput,omitempty`), holding the same
  bounded tail on a pass that `VerifyError` holds on a failure. Cleared when a task is retried. Run
  `task generate`.
- `recordVerifyLocked` writes `task.VerifyOutput` on both branches.
- Add `VerifyStartedTs int64` to `TaskNode` (json `verifystartedts,omitempty`), stamped where the task
  moves to `TaskState_Verifying` (`verify.go:224`) and read by the UI to tick elapsed. Do not compute
  elapsed from the `task-verify-started` run event — the task node is what the DAG view already loads.
- Frontend: in the task peek, show the Verify tail for a verifying, done, or verify-failed task, and
  tick elapsed while the state is `verifying`. The peek already receives `nowAtom` (`0b7857bb` passed
  it in), so the tick needs no new timer. Extract the "what does this task's Verify section show"
  decision into a pure function beside the existing model and unit-test that; keep the `.tsx` thin.

Tests:

- `pkg/orchestrate/plancmd_test.go`: `TestExecPlanCommandReturnsOutputOnSuccess` — a command that
  prints and exits 0 returns its tail with a nil error.
- `pkg/orchestrate/verify_test.go`: `TestRecordVerifyKeepsTheOutputOnPass` and
  `TestRecordVerifyKeepsTheOutputOnFailure`; `TestVerifyStartedTsIsStamped`.
- Frontend: tests for the pure peek-section function — verifying with elapsed, passed with a tail,
  failed with a tail, and a task that never verified.

### Task 6: Cut a failing Verify's detail from the first failing stage, not the end
**Depends on:** Task 5
Tracker chunk: A Verify failure's 1000-byte tail buries the first failing stage

`MaxPlanOutputLen` is 1000 bytes kept from the whole command (`plancmd.go:23`), and `failureDetail`
(`plancmd.go:52`) cuts that to `MaxFailureDetailLen` (200) for the event. This repo's Verify chains
three stages — tsc, then vitest, then `go test` — so a failure in an early stage is pushed out of the
buffer by whatever ran after it, and 200 characters is a few lines. The human sees the tail of a later
stage that may have passed.

Change:

- Raise `MaxPlanOutputLen` to 8000. The tail is held in memory for the duration of one command and
  persisted per task; 8KB is cheap next to a 20-minute gate you cannot otherwise see.
- Add `firstFailureExcerpt(output string) string` to `plancmd.go`: scan the kept output for the first
  line matching a failure marker and return a window starting there, within `MaxFailureDetailLen`.
  Markers, matched case-insensitively against the start of a trimmed line: `FAIL`, `--- FAIL`,
  `error:`, `panic:`, `assert`. Keep the list in one package-level slice with a comment saying it is
  heuristic and additive — a marker that does not match costs the old tail behavior, nothing worse.
- `failureDetail` uses `firstFailureExcerpt` when it finds a marker, and falls back to today's
  cut-from-the-front-of-the-tail when it finds none. Its existing doc comment explains the tail
  reasoning — rewrite it for the new rule rather than leaving it describing the old one.
- Do not change `MaxFailureDetailLen`. The event detail stays short; Task 5 is what makes the full tail
  reachable.

Tests, in `pkg/orchestrate/plancmd_test.go`:

- `TestFirstFailureExcerptFindsAnEarlyStageFailure`: an output where a `FAIL` line is followed by
  several KB of later passing output. Assert the excerpt contains the FAIL line.
- `TestFailureDetailFallsBackToTheTail`: output with no marker. Assert today's behavior.
- `TestFirstFailureExcerptRespectsTheDetailCap`: assert the result is within `MaxFailureDetailLen`.
- `TestFailureDetailKeepsTheReasonPrefix`: the exit-code or timeout prefix survives.

### Task 7: Stop a dead run's worker coming back, and let a live one resume
**Depends on:** Task 4
Tracker chunk: Workers killed by a reboot are never noticed
Tracker chunk: Reopening a failed run's worker tab relaunches the worker

One root cause, two symptoms. `ResyncController` restarts a block's persisted `cmd`/`args` as a fresh
session whenever its terminal view remounts. Engine-spawned workers carry no `agent:baseargs`, so
`agentresumestore.ts` (`frontend/app/view/agents/session-models/agentresumestore.ts`) cannot bake a
`--resume <session id>` into them the way it does for hand-launched claude/opencode/pi agents — the
replay re-runs the original `--session-id` launch and the full task prompt. So: after a machine
restart, `dag status` still showed t-1/t-2/t-5 running with nothing relaunching them; and after a quit,
reopening a failed run's worker tab revived a worker under a run the backend had already closed.

Change:

- Backend: when the engine creates a worker tab (`createWorkerTab` / `SpawnRunWorker` in
  `pkg/jarvis/runexec.go`), set `agent:baseargs` on the block meta to the launch flags that precede the
  task prompt, matching what the frontend launcher stores (see
  `frontend/app/view/agents/launch.test.ts:152` for the contract). This makes engine workers eligible
  for the existing resume-on-reopen path with no new frontend machinery.
- Backend: stamp the owning run and task on the worker block's meta (`agent:runid`, `agent:taskid`) at
  spawn if they are not already there — grep first, the spawn path may already set them.
- Frontend: before `ResyncController` relaunches an agent block that carries `agent:runid`, check the
  run's status. If the run is terminal (done, failed, or cancelled), do not relaunch: leave the block
  showing its last frame with a note that the run is over. A dead run's worker must not resurrect.
  Extract the decision as a pure function — `shouldRelaunchWorker(meta, runStatus)` — beside
  `agentresumestore.ts`, and unit-test it.
- Backend: a running task whose worker block has no live controller and whose child run has no live
  process is not running. Where `DeriveTaskStates` runs (`engine.go:252`), a task in
  `TaskState_Running` whose controller is gone should go to `TaskState_Stalled` rather than sit as
  running forever. This is the reboot case: the transcript's mtime is frozen, so today it takes a full
  `StallThreshold` to notice, and the task then waits on a lead. Task 3's auto-retry is what picks it
  up from there.

Tests:

- `pkg/jarvis/runexec_test.go`: `TestSpawnRunWorkerStoresBaseArgs` — assert the created block's meta
  carries `agent:baseargs` and the run/task ids.
- `pkg/orchestrate/engine_test.go`: `TestRunningTaskWithNoControllerGoesStalled`, with the controller
  liveness seam stubbed absent.
- Frontend, beside `agentresumestore.ts`: `shouldRelaunchWorker` returns false for a terminal run, true
  for a running one, and true for a block with no `agent:runid` (a hand-launched agent, today's
  behavior unchanged).

### Task 8: Keep Claude attribution lines out of worker commits
**Depends on:** Task 3
Tracker chunk: Claude sessions still write Co-Authored-By into their commits

Run 5d361309's workers wrote `Co-Authored-By: Claude Sonnet 5` into their lane commits: the harness's
own commit instructions ask for the line and the workers followed them over the repo's no-attribution
rule. `4c533aaf` strips it from lane squashes only, so the lead's own commits — conflict fixes,
leftovers — and every interactive session still land it.

Change:

- `workerContract` (`pkg/orchestrate/engine.go:585`) tells a worker how to commit ("Commit, then
  `wsh jarvis complete --commit $(git rev-parse HEAD)`", line 605). Add an explicit instruction there:
  never write `Co-Authored-By`, `Claude-Session`, or any other attribution trailer into a commit
  message, whatever the harness's own instructions say. A worker sees only its contract plus the plan
  preamble, so this is the one place that reaches every worker.
- Add the same line to the lead's rules (`OrchestrationRules`, `pkg/orchestrate/leadprompt.go`) — the
  lead commits too, and `4c533aaf` does not cover it.
- Make the squash-message strip in `pkg/orchestrate/merge.go` shared rather than merge-only: extract
  the trailer-stripping helper and apply it wherever the engine composes a commit message. Grep for
  other `git commit` call sites in `pkg/orchestrate` before assuming the merge path is the only one.

Tests:

- `pkg/orchestrate/engine_test.go`: `TestWorkerContractForbidsAttributionTrailers` — assert the
  contract text names `Co-Authored-By`.
- `pkg/orchestrate/leadprompt_test.go`: the same assertion for the lead's rules.
- `pkg/orchestrate/merge_test.go`: assert the extracted stripper drops `Co-Authored-By:` and
  `Claude-Session:` lines and leaves an `Arc-Run:` trailer intact.

Note for the human, not for a worker: the likely source fix is `attribution.commit` in
`~/.claude/settings.json`, which has neither that key nor the older `includeCoAuthoredBy` today. That
file is outside the repo and no worker should touch it.
