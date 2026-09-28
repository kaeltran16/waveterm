# Orchestrator findings 48 and 49: an unprepared landing tree, and an outcome lost behind cleanup

Source: run c84aa179 (dag 44b3e104), 2026-09-27. Both gaps are written up under "Also seen in this run" in
`docs/orchestrator-findings-2026-09-25.md`; this spec gives each a cause in the code and a change. They are
recorded there as findings 48 and 49.

## Scope

In:

1. 48: a project can name its default Setup in a checked-in file, and a plan with no Setup line uses it, so every
   tree the engine makes (landing, worker, bisect, base-check, final) is prepared without the plan saying so.
2. 49: tree removal after a merge (and on cancel, the tick's debt retry and `retry-cleanup`) no longer holds the
   dag mutation lock, and a child's outcome is never bound by a deadline shorter than some lock hold.
3. Findings 48 and 49 in the findings doc: a Summary row each and a Fixes section, in the style of 37 to 47.

Out, and why:

- An engine that knows about `node_modules` (or any other ecosystem's directories). Decided against: the engine
  runs other projects too, and a project already has a place to say how a tree is prepared (Setup).
- Re-running Setup in the landing tree when a revised plan (after a failed plan review) changes the Setup line.
  The first submit already prepared the tree, with the project default at least; a changed Setup command on a
  resubmit has not been seen.
- The plan preview (`DagPlanPreviewCommand`) showing the default. It shows what the plan says.
- Setup still runs under the dag lock at spawn (`engine.go`, up to `SetupTimeout`). Change 2b makes an outcome
  survive that hold; shortening it is a separate question.

## 48. The landing tree is prepared only by the plan's Setup line

**What happened.** t-1's merge Verify failed at 02:13:26: `scripts/verify.mjs` ran tsc (t-1 regenerated
`wshclientapi.ts`) and the landing tree `.waveterm/worktrees/c84aa179…` had no `node_modules`. The lead ran
`node scripts/worktree-junctions.mjs prepare` in the tree and `dag merge t-1 --continue`.

**Cause.** The engine prepares a tree only by running the plan's Setup command, and only if there is one:

| Tree | Where Setup runs |
|---|---|
| landing (`.waveterm/worktrees/<runId>`) | `DagSubmitCommand` (`wshserver_dag.go:254`), on the first submit, `if plan.Setup != ""` |
| worker lane | `scheduleLocked` (`engine.go:507`), when `EnsureRunWorktree` created the tree, `if g.Setup != ""` |
| bisect, base check | `withDetachedTree` (`basecheck.go:106`), `if setup != ""` |
| final | `final.go:388`, `if g.Setup != ""` |

c84aa179's plan had no Setup line (`setupms` 0 on every spawn), so no tree was prepared. The workers got by; the
landing tree, where Verify runs, did not. So the landing tree is prepared exactly the way worker trees are.
The gap is that nothing prepares any tree when a plan leaves Setup out, and a plan is written per run by a
lead that may not know the repo needs it.

**Change (decided: a project default Setup file).**

- A project may check in `.arc/setup`: one command, the same shape as a plan's Setup line (POSIX shell, Git Bash on
  Windows). New `orchestrate.ProjectSetup(dir string) (string, error)` reads `<dir>/.arc/setup` and trims it. A
  missing file returns `""` and no error. An unreadable file is an error. So is one that holds more than one
  non-empty line, since a plan's Setup is one command: `.arc/setup must hold one command, found N lines`.
- `DagSubmitCommand`, right after the plan is loaded (plan file or JSON tasks), sets `plan.Setup` from
  `ProjectSetup(jarvis.LandPath(run))` when the plan has none. It reads the landing tree when there is one: that
  tree is at the commit the run builds from, while the project checkout may be on another branch. A submit whose
  file is unreadable or malformed fails with that error before anything is created. From there the existing
  code does the rest unchanged: `proposed.Setup` carries it into `g.Setup`, the landing tree runs it at line 254,
  and every other tree reads `g.Setup`. `ReplacePlanReviewProposal` receives the same `proposed`, so a revised
  plan without a Setup line keeps the default.
- A plan's own Setup line wins over the file. The file is a default, not an addition.
- `jarvis.PlanFormat` adds one clause to its Setup sentence: left out, the project's `.arc/setup` runs, if it has
  one. AGENTS.md's "Plans the engine runs" bullet names the file too.
- This repo checks in `.arc/setup` holding `node scripts/worktree-junctions.mjs prepare`: the command the lead ran
  by hand, and what `task worktree:prepare` runs, without Task's own npm-install check. `final-verify.mjs` already
  replaces the build junctions it needs its own copy of (`BUILD_JUNCTIONS`), and `removeWorktreeDir` unlinks
  junctions before git sees the tree, so a default that junctions is safe in every tree the engine makes.

**Tests (each fails without the change).**

- `TestProjectSetupReadsTheCheckedInDefault` (orchestrate): no file gives `""`; `  cmd arg \n` gives `cmd arg`; two
  command lines give the one-command error.
- Three new subtests of `TestDagSubmitRunsSetupInTheLandingTree` (wshserver), which runs real Setup commands
  through the shell, as its existing subtests do:
  - "a plan with no Setup line runs the project's default": a branch-landed orchestrator run whose landing tree
    holds `.arc/setup`, and a plan with no Setup line. The submit runs the file's command in the landing tree
    (the file it writes exists), and the stored dag's `Setup` is that command.
  - "the plan's Setup line wins over the project default": the plan's command runs; the file's does not.
  - "a malformed default fails the submit": a two-line `.arc/setup` fails the submit with the one-command error.

## 49. A child's outcome times out behind a merge's cleanup

**What happened.** While a merge's worktree cleanup held the dag (39 s for t-2, 22 s for t-1), four finished
sessions' exits logged `jarvis child outcome for …: loading dag for child outcome: context deadline exceeded`, then
`jarvis onexit: no dispatch channel for worker …; outcome not posted` (`waveapp.log`, 02:07:43 and 02:10:38 on
2026-09-27).

**Cause.** Three things combine:

1. `FinishMergedTask` runs `CleanupMergedTask` inside the caller's `withDagMutation` (`mergetask.go:299`, from
   `mergeTaskEntry`, `mergeBatch` and `continueBlockedMerge`). `CleanupTaskWorktree` reaps the lane's workers
   (`reapLaneWorkers`) and then removes the tree, which took 22 to 39 s on Windows. The scheduler tick's debt
   retry (`scheduleLocked` → `RetryPendingCleanup`), `RetryCleanup` and `cancelLocked` do the same under the lock.
2. The workers that `reapLaneWorkers` stops exit, and each exit runs `jarvis.OnWorkerExit`. That gives the whole
   exit a 10 s context and calls `HandleChildOutcome` with it. `HandleChildOutcome` waits on the dag lock the
   reaping cleanup still holds, and its first read inside the lock (`GetDag`) fails on the expired context. The
   cleanup kills the workers and then makes their exits wait on itself.
3. `OnWorkerExit` resolves the dispatch channel after the hook returns, with the same expired context, so the
   channel outcome post is lost too.

In c84aa179 the exits were the reaped workers of tasks already done, so nothing was lost that mattered. The same
path loses anything else that exits during a hold longer than 10 s: a failed worker's outcome is the one that
classifies and retries it. Without it the task sits "running" until the stall watchdog notices, at
`StallThreshold`. Holds longer than 10 s happen on every slow cleanup and on every spawn with Setup (up to 2 min).

**Change (decided: both halves).**

### 49a. Removal runs outside the dag lock

Removing a tree is git and process work on a directory. It is not a read-modify-write of the dag. Only its result
is, and recording a result takes milliseconds.

- New `removeTaskTree(ctx, dagID, taskID string, wait bool) error` in `cleanup.go` is the one way a task's tree
  is removed. The caller must not hold the dag lock. It:
  1. takes a per-tree lock: `treeRemovals`, a `keyedmutex` keyed by the tree's path. So the merge path, the tick's
     retry, cancel and `retry-cleanup` never remove one tree at the same time;
  2. reads the dag fresh. A task with no cleanup debt returns nil: another caller already removed it;
  3. runs `CleanupTaskWorktree` (reap, then `RemoveTaskWorktree`) on that snapshot, with no dag lock held;
  4. records the result under `withDagMutation`. Only this task's `CleanupPending`, `CleanupError` and
     `CleanupAttempts` are written onto the current stored dag, then status is recomputed and published.
     `PersistCleanupState` copies every task's fields from a snapshot, which would overwrite a result another
     tree's removal recorded in between. It gains a task-ID filter, or a per-task sibling;
  5. appends `task-cleanup-completed` or `task-cleanup-failed` and, on success, seals the child's evidence, as
     `CleanupMergedTask` does today.
- `FinishMergedTask` no longer removes the tree. It stamps the merge (Merged, `CleanupPending`, verifying) and
  returns the Verify command. `CleanupMergedTask` is replaced by `removeTaskTree`.
- `mergeTaskEntry` and `continueBlockedMerge` call `removeTaskTree` for the lane tip after the dag lock is
  released and the claim is handed to Verify (`landAfterMerge`). `mergeBatch` does the same for every tip it
  merged, after `startVerify`, so a batch's Verify no longer waits on its cleanups. `mergeTaskLocked`'s
  already-merged-with-debt branch and `ContinueMerge`'s `task.Merged` branch return without cleaning; their callers
  remove the tree after the lock.
- The tick's debt retry moves out of `scheduleLocked` into `Schedule`, before the lock, beside `AutoMergeReady`. It
  calls `removeTaskTree` for each task with debt under the retry cap, and uses a try-lock on the tree, so a tree
  another caller is removing is skipped, not waited on. A stuck tree still never blocks scheduling.
- The startup sweep (`retryCleanupDebtAtStartup`, `cmd/server/main-server.go`) calls `RetryPendingCleanup` and
  `PersistCleanupState` per dag with debt. The tick's retry is exported as `orchestrate.RetryCleanupDebt(ctx,
  dagID)` and the sweep calls it for each such dag. It persists its own results, so the sweep's
  `PersistCleanupState` call goes. `RetryPendingCleanup` is deleted, and so is `PersistCleanupState` if nothing
  outside tests still calls it.
- `RetryCleanup` resets the task's attempts under the dag lock and then calls `removeTaskTree` after releasing
  it.
- `Cancel` keeps its state write and its worker stops under the lock. The recovery-patch dump and tree removal
  loop run after the lock is released, one task at a time through `removeTaskTree`, dump first as today. The
  shared 10 s `cleanupCtx` bounds the stops only. Each removal gets `context.WithoutCancel`, as the merge path's
  does, so one slow tree no longer fails the rest.
- The lock's doc comment (`WithDagMutation`) gains a line on this: work on a tree or a process runs outside the
  lock, and only its result is recorded under it.

### 49b. An outcome survives any lock hold

- `HandleChildOutcome` runs on `context.WithoutCancel(ctx)`. It does this before `withDagMutation`, the way
  `Schedule` detaches its tick. The exit's 10 s read deadline then no longer limits how long it may wait for the
  lock, and the outcome is recorded whenever the lock frees. Setup at spawn (2 min) and any future long hold are
  covered too.
- `OnWorkerExit` resolves the dispatch channel before it calls the child-outcome hook, while its own 10 s context
  is fresh. `PostOutcome` takes no context, so however long the hook waits, the channel post still happens.

**Tests (each fails without the change).**

- `TestMergeRemovesTheTreeWithoutHoldingTheDagLock` (orchestrate): `RemoveTaskWorktree` is stubbed to signal and
  block. While it blocks, inside a merge through `mergeTaskEntry`, `TryWithDagMutation(dagID)` runs. Unblocked, the
  task's debt is cleared and `task-cleanup-completed` is appended.
- `TestAChildOutcomeLandsWhileAMergesTreeIsRemoved` (orchestrate): c84aa179's case. With the removal blocked as
  above, `HandleChildOutcome` for another running task's failed exit, under the exit's real 10 s context,
  returns nil within 5 s and records the failure (the task is retried or failed), before the removal finishes.
  The 10 s context keeps this test independent of 49b: it fails only if the removal holds the lock.
- `TestTheTickSkipsATreeAnotherCallerIsRemoving` (orchestrate): with a merge's removal blocked, a `Schedule` tick
  does not call `RemoveTaskWorktree` a second time, and does not wait for the first.
- `TestRemovingOneTreeKeepsAnotherTreesRecordedResult` (orchestrate): two lanes' removals whose results are
  recorded in either order leave both tasks' cleanup fields as their own removal set them.
- `TestHandleChildOutcomeOutlivesTheExitDeadline` (orchestrate): another goroutine holds the dag lock for 200 ms.
  `HandleChildOutcome` with a 50 ms context and a failed outcome returns nil and records it.
- `TestOnWorkerExitPostsTheOutcomeWhenTheHookOutlivesTheDeadline` (jarvis): a `ChildOutcomeHook` stub that
  sleeps past the exit context's deadline. The outcome is still posted to the dispatch channel. The exit
  deadline becomes a package var (`exitReadTimeout`) so the test can shorten it.
- The existing cleanup, cancel and merge tests keep passing; the ones that call `CleanupMergedTask` or assert
  that cleanup ran inside the lock move to `removeTaskTree`.

## Findings doc

`docs/orchestrator-findings-2026-09-25.md` gains:

- two Summary rows after 47:
  - `| 48 | A merge Verify fails on an unprepared landing tree: no plan Setup line, so no tree is prepared (c84aa179 t-1) | medium | fixed: a project default Setup in .arc/setup |`
  - `| 49 | A child's outcome times out behind a merge's cleanup, which holds the dag lock 22-39 s (c84aa179) | medium | fixed: removal outside the lock; outcomes detached from the exit deadline |`
- a `## Fixes: run c84aa179` section after "Fixes: run 33880f82", a `| # | Fix | Test |` table with one row each,
  written like rows 37 to 47: what changed, in the code's names, and the tests that prove it.
- The two "Also seen in this run" bullets under the c84aa179 live check each end with `(48)` and `(49)`. The 48
  bullet's "Not checked: whether a Setup line would have prepared the landing tree" becomes the answer: it would
  have (`wshserver_dag.go:254`).
