# Memory gate fragility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-11-13-memgate-fragility-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/memgate ./pkg/util/jobobject ./pkg/orchestrate ./pkg/wshrpc/wshserver`
**Check:** `go vet ./pkg/memgate ./pkg/util/jobobject ./pkg/orchestrate ./pkg/wshrpc/wshserver ./cmd/server`

**Goal:** The memory gate can delay a run but never stall one: only new workers are held, on the median of their
project's learned peaks, and the loop pauses only the youngest spiking worker, never past its prompt cache.

**Architecture:** `pkg/memgate` gets back a footprint store (peaks recorded at job close, keyed by project and
role) and admits on the key's median instead of the fixed `Headroom`. Progress (reviewers, every plan command)
takes a never-blocking `Admit` that counts like a starting worker. The reconciliation loop pauses one spiking
worker per tick, youngest first, and ends each pause before that worker's 5-minute prompt cache would expire,
which `pkg/orchestrate` supplies per claim from the worker's transcript.

**Tech Stack:** Go (`pkg/memgate`, `pkg/util/jobobject`, `pkg/orchestrate`), Windows job objects.

## Decisions beyond the design (and why)

1. **Planned against current main, not after `2026-11-13-dispatch-off-dag-lock.md`.** That plan is untracked in
   the main checkout, not merged and not running (`wsh runs list`, 11-13), and this goal was handed over to build
   now; the spec's Constraints now say so. This plan touches `engine.go` at two call sites (`claimWorkers` gains
   `owner`, `bindToBlock` gains the child run), so whichever lands second adapts two lines. The dispatch plan's
   `treePrep` registry keeps the claim; this plan changes only how the claim is sized and bound.
2. **No store-walking owner resolver.** Every tree that is ever sized (worker, reviewer, plan command) takes a
   claim whose `Request.Key` names its project and role. The gate remembers each bound owner's key and records
   the peak under it when the job closes, even after the claim was released early (`ReleaseOwner` on run done).
   The old `ResolveMemOwner` (a block → tab → run walk through the store, in `wshserver`) and its
   `RoleAgent`/`RoleTerminal` keys served only trees nothing sizes now. Fewer moving parts (spec anti-goal).
   A remembered key is forgotten at its job's close, or when the loop drops its claim as never seen
   (`bindStale`: the job never registered, so no close will come). It is not forgotten when a seen claim is
   dropped, since that job's close hook follows its unregister and still needs the key.
3. **`Wait` and the waiter queue are deleted.** Once plan commands take `Admit`, `Wait` has no caller, and the
   queued-Wait Headroom in `freeLocked` goes with it. `TryAdmit` (workers) and `Hold` stay. Because deleting
   `Wait` and `Headroom` breaks `pkg/orchestrate`'s build, Task 1 carries the few orchestrate lines that use
   them (`admitPlanCommand`, `plancmd.go`'s call, `memadmit_test.go`'s sizing); everything else in orchestrate
   is Task 2.
4. **Median of an even count:** the mean of the two middle values. Kept peaks stay the last 8 (`keepPeaks`).
   With 5 kept waveterm worker peaks (4.6, 4.8, 4.2, 4.1, 5.3 GB) the median is 4.6 GB, as the spec expects.
5. **Defaults for an unseen key** are the pre-0c293eaae map, minus `Setup`: worker, Verify, Check, Final
   3584 MiB; reviewer 1536 MiB; any other role 1 GiB. A worker's need is its own median; the old
   max(worker, Setup) sizing goes. Setup takes no claim (spec Decision 1), so its peak is never recorded and
   max(worker, Setup) would only ever compare against a fixed 1.5 GiB default below the worker's own; a Setup
   runs while its worker's claim is starting, so it is covered by the worker's charge for its first 30 s.
   Recorded as a spec change in Decision 2.
6. **Same store file and key format as before 0c293eaae:** `memfootprints.json` in the wave data dir, project
   key `MemProjectKey` (the lower-cased main checkout of the path on Windows). A file left by the old code
   loads as-is; keys no role uses (agent, terminal, Setup) are kept but never read.
7. **Base check and land-time Check/Verify are counted, not exempt.** They drop `WithGateAdmitted` and take
   the never-blocking claim like every plan command (spec Decision 1: "every plan command ... base check").
   Every Setup rides: dispatch and submit already mark theirs admitted, and `withDetachedTree` (base check and
   Verify bisect) marks its Setup ctx admitted, so no Setup takes a claim of its own.
8. **Pause trigger and watermarks unchanged** (`lowWater` 1.5 GiB, `highWater` 3 GiB, `pauseLimit` 3 min,
   `pauseCooldown` 10 min): the spec's non-goal forbids retuning them, and nothing in the repo records the free
   memory at which Claude Code kills a command, so the existing low watermark stands as "near the kill point".
9. **Spiking rule:** a worker is spiking when its job's current memory is at least `spikeRise` = 1 GiB above
   the lowest it has read since the loop first saw it, and higher than at the previous tick. An idle claude
   sits at 0.35-0.7 GB and a typecheck adds ~2.8 GB, so 1 GiB over the worker's own floor separates a
   command's spike from drift without learning idle use.
10. **Cache bound:** a pause ends at the earlier of `pausedAt + pauseLimit` and `expiry - pauseMargin`
    (`pauseMargin` = 30 s), where `expiry` is the worker's last transcript write plus
    `consult.ShortSessionCacheTTL`. A worker whose bound leaves less than `minPause` = 15 s is not paused, nor
    one whose expiry is unknown (no transcript yet, untracked runtime). The margin covers the gap between the
    request that refreshed the cache and the transcript write that follows it, plus resume and the next
    request. The TTL stays single-sourced in `consult` and is applied in `orchestrate`, so `memgate` imports
    nothing new.
11. **The expiry function is called outside `book.mu`.** It stats (and may glob) the sessions dir, so the loop
    never calls it with the book locked.
12. **The cache-expiry setter and its test accessor land in Task 1, with no behavior**, so the pause loop
    (Task 3) and the orchestrate work (Tasks 2 and 4) proceed side by side.

## Global Constraints

- No change to `MaxLiveWorkers`, the per-run fair share (`workerGrant`), CPU priority, or interactive agents and
  terminals (they take no claim).
- No change to `lowWater`, `highWater`, `pauseLimit`, `pauseCooldown`, `loopTick`, `startupGrace`, `bindStale`.
- No wshrpc / waveobj / wconfig type changes, so no `task generate`; no SQL migration; no frontend change. The
  `memory-*` run events keep their shape (`Need` on a held event is now the request's median).
- Free memory that cannot be read admits everything and pauses nothing (unchanged); a footprint file that cannot
  be read or parsed means defaults, logged once, never an error.
- Tests never read or write the real `memfootprints.json` (`SetStoreDirForTest` in each package's test setup).
- Comments say why, lower case, only where needed.

## Review Focus

1. **A job closes after its claim was released** (a worker's run went done, `ReleaseRunClaims`, then its lane is
   reaped). Expected: its peak is still recorded under its key (Task 1, `TestPeakRecordedAfterEarlyRelease`).
2. **An old `memfootprints.json` with one 19.8 GB outlier among worker peaks.** Expected: the estimate is the
   median, not the outlier (Task 1, `TestEstimateIsTheMedian`).
3. **A footprint file that is missing, unreadable or not JSON.** Expected: defaults, and the next record rewrites
   it (Task 1, `TestFootprintsFallBackToDefaults`).
4. **A spiking worker with no transcript yet, or a pi worker with no tracked transcript.** Expected: not paused;
   the loop moves to the next candidate or pauses nothing (Task 3, `TestNoPauseWithoutKnownCacheExpiry`).
5. **A worker whose spike has plateaued (memory high but no longer rising).** Expected: not paused, since a
   pause frees nothing already held (Task 3, `TestPausesOnlyRisingSpikes`).

---

### Task 1: Learned medians and the never-blocking admit, in memgate
**Depends on:** none
**Files:** `pkg/util/jobobject/registry.go`, `pkg/util/jobobject/jobobject_windows.go`, `pkg/util/jobobject/jobobject_windows_test.go`, `pkg/memgate/footprints.go`, `pkg/memgate/footprints_test.go`, `pkg/memgate/gate.go`, `pkg/memgate/gate_test.go`, `pkg/memgate/reconcile.go`, `pkg/memgate/reconcile_test.go`
**Files:** `pkg/orchestrate/memadmit.go`, `pkg/orchestrate/memadmit_test.go`, `pkg/orchestrate/maintest_test.go`, `pkg/orchestrate/plancmd.go`

Covers spec Decisions 2-3 and the plan-command half of Decision 1; plan decisions 2-6, 12. Recover the removed
code with `git show 0c293eaae^:pkg/memgate/footprints.go`, `git show 0c293eaae^:pkg/memgate/footprints_test.go`
and `git show 0c293eaae -- pkg/util/jobobject pkg/orchestrate/memadmit.go` (reverse the peak and
`MemProjectKey` hunks).

**Interfaces:**
- Produces (`jobobject`): `type CloseHook func(o Owner, rootPid int, peak uint64)`; `Close` reads the job's
  `PeakJobMemoryUsed` before closing and passes it (0 when the read failed, logged).
- Produces (`memgate`):
  - `type Key struct{ Project, Role string }`; `Request` gains `Key Key` (first field).
  - `func Estimate(k Key) uint64` (median of kept peaks, else the role default), `func Record(k Key, peak uint64)`
    (0 ignored), `func SetStoreDirForTest(dir string) (restore func())`.
  - `func Admit(r Request) *Claim`: always admits, never blocks, never marks held. The claim counts
    `Estimate(r.Key)` while starting, like any claim.
  - `TryAdmit(r Request) (*Claim, bool)` and `Hold(r Request)` keep their signatures and size on `Estimate(r.Key)`.
  - `func (c *Claim) SetCacheExpiry(fn func() (time.Time, bool))`: nil-safe, stores `fn` on the claim under
    `book.mu`; nothing reads it yet (Task 3 does). `func HasCacheExpiryForTest(c *Claim) bool`.
  - Removed: `Headroom`, `Wait`, `waiter`, `waitRecheck`, `book.waiters`.
- Produces (`orchestrate`): `func MemProjectKey(path string) string`;
  `admitPlanCommand(ctx context.Context, dir string) *memgate.Claim` (nil when ctx has no run-command owner or is
  marked admitted; otherwise `memgate.Admit` keyed `{MemProjectKey(dir), owner.Cmd}`). `workerRequest` keeps its
  signature and gains `Key{Role: memgate.RoleWorker}` (Task 2 adds the project).

- [ ] **Step 1: jobobject peak on close.** Restore `jobPeak` and the peak argument; rename
  `TestCloseHookGetsOwner` back to `TestCloseHookGetsPeak` asserting `peak >= allocBytes`. Run
  `go test ./pkg/util/jobobject -run '^TestCloseHookGetsPeak$'`: PASS.

- [ ] **Step 2: failing memgate tests** (`footprints_test.go`, `gate_test.go`, `reconcile_test.go`; `newGate` points
  the store at a temp dir):
  - `TestEstimateIsTheMedian`: peaks 4.6, 4.8, 4.2, 4.1, 5.3 GB → 4.6 GB; add 19.8 GB → mean of 4.6 and 4.8;
    9 records keep the last 8; unseen worker key → 3584 MiB, unseen reviewer → 1536 MiB, unseen `"x"` → 1 GiB.
  - `TestFootprintsFallBackToDefaults`: missing file, a directory in its place, and `not json` each give the
    default; a `Record` afterwards writes a file that reloads (via `SetStoreDirForTest`).
  - `TestMedianAdmitsWithinFree` (spec): a non-empty book, a key with a 4.6 GB median, 5.0 GB free → `TryAdmit`
    admits; 4.5 GB free → refused, and the held event's `Need` is the median.
  - `TestStartingClaimCountsItsMedian` (spec; replaces the Headroom wording of `TestStartupAllowanceBoundsABurst`):
    a just-admitted claim owes its own median against the next admission until seen or `startupGrace` passes.
  - `TestAdmitNeverHolds`: free 0 and a claim in the book → `Admit` returns a claim, emits no held event, and its
    starting median makes a following worker `TryAdmit` refuse.
  - `TestPeakRecordedOnClose` and `TestPeakRecordedAfterEarlyRelease`: a claim bound to a block with a key; the
    close hook fires with peak P (after `ReleaseOwner` in the second) → `Estimate(key)` reflects P. A close for an
    owner no claim ever bound records nothing and logs nothing.
  - `TestNeverSeenClaimForgetsItsKey`: a claim bound to an owner whose job never shows in live usage; past
    `bindStale` a tick drops it, and the remembered-key map is empty. A seen claim dropped because its job left
    live usage keeps its key until the close hook fires.
  - `TestSetCacheExpiryIsNilSafe`: `(*Claim)(nil).SetCacheExpiry(fn)` does nothing; on a claim,
    `HasCacheExpiryForTest` turns true.
  - Delete `TestWaitAdmitsOnRelease`, `TestWaitCancel`, `TestTryAdmitYieldsToQueuedWait`; replace every
    `Headroom` in tests with the request's estimate.
  Run `go test ./pkg/memgate -run '^(TestEstimateIsTheMedian|TestFootprintsFallBackToDefaults|TestMedianAdmitsWithinFree|TestStartingClaimCountsItsMedian|TestAdmitNeverHolds|TestPeakRecordedOnClose|TestPeakRecordedAfterEarlyRelease|TestNeverSeenClaimForgetsItsKey|TestSetCacheExpiryIsNilSafe)$'`: FAIL to compile.

- [ ] **Step 3: implement memgate.** `footprints.go` restored with the median and decisions 4-6. `Claim` keeps
  its key and need; `startingLocked` claims owe their need; `fitsLocked(need)`: an empty book always admits,
  else `free >= need`. Binding (`Bind`, or `Admit`/`TryAdmit` with an `Owner`) remembers the owner's key per
  decision 2, counted per bind so two live jobs under one owner both record. The close hook looks the key up
  synchronously and writes the peak off the caller's goroutine (`Close` runs on a block's exit path and must not
  wait on the file write), then does what `onJobClosed` does today. Run the Step 2 command: PASS.

- [ ] **Step 4: orchestrate compile edge.** In `maintest_test.go`'s `TestMain` restore
  `memgate.SetStoreDirForTest(filepath.Join(dir, "memgate"))` (as before 0c293eaae). `admitPlanCommand(ctx, dir)`
  per Interfaces, called from `execPlanCommandEnv` with its `dir` (the comment about time held before the
  timeout goes). In `memadmit_test.go`:
  - `TestPlanCommandNeverWaits` (replaces `TestPlanCommandWaitsBeforeTimeout` and
    `TestPlanCommandWaitEndsWithItsContext`): `refuseAllMemory`, then `execPlanCommandEnv` with a Verify owner and
    a 200 ms timeout runs `echo ok` and succeeds within `gateWait`; afterwards `LiveClaimsForTest()` is 1 (only
    the blocker).
  - `TestIdleFinishedWorkerNeverBlocksVerify` (spec): a worker claim bound to a block and free 0 → a Verify
    command runs within `gateWait`.
  - `TestMemProjectKeyFoldsWorktrees`: a worktree of a repo keys to the repo's key.
  - `TestClaimWorkersStopsAtMemory` and `TestFinishedWorkerClaimDoesNotHoldItsReviewer` size free memory from
    `memgate.Estimate(workerRequest(...).Key)` instead of `Headroom`.
  Run `go test ./pkg/orchestrate -run '^(TestPlanCommandNeverWaits|TestIdleFinishedWorkerNeverBlocksVerify|TestMemProjectKeyFoldsWorktrees|TestClaimWorkersStopsAtMemory|TestFinishedWorkerClaimDoesNotHoldItsReviewer|TestDispatchSetupNeverWaits|TestLandAndBaseCheckNeverWait)$'`
  and `go test ./pkg/wshrpc/wshserver -run '^TestSubmitSetupNeverWaits$'`: PASS.

- [ ] **Step 5: commit** `feat(memgate): admit on learned medians; plan commands never wait`.

### Task 2: Workers keyed by project; reviewers and every plan command counted, never held
**Depends on:** Task 1
**Files:** `pkg/orchestrate/memadmit.go`, `pkg/orchestrate/memadmit_test.go`, `pkg/orchestrate/workerslots.go`, `pkg/orchestrate/engine.go`, `pkg/orchestrate/review.go`, `pkg/orchestrate/basecheck.go`, `pkg/orchestrate/land.go`

Covers the reviewer and inline-command half of spec Decision 1; plan decision 7.

**Interfaces:**
- Consumes: `memgate.Admit`, `memgate.Key`, `MemProjectKey` (Task 1).
- Produces: `workerRequest(g *waveobj.TaskGroup, owner *waveobj.Run, taskID string) memgate.Request` keyed
  `{MemProjectKey(owner.ProjectPath), RoleWorker}`; `claimWorkers(ctx, g, owner, next)`.

- [ ] **Step 1: failing tests** (`memadmit_test.go`):
  - `TestIdleFinishedWorkerNeverBlocksItsReviewer` (spec; replaces `TestReviewerHeldAtDoor`): a worker claim bound
    to a block and `refuseAllMemory` → the next `schedule` spawns the reviewer.
  - `TestStartingPlanCommandHoldsAWorker`: free = Verify default + 1 GiB and a starting Verify
    `admitPlanCommand` claim → `claimWorkers` admits no worker; once it is released, the next call admits one.
  - `TestWorkerRequestKeysItsProject`: `workerRequest(g, owner, "t-0").Key` is
    `{MemProjectKey(owner.ProjectPath), RoleWorker}`.
  - `TestDetachedTreeSetupRidesItsCommand`: the Setup ctx `withDetachedTree` builds (extract it as
    `detachedSetupCtx(ctx context.Context) context.Context`) makes `admitPlanCommand` return nil, and keeps the
    owner renamed `Setup`.
  - `TestLandAndBaseCheckNeverWait` keeps passing unchanged.
  Run `go test ./pkg/orchestrate -run '^(TestIdleFinishedWorkerNeverBlocksItsReviewer|TestStartingPlanCommandHoldsAWorker|TestWorkerRequestKeysItsProject|TestDetachedTreeSetupRidesItsCommand|TestLandAndBaseCheckNeverWait|TestClaimWorkersStopsAtMemory|TestDispatchSetupNeverWaits)$'`: FAIL.

- [ ] **Step 2: implement.** Reviewer: `memgate.Admit` keyed `{MemProjectKey(worker.ProjectPath), RoleReviewer}`;
  the "refused" branch and its comment go. `claimWorkers` takes `owner`; `engine.go`'s call passes it.
  `basecheck.go` (`runBaseCheck`) and `land.go` drop `WithGateAdmitted` and their "never wait" comments;
  `withDetachedTree` uses `detachedSetupCtx`, which marks the Setup ctx `WithGateAdmitted`. `WithGateAdmitted`'s
  doc names Setup as its only use. Run the Step 1 command: PASS.

- [ ] **Step 3: commit** `feat(orchestrate): reviewers and plan commands count but never wait`.

### Task 3: Pause only the youngest spiking worker, within its cache
**Depends on:** Task 1
**Files:** `pkg/memgate/gate.go`, `pkg/memgate/reconcile.go`, `pkg/memgate/reconcile_test.go`

Covers spec Decision 4 and plan decisions 8-11.

**Interfaces:**
- Consumes: `(*Claim).SetCacheExpiry(fn func() (time.Time, bool))` from Task 1. Tests set it directly.
- Produces: no new exported names. Constants `spikeRise = 1 * gib`, `pauseMargin = 30 * time.Second`,
  `minPause = 15 * time.Second`.

- [ ] **Step 1: failing tests** (`reconcile_test.go`; add a `fakeMachine.setUse(o, bytes)` beside `setLive`):
  - `TestPausesYoungestSpikingWorker` (spec): three bound, seen workers admitted at t0 < t1 < t2, each with an
    expiry 4 min out; free under `lowWater`; the t2 worker idle (flat at its floor), t0 and t1 rising 2 GiB above
    their floors → one tick suspends t1 only; the next tick, still low, suspends t0.
  - `TestNeverPausesAReviewer` (spec; replaces `TestPauseReviewersBeforeWorkers`): a spiking reviewer with an
    expiry and nothing else pausable → no suspend.
  - `TestPausesOnlyRisingSpikes`: a worker 2 GiB above its floor but equal to its last reading → not paused.
  - `TestNoPauseWithoutKnownCacheExpiry`: expiry func nil, or returning false → not paused.
  - `TestNoPauseNearCacheExpiry` (spec): expiry 40 s out (bound 10 s < `minPause`) → not paused; a younger
    candidate near expiry is skipped for an older one with time left.
  - `TestPauseEndsBeforeCacheExpires` (spec): expiry 2 min out → paused; resumed with reason `limit` once the
    clock reaches expiry − 30 s, not at `pauseLimit`; an expiry 10 min out still ends at `pauseLimit`.
  - `TestCacheExpiryReadWithoutTheBookLock`: the expiry func calls `LiveClaimsForTest()` (which takes `book.mu`)
    and the tick completes.
  - Existing `TestNeverPauseLastTree`, `TestResumeAboveHigh`, `TestPauseLimit`, `TestPausedTreeExit`,
    `TestReleaseOwnerResumesAPausedTreeAndSparesOthers` keep passing, their workers made spiking with a known expiry.
  Run `go test ./pkg/memgate -run '^(TestPausesYoungestSpikingWorker|TestNeverPausesAReviewer|TestPausesOnlyRisingSpikes|TestNoPauseWithoutKnownCacheExpiry|TestNoPauseNearCacheExpiry|TestPauseEndsBeforeCacheExpires|TestCacheExpiryReadWithoutTheBookLock|TestNeverPauseLastTree|TestResumeAboveHigh|TestPauseLimit|TestPausedTreeExit|TestReleaseOwnerResumesAPausedTreeAndSparesOthers)$'`: FAIL.

- [ ] **Step 2: implement.** `tick` sums `Current` per owner; each seen claim keeps its floor and last reading.
  `pausable` is a bound, seen `RoleWorker` that is spiking (decision 9) and past `noPauseBefore`; `rolePauseOrder`
  goes. Candidates are ordered youngest admitted first; for each in turn, read its expiry outside `book.mu`
  (decision 11) and pause the first whose bound (decision 10) is at least `minPause`, storing the bound on the
  claim. One pause per tick; the never-pause-the-last-unpaused-claim rule stays. `resumeLimitedLocked` resumes at
  the stored bound with reason `limit` and sets the cooldown as today. Run the Step 1 command: PASS.

- [ ] **Step 3: commit** `feat(memgate): pause the youngest spiking worker within its prompt cache`.

### Task 4: Hand each worker's cache expiry to the gate, and document the gate
**Depends on:** Task 2
**Files:** `pkg/orchestrate/memadmit.go`, `pkg/orchestrate/memadmit_test.go`, `pkg/orchestrate/engine.go`, `pkg/orchestrate/review.go`, `docs/orchestrator-guide.md`, `docs/reference/architecture.md`

**Interfaces:**
- Consumes: `(*Claim).SetCacheExpiry`, `memgate.HasCacheExpiryForTest` (Task 1, through Task 2).
- Produces: `bindToBlock(c *memgate.Claim, blockId string, run *waveobj.Run)`: binds as today, and when `run` is
  non-nil sets the claim's expiry to `func() (time.Time, bool) { return workerCacheExpiry(run) }`.
  `workerCacheExpiry(run *waveobj.Run) (time.Time, bool)`: `lastActivityForRun(run)` plus
  `consult.ShortSessionCacheTTL` (parsed once); false when the run is untracked or has written no transcript
  (`lastActivityForRun` returns 0).

- [ ] **Step 1: failing tests** (`memadmit_test.go`, using the test sessions root `sessionsRootFor` already
  points at):
  - `TestWorkerCacheExpiry`: a claude run whose transcript was last written at T → `T + 5m, true`; a run with no
    session id → false; a tracked run with no transcript yet → false.
  - `TestDispatchBindsWorkerCacheExpiry`: a scheduled dispatch of one ready task, with the claims the
    `bindClaim` stub collects (`boundClaims`) → the worker's bound claim has `HasCacheExpiryForTest` true; a
    review dag's scheduled reviewer's bound claim has it false. Fails if `engine.go` passes no run.
  Run `go test ./pkg/orchestrate -run '^(TestWorkerCacheExpiry|TestDispatchBindsWorkerCacheExpiry)$'`: FAIL.

- [ ] **Step 2: implement.** `engine.go`'s dispatch passes the child run it just started; `review.go` passes nil
  (reviewers are never paused). Update every `bindToBlock` call in `memadmit_test.go`
  (`TestIdleFinishedWorkerNeverBlocksVerify`, `TestIdleFinishedWorkerNeverBlocksItsReviewer`,
  `TestFinishedWorkerClaimDoesNotHoldItsReviewer`) to pass nil. Run the Step 1 command and
  `go test ./pkg/orchestrate -run '^(TestFinishedWorkerClaimDoesNotHoldItsReviewer|TestUnboundClaimsReleasedAfterTick|TestSpawnFailureReleasesClaim|TestIdleFinishedWorkerNeverBlocksVerify|TestIdleFinishedWorkerNeverBlocksItsReviewer)$'`: PASS.

- [ ] **Step 3: docs.** `docs/reference/architecture.md`'s Memory gate bullet and `docs/orchestrator-guide.md`'s
  worker-cap paragraph (around "a new one only while the machine has at least 3 GB") say: only new workers wait,
  on the median of their project's last 8 learned peaks (defaults per decision 5, `memfootprints.json`);
  reviewers and every plan command start at once and count their median while starting; every Setup rides its
  worker or command; a just-started tree counts its median until seen or 30 s; under 1.5 GB available the loop
  pauses one spiking worker per tick, youngest first, never a reviewer or plan command, and resumes it before its
  5-minute prompt cache would expire (at most 3 minutes). Drop every `Headroom` and "3 GB" wording.

- [ ] **Step 4: commit** `feat(orchestrate): bound worker pauses by their prompt cache; gate docs`.
