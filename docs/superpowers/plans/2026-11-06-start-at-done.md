# Start-at-done in the engine Implementation Plan

**Effort:** effort:78e4fe20-5d7c-4701-9360-8dd67c792731
**Spec:** `docs/superpowers/specs/2026-11-06-start-at-done-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/orchestrate ./pkg/jarvis ./pkg/waveobj ./pkg/wshrpc/... ./cmd/wsh/cmd`
**Check:** `go vet ./pkg/orchestrate ./pkg/jarvis ./pkg/waveobj ./pkg/wshrpc/... ./cmd/wsh/cmd`

**Goal:** a task whose one unmerged cross-lane predecessor lane is worker-done starts now, on that lane's branch tip,
instead of waiting for the lane's merge.

**Architecture:** readiness (`ReadyTasks`), spawn base (`dispatchTasks`), merge order (`laneMergeReady`,
`mergeTaskLocked`), restart on a base that went back to work (new `earlystart.go`, hooked into `scheduleLocked`),
note routing (`routeForLater`) and the digest each read five new `TaskNode` fields and a few lane predicates that
Task 1 lands first. Every decision and its reason is in the spec; read it before your task.

**Tech Stack:** Go (pkg/orchestrate, pkg/waveobj, pkg/wshrpc), real git in tests where the merge tests use it.

## Global Constraints

- Only when `g.MergeRequired`; a dag without merges behaves exactly as today. Within a lane nothing changes.
- No flag or setting: `git revert` is the off switch.
- A restart is never a failure: `g.Failures` and `Attempts` stay as they are.
- Nothing is ever merged into a running worker's tree.
- Locate code by symbol, not line number. Comments say why, lower case, only when needed.
- `task generate` after changing any waveobj / wshrpc type; never hand-edit the generated files.
- Name each test you add with the focused `go test ./pkg/orchestrate -run '<names>'` run; Verify runs the rest.

## Review Focus

- A retry of an early-started task (worker failed, same branch) must keep `EarlyBase*`: its branch still holds the
  predecessor's commits, so the merge hold and the message base still apply (Task 2 test).
- A predecessor that is skipped or retried by the lead (not only a review reject) restarts the dependent (Task 4 test).
- A predecessor in `review-failed` does not restart the dependent (Task 4 test); the lead's approve then lets both
  merge in order (Task 3 test).
- The dependent lane's squash message holds only its own workers' commits, not the predecessor's (Task 3 test).
- A chain A <- B <- C of early starts: C waits to merge for B, B for A (Task 3 test), and a reject on A restarts B and
  C (Task 4 test).
- A restarted task's evidence and review base start at the predecessor's fixed tip, not the discarded branch point
  (Task 4 test).

---

### Task 1: Early-start fields and lane predicates
**Depends on:** none
**Files:** `pkg/waveobj/wtype.go`, `pkg/waveobj/runevent.go`, `pkg/orchestrate/lane.go`, `pkg/orchestrate/earlystart_test.go`, `frontend/types/gotypes.d.ts`

The interface every other task builds on. No behaviour changes yet.

- [ ] Add to `waveobj.TaskNode` (pkg/waveobj/wtype.go), each with a why-comment:
  (JSON key: the lower-cased name, `omitempty`, as the struct's other fields)
  - `EarlyBaseTask string` — the tip task of the predecessor lane this lane's tree
    branched from before that lane merged; set only on a lane's head.
  - `EarlyBaseCommit string` — that tip's branch commit at the branch point.
  - `EarlyRestarts int` — times the lane restarted because its base went back to work.
  - `DiscardTree bool` — the lane's branch and tree hold discarded work; the next
    dispatch removes them before creating the tree.
  - `RestartTs int64` — UnixMilli of the lane's last restart; worker runs created before it are not the task's start.
- [ ] Add `RunEventKindTaskRestarted = "task-restarted"` to pkg/waveobj/runevent.go (detail keys: `taskid`,
  `basetask`, `reason`).
- [ ] Add to pkg/orchestrate/lane.go:
  - `func laneWorkerDone(g *waveobj.TaskGroup, lane []string) *waveobj.TaskNode` — the lane's tip (`laneTip`) when
    every non-skipped task is `done` except the tip, which is `reviewing`, `done` or `blocked-merge`, and the tip has
    a `RunID`; nil otherwise (also nil for `review-failed`, and when every task was skipped).
  - `func earlyBaseLive(g *waveobj.TaskGroup, t *waveobj.TaskNode) bool` — true when `t.EarlyBaseTask` is empty,
    when the base task's lane has merged (`laneMerged`), or when the base task is `reviewing`, `review-failed`,
    `done`, `blocked-merge`, `verifying` or `verify-failed`; false otherwise (including a base task that no longer exists).
  - `func earlyBaseUnmerged(g *waveobj.TaskGroup, lane []string) *waveobj.TaskNode` — the base task named by the
    lane head's `EarlyBaseTask` while the base's lane has not merged; nil otherwise.
- [ ] Run `task generate`; commit the regenerated `frontend/types/gotypes.d.ts` with the change.
- [ ] Tests in pkg/orchestrate/earlystart_test.go (build groups like `laneGroup` in lane_test.go does):
  `TestLaneWorkerDoneTipReviewing`, `TestLaneWorkerDoneNotWhileEarlierTaskRunsOrTipReviewFailed`,
  `TestEarlyBaseLiveStates` (table over every state named above plus `pending`, `running`, `skipped`, and a merged
  base lane with a `verify-failed` tip, which is live), `TestEarlyBaseUnmergedNilOnceBaseLaneMerged`.
  Run: `go test ./pkg/orchestrate -run 'TestLaneWorkerDone|TestEarlyBaseLive|TestEarlyBaseUnmerged'`.

### Task 2: Readiness and spawn base
**Depends on:** Task 1 (uses laneWorkerDone and the EarlyBase fields)
**Files:** `pkg/orchestrate/scheduler.go`, `pkg/orchestrate/engine.go`, `pkg/orchestrate/digest.go`, `pkg/orchestrate/lane_test.go`, `pkg/orchestrate/earlyready_test.go`
**Files:** `pkg/orchestrate/digest_test.go`, `pkg/orchestrate/verifybatch_test.go`, `pkg/orchestrate/mergetask_test.go`, `pkg/orchestrate/dag_test.go`, `pkg/orchestrate/scheduler_test.go`

Decisions 1 and 2 of the spec.

- [ ] In pkg/orchestrate/scheduler.go add
  `func startBase(g *waveobj.TaskGroup, taskID string) (base *waveobj.TaskNode, ready bool)`:
  without `g.MergeRequired`, every dep done or skipped as today (`base` nil). With merges: same-lane deps must be
  done or skipped as today; cross-lane deps are grouped by their lane; all lanes merged → `(nil, true)`; exactly one
  unmerged lane and `laneWorkerDone` returns its tip → `(tip, true)`; anything else → `(nil, false)`.
  `ReadyTasks` uses it. Keep `depSatisfied` as the per-dependency "merged" rule; in pkg/orchestrate/digest.go,
  `hasUnsatDep`, `taskReady`, `dependencyWait` and `depChainReachesMergeReady` switch to `startBase` (a dep
  blocks only while its task is not ready), so the digest never lists an early-ready task as waiting on a dependency
  or blocked by a merge. Update `depSatisfied`'s comment, and the `predecessorHandoff` comment in engine.go that
  cites it.
- [ ] In `dispatchTasks` (engine.go): when `startBase` gives a base tip and the lane has no branch yet
  (`WorktreeHeadCommit(ctx, owner.ProjectPath, key)` errors), read the tip's branch head with
  `WorktreeHeadCommit(ctx, owner.ProjectPath, LaneWorktreeKey(g, tip.ID))`, create the tree there instead of
  `spawnBase`, and set `task.EarlyBaseTask = tip.ID`, `task.EarlyBaseCommit = <that commit>`. A failure to read the
  tip goes through `failDispatch` with `FailureKindWorktree`. When the lane's branch already exists (a retry), leave
  the tree and the `EarlyBase*` record as they are. Never clear `EarlyBase*` here.
  An early-ready task whose base tip's run (`runs[tip.RunID]`) has no `Evidence` yet is left pending this tick: the
  tip enters `reviewing` before its evidence is sealed, and `predecessorHandoff` reads the For later section from it.
- [ ] Existing merge-required tests that hold a done cross-lane tip with a `RunID` may now see its dependents ready:
  grep the test files on the Files lines (`setTaskStates` in digest_test.go gives done tasks a RunID) and update only
  the cases whose answer the new rule changes, keeping what each case meant to pin.
- [ ] Tests in pkg/orchestrate/earlyready_test.go, on in-memory groups:
  `TestStartBaseForkStartsOnDonePredecessor` (fork: t-1 reviewing with a run, t-2 and t-3 depend on it → both ready
  with base t-1), `TestStartBaseJoinOneUnmergedPredecessor` (join on a merged lane and a worker-done lane → ready,
  base = the unmerged lane's tip), `TestStartBaseJoinTwoUnmergedPredecessorsWaits`,
  `TestStartBaseSameLaneUnchanged` (next in lane ready only once the previous is `done`, base nil),
  `TestStartBaseNotWhilePredecessorRunningOrReviewFailed`, `TestStartBaseWithoutMergesUnchanged`.
  `TestDispatchEarlyStartWaitsForBaseEvidence` (base tip reviewing, its run without `Evidence`: nothing dispatched;
  with it: dispatched). A real-git dispatch test, `TestDispatchEarlyStartBranchesFromPredecessorTip`, on
  `newMergeFixture` (mergetask_test.go, as leftbehind_test.go uses it): the dependent's tree HEAD equals the predecessor's branch tip and the
  task records `EarlyBaseTask`/`EarlyBaseCommit`; then mark the dependent failed, retry it, dispatch again and assert
  the record is unchanged (`TestDispatchEarlyStartRetryKeepsBase`).
  Run: `go test ./pkg/orchestrate -run 'TestStartBase|TestDispatchEarlyStart|TestDepSatisfied|TestReadyTasks'`, then
  the tests you changed in the other files, by name.

### Task 3: Merge order and the squash after the predecessor's squash
**Depends on:** Task 1 (uses earlyBaseUnmerged and the EarlyBase fields)
**Files:** `pkg/orchestrate/lane.go`, `pkg/orchestrate/mergetask.go`, `pkg/orchestrate/merge.go`, `pkg/orchestrate/earlymerge_test.go`

Decisions 3 and 4.

- [ ] `laneMergeReady` (lane.go) returns nil while `earlyBaseUnmerged(g, lane)` is non-nil, so `autoMergeable` and
  `mergeReadyTip` both hold the lane.
- [ ] `mergeTaskLocked` (mergetask.go) refuses the same lane with
  `fmt.Errorf("%w: task %s started on task %s's lane, which has not merged", errProjectBusy, head, base)` before any git
  work, so `mergeBatch` logs it and moves on as it does for `unverifiedDependency`.
- [ ] `MergeLane` (merge.go) gains `Base string`; `mergeLane` (mergetask.go) sets it to the lane head's
  `EarlyBaseCommit`. `mergeMessage` logs `Base..wave/<key>` when `Base` is set, `HEAD..wave/<key>` otherwise;
  `landedHead` follows through `mergeMessage`.
- [ ] Tests in pkg/orchestrate/earlymerge_test.go, real git as merge_test.go sets it up:
  `TestEarlyDependentSquashMergesCleanAfterPredecessor` — lane A commits on its branch from main; lane B's branch is
  created from A's tip and commits its own file (and one edit to a file A also touched, in a different hunk); squash A
  with `MergeRunWorktree`, then squash B: no conflict, the project tree holds both, and B's squash commit message holds
  only B's commit messages. `TestEarlyDependentRealDifferenceConflicts` — A's branch gains a commit after B branched
  that changes a line B also changed: B's squash returns `ErrMergeConflict`.
  `TestEarlyLaneHeldUntilBaseLaneMerged` — in memory: the dependent lane is done and its base lane unmerged →
  `autoMergeable` omits it and `mergeTaskLocked` (through the `mergeWorktree` seam the mergetask tests stub) refuses
  with `errProjectBusy`; once the base lane is `Merged` it is offered. Same test, two more cases: a base in
  `review-failed` holds the dependent until the lead's approve makes it `done`, then the base merges first and the
  dependent after; a chain A <- B <- C offers only A, then B once A merged, then C once B merged.
  Run: `go test ./pkg/orchestrate -run 'TestEarlyDependentSquash|TestEarlyDependentRealDifference|TestEarlyLaneHeld'`.

### Task 4: Restart when the base goes back to work
**Depends on:** Task 2 (hooks into scheduleLocked and dispatchTasks in engine.go)
**Files:** `pkg/orchestrate/earlystart.go`, `pkg/orchestrate/engine.go`, `pkg/orchestrate/rewind.go`, `pkg/orchestrate/earlyrestart_test.go`

Decisions 5 and 6; the spec's "Restart" section lists every effect.

- [ ] New pkg/orchestrate/earlystart.go:
  `func restartEarlyDependents(ctx context.Context, g *waveobj.TaskGroup, afterCommit *[]func()) []string` — to a
  fixed point, for every lane head with `!earlyBaseLive(g, head)`: every task of its lane back to `pending` (a
  `skipped` or `cancelled` task keeps its state)
  (`RunID`, `ReviewRunID`, `ReviewRound`, `ReviewVerdict`, `ReviewNote`, `ReviewBase`, `ReviewCommit` and the other
  review-outcome fields cleared; `LeadNotes` kept; `Attempts` and `g.Failures` untouched); an in-flight worker's run
  cancelled with `cancelTaskRun` and its process stopped after commit with `stopRunWorkers`; a reviewer stopped with
  `stopReviewer`; the head gets `DiscardTree = true`, `EarlyRestarts++`, `RestartTs = now`, `EarlyBaseTask`/`EarlyBaseCommit` cleared.
  After commit: a `RunEventKindTaskRestarted` event `{taskid, basetask, reason}` with reason
  `predecessor review failed` when the base task is `pending` with `ReviewRound > 0`, else `predecessor <state>`, and
  a `PostQuiet` line for the lead. Returns the restarted task ids.
  `func discardLaneTree(ctx context.Context, projectPath, key string) error` — best-effort `DumpRecoveryPatch`, remove
  the tree (`removeWorktreeDir`, tolerating `leftBehind`), `git worktree prune`, delete branch `wave/<key>`; a missing
  tree or branch is not an error.
- [ ] `scheduleLocked` calls `restartEarlyDependents` after `countFailures` and before `NextToSpawn`; its ids are
  removed from `next` and from the returned `stalled` list, so a restarted lane is not dispatched or auto-retried in the
  tick that stopped its worker.
- [ ] `dispatchTasks`: a task with `DiscardTree` runs `discardLaneTree` first, before Task 2's "the lane's branch
  exists, so this is a retry and keeps its record" check (otherwise a restarted head is taken for a retry), then
  clears the flag; an error goes through `failDispatch` with `FailureKindWorktree`.
- [ ] `taskStartBase` (rewind.go) ignores worker runs whose `CreatedTs` is before the task's `RestartTs`: the fixed
  tip descends from the discarded branch point, so the oldest run's `BaseCommit` would make `attemptBase` (and the
  review base) start at the old tip and count the predecessor's fix as this task's work.
- [ ] Tests in pkg/orchestrate/earlyrestart_test.go:
  `TestPredecessorReviewRejectRestartsDependent` — drive a tick with the engine fixture review_test.go uses: base t-1
  reviewing, dependent t-2 running with `EarlyBaseTask = "t-1"`; record a fail verdict for t-1; after the tick t-2 is
  `pending` with no run, `DiscardTree`, `EarlyRestarts == 1`, its worker run cancelled, `g.Failures == 0`, a
  `task-restarted` event with reason `predecessor review failed`, and t-2 not dispatched in that tick.
  `TestPredecessorVerifyFailLeavesDependentRunning` — base lane merged with tip `verify-failed`: t-2 stays `running`
  with its run. `TestPredecessorReviewFailedKeepsDependent` (base `review-failed`: untouched).
  `TestPredecessorSkippedOrRetriedRestartsDependent`. `TestRestartCascadesAlongEarlyChain` (A <- B <- C).
  `TestDiscardLaneTreeDropsBranchAndTree` (real git: after discard, `EnsureRunWorktree` at a new base yields a tree
  whose HEAD is the new base). `TestDispatchDiscardsTreeBeforeRebranching` (the next dispatch of a restarted task
  creates its tree at the predecessor's new tip, records the new `EarlyBaseCommit`, and the new worker run's
  `BaseCommit` is that new tip, not the discarded branch point). `TestRestartKeepsSkippedTask` (a skipped task in the
  restarted lane stays skipped).
  Run: `go test ./pkg/orchestrate -run 'TestPredecessor|TestRestartCascades|TestRestartKeeps|TestDiscardLaneTree|TestDispatchDiscards'`.

### Task 5: Notes for later tasks reach a running dependent once
**Depends on:** none
**Files:** `pkg/orchestrate/review.go`, `pkg/orchestrate/earlynotes_test.go`

Decision 7. `predecessorHandoff` already puts every ancestor's "For later tasks" in a dependent's prompt at dispatch,
including an ancestor still under review; the reviewer's downstream note is delivered by `deliverLater`.

- [ ] `routeForLater`: a target in `later` (an unfinished descendant) that is in flight (`tellRunID(t) != ""`) read
  the section at dispatch: count it as `id + " (at dispatch)"` and type nothing to it. Named targets off the plan's
  edges keep today's delivery. Update the function comment.
- [ ] Tests in pkg/orchestrate/earlynotes_test.go, with the `sendWakeFn` seam the review tests use:
  `TestForLaterNotRetypedToRunningDescendant` — t-1 passes review with a For later section while its dependent t-2
  is running: nothing is typed to t-2 and the quiet line says t-2 was reached at dispatch.
  `TestReviewDownstreamTypedToRunningDependent` — t-1's reviewer leaves a downstream note while t-2 is running: it is
  typed to t-2's terminal and recorded in t-2's `LeadTold`.
  Run: `go test ./pkg/orchestrate -run 'TestForLaterNotRetyped|TestReviewDownstreamTyped'`.

### Task 6: Digest: early base, held merge, restart count
**Depends on:** Task 2
**Files:** `pkg/orchestrate/digest.go`, `pkg/wshrpc/wshrpctypes_dag.go`, `pkg/wshrpc/wshserver/wshserver_dag.go`, `cmd/wsh/cmd/wshcmd-jarvisdag.go`, `frontend/types/gotypes.d.ts`, `pkg/orchestrate/digestearly_test.go`
**Files:** `frontend/app/view/agents/runtimeline.ts`, `frontend/app/view/agents/runtimeline.test.ts`, `frontend/app/view/orchestrate/timelinefilter.ts`, `frontend/app/view/orchestrate/timelinefilter.test.ts`, `frontend/app/view/orchestrate/timelinegroups.ts`, `frontend/app/view/orchestrate/timelinegroups.test.ts`

Decision 8 (digest half).

- [ ] `wshrpc.DagReportDigest` gains `Restarted int` (JSON `restarted`, omitempty; restarts because a predecessor
  went back to work; never a failure); `buildReport` sums `EarlyRestarts`. `wsh jarvis dag status` prints it in the
  report line as `restarted (predecessor review failed) N`, only when N > 0.
- [ ] `wshrpc.DagTaskDigest` gains `EarlyBase string` (JSON `earlybase`, omitempty): the base task id while the
  task's lane has `earlyBaseUnmerged` non-nil.
- [ ] A `done` lane tip held by `earlyBaseUnmerged` gets `WaitReason` `merge` and the base task in `BlockingTaskIds`
  (`taskWaitReason`, `taskBlockingIds`).
- [ ] Add `waveobj.RunEventKindTaskRestarted` to the event kinds pkg/wshrpc/wshserver/wshserver_dag.go retains for the
  digest. Run `task generate`; commit the regenerated `frontend/types/gotypes.d.ts`.
- [ ] Label `task-restarted` on the run timeline the way `task-retried` is: "Task restarted", `text-warning`, a
  worker row, in runtimeline.ts, timelinefilter.ts and timelinegroups.ts (only the maps that list `task-retried`).
  One assertion per map in the test file beside it; run `npx vitest run frontend/app/view/agents/runtimeline.test.ts
  frontend/app/view/orchestrate/timelinefilter.test.ts frontend/app/view/orchestrate/timelinegroups.test.ts` and
  `task check:ts`. No Final scenario: one more label in an existing row type (spec, 8).
- [ ] Tests in pkg/orchestrate/digestearly_test.go: `TestDigestReportCountsRestarts`,
  `TestDigestShowsEarlyBaseAndHeldMerge`, `TestDigestEarlyReadyTaskNotWaitingOnDependency` (also absent from the dependency-waiting list and the
  blocked-by-merge list that `dependencyWait` and `depChainReachesMergeReady` feed).
  Run: `go test ./pkg/orchestrate -run 'TestDigestReportCountsRestarts|TestDigestShowsEarlyBase|TestDigestEarlyReady'`.

### Task 7: Guide: when a dependent starts, and the lane merge rules
**Depends on:** none
**Files:** `docs/orchestrator-guide.md`

Write from the spec's decisions, not from the other tasks' code.

- [ ] In the lanes paragraph ("A task whose dependency is in another lane starts once that lane has merged..."), say:
  with one unmerged predecessor lane whose workers are done (its tip may still be under review), the task starts at
  once on that lane's branch tip; with two or more it waits for their merges; a predecessor's review reject (or the
  lead's retry or skip of it) stops the dependent, discards its tree and restarts it from the fixed tip, counted as
  "restarted", not a failure; a failed predecessor Verify does not restart it.
- [ ] In "Merges batch", add: a lane started on another lane's tip merges only after that lane merged; its squash
  lands the predecessor's identical changes cleanly, and a real difference is an ordinary merge conflict.
- [ ] Mention the predecessor's For later section is in the dependent's prompt and the reviewer's note is typed to it.
  No other section changes.
