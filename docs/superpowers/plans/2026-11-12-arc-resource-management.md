# Memory and CPU management across Arc: implementation plan

> **For agentic workers:** each task names its files, the interfaces it produces or consumes, and the tests that
> prove it. Write the implementation yourself; follow the decisions below, which the spec leaves to the builder.

**Effort:** effort:de39be0f-317c-4b34-a243-5879a6e4d94c
**Spec:** `docs/superpowers/specs/2026-11-12-arc-resource-management-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/... ./cmd/...`
**Check:** `go build ./... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs run-sheet-polish final-stage`

**Goal:** every process tree Arc starts is measured; run workers, task reviewers and plan commands wait at the door
for memory by learned per-project, per-role peaks, and a reconciliation loop pauses reviewers then workers when
free memory still runs low; holds and pauses show on the task row and the final-stage step.

**Architecture:** a new package `pkg/memgate` owns the learned footprints, the book of claims (admission) and the
reconciliation loop. `pkg/util/jobobject` gains the Windows primitives it needs (job memory, suspend/resume, a
close hook). `pkg/orchestrate` asks the gate before spawning a worker or reviewer (non-blocking, per tick) and
before running a plan command (blocking, before the command's timeout starts), and turns gate events into run
events. The digest derives a task's memory state from those run events; the run sheet and the final stage render
it. `wshserver` supplies the owner resolver and `main-server.go` starts the loop.

**Tech stack:** Go (golang.org/x/sys/windows, gopsutil `mem`), React/TS (vitest), CDP scenarios.

## Decisions beyond the spec (and why)

1. **One package, `pkg/memgate`.** Footprints, gate and loop share one book; splitting them across packages would
   need the book exported. It imports only `jobobject`, `wavebase` and gopsutil, so `orchestrate` and `wshserver`
   can both import it without a cycle. Store and role knowledge stay outside: callers pass a `Key`, and a resolver
   injected by `wshserver` classifies live jobs.
2. **Footprint store:** a JSON file `memfootprints.json` in `wavebase.GetWaveDataDir()`, written atomically
   (temp + rename) on each record. A missing or unreadable file means defaults (logged, never fatal) and is
   rewritten on the next record. Not a SQLite table: a few dozen keys, one writer, and no migration needed.
3. **Aging:** each key keeps its last 8 recorded peaks; the estimate is their max. Conservative (a worker's tsc
   spike is reserved), and a spike ages out after 8 later trees. Peaks of 0 (unsupported platform) are not recorded.
4. **Defaults with no history:** worker 3.5 GiB (today's `WorkerMemoryReserve`), Verify / Check / Final 3.5 GiB,
   reviewer 1.5 GiB, Setup 1.5 GiB, any other role 1 GiB (recorded but never owed).
5. **Project key:** `jarvis.MainCheckout(path)` (falls back to the path), cleaned and lower-cased on Windows, so a
   run's worktrees key to their main checkout and nothing is lost when they are deleted. Exposed once as
   `orchestrate.MemProjectKey`.
6. **Role key strings:** session roles are `jarvis.UsageRole(run)` values (`worker`, `reviewer`, `lead`,
   `plan-reviewer`, `verifier`, `builder-check`, `brainstorm-judge`); plan commands are `Setup`, `Verify`, `Check`,
   `Final`; blocks in no run are `agent` (tab has `session:agent`) or `terminal`.
7. **Admission rule:** admit when `Available − Σ owed(other claims) ≥ need`, or when the book holds no claim at all
   (the one-tree-always-starts rule; only gated trees are claims, so open agents and leads never count as live).
   `owed = max(0, estimate − current use)` of a claim's tree, held until its root process exits.
8. **Workers carry their Setup.** The dispatch-time Setup runs under the dag mutation lock, so it must never wait.
   A worker's need is `max(estimate(worker), estimate(Setup))` when the plan has a Setup, and the dispatch Setup
   runs on that admission (ctx marked admitted with `orchestrate.WithGateAdmitted`). Every plan-command call site,
   and what a hold there shows on:
   - merge-point Verify (`startVerify`) and its bisect steps: wait; shown on the task the Verify is attributed to
     (the batch's first tip, as `task-verify-started` already is; each bisect step on its own tip).
   - bisect-tree Setup (`withDetachedTree`, owner Setup with the first tip's task): waits; shown on that tip's row.
   - final stage Setup (tree step), Check, Verify, Final: wait; shown on the final stage's running step.
   - base Check at submit and its tree's Setup (`runBaseCheck`): admitted. It runs once, before any worker, and no
     view shows the base check, so a hold there would be invisible; it counts through real use.
   - submit-time landing-tree Setup (`wshserver_dag.go`, inside the submit RPC): admitted, so the RPC never waits.
   - land-time Check and Verify (`land.go`, inside `LandRun`, called from an RPC): admitted, for the same reason;
     they run once per run with the human or lead waiting on them directly, like a lead.
   A waiting command waits in `execPlanCommandEnv` before its `context.WithTimeout`, so the wait never counts
   against the timeout. The spec's Scope line is amended to say this.
9. **Workers and reviewers never block a tick.** They use the non-blocking `TryAdmit`; a refused task stays pending
   (or reviewing with no reviewer). Admission keeps plan order: after the first refusal in a dag's count grant, every
   remaining task of that grant is marked held (`memgate.Hold`) without being tried, so each shows "waiting for
   memory". Re-admission is prompt: whenever room frees (a claim released or dropped, or a loop tick that sees
   `Available` rise by 512 MiB or more since the last call) memgate calls a room hook with the run ids of held
   Tags, and orchestrate ticks those runs' dags at once (`go tickDag`, which already skips a dag mid-tick), rather
   than waiting out the 30 s watchdog. The count cap (`MaxLiveWorkers`, fair share) stays in `workerslots.go`;
   only the memory half moves to memgate.
10. **Claim lifetime:** plan-command claims are bound at admission and released by the caller when the command
    returns. Worker and reviewer claims are bound to `Owner{block, blockId}` once the worker starts and released
    when that block's job closes (close hook). An unbound claim is its caller's to release: `Schedule` defers a
    release of every claim still unbound when the tick returns (beside `releaseWorkerClaim`), which covers each
    dispatch failure, `cleanupScheduleFailure`'s early return and the tasks after it; the loop never drops an
    unbound claim, since a serial batch of Setups can take many minutes. The loop drops a bound claim whose job was
    seen and is gone, or whose job has not appeared 60 s after the bind (the job registers within
    `workerJobWait`, 30 s).
11. **Loop:** ticks every 2 s. Low watermark 1.5 GiB, high 3 GiB of `Available`. Below low it pauses one tree per
    tick: reviewers first, then workers, the most recently admitted first; it never pauses the last unpaused gated
    tree (something must finish to free memory). Above high it resumes one per tick, oldest pause first. Plan
    commands are never paused: Verify/Final run on a wall-clock timeout, and a flake there costs a retry round.
12. **Pause limit:** a pause lasts at most 3 minutes, then the tree is resumed (reason `limit`) and is not paused
    again for 10 minutes. Claude Code's own API timeout is 10 minutes and the stall threshold 15, so a 3-minute
    pause risks neither; an unbounded one would risk both.
13. **How a pause is done:** on Windows, `NtSuspendProcess` on each member of the owner's job, keeping each
    suspended process's handle open (it pins the pid and makes resume exact); calling suspend again suspends only
    members that joined since. Elsewhere a no-op. A paused tree that closes (cancel, kill) gets a `resumed` event
    with reason `exited`, so no row stays paused.
14. **Run events:** four kinds, written on the dag owner's run. Detail keys: `taskid` ("" for a task-less command),
    `role`, `free` and `need` (bytes), `reason` (resumed: `memory` | `limit` | `exited`), `ms` (admitted: time
    waited; resumed: time paused). `held` is written once per transition, not per tick. A Wait cancelled while
    held writes nothing more; readers bound a hold by the owning state (decision 15). Events are delivered in
    order on memgate's own goroutine, so a tick or a waiting command never blocks on the store.
15. **Visibility:** the digest derives `DagTaskDigest.Memory` (the CLI status and the run sheet both read it); the
    final stage reads the task-less events directly, as it already reads `final-step` events: a `memory-held` for
    the running step's command, with no later `memory-admitted` and a ts after the run's latest `final-ended`
    event (the previous round's end; any ts in round 1), shows on that step. `waitreason` keeps its enum: several
    views switch on it, and memory is shown beside it, not instead of it. Byte figures read as GB with one decimal
    (`2.1 GB`), from a new `fmtGB` beside `fmtBytes` (which stops at MB).
16. **CPU (spec section 5):** nothing to build. Run workers and reviewers are already lowered by
    `deprioritizeWorker`; leads, stage sessions, Verify/Final and interactive agents stay normal.
17. **Test seams.** memgate exports `SetFreeForTest`, `SetStoreDirForTest`, `LiveClaimsForTest` and
    `UncapForTest`, so orchestrate's tests can script free memory, keep `Record` off the real data dir and read
    the book. `UncapWorkersForTest` also points the store at a temp dir.
18. **Task 3 waits on Task 1** rather than on a stub-first task: Task 1 is short, and a stub task would add a
    review and merge round for a few minutes of overlap.

## Review focus

- Free memory already below the need with no gated tree live: one tree still starts (Task 2 test).
- A worker or reviewer admitted but whose spawn fails, or a tick that fails part-way: every unbound claim is
  released, or the gate holds forever (Task 5 tests).
- A paused tree cancelled while suspended: a `resumed`/`exited` event and its suspended handles released (Tasks 1, 3).
- A plan command waiting at the door when its run is cancelled: returns promptly with the ctx error (Task 2 test).
- A corrupt or missing footprints file: defaults, logged, admission never blocked (Task 2 test).

---

### Task 1: Job-object memory, suspend/resume and close hook
**Depends on:** none
**Files:** `pkg/util/jobobject/jobobject_windows.go`, `pkg/util/jobobject/jobobject_other.go`, `pkg/util/jobobject/registry.go`, `pkg/util/jobobject/jobobject_windows_test.go`, `pkg/util/jobobject/registry_test.go`

Produces (memgate relies on these exact names):
- `type JobUsage struct { Owner Owner; RootPid int; Current, Peak uint64 }` and `func LiveUsage() []JobUsage`:
  every registered job, under the registry lock. Peak from `JOBOBJECT_EXTENDED_LIMIT_INFORMATION.PeakJobMemoryUsed`;
  Current from `JobObjectMemoryUsageInformation` (`JOBOBJECT_MEMORY_USAGE_INFORMATION.JobMemory`). A job whose
  query fails is logged and skipped. nil off Windows.
- `func Suspend(o Owner) (int, error)`: suspends every member of every live job registered for `o` not already
  suspended by this package, returns how many it newly suspended; `ErrNotMember` when no job is registered.
- `func Resume(o Owner) error`: resumes and closes every handle `Suspend` kept for `o`'s jobs.
- `func SetCloseHook(fn func(o Owner, rootPid int, peak uint64))`: `Close` of a registered job reads its peak
  before closing the handle and calls `fn` after releasing the registry lock (never under it). Close also releases
  any suspended handles of that job.
- Off Windows: `Suspend` returns `(0, nil)`, `Resume` nil, the hook never fires.

Acceptance (real job objects, child process allocating a known amount, e.g. a Go test helper or `powershell` byte array):
- `TestLiveUsageReportsChildMemory`: Current and Peak ≥ the allocation while the child holds it.
- `TestCloseHookGetsPeak`: the hook fires once with the owner and a peak ≥ the allocation; an unregistered job fires nothing.
- `TestSuspendResume`: a suspended child's CPU time stops advancing; after Resume it advances; a second Suspend
  with no new members returns 0 (no double suspend count).
- `TestKillSuspendedTree`: `KillTree` + `Close` of a suspended job terminates it and releases its handles.
- Run: `go test ./pkg/util/jobobject -run 'TestLiveUsageReportsChildMemory|TestCloseHookGetsPeak|TestSuspendResume|TestKillSuspendedTree'`

### Task 2: memgate core: footprints and admission
**Depends on:** none
**Files:** `pkg/memgate/footprints.go`, `pkg/memgate/footprints_test.go`, `pkg/memgate/gate.go`, `pkg/memgate/gate_test.go`

Decisions 2, 3, 4, 7, 14 apply. Produces:
```go
type Key struct{ Project, Role string }
type Tag struct{ RunId, TaskId, Role string } // where events about a tree go; RunId "" = no events
type Request struct {
    Key   Key
    Need  uint64          // bytes; 0 = Estimate(Key)
    Tag   Tag
    Owner jobobject.Owner // zero when bound later with Claim.Bind
}
const RoleWorker, RoleReviewer = "worker", "reviewer" // the pausable roles
func Estimate(k Key) uint64
func Record(k Key, peak uint64)
func TryAdmit(r Request) (*Claim, bool)                     // never blocks; emits held once per Tag transition
func Hold(r Request)                                        // marks r's Tag held (emits held once) without trying
func Wait(ctx context.Context, r Request) (*Claim, error)   // blocks until admitted or ctx ends
func (c *Claim) Bind(o jobobject.Owner)
func (c *Claim) Release()                                   // idempotent and nil-safe
type EventKind string // EventHeld "held", EventAdmitted "admitted", EventPaused "paused", EventResumed "resumed"
type Event struct { Kind EventKind; Tag Tag; Free, Need uint64; Reason string; Ms int64 }
func SetEventSink(fn func(Event))
func SetRoomHook(fn func(runIds []string)) // decision 9: called on memgate's goroutine when room frees
func UncapForTest() (restore func())                                     // free memory reads as unlimited
func SetFreeForTest(fn func() (uint64, error)) (restore func())
func SetStoreDirForTest(dir string) (restore func())
func LiveClaimsForTest() int                                             // claims in the book
```
Free memory comes from a package var (gopsutil `mem.VirtualMemory().Available`) that tests replace. `Wait` re-checks
on every Release and at least every 2 s; a refusal emits `held` once, the later admission `admitted` with `Ms`.

Acceptance (`go test ./pkg/memgate -run '<names>'`):
- `TestEstimateDefaults`: worker / Verify / Check / Final 3.5 GiB, reviewer / Setup 1.5 GiB, other 1 GiB.
- `TestEstimateIsMaxOfLastEight`: 9 records; the oldest no longer counts; a 0 peak is ignored.
- `TestFootprintsPersist`: Record, reload from the file, same estimate; a corrupt file yields defaults and is
  rewritten on the next Record.
- `TestAdmitByFreeLessOwed`: with 8 GiB free and a live claim owing 3 GiB, a 4 GiB request admits, a 6 GiB one is refused.
- `TestOneTreeAlwaysStarts`: 1 GiB free, empty book, a 3.5 GiB request admits; with one claim live it is refused.
- `TestHeldOncePerTransition`: three refused TryAdmits of one Tag emit one `held`; the admission emits one `admitted`.
- `TestWaitAdmitsOnRelease`: a Wait blocked behind a claim returns once that claim is released.
- `TestWaitCancel`: cancelling ctx returns `ctx.Err()` promptly with a nil claim and no `admitted` event.
- `TestHoldMarksWithoutAdmitting`: `Hold` emits one `held` and adds nothing to the book.
- `TestRoomHookOnRelease`: releasing a claim while a Tag is held calls the room hook with that Tag's run id; no
  call when nothing is held.

### Task 3: memgate reconciliation loop
**Depends on:** Task 1 (uses LiveUsage, Suspend, Resume, SetCloseHook), Task 2
**Files:** `pkg/memgate/reconcile.go`, `pkg/memgate/reconcile_test.go`, `pkg/memgate/gate.go`

Decisions 10–13 apply. Produces:
```go
type Resolver func(ctx context.Context, o jobobject.Owner) (Key, bool)
func SetResolver(r Resolver)
func StartLoop(ctx context.Context) // installs the jobobject close hook and ticks every 2 s
```
Each tick: read `jobobject.LiveUsage()`; set each bound claim's current use, and raise its estimate to its tree's
observed peak when higher; drop dead and stale claims (decision 10); resolve each live job's owner once and cache
it per owner. On close (hook): record the peak under the cached key (resolve now when uncached; skip and log when
that fails), release a block-owned claim, and emit `resumed`/`exited` for a paused one. Call the room hook per
decision 9 (drops, and a 512 MiB rise in `Available`). Then apply the pause and
resume rules of decisions 11–12, emitting `paused` (Need = the high watermark) and `resumed`. The jobobject calls
and free memory go through package vars so tests run on any OS without real processes.

Acceptance (`go test ./pkg/memgate -run '<names>'`):
- `TestPauseReviewersBeforeWorkers`: below low, the first pause hits the reviewer, the next the newest worker.
- `TestNeverPauseLastTree`: one gated tree live and memory below low: nothing pauses.
- `TestResumeAboveHigh`: resumes oldest pause first, one per tick, only above the high watermark.
- `TestPauseLimit`: after 3 min the tree resumes with reason `limit` and is not paused again within 10 min.
- `TestCloseRecordsPeakAndReleases`: the hook records the peak under the resolved key and releases the block's claim.
- `TestPausedTreeExit`: a paused tree's close emits `resumed` with reason `exited`.
- `TestDropDeadAndStaleClaims`: a bound claim whose job vanished is dropped, and one whose job never appeared
  60 s after the bind; an unbound claim is never dropped by the loop.
- `TestRoomHookOnRise`: a tick seeing `Available` 512 MiB above the last call calls the room hook with held run ids.

### Task 4: Memory run-event kinds and the digest's memory field
**Depends on:** none
**Files:** `pkg/waveobj/runevent.go`, `pkg/wshrpc/wshrpctypes_dag.go`, `frontend/types/gotypes.d.ts`

Add `RunEventKindMemoryHeld = "memory-held"`, `RunEventKindMemoryAdmitted = "memory-admitted"`,
`RunEventKindMemoryPaused = "memory-paused"`, `RunEventKindMemoryResumed = "memory-resumed"` with the detail keys of
decision 14 documented beside them. Add to `wshrpc`:
```go
type DagMemoryState struct {
    State string `json:"state"` // waiting | paused
    Role  string `json:"role"`  // worker | reviewer | Setup | Verify | Check | Final
    Free  int64  `json:"free"`  // bytes
    Need  int64  `json:"need"`  // bytes
    Ts    int64  `json:"ts"`    // UnixMilli the hold or pause began
}
```
and `Memory *DagMemoryState \`json:"memory,omitempty"\`` on `DagTaskDigest`. Run `task generate`; commit the
regenerated `frontend/types/gotypes.d.ts`. Acceptance: `go build ./...` and `task check:ts` pass.

### Task 5: Orchestrate admits workers, reviewers and plan commands
**Depends on:** Task 2 (uses the gate API), Task 4 (uses the run-event kinds)
**Files:** `pkg/orchestrate/workerslots.go`, `pkg/orchestrate/workerslots_test.go`, `pkg/orchestrate/engine.go`, `pkg/orchestrate/review.go`, `pkg/orchestrate/plancmd.go`, `pkg/orchestrate/basecheck.go`, `pkg/orchestrate/land.go`, `pkg/orchestrate/maintest_test.go`, `pkg/orchestrate/workerpriority_test.go`, `pkg/orchestrate/memadmit.go`, `pkg/orchestrate/memadmit_test.go`

Decisions 5, 8, 9, 10, 14, 17 apply.
- Remove `WorkerMemoryReserve`, `availableMemory` and `workerLoad.claimed`; `workerGrant` becomes count-only. Grep
  confirms no other references outside these files (the spec mentions them in prose only).
- `claimWorkers(ctx, g, owner, next []string) ([]string, map[string]*memgate.Claim)`: the count grant first, then
  `memgate.TryAdmit` per task in order with `Key{MemProjectKey(owner.ProjectPath), "worker"}`,
  `Tag{g.RunID, taskID, "worker"}` and the need of decision 8; after the first refusal the rest of the grant gets
  `memgate.Hold`; the count claim equals the admitted count. `Schedule` hands the claims to `dispatchTasks` and
  defers releasing every claim still unbound when it returns (decision 10).
- Bind each claim to `jobobject.Owner{Kind: block, Id: blockId}` once the worker started (the block id
  `deprioritizeWorker` already resolves).
- `spawnReviewer`: `TryAdmit` with role `reviewer` before `spawnWorker`; refused → return, spawning nothing (the
  task stays reviewing with no `ReviewRunID`, the next tick retries); bind on start, release on each failure path.
- `execPlanCommandEnv`: when ctx carries a run-command owner and is not marked admitted, `memgate.Wait` with
  `Key{MemProjectKey(dir), owner.Cmd}`, `Tag{owner.Id, owner.Task, owner.Cmd}`, `Owner: owner`, before
  `context.WithTimeout`; release when the command returns. A Wait error returns as the command's error.
- `func WithGateAdmitted(ctx context.Context) context.Context` (in `memadmit.go`, exported for the submit RPC in
  Task 8) marks a ctx admitted. Apply it to the dispatch Setup in `dispatchTasks`, to `runBaseCheck`'s ctx, and to
  the land-time Check/Verify in `land.go` (decision 8).
- `func KickHeldRuns(runIds []string)` (in `memadmit.go`): for each run, load its dag and, when nonterminal,
  `go tickDag(context.Background(), g)` (decision 9). Task 8 wires it as the room hook.
- `memadmit.go` also holds `func MemProjectKey(path string) string` and
  `func RecordMemoryEvent(ev memgate.Event)`: maps the kind to the run-event kind, finds the run's channel with
  `wstore.DBGet[*waveobj.Run](ctx, ev.Tag.RunId)`, and appends the event with decision 14's detail.
- `maintest_test.go` uses `memgate.UncapForTest()` and `memgate.SetStoreDirForTest(<temp dir>)` where it stubbed
  `availableMemory`; `UncapWorkersForTest` keeps its signature and also does both. Tests below script memory with
  `memgate.SetFreeForTest` and read the book with `memgate.LiveClaimsForTest`.

Acceptance (`go test ./pkg/orchestrate -run '<names>'`):
- `TestWorkerGrant` (rewritten): the count cases only.
- `TestClaimWorkersStopsAtMemory`: with memory for one worker, three ready tasks give one admitted and two
  pending, and both pending tasks get a `held` event.
- `TestUnboundClaimsReleasedAfterTick`: a tick whose dispatch fails part-way (`cleanupScheduleFailure`) leaves
  `LiveClaimsForTest() == 0`.
- `TestLandAndBaseCheckNeverWait`: with a gate that refuses everything, `runBaseCheck` and the land's Check run.
- `TestKickHeldRunsTicksDag`: kicking a held run's id runs its dag's Schedule without the watchdog.
- `TestWorkerNeedIncludesSetup`: with a learned Setup peak above the worker's, the request's need is the Setup's.
- `TestSpawnFailureReleasesClaim`: a failed `spawnWorker` leaves `LiveClaimsForTest() == 0`.
- `TestReviewerHeldAtDoor`: refused reviewer → no spawn, `ReviewRunID` empty, task still reviewing.
- `TestPlanCommandWaitsBeforeTimeout`: a command held 300 ms with a 200 ms timeout still runs and passes.
- `TestDispatchSetupNeverWaits`: with a gate that refuses everything, the dispatch Setup runs without blocking.
- `TestMemProjectKeyFoldsWorktrees`: a linked worktree path keys to its main checkout.
- `TestRecordMemoryEventDetail`: a held event lands on the run with taskid, role, free and need.

### Task 6: Digest and CLI show a task's memory state
**Depends on:** Task 4 (uses DagMemoryState and the run-event kinds)
**Files:** `pkg/orchestrate/digest.go`, `pkg/orchestrate/digestmemory_test.go`, `pkg/wshrpc/wshserver/wshserver_dag.go`, `cmd/wsh/cmd/wshcmd-jarvisdag.go`, `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`

- Add the four memory kinds to `dagDigestRetainedKinds`.
- `buildTaskDigest` sets `td.Memory` from the task's latest memory event in `sn.Retained`: `held` with no later
  `admitted` → `waiting`, only while the role still fits the task's state (worker: pending; reviewer: reviewing
  with no reviewer run; Verify or Setup: verifying); `paused` with no later `resumed` → `paused` while the task is running,
  stalled or reviewing. Otherwise nil. `Ts` is the event's.
- The CLI status task line appends `waiting for memory (2.1 GB free, 3.5 GB needed)` or
  `paused: memory (…)`, naming the role when it is not `worker`.

Acceptance:
- `go test ./pkg/orchestrate -run 'TestDigestMemoryWaiting|TestDigestMemoryAdmittedClears|TestDigestMemoryPaused|TestDigestMemoryTerminalTask'`:
  waiting for a pending worker, cleared by admitted, paused/resumed, and nil once the task is done or cancelled.
- `go test ./cmd/wsh/cmd -run 'TestDagStatusMemoryLine'` (in `wshcmd-jarvisdag_test.go`): the waiting and paused
  texts above, the role named for a Verify hold, nothing added when `Memory` is nil.

### Task 7: Run sheet row and final-stage step show holds and pauses
**Depends on:** Task 4 (uses DagMemoryState in gotypes.d.ts)
**Files:** `frontend/app/view/agents/runcompletion.ts`, `frontend/app/view/agents/runcompletion.test.ts`, `frontend/app/view/jarvis/runsheetmodel.ts`, `frontend/app/view/jarvis/runsheetmodel.test.ts`, `frontend/app/view/agents/finalstage.ts`, `frontend/app/view/agents/finalstage.test.ts`, `frontend/app/view/agents/finalstageviews.tsx`, `frontend/app/view/orchestrate/dagdigest.ts`, `frontend/app/view/orchestrate/dagdigest.test.ts`, `scripts/cdp/scenarios-runs.mjs`

- Add the four memory kinds to `REFRESH_EVENT_KINDS` in `dagdigest.ts`, so a hold refreshes the digest.
- `taskRow`: when `td.memory` is set, the row reads state `waiting` (tone warning) with meta
  `waiting for memory · 2.1 GB free, 3.5 GB needed`, or state `paused` with meta
  `paused: memory · 1.2 GB free, 3.0 GB needed`; a non-worker role is named after the first words
  (`waiting for memory (Verify) · …`). It takes precedence over the state's own row, but not over an ask. Figures
  use a new `export function fmtGB(bytes: number): string` in `runcompletion.ts` (bytes / 1024^3, one decimal:
  `2.1 GB`), shared with the final stage.
- `finalstage.ts`: a running step whose command (tree → Setup, check → Check, verify → Verify, final → Final) has a
  task-less `memory-held` event with no later `memory-admitted` and a ts after the run's latest `final-ended` event
  (decision 15) shows the detail
  `waiting for memory · X free, Y needed`; `finalstageviews.tsx` renders it where the step's detail shows today.
- Scenarios: in `run-sheet-polish`, a new step injects (via `injectPageDag`) `memory` on one pending task's digest
  row and asserts its meta reads `waiting for memory · …`, then a running task's `paused: memory · …`, with a
  screenshot. In `final-stage`, a new step seeds a running Check step with a `memory-held` event and asserts the
  step's detail text, with a screenshot.

Acceptance:
- `npx vitest run frontend/app/view/jarvis/runsheetmodel.test.ts frontend/app/view/agents/finalstage.test.ts frontend/app/view/orchestrate/dagdigest.test.ts frontend/app/view/agents/runcompletion.test.ts`
  with tests `memory waiting row`, `memory paused row`,
  `ask beats memory`, `final step waiting for memory`, `previous round's hold is not shown`,
  `memory events refresh the digest`, `fmtGB one decimal`.
- `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs run-sheet-polish final-stage` passes the new steps.

### Task 8: Resolver and startup wiring
**Depends on:** Task 3 (uses SetResolver, StartLoop), Task 5 (uses MemProjectKey, RecordMemoryEvent, KickHeldRuns, WithGateAdmitted), Task 6
**Chunk:** Build: learned-footprint memory gate and reconciliation
**Files:** `pkg/wshrpc/wshserver/wshserver_memgate.go`, `pkg/wshrpc/wshserver/wshserver_memgate_test.go`, `pkg/wshrpc/wshserver/wshserver_dag.go`, `cmd/server/main-server.go`, `docs/reference/architecture.md`

- `func ResolveMemOwner(ctx context.Context, o jobobject.Owner) (memgate.Key, bool)`: a run-command owner → the run's
  `MemProjectKey(ProjectPath)` and `o.Cmd`; a block in a run (`ownerRunForBlock`) → the run's project and
  `jarvis.UsageRole(run)`; any other block → `MemProjectKey` of its `cmd:cwd` meta ("" when unset) and `agent` or
  `terminal` by the tab's `session:agent`. false when the block or run is gone.
- `main-server.go`, beside `StartWatchdog` and only when not a snapshot: `memgate.SetEventSink(orchestrate.RecordMemoryEvent)`,
  `memgate.SetRoomHook(orchestrate.KickHeldRuns)`, `memgate.SetResolver(wshserver.ResolveMemOwner)`,
  `memgate.StartLoop(ctx)`.
- `wshserver_dag.go`: the submit-time landing-tree Setup runs with `orchestrate.WithGateAdmitted(setupCtx)`
  (decision 8), so the submit RPC never waits at the gate.
- `docs/reference/architecture.md`: one paragraph on `pkg/memgate` (what is gated, where holds show).

Acceptance: `go test ./pkg/wshrpc/wshserver -run 'TestResolveMemOwner'`: run command, run worker (worktree path
folds to the project), reviewer, lead, agent tab and plain terminal each resolve to the expected key; a deleted
block resolves false. `go test ./pkg/wshrpc/wshserver -run 'TestSubmitSetupNeverWaits'`: with a gate that refuses
everything (`memgate.SetFreeForTest` returning 0 and a live claim), a submit with a Setup still completes.
