# Dispatch off the dag lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Verify:** `node scripts/verify.mjs ./pkg/orchestrate`
**Effort:** effort:cfe52146-96e3-47a6-94b4-a3a2dabdf416

**Goal:** A task's lane tree and Setup are made outside the dag lock, so a tick holds the lock for milliseconds per spawn instead of the 30 s to 4 min it holds today.

**Architecture:** Dispatch becomes two locked passes with the slow work between them. The first pass moves each task it claims to a new persisted state, `preparing`, and returns a prepare job. `runTick` runs the jobs after the lock is released, as it already runs stalled retries. The next locked pass spawns the prepared tasks into their now-warm trees, reusing the tree path and head the prepare recorded. The task's worker claim and its prepare outcome live in an in-memory registry between the two passes. A `preparing` task with no registry entry (wavesrv restarted mid-prepare) goes back to `pending`.

**Tech Stack:** Go, `pkg/orchestrate`; one frontend constant (`frontend/app/view/agents/runlineage.ts`).

**Evidence (no spec):** the evidence and the decision are the notes on effort chunk S-E1 (`wsh effort show cfe52146-96e3-47a6-94b4-a3a2dabdf416`). Every `runTick` lock hold of 30 s or more on 11-11 and 11-12 was 91% `git worktree add` plus Setup inside `dispatchTasks` (engine.go). The cyber_assistant repo's checkouts took 15-55 s. Past 60 s, `RunWorkerSpawnTimeout` killed them, which cost 19 failed attempts on 11-11.

## Global Constraints

- Every dag write still happens under the dag lock (`withDagMutation`). The off-lock prepare writes only the filesystem and the in-memory registry; what it learns that belongs on the dag (a failure, leftover trees) is recorded in the registry entry and written by the next locked pass.
- One `Schedule` call still returns with a ready task running (or failed). `runTick` loops until no prepare job is left. Existing tests that call `Schedule` once and assert a spawn must keep passing unchanged.
- A dispatch failure still waits for the next `Schedule`: a task that `failDispatch` reset to `pending` (or failed) during one `Schedule` call is not claimed again by a later pass of that same call. Without this, `runTick`'s loop would run every `MaxAutoDispatchRetries` attempt back to back in one call (`TestDispatchFailureIsRetriedOnTheNextTick` pins the one-retry-per-tick behavior).
- No new dependency, no SQL migration (task state is a string on `TaskNode`). The one frontend change: `runEngineBusy` counts a `preparing` task as in flight (Task 1). Every other cockpit view shows the new state by its raw word, `preparing`; no other frontend mapping is added.
- Comments say why, lower case, only where needed. Commit message bodies name S-E1.

## Review Focus

1. **A prepare cut short by a wavesrv restart.** The task is stored `preparing` and no registry entry exists. Expected: the next tick puts it back to `pending` and prepares it again, and it never holds a parallelism slot forever (Task 2, `TestAPreparingTaskLostToARestartIsPreparedAgain`).
2. **Cancel while Setup runs.** Expected: no worker spawns, the task reads `cancelled`, the registry holds nothing for the dag, and the prepared tree is removed (Task 2, `TestCancelDuringSetupSpawnsNothing`).
3. **A second tick while a task is preparing** (a worker exit or an RPC pokes `Schedule`). Expected: Setup runs once and one worker spawns (Task 2, `TestAPreparingTaskIsPreparedOnce`).
4. **A lead skip while the task is preparing.** Expected: the task reads `skipped`, no worker spawns, and the registry drops its entry and releases its claim (Task 2, `TestSkipDuringSetupSpawnsNothing`).
5. **Setup or worktree failure in the prepare.** Expected: the same failure, wake, retry and tree removal as today (the existing `TestSetupFailureFailsTheTaskDropsItsWorktreeAndWakesTheLead` and `TestSetupFailureInALaneKeepsItsCommitsForTheRetry` pass unchanged).
6. **A Setup that leaves untracked files in the tree.** `EnsureRunWorktree` rebuilds any tree whose `git status --porcelain` is non-empty. Expected: the spawn pass reuses the prepared tree and never calls `EnsureRunWorktree` on it, so Setup runs once and its output survives (Task 2, `TestASetupThatLeavesUntrackedFilesRunsOnce`).
7. **A spawn that fails after its prepare.** Expected: the task is `pending` with one attempt after that `Schedule`, and the retry waits for the next call (Task 2, `TestADispatchFailedAfterItsPrepareWaitsForTheNextTick`).

---

### Task 1: The `preparing` task state

**Files:** `pkg/orchestrate/dag.go`, `pkg/orchestrate/scheduler.go`, `pkg/orchestrate/scheduler_test.go`, `docs/orchestrator-guide.md`, `frontend/app/view/agents/runlineage.ts`, `frontend/app/view/agents/runlineage.test.ts`

**Interfaces:**
- Produces: `TaskState_Preparing = "preparing"`, classified so that it holds a parallelism slot, its lane, and a share of the live-worker cap (`busyTaskIDs` counts `inFlight`). `CancelGroup` writes `cancelled` over it, and `SkipTask` accepts it. The cockpit's `runEngineBusy` reads it as engine work.

- [ ] **Step 1: Write the failing tests** in `scheduler_test.go`, using `groupWith`:

```go
// a preparing task's tree and Setup are being made for its worker: it holds the slot the worker will use
func TestNextToSpawnPreparingHoldsSlot(t *testing.T) {
	g := groupWith(TaskState_Done, TaskState_Preparing)
	g.Parallelism = 1
	if got := NextToSpawn(g); len(got) != 0 {
		t.Fatalf("a preparing task must hold its slot, got %v", got)
	}
}

func TestCancelGroupCancelsAPreparingTask(t *testing.T) {
	g := groupWith(TaskState_Done, TaskState_Preparing)
	CancelGroup(g)
	if g.Tasks[1].State != TaskState_Cancelled {
		t.Fatalf("cancel: preparing -> %s, want cancelled", g.Tasks[1].State)
	}
}

func TestSkipTaskFromPreparing(t *testing.T) {
	g := groupWith(TaskState_Done, TaskState_Preparing)
	if err := SkipTask(g, "t-1"); err != nil || g.Tasks[1].State != TaskState_Skipped {
		t.Fatalf("skip from preparing: err=%v state=%s", err, g.Tasks[1].State)
	}
}
```

Add `TestNextToSpawnPreparingHoldsItsLane` beside `TestNextToSpawnReviewingHoldsItsLane`, mirroring it: the same two-task lane built with `NewTaskGroup` (t-1 depends on t-0), Parallelism 2, `g.Tasks[1].State = TaskState_Preparing`, t-0 left `pending`. `NextToSpawn` returns nothing (t-0 is ready by its deps, so only the lane can hold it).

In `runlineage.test.ts`'s `describe("runEngineBusy")`, add `"preparing"` to the task states the existing loop asserts busy (line ~486, `tasks("done", state)`).

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./pkg/orchestrate -run '^(TestNextToSpawnPreparing|TestCancelGroupCancelsAPreparingTask|TestSkipTaskFromPreparing|TestEveryTaskStateIsClassified)'` and `npx vitest run frontend/app/view/agents/runlineage.test.ts`
Expected: Go compile error, `undefined: TaskState_Preparing`; the vitest `preparing` case fails.

- [ ] **Step 3: Implement in `dag.go`, `scheduler.go` and `runlineage.ts`**
  - Add the constant beside the others, with the comment `// claimed for dispatch; its lane tree and Setup are being made outside the dag lock`.
  - Add a `slot bool` column to `taskStateClass`: "holds one of the run's parallelism slots (slotsInUse)". Move that clause out of the `active` comment. `slot` is true for Running, Stalled and Preparing only.
  - `slotsInUse` (dag.go) reads `taskStates[s].slot` instead of `taskActive`.
  - Preparing row: active false (no process, so its exit is no event), inFlight true, slot true, review/landing/settled/terminal false, cancelTo `TaskState_Cancelled`.
  - Add `TaskState_Preparing` to `skippable`.
  - `runlineage.ts`: `TASK_IN_FLIGHT` gains `"preparing"`. A prepare takes 15-55 s and more on a large repo, and the lead is idle through it.
  - In `docs/orchestrator-guide.md`, the `dag skip` row's state list gains "preparing".

- [ ] **Step 4: Run the tests to see them pass**

Run: `go test ./pkg/orchestrate -run '^(TestNextToSpawn|TestCancelGroup|TestSkipTask|TestEveryTaskStateIsClassified)'` and `npx vitest run frontend/app/view/agents/runlineage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/orchestrate/dag.go pkg/orchestrate/scheduler.go pkg/orchestrate/scheduler_test.go docs/orchestrator-guide.md frontend/app/view/agents/runlineage.ts frontend/app/view/agents/runlineage.test.ts
git commit -m "feat(orchestrate): a preparing task state that holds its slot and lane" -m "S-E1: dispatch is moving its tree and Setup work out of the dag lock; the task needs a stored state for that span so the cap, its lane, Cancel and the cockpit's busy read all see it."
```

### Task 2: Prepare the tree outside the lock, spawn in the next pass

**Files:** `pkg/orchestrate/treeprep.go`, `pkg/orchestrate/treeprep_test.go`, `pkg/orchestrate/engine.go`, `pkg/orchestrate/memadmit.go`, `pkg/orchestrate/mutation.go`
**Chunk:** S-E1: dispatch out of the dag lock (worktree + Setup + spawn), raise the spawn budget off the lock

**Interfaces:**
- Consumes: `TaskState_Preparing` (Task 1).
- Produces (in `treeprep.go`):

```go
// worktreePrepTimeout bounds one lane tree's checkout off the lock. cyber_assistant checkouts took 15-55 s and
// RunWorkerSpawnTimeout (60 s) killed the slower ones; this only stops a hung git.
const worktreePrepTimeout = 5 * time.Minute

// treePrep is one task's tree preparation, from the tick that claims the task to the tick that spawns or fails it
type treePrep struct {
	claim      *memgate.Claim // the worker's admission, held through Setup and bound at spawn
	done       bool
	failKind   string // FailureKindWorktree or FailureKindSetup, set with err
	err        error
	wt, head   string   // the prepared tree and its head, which the spawn pass uses while wt exists
	leftovers  []string // laneLeftovers' result, written to the task's CleanupError by the spawn pass
	worktreeMs int64
	setupMs    int64
	notLinked  []string
}

type treePrepJob struct {
	dagID, taskID, ownerID, projectPath, key, spawnBase, setup string
}

func registerTreePrep(dagID, taskID string, claim *memgate.Claim)
func treePrepFor(dagID, taskID string) (prep treePrep, ok bool)     // a copy, under the registry mutex
func finishTreePrep(dagID, taskID string, outcome treePrep) bool    // sets done and the outcome fields; false (a no-op) when the entry is gone
func takeTreePrep(dagID, taskID string) *treePrep                    // removes it; nil when none
func dropTreePreps(dagID string, keep func(taskID string) bool)      // removes and Releases every entry of the dag keep refuses
func treePrepCount(dagID string) int                                 // for tests
func prepareTaskTree(ctx context.Context, job treePrepJob)           // off the lock
```

- [ ] **Step 1: Write the failing tests** in `treeprep_test.go`, with `newMergeFixture`, `f.setPlanCommands(t, "", setupCmd)`, `stubPlanCommand` and `stubSpawn` from `setup_test.go`/`mergetask_test.go`. Each test calls `Schedule(f.ctx, f.dagID)` once from the test unless it says otherwise. The Setup stub does the probing, because it runs where the prepare runs.
  - `TestDispatchRunsSetupOutsideTheDagLock`: the stub records `TryWithDagMutation(f.dagID, func() error { return nil })`'s `ran`. Afterwards: one Setup call, `ran == true`, one spawn, `f.dag(t).Tasks[0].State == TaskState_Running`.
  - `TestATaskIsPreparingWhileItsSetupRuns`: the stub reads `wstore.GetDag` and records `Tasks[0].State`. Want `TaskState_Preparing`.
  - `TestAPreparingTaskIsPreparedOnce`: the stub calls `Schedule(f.ctx, f.dagID)` itself the first time it runs (a second caller's tick). Afterwards: Setup ran once, one spawn, task running.
  - `TestASetupThatLeavesUntrackedFilesRunsOnce`: the stub writes an untracked, non-ignored file (`os.WriteFile(filepath.Join(dir, "setup-output.txt"), ...)`). Afterwards: Setup ran once, one spawn, task running, and the file still exists in the spawned worker's cwd (the tree was not rebuilt).
  - `TestADispatchFailedAfterItsPrepareWaitsForTheNextTick`: Setup succeeds; the spawn fails once (`allowWorkerHarnessForTest(t)` then `stubFlakySpawn(t, 1)` from engine_test.go, instead of `stubSpawn`). After the first `Schedule`: the task is `pending` with `Attempts == 1` and Setup ran once. After a second `Schedule`: the task is running.
  - `TestCancelDuringSetupSpawnsNothing`: the stub calls `Cancel(f.ctx, f.dagID)`. Afterwards: no spawn, the task is `TaskState_Cancelled`, `treePrepCount(f.dagID) == 0`, and `worktreeDir(f.project, TaskWorktreeKey(f.ownerID, "t-0"))` does not exist.
  - `TestSkipDuringSetupSpawnsNothing`: the stub calls `ApplyAction(f.ctx, f.dagID, "t-0", "skip", ActionByHuman, waveobj.RoutePin{})`. Afterwards: no spawn, the task is `TaskState_Skipped`, `treePrepCount(f.dagID) == 0`.
  - `TestAPreparingTaskLostToARestartIsPreparedAgain`: before `Schedule`, store `Tasks[0].State = TaskState_Preparing` with no registry entry. Afterwards: Setup ran once, one spawn, task running.
  - `TestSpawnedEventCarriesThePrepareTimings`: the stub sleeps 50 ms. The run's `task-spawned` event has `setupms >= 50`. Read it the way existing event tests do (grep `RunEventKindTaskSpawned` in `*_test.go`).

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./pkg/orchestrate -run '^(TestDispatchRunsSetupOutsideTheDagLock|TestATaskIsPreparingWhileItsSetupRuns|TestAPreparingTaskIsPreparedOnce|TestASetupThatLeavesUntrackedFilesRunsOnce|TestADispatchFailedAfterItsPrepareWaitsForTheNextTick|TestCancelDuringSetupSpawnsNothing|TestSkipDuringSetupSpawnsNothing|TestAPreparingTaskLostToARestartIsPreparedAgain|TestSpawnedEventCarriesThePrepareTimings)$'`
Expected: compile error (`treePrepCount` undefined). Once it compiles, the lock and state tests fail.

- [ ] **Step 3: Implement `treeprep.go`.** The registry is a package-level map keyed `dagID + "/" + taskID` behind a `sync.Mutex`. `prepareTaskTree` moves today's git branch of `dispatchTasks` (engine.go, from `EnsureRunWorktree` to `markTreeSetUp`) out of the lock, unchanged except:
  - `EnsureRunWorktree` and `laneLeftovers` run on `context.WithTimeout(context.WithoutCancel(ctx), worktreePrepTimeout)` instead of the spawn budget.
  - Setup (or, with no Setup line, the default link step) keeps its context exactly as today (`WithGateAdmitted(withRunCmdOwner(...))`): the claim in the entry still covers it. `PrepareTree`'s condition stays `g.Setup == "" || !treeSetUp(wt)`.
  - On a Setup failure the tree dir is removed as today. Every outcome (failure kind and error, or `wt`, `head`, `leftovers`, timings, `notLinked`) is recorded with one `finishTreePrep` call, never in the dag.
  - The entry can vanish while the prepare runs (a skip or cancel's pass calls `dropTreePreps`): `finishTreePrep` then returns false and the prepare records nothing more.
  - Afterwards, if `wstore.GetDag` reads the dag `DagStatus_Cancelled`, remove the tree (`removeWorktreeDir`): Cancel's own removal may have run before the tree existed.

- [ ] **Step 4: Rework `engine.go`**
  - `scheduleLocked` takes `retried map[string]bool` (owned by `runTick`, shared by every pass of one `Schedule`) and returns `([]stalledTask, []treePrepJob, error)`. On a cancelled dag it calls `dropTreePreps(dagID, nil)` before returning.
  - Before `claimWorkers`, a new `settlePreparing(ctx, g, retried, afterCommit) (ready []string, preps map[string]*treePrep)` runs. For each `preparing` task:
    - No entry: back to `TaskState_Pending`, with a log line.
    - Not done: left alone.
    - Done with an error: take the entry, `Release` its claim, and for `FailureKindWorktree` set `CleanupError`/`CleanupAttempts` as `dispatchTasks` does today. Then `failDispatch`, and add the task to `retried`.
    - Done without error: take the entry into `ready`/`preps`, and when its `leftovers` is non-empty set `CleanupError`/`CleanupAttempts` from it as `dispatchTasks` does today.

    Then `dropTreePreps(g.OID, keep)`, where `keep` accepts only tasks still `preparing`, so a skip or cancel during the prepare releases its claim.
  - Spawn `ready` through `dispatchTasks`, with claims from `preps` merged into the tick's `claims` map, so the existing `bindToBlock(claims[taskID], deprioritizeWorker(spawnCtx, oref), &childRun)` binds them and the tick's `ReleaseIfUnbound` defer releases one whose spawn failed. `claimWorkers(ctx, g, owner, next)` keeps its signature. `dispatchTasks` takes `preps`: for a task with a prep whose `wt` still exists, it uses the prep's `wt` and `head` and skips `EnsureRunWorktree`, `laneLeftovers`, Setup and the link step entirely (`EnsureRunWorktree` would rebuild a tree that Setup left untracked files in). The `task-spawned` event and the prompt's `notLinked` take the prep's `worktreeMs`, `setupMs` and `notLinked`. Only when the prep's `wt` has vanished does the existing `EnsureRunWorktree` + Setup code run, under the lock, as the fallback it is today. Every task whose spawn `failDispatch`es is added to `retried`.
  - Then `NextToSpawn` → `claimWorkers` as today, with tasks in `retried` filtered out of `NextToSpawn`'s result first. For each claimed task in a git project: do the route and harness checks as today (they fail without preparing). Otherwise set it `TaskState_Preparing`, `registerTreePrep` its claim, delete it from `claims` (so the tick's unbound-release defer leaves it alone), and emit a `treePrepJob`. A non-git project has no tree, so its tasks spawn directly in the same pass, as today.
  - `runTick`: after the lock, run `prepareTaskTree` for each job, in order, then loop when any job ran or any stalled task was retried. In order keeps one tick's checkouts from multiplying its memory and disk load; another `Schedule` call can prepare beside it, which is safe because `repoAdminMu` already serializes the engine's worktree-registry git commands and each Setup runs on its own worker's admission.
  - `scheduleTickTimeout`: resize for the new shape, `MaxParallelism*(worktreePrepTimeout+SetupTimeout+jarvis.RunWorkerSpawnTimeout) + 10*time.Minute`, and rewrite its comment: each dispatched task now spends up to `worktreePrepTimeout` on its tree and `SetupTimeout` on Setup off the lock, then a spawn budget in the spawn pass, and every pass after the first runs on this tick's context.
  - Comments that say Setup runs under the dag lock now lie: update `dispatchTasks`' "no progress sink" comment (Setup runs off the lock in `prepareTaskTree` and still has no sink; say so only if a reason remains, else drop it), `workerRequest` in `memadmit.go` ("under the dag lock"), and in `mutation.go` the `WithDagMutation` "(a Setup aside)" clause, `TryWithDagMutation`'s "Setup command holds this lock for up to SetupTimeout", and `cancelDag`'s "held for minutes (Setup)". Each keeps the fallback in mind: a vanished prepared tree is the one case Setup still runs under the lock.

- [ ] **Step 5: Run the new tests and the dispatch tests they border**

Run: `go test ./pkg/orchestrate -run '^(TestDispatch|TestSetup|TestNoSetupLineRunsNothing|TestATaskIsPreparing|TestAPreparingTask|TestASetupThatLeaves|TestADispatchFailedAfterItsPrepare|TestCancelDuringSetup|TestSkipDuringSetup|TestSpawnedEventCarries|TestKickHeldRunsTicksDag|TestTaskActionsStop)'`
Expected: PASS, including the existing Setup and dispatch-retry tests, unchanged.

- [ ] **Step 6: Commit**

```bash
git add pkg/orchestrate/treeprep.go pkg/orchestrate/treeprep_test.go pkg/orchestrate/engine.go pkg/orchestrate/memadmit.go pkg/orchestrate/mutation.go
git commit -m "perf(orchestrate): make a task's tree and Setup outside the dag lock" -m "S-E1: on 11-11/11-12 every runTick lock hold of 30 s or more was 91% git worktree add plus Setup inside dispatchTasks; worker exits and RPCs waited up to 224 s behind it, and cyber_assistant checkouts over the 60 s spawn budget were killed. The claim pass now marks the task preparing and runTick prepares its tree after the lock, on a 5 min checkout bound; the next pass spawns into the warm tree it recorded."
```
