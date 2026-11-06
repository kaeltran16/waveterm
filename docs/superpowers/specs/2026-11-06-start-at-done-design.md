# Start-at-done: a cross-lane dependent starts when its predecessor is done

Initiative 78e4fe20, chunk "Build: start-at-done in the engine". The replay (first chunk's notes) puts the gain
at 5.5% of the task phase on runs since 10-16. The owner chose this over contract edges
(`2026-11-06-early-start-contract-design.md`, deferred). No flag: `git revert` is the off switch.

## Today

- `depSatisfied` (pkg/orchestrate/scheduler.go): a same-lane dependency must be done; a cross-lane one waits until
  its whole lane merged (`laneMerged`, pkg/orchestrate/lane.go). Lanes come from `jarvis.Lanes`.
- `scheduleLocked` (pkg/orchestrate/engine.go) resolves one `spawnBase` per tick, the landing head
  (`landingHead`), and `dispatchTasks` creates a new lane's tree there (`EnsureRunWorktree`).
- A task's state goes running -> reviewing (worker finished with a commit) -> done (review passed) or back to
  pending for a fix round (`applyReviewVerdict`, review.go), or review-failed for the lead.
- A cross-lane edge always leaves a lane's last task, and always enters a lane's first task (a fork or a join
  ends and starts lanes). So an early-started task is always the head of its lane, and the lane's tree key is its own.

## Decisions

Given by the goal (1-8), with the calls made from the code marked **call**.

### 1. Readiness

Only when `g.MergeRequired`; without merges nothing changes. Within a lane nothing changes.

A pending task's cross-lane dependencies are grouped by predecessor lane. With every such lane merged it starts as
today. With exactly one unmerged predecessor lane, and that lane **worker-done**, it starts now (early start).
With two or more unmerged predecessor lanes it waits as today.

**call: "done" means worker-done, not review-passed.** The owner's note says "done (not reviewed/merged)" and
decision 5 restarts dependents on a review reject, which only exists if the dependent can start before the review
ends. A lane is worker-done when every non-skipped task is `done` except its tip (last non-skipped task), which is
`reviewing`, `done` or `blocked-merge`, and the tip has a run. `review-failed` does not count: the lead is judging it.

**call: chains of early starts are allowed.** Lane C may start early on lane B, itself early-based on unmerged lane A:
B's tip holds A's work too. The merge hold (4) and the restart cascade (5) both follow the chain.

### 2. Base

An early-started task's tree branches from the predecessor lane's branch tip (`wave/<LaneWorktreeKey(tip)>`,
read with `WorktreeHeadCommit`), not the landing head. The task records `EarlyBaseTask` (the predecessor lane's
tip task id) and `EarlyBaseCommit` (that commit).

**call (plan review 1): an early start waits for the base tip's evidence.** A task enters `reviewing` before its
worker's evidence is sealed, and `predecessorHandoff` reads the For later section from it; a dependent dispatched
before the seal would miss the section for good (7). Dispatch leaves an early-ready task pending until the base
tip's run has `Evidence`.

**call:** both are written only by a dispatch that creates the lane's branch from a predecessor tip, and cleared
only by a restart. A retry of the same task reuses the branch, which still holds the base, so the record must stay.

### 3. No merge into a live tree

Nothing is merged into the dependent's tree while it works. The dependent lane's squash (`MergeRunWorktree`,
`git merge --squash`) lands after the predecessor's squash; the predecessor's changes are on both sides and git
merges identical changes cleanly. A real difference goes to today's conflict path.

**call: the squash message excludes the predecessor's commits.** `mergeMessage` logs `HEAD..wave/<key>`; after the
predecessor's squash its original commits are not ancestors of HEAD, so the dependent's message would repeat them.
`MergeLane` gains `Base string`; when set, the message (and `landedHead`, which compares against it) logs
`Base..wave/<key>`. The merge path passes the lane head's `EarlyBaseCommit`.

### 4. Merge order

A lane whose head has an `EarlyBaseTask` merges only once that task's lane has merged (`laneMerged`). Both the
automatic batch (`laneMergeReady`, so `autoMergeable` and the digest's `mergeReadyTip` agree) and the lead's
`dag merge` (`mergeTaskLocked`, which checks lane states itself) hold it; the latter refuses with an error naming
the base task. Once the base merged, today's `unverifiedDependency` rule holds it during the base's Verify.

### 5. Predecessor review reject: restart

**call: the trigger is a state rule, not a review hook.** An early-based lane is restarted when its base lane has not
merged and its base task is no longer in `reviewing`, `review-failed`, `done`, `blocked-merge`, `verifying` or
`verify-failed`. That catches the review reject (base back to `pending` for a fix round) and also the lead's
retry (`pending`) or skip (`skipped`, whose commits `dropRejectedCommit`/`dropSkippedAttempt` take off the branch)
of a base task, all of which change the base the dependent holds. `review-failed` keeps the dependent running:
the lead may approve the commit as it is, and its retry or skip restarts the dependent then.

Restart, in the tick after the reviews are applied:
- every task of the dependent lane goes back to `pending` (a `skipped` or `cancelled` one keeps its state) with no run and fresh review fields; workers and
  reviewers in flight are cancelled (`cancelTaskRun`, `stopReviewer`) and their processes stopped after commit;
- the lane head gets `DiscardTree = true`, `EarlyRestarts++`, and loses its `EarlyBase*` record;
- lanes early-based on a restarted lane restart in the same tick (to a fixed point);
- a restarted lane is not dispatched in the tick that restarted it (its worker is stopped after the commit);
- the head's `RestartTs` is stamped, and `taskStartBase` (rewind.go) ignores worker runs created before it: the
  fixed tip descends from the discarded branch point, so without it the restarted task's evidence and review base
  (`attemptBase`) would start at the old tip and judge the predecessor's fix as its own;
- `g.Failures` and `Attempts` are untouched: a restart is not a failure;
- a `task-restarted` run event records `{taskid, basetask, reason}`, reason `predecessor review failed` when the
  base went back for a fix round, else `predecessor <state>`; the lead gets a quiet line.

**call: the tree is discarded at the next dispatch, not in the tick.** Removing a tree takes tens of seconds on
Windows and the worker must have exited first. The discard runs before dispatch's "branch exists, so this is a retry" check (2). A dispatch of a task with `DiscardTree` dumps a recovery patch
(best effort, as `EnsureRunWorktree` does), removes the tree, deletes the branch, clears the flag and then creates
the tree from the base readiness picks (the fixed predecessor tip, or the landing head once it merged).

### 6. Predecessor Verify fails

Unchanged: the base lane is merged, so the dependent is never restarted for it and keeps running; a later
conflict goes to today's conflict path.

### 7. Notes for later tasks

`predecessorHandoff` already reads every ancestor's worker report at dispatch, including one under review, so an
early-started dependent has its predecessor's "For later tasks" in its prompt. **call:** `routeForLater` counts an
in-flight descendant as reached "(at dispatch)" instead of typing the section again. The reviewer's downstream note
exists only after the pass and reaches the running dependent through `deliverLater`'s existing tell path
(`sendWakeFn` to its terminal); a test pins that.

### 8. Digest and docs

- `DagReportDigest.Restarted int` sums `EarlyRestarts`; `wsh jarvis dag status` prints it as
  `restarted (predecessor review failed) N`. Not counted as a failure anywhere.
- `DagTaskDigest.EarlyBase string`: the base task id while the task's lane is early-based and that base is unmerged.
- The run timeline labels `task-restarted` ("Task restarted", warning tone, a worker row like `task-retried`) in
  runtimeline.ts, timelinefilter.ts and timelinegroups.ts; the label maps are unit-tested. No Final scenario: it
  is one more label in an existing row type, and no fixture can stage a restart.
- A lane held by its base shows `WaitReason` `merge` with the base task in `BlockingTaskIds`.
- `docs/orchestrator-guide.md`: the lane paragraph (when a dependent starts) and the merge rules.

## Out of scope

The replay script's single-run mode and the re-measure chunk. Joins with two or more unmerged predecessor lanes.
