# Dispatch off the dag lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Verify:** `node scripts/verify.mjs ./pkg/orchestrate`
**Effort:** effort:cfe52146-96e3-47a6-94b4-a3a2dabdf416

**Goal:** A task's lane tree and Setup are made outside the dag lock, so a tick holds the lock for milliseconds per spawn instead of the 30 s to 4 min it holds today.

**Architecture:** Dispatch becomes two locked passes with the slow work between them. The first pass moves each task it claims to a new persisted state, `preparing`, and returns a prepare job. `runTick` runs the jobs after the lock is released, as it already runs stalled retries. The next locked pass spawns the prepared tasks into their now-warm trees. The task's worker claim and its prepare outcome live in an in-memory registry between the two passes. A `preparing` task with no registry entry (wavesrv restarted mid-prepare) goes back to `pending`.

**Tech Stack:** Go, `pkg/orchestrate`.

**Evidence (no spec):** the evidence and the decision are the notes on effort chunk S-E1 (`wsh effort show cfe52146-96e3-47a6-94b4-a3a2dabdf416`). Every `runTick` lock hold of 30 s or more on 11-11 and 11-12 was 91% `git worktree add` plus Setup inside `dispatchTasks` (engine.go). The cyber_assistant repo's checkouts took 15-55 s. Past 60 s, `RunWorkerSpawnTimeout` killed them, which cost 19 failed attempts on 11-11.

## Global Constraints

- Every dag write still happens under the dag lock (`withDagMutation`). The off-lock prepare writes only the filesystem and the in-memory registry.
- One `Schedule` call still returns with a ready task running (or failed). `runTick` loops until no prepare job is left. Existing tests that call `Schedule` once and assert a spawn must keep passing unchanged.
- No new dependency, no SQL migration (task state is a string on `TaskNode`), no frontend change. The cockpit shows the new state by its raw word, `preparing`.
- Comments say why, lower case, only where needed. Commit message bodies name S-E1.

## Review Focus

1. **A prepare cut short by a wavesrv restart.** The task is stored `preparing` and no registry entry exists. Expected: the next tick puts it back to `pending` and prepares it again, and it never holds a parallelism slot forever (Task 2, `TestAPreparingTaskLostToARestartIsPreparedAgain`).
2. **Cancel while Setup runs.** Expected: no worker spawns, the task reads `cancelled`, the registry holds nothing for the dag, and the prepared tree is removed (Task 2, `TestCancelDuringSetupSpawnsNothing`).
3. **A second tick while a task is preparing** (a worker exit or an RPC pokes `Schedule`). Expected: Setup runs once and one worker spawns (Task 2, `TestAPreparingTaskIsPreparedOnce`).
4. **A lead skip while the task is preparing.** Expected: the task reads `skipped`, no worker spawns, and the registry drops its entry and releases its claim (Task 2, `TestSkipDuringSetupSpawnsNothing`).
5. **Setup or worktree failure in the prepare.** Expected: the same failure, wake, retry and tree removal as today (the existing `TestSetupFailureFailsTheTaskDropsItsWorktreeAndWakesTheLead` and `TestSetupFailureInALaneKeepsItsCommitsForTheRetry` pass unchanged).

---

### Task 1: The `preparing` task state

**Files:** `pkg/orchestrate/dag.go`, `pkg/orchestrate/scheduler.go`, `pkg/orchestrate/scheduler_test.go`, `docs/orchestrator-guide.md`

**Interfaces:**
- Produces: `TaskState_Preparing = "preparing"`, classified so that it holds a parallelism slot, its lane, and a share of the live-worker cap. `CancelGroup` writes `cancelled` over it, and `SkipTask` accepts it.

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

Add a lane case beside `TestNextToSpawnReviewingHoldsItsLane`: two tasks in one lane (t-1 depends on t-0), t-0 `preparing`, Parallelism 2. `NextToSpawn` returns nothing.

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./pkg/orchestrate -run '^(TestNextToSpawnPreparing|TestCancelGroupCancelsAPreparingTask|TestSkipTaskFromPreparing|TestEveryTaskStateIsClassified)'`
Expected: compile error, `undefined: TaskState_Preparing`.

- [ ] **Step 3: Implement in `dag.go` and `scheduler.go`**
  - Add the constant beside the others, with the comment `// claimed for dispatch; its lane tree and Setup are being made outside the dag lock`.
  - Add a `slot bool` column to `taskStateClass`: "holds one of the run's parallelism slots (slotsInUse)". Move that clause out of the `active` comment. `slot` is true for Running, Stalled and Preparing only.
  - `slotsInUse` reads `taskStates[s].slot` instead of `taskActive`.
  - Preparing row: active false (no process, so its exit is no event), inFlight true, slot true, review/landing/settled/terminal false, cancelTo `TaskState_Cancelled`.
  - Add `TaskState_Preparing` to `skippable`.
  - In `docs/orchestrator-guide.md`, the `dag skip` row's state list gains "preparing".

- [ ] **Step 4: Run the tests to see them pass**

Run: `go test ./pkg/orchestrate -run '^(TestNextToSpawn|TestCancelGroup|TestSkipTask|TestEveryTaskStateIsClassified)'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/orchestrate/dag.go pkg/orchestrate/scheduler.go pkg/orchestrate/scheduler_test.go docs/orchestrator-guide.md
git commit -m "feat(orchestrate): a preparing task state that holds its slot and lane" -m "S-E1: dispatch is moving its tree and Setup work out of the dag lock; the task needs a stored state for that span so the cap, its lane and Cancel all see it."
```

### Task 2: Prepare the tree outside the lock, spawn in the next pass

**Files:** `pkg/orchestrate/treeprep.go`, `pkg/orchestrate/treeprep_test.go`, `pkg/orchestrate/engine.go`
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
	worktreeMs int64
	setupMs    int64
	notLinked  []string
}

type treePrepJob struct {
	dagID, taskID, ownerID, projectPath, key, spawnBase, setup string
}

func registerTreePrep(dagID, taskID string, claim *memgate.Claim)
func treePrepFor(dagID, taskID string) (prep treePrep, ok bool) // a copy, under the registry mutex
func takeTreePrep(dagID, taskID string) *treePrep                // removes it; nil when none
func dropTreePreps(dagID string, keep func(taskID string) bool)  // removes and Releases every entry of the dag keep refuses
func treePrepCount(dagID string) int                             // for tests
func prepareTree(ctx context.Context, job treePrepJob)            // off the lock
```

- [ ] **Step 1: Write the failing tests** in `treeprep_test.go`, with `newMergeFixture`, `f.setPlanCommands(t, "", setupCmd)`, `stubPlanCommand` and `stubSpawn` from `setup_test.go`/`mergetask_test.go`. Each test calls `Schedule(f.ctx, f.dagID)` once from the test. The Setup stub does the probing, because it runs where the prepare runs.
  - `TestDispatchRunsSetupOutsideTheDagLock`: the stub records `TryWithDagMutation(f.dagID, func() error { return nil })`'s `ran`. Afterwards: one Setup call, `ran == true`, one spawn, `f.dag(t).Tasks[0].State == TaskState_Running`.
  - `TestATaskIsPreparingWhileItsSetupRuns`: the stub reads `wstore.GetDag` and records `Tasks[0].State`. Want `TaskState_Preparing`.
  - `TestAPreparingTaskIsPreparedOnce`: the stub calls `Schedule(f.ctx, f.dagID)` itself the first time it runs (a second caller's tick). Afterwards: Setup ran once, one spawn, task running.
  - `TestCancelDuringSetupSpawnsNothing`: the stub calls `Cancel(f.ctx, f.dagID)`. Afterwards: no spawn, the task is `TaskState_Cancelled`, `treePrepCount(f.dagID) == 0`, and `worktreeDir(f.project, TaskWorktreeKey(f.ownerID, "t-0"))` does not exist.
  - `TestSkipDuringSetupSpawnsNothing`: the stub calls `ApplyAction(f.ctx, f.dagID, "t-0", "skip", ActionByHuman, waveobj.RoutePin{})`. Afterwards: no spawn, the task is `TaskState_Skipped`, `treePrepCount(f.dagID) == 0`.
  - `TestAPreparingTaskLostToARestartIsPreparedAgain`: before `Schedule`, store `Tasks[0].State = TaskState_Preparing` with no registry entry. Afterwards: Setup ran once, one spawn, task running.
  - `TestSpawnedEventCarriesThePrepareTimings`: the stub sleeps 50 ms. The run's `task-spawned` event has `setupms >= 50`. Read it the way existing event tests do (grep `RunEventKindTaskSpawned` in `*_test.go`).

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./pkg/orchestrate -run '^(TestDispatchRunsSetupOutsideTheDagLock|TestATaskIsPreparingWhileItsSetupRuns|TestAPreparingTaskIsPreparedOnce|TestCancelDuringSetupSpawnsNothing|TestSkipDuringSetupSpawnsNothing|TestAPreparingTaskLostToARestartIsPreparedAgain|TestSpawnedEventCarriesThePrepareTimings)$'`
Expected: compile error (`treePrepCount` undefined). Once it compiles, the lock and state tests fail.

- [ ] **Step 3: Implement `treeprep.go`.** The registry is a package-level map keyed `dagID + "/" + taskID` behind a `sync.Mutex`. `prepareTree` moves today's git branch of `dispatchTasks` (engine.go, from `EnsureRunWorktree` to `markTreeSetUp`) out of the lock, unchanged except:
  - `EnsureRunWorktree` and `laneLeftovers` run on `context.WithTimeout(context.WithoutCancel(ctx), worktreePrepTimeout)` instead of the spawn budget.
  - Setup keeps its context exactly as today (`WithGateAdmitted(withRunCmdOwner(...))`): the claim in the entry still covers it.
  - On a Setup failure the tree dir is removed as today. Both failures are recorded in the entry (`done`, `failKind`, `err`), never in the dag.
  - Afterwards, if `wstore.GetDag` reads the dag `DagStatus_Cancelled`, remove the tree (`removeWorktreeDir`): Cancel's own removal may have run before the tree existed.

- [ ] **Step 4: Rework `engine.go`**
  - `scheduleLocked` returns `([]stalledTask, []treePrepJob, error)`. On a cancelled dag it calls `dropTreePreps(dagID, nil)` before returning.
  - Before `claimWorkers`, a new `settlePreparing(ctx, g, afterCommit) (ready []string, preps map[string]*treePrep)` runs. For each `preparing` task:
    - No entry: back to `TaskState_Pending`, with a log line.
    - Not done: left alone.
    - Done with an error: take the entry, `Release` its claim, and for `FailureKindWorktree` set `CleanupError`/`CleanupAttempts` as `dispatchTasks` does today. Then `failDispatch`.
    - Done without error: take the entry into `ready`/`preps`.

    Then `dropTreePreps(g.OID, keep)`, where `keep` accepts only tasks still `preparing`, so a skip or cancel during the prepare releases its claim.
  - Spawn `ready` through `dispatchTasks`, with claims from `preps` merged into the tick's `claims` map, so the existing `bindToBlock(claims[taskID], deprioritizeWorker(spawnCtx, oref), &childRun)` binds them and the tick's `ReleaseIfUnbound` defer releases one whose spawn failed. `claimWorkers(ctx, g, owner, next)` keeps its signature. Inside the git branch the existing `EnsureRunWorktree` + `treeSetUp` code stays as the fallback for a tree that vanished in between. On a warm tree it is a rev-parse and a status, and it skips Setup. The `task-spawned` event and the prompt's `notLinked` take the prepare's `worktreeMs`, `setupMs` and `notLinked` when `preps` has them.
  - Then `NextToSpawn` → `claimWorkers` as today. For each claimed task in a git project: do the route and harness checks as today (they fail without preparing). Otherwise set it `TaskState_Preparing`, `registerTreePrep` its claim, delete it from `claims` (so the tick's unbound-release defer leaves it alone), and emit a `treePrepJob`. A non-git project has no tree, so its tasks spawn directly in the same pass, as today.
  - `runTick`: after the lock, run `prepareTree` for each job, in order, then loop when any job ran or any stalled task was retried. Run them in order, not in parallel: concurrent `git worktree add` in one repo contends on its locks, and the lock release is the gain.

- [ ] **Step 5: Run the new tests and the dispatch tests they border**

Run: `go test ./pkg/orchestrate -run '^(TestDispatch|TestSetup|TestNoSetupLineRunsNothing|TestATaskIsPreparing|TestAPreparingTask|TestCancelDuringSetup|TestSkipDuringSetup|TestSpawnedEventCarries|TestWorkerNeedIncludesSetup|TestKickHeldRunsTicksDag|TestTaskActionsStop)'`
Expected: PASS, including the existing Setup tests, unchanged.

- [ ] **Step 6: Commit**

```bash
git add pkg/orchestrate/treeprep.go pkg/orchestrate/treeprep_test.go pkg/orchestrate/engine.go
git commit -m "perf(orchestrate): make a task's tree and Setup outside the dag lock" -m "S-E1: on 11-11/11-12 every runTick lock hold of 30 s or more was 91% git worktree add plus Setup inside dispatchTasks; worker exits and RPCs waited up to 224 s behind it, and cyber_assistant checkouts over the 60 s spawn budget were killed. The claim pass now marks the task preparing and runTick prepares its tree after the lock, on a 5 min checkout bound; the next pass spawns into the warm tree."
```
