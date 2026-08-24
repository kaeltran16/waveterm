# Orchestrator Safety Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DAG scheduling single-spawn, child ownership durable, cancellation complete, and submission atomic and server-authoritative without changing the happy-path product flow.

**Architecture:** `pkg/orchestrate` becomes the only mutation authority for a DAG, guarded by a shared ref-counted keyed mutex and ID-based reloads. Worker process lifecycle moves beside worker spawn in `pkg/jarvis`; DAG submission uses one nested `wstore.WithTx`; cancellation persists terminal Run/DAG state before stopping workers. The frontend keeps the existing deferred-Run launch but submits authoring-only state and retries an idempotent submit once.

**Tech Stack:** Go, SQLite through `txwrap`/`wstore`, typed wshrpc handlers, React 19, TypeScript, Vitest, and the repository CDP verification harness.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-21-orchestrator-safety-hardening-design.md`.
- Do not add a task state, persisted spawn reservation, cross-process lease, feature flag, dependency, or routing/model policy.
- Arc has one wavesrv process per store; serialize by DAG OID in that process while allowing different DAGs to advance concurrently.
- DAG submission accepts 1–8 tasks and parallelism from 1 through 8. The backend is authoritative.
- Never run external worker spawn or worker stop inside a database transaction.
- Persist cancellation state before stopping processes; return partial stop failures without reverting cancellation.
- Keep the existing deferred-Run approval boundary: planning creates no Run.
- Do not hand-edit generated files. Run `task generate` after any wshrpc/waveobj type change and verify generated drift.
- Use `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`; plain `npx tsc` is invalid in this repository.
- Repository Git policy overrides generic plan defaults: do not commit or push during individual tasks. At the end, show status, summary, and proposed commit message, then wait for explicit approval.
- Keep all task changes unstaged until the final approval gate.

---

## File Map

### New files

- `pkg/util/keyedmutex/keyedmutex.go` — reusable ref-counted keyed mutex already needed by Run spawn and DAG mutation.
- `pkg/util/keyedmutex/keyedmutex_test.go` — same-key, different-key, load, and cleanup behavior.
- `pkg/jarvis/runworker.go` — durable stop operations shared by ordinary and DAG workers; shared spawn timeout.
- `pkg/jarvis/runworker_test.go` — verifies `cmd:runonstart=false`, malformed orefs, and aggregate stop errors.
- `pkg/orchestrate/mutation.go` — keyed DAG mutation guard, action application, retry cleanup, and full-DAG cancellation.
- `pkg/orchestrate/mutation_test.go` — action serialization, cancellation transaction, stop behavior, and child-vs-owner cancellation cases.
- `pkg/wstore/wstore_dag_test.go` — atomic create/link/transition and rollback tests.

### Modified files

- `pkg/wshrpc/wshserver/keyedmutex.go` — delete after moving the implementation to `pkg/util/keyedmutex`.
- `pkg/wshrpc/wshserver/keyedmutex_test.go` — delete after moving tests.
- `pkg/wshrpc/wshserver/wshserver_runs.go` — use shared keyed mutex/worker stop, route owner DAG cancellation, and remove post-cancel scheduling.
- `pkg/wshrpc/wshserver/wshserver_run_test.go` — owner cancellation cascade and unchanged ordinary-Run cancellation.
- `pkg/wshrpc/wshserver/wshserver_childrun_test.go` — child cancellation updates its DAG without invoking owner-wide cancellation.
- `pkg/orchestrate/engine.go` — replace snapshot-based `ScheduleOnce` with authoritative `Schedule`, retain worker orefs, detach/bound spawn, and clean up persistence failures.
- `pkg/orchestrate/engine_test.go` — update ID-based calls; add duplicate-spawn, ownership, cleanup, and detached-context tests.
- `pkg/orchestrate/watchdog.go` / `watchdog_test.go` — schedule by DAG OID.
- `pkg/orchestrate/control.go` / `control_test.go` — log lead-notification failures with DAG/Run/event context instead of discarding them.
- `pkg/orchestrate/scheduler.go` / `scheduler_test.go` — keep pure state helpers; remove process-side cancellation from `RetryTask` so mutation orchestration owns ordering.
- `pkg/orchestrate/dag.go` / `dag_test.go` — server limits, authoring validation, sanitized copy, and proposal equality.
- `pkg/wstore/wstore_dag.go` — atomic create-or-get DAG plus Run link/status transition.
- `pkg/wshrpc/wshserver/wshserver_dag.go` — delegate mutation/cancellation, use atomic idempotent submission, and publish only committed state.
- `pkg/wshrpc/wshserver/wshserver_dag_test.go` — invalid engine fields/limits, identical retry, conflict retry, and cancellation cascade.
- `pkg/wshrpc/wshserver/wshserver_dagask_test.go` — build child ownership through the scheduler instead of manually injecting `WorkerOrefs`.
- `frontend/app/view/orchestrate/draftmodel.ts` / `draftmodel.test.ts` — submit empty engine state.
- `frontend/app/view/orchestrate/daglaunch.ts` / `daglaunch.test.ts` — retry submit once before unified cleanup.
- `scripts/cdp/scenarios.mjs` — assert idempotent submit and one-command cancellation cascade.
- `docs/superpowers/specs/2026-08-21-orchestrator-safety-hardening-design.md` — update status/evidence only after all gates pass.

## Interfaces Locked by This Plan

```go
// pkg/util/keyedmutex
func New() *Mutex
func (m *Mutex) Lock(key string)
func (m *Mutex) Unlock(key string)

// pkg/jarvis
const RunWorkerSpawnTimeout = 60 * time.Second
func StopRunWorker(ctx context.Context, workerORef string) error
func StopRunWorkers(ctx context.Context, run *waveobj.Run) error

// pkg/orchestrate
func Schedule(ctx context.Context, dagID string) error
func ApplyAction(ctx context.Context, dagID, taskID, action string) error
func MarkBlockedMerge(ctx context.Context, dagID, childRunID string) error
func Cancel(ctx context.Context, dagID string) error
func SameDagProposal(a, b *waveobj.TaskGroup) bool

// pkg/wstore
func CreateDagForRun(
    ctx context.Context,
    channelID string,
    runID string,
    proposed *waveobj.TaskGroup,
    transition func(*waveobj.Run) error,
) (dag *waveobj.TaskGroup, created bool, err error)
```

---

### Task 1: Extract the Shared Ref-Counted Keyed Mutex

**Files:**

- Create: `pkg/util/keyedmutex/keyedmutex.go`
- Create: `pkg/util/keyedmutex/keyedmutex_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go:31-33,190-191`
- Delete: `pkg/wshrpc/wshserver/keyedmutex.go`
- Delete: `pkg/wshrpc/wshserver/keyedmutex_test.go`

**Interfaces:**

- Produces: `keyedmutex.New() *Mutex`, `(*Mutex).Lock(string)`, and `(*Mutex).Unlock(string)`.
- Consumed by: Task 2 DAG scheduling and the existing `runSpawnLocks` in `wshserver_runs.go`.

- [ ] **Step 1: Create the utility tests before moving production code**

Create `pkg/util/keyedmutex/keyedmutex_test.go` in package `keyedmutex` with the four existing behaviors. Use this exact cleanup assertion so the test can inspect package-private fields:

```go
func TestMutexCleansUpIdleKeys(t *testing.T) {
    m := New()
    m.Lock("a")
    m.Unlock("a")

    m.mu.Lock()
    count := len(m.locks)
    m.mu.Unlock()
    if count != 0 {
        t.Fatalf("idle key not cleaned up: %d entries remain", count)
    }
}
```

Also copy the current same-key serialization, different-key concurrency, and 20-goroutine mutual-exclusion tests, renaming `newKeyedMutex` to `New`.

- [ ] **Step 2: Run the new package test and verify it fails**

Run:

```bash
go test ./pkg/util/keyedmutex
```

Expected: FAIL because package `pkg/util/keyedmutex` has no implementation.

- [ ] **Step 3: Move the implementation with exported package-local vocabulary**

Create `pkg/util/keyedmutex/keyedmutex.go`:

```go
package keyedmutex

import "sync"

type Mutex struct {
    mu    sync.Mutex
    locks map[string]*entry
}

type entry struct {
    mu   sync.Mutex
    refs int
}

func New() *Mutex {
    return &Mutex{locks: make(map[string]*entry)}
}

func (m *Mutex) Lock(key string) {
    m.mu.Lock()
    e := m.locks[key]
    if e == nil {
        e = &entry{}
        m.locks[key] = e
    }
    e.refs++
    m.mu.Unlock()
    e.mu.Lock()
}

func (m *Mutex) Unlock(key string) {
    m.mu.Lock()
    e := m.locks[key]
    e.refs--
    if e.refs == 0 {
        delete(m.locks, key)
    }
    m.mu.Unlock()
    e.mu.Unlock()
}
```

Preserve the copyright header and the existing comment explaining waiter reference counting.

- [ ] **Step 4: Rewire Run spawn and delete the old copy**

In `wshserver_runs.go`, import `github.com/wavetermdev/waveterm/pkg/util/keyedmutex` and replace:

```go
var runSpawnLocks = newKeyedMutex()
```

with:

```go
var runSpawnLocks = keyedmutex.New()
```

Delete the two old `wshserver/keyedmutex*` files only after the new package compiles.

- [ ] **Step 5: Run focused tests**

Run:

```bash
go test ./pkg/util/keyedmutex ./pkg/wshrpc/wshserver
```

Expected: PASS. Do not commit; record this task as an unstaged checkpoint.

---

### Task 2: Make Scheduling ID-Based and Single-Spawn

**Files:**

- Create: `pkg/orchestrate/mutation.go`
- Create: `pkg/orchestrate/mutation_test.go`
- Modify: `pkg/orchestrate/engine.go:44-180`
- Modify: `pkg/orchestrate/engine_test.go`
- Modify: `pkg/orchestrate/watchdog.go:23-33`
- Modify: `pkg/orchestrate/watchdog_test.go`
- Modify: `pkg/orchestrate/control.go:39-122`
- Modify: `pkg/orchestrate/control_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go:78-83,133-143`
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go:623-631,719-727`

**Interfaces:**

- Consumes: `keyedmutex.New` from Task 1.
- Produces: `Schedule(ctx context.Context, dagID string) error` and private `withDagMutation` / `scheduleLocked` helpers.
- Required by: Tasks 3–5.

- [ ] **Step 1: Add a failing concurrent duplicate-spawn test**

In `pkg/orchestrate/mutation_test.go`, seed a channel, owner Run, and one-task persisted DAG. Stub `spawnWorker` with a barrier and call `Schedule` twice:

```go
func TestScheduleSerializesSameDag(t *testing.T) {
    ctx, dag := seedPendingDag(t)
    allowWorkerHarnessForTest(t)

    entered := make(chan struct{})
    release := make(chan struct{})
    var calls atomic.Int32
    old := spawnWorker
    spawnWorker = func(context.Context, runroute.Capability, string, string, string, string) (string, error) {
        if calls.Add(1) == 1 {
            close(entered)
            <-release
        }
        return waveobj.MakeORef(waveobj.OType_Tab, uuid.NewString()).String(), nil
    }
    t.Cleanup(func() { spawnWorker = old })

    errs := make(chan error, 2)
    go func() { errs <- Schedule(ctx, dag.OID) }()
    <-entered
    go func() { errs <- Schedule(ctx, dag.OID) }()
    close(release)
    if err := <-errs; err != nil { t.Fatal(err) }
    if err := <-errs; err != nil { t.Fatal(err) }
    if calls.Load() != 1 {
        t.Fatalf("spawn calls = %d, want 1", calls.Load())
    }
}
```

Add `TestScheduleDifferentDagsProceedConcurrently`: block DAG A's spawn and assert DAG B enters its spawn before A is released.

- [ ] **Step 2: Run the concurrency tests and verify they fail**

Run:

```bash
go test ./pkg/orchestrate -run 'TestSchedule(SerializesSameDag|DifferentDagsProceedConcurrently)' -count=1
```

Expected: FAIL because `Schedule` and the mutation guard do not exist.

- [ ] **Step 3: Add the DAG mutation guard**

Create `pkg/orchestrate/mutation.go` with:

```go
var dagMutationLocks = keyedmutex.New()

func withDagMutation(dagID string, fn func() error) error {
    if dagID == "" {
        return fmt.Errorf("dag id is required")
    }
    dagMutationLocks.Lock(dagID)
    defer dagMutationLocks.Unlock(dagID)
    return fn()
}
```

Do not expose the raw lock outside `pkg/orchestrate`.

- [ ] **Step 4: Replace snapshot scheduling with authoritative reload**

In `engine.go`, replace `ScheduleOnce(ctx, g *TaskGroup)` with:

```go
func Schedule(ctx context.Context, dagID string) error {
    return withDagMutation(dagID, func() error {
        return scheduleLocked(ctx, dagID)
    })
}

func scheduleLocked(ctx context.Context, dagID string) error {
    g, err := wstore.GetDag(ctx, dagID)
    if err != nil {
        return fmt.Errorf("loading dag: %w", err)
    }
    if g.Status == DagStatus_Cancelled {
        return nil
    }
    // existing derive, spawn, persist, and publish body uses this reloaded g
}
```

Keep `scheduleLocked` private; Task 4 may call it only while the same guard is already held.

- [ ] **Step 5: Update every scheduler caller and test**

Replace calls with `Schedule(ctx, g.OID)` in watchdog, submit, actions, and run completion/cancellation paths. Existing tests that inspect the old mutated pointer must reload:

```go
got, err := wstore.GetDag(ctx, g.OID)
if err != nil { t.Fatal(err) }
g = *got
```

In `watchdog.go`, keep the list query but schedule each `g.OID`; never pass its snapshot.

- [ ] **Step 6: Stop discarding lead-notification failures**

In `control.go`, add a test seam and one contextual best-effort wrapper:

```go
var notifyLeadFn = NotifyLead

func notifyLeadBestEffort(ctx context.Context, g *waveobj.TaskGroup, kind, detail string) {
    if err := notifyLeadFn(ctx, g, kind, detail); err != nil {
        log.Printf("dag %s run %s notify lead %s: %v", g.OID, g.RunID, kind, err)
    }
}
```

Replace every `_ = NotifyLead(...)` in `engine.go` and `control.go` with this wrapper. In `control_test.go`, stub `notifyLeadFn` to return `errors.New("write failed")`, redirect the standard logger to a buffer for the test, and assert the log contains DAG OID, Run ID, event kind, and `write failed`.

- [ ] **Step 7: Run focused and race tests**

Run:

```bash
go test ./pkg/orchestrate ./pkg/wshrpc/wshserver
go test -race ./pkg/orchestrate -run 'TestSchedule(SerializesSameDag|DifferentDagsProceedConcurrently)' -count=1
```

Expected: PASS and one spawn for the same DAG. Do not commit.

---

### Task 3: Persist Worker Ownership and Centralize Worker Shutdown

**Files:**

- Create: `pkg/jarvis/runworker.go`
- Create: `pkg/jarvis/runworker_test.go`
- Modify: `pkg/jarvis/runexec.go:68-122`
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go:35-40,190-273`
- Modify: `pkg/orchestrate/engine.go`
- Modify: `pkg/orchestrate/engine_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_dagask_test.go`

**Interfaces:**

- Consumes: `Schedule` and the DAG guard from Task 2.
- Produces: `jarvis.RunWorkerSpawnTimeout`, `jarvis.StopRunWorker`, `jarvis.StopRunWorkers`, and child Runs whose active phase owns the spawned tab oref.
- Required by: Task 4 cancellation and retry cleanup.

- [ ] **Step 1: Write failing worker-stop tests**

Create `pkg/jarvis/runworker_test.go`. Insert a real Tab and Block into the test store, call `StopRunWorker`, reload the Block, and assert:

```go
if got := block.Meta[waveobj.MetaKey_CmdRunOnStart]; got != false {
    t.Fatalf("cmd:runonstart = %#v, want false", got)
}
```

Add cases for a malformed oref, a non-tab oref, a missing tab, and `StopRunWorkers` joining errors from two bad orefs.

- [ ] **Step 2: Write failing engine ownership and cleanup tests**

Add to `engine_test.go`:

```go
func TestSchedulePersistsSpawnedWorkerOwnership(t *testing.T) {
    ctx, dag := seedPendingDag(t)
    worker := waveobj.MakeORef(waveobj.OType_Tab, uuid.NewString()).String()
    stubSpawnWorker(t, worker, nil)

    if err := Schedule(ctx, dag.OID); err != nil { t.Fatal(err) }
    got, _ := wstore.GetDag(ctx, dag.OID)
    child, _ := wstore.GetRun(ctx, got.ChannelId, got.Tasks[0].RunID)
    if len(child.Phases) == 0 || !slices.Equal(child.Phases[0].WorkerOrefs, []string{worker}) {
        t.Fatalf("worker ownership = %+v, want %s", child.Phases, worker)
    }
}
```

Add `TestScheduleStopsWorkerWhenChildPersistFails` using package seams:

```go
oldAppend, oldStop := appendChildRun, stopSpawnedWorker
appendChildRun = func(context.Context, string, waveobj.Run) error { return errors.New("persist failed") }
stopSpawnedWorker = func(context.Context, string) error { stopped = true; return nil }
t.Cleanup(func() { appendChildRun, stopSpawnedWorker = oldAppend, oldStop })
```

Assert the returned error contains both task identity and `persist failed`, and `stopped` is true.

- [ ] **Step 3: Run the new tests and verify they fail**

Run:

```bash
go test ./pkg/jarvis ./pkg/orchestrate -run 'Test(StopRun|SchedulePersistsSpawnedWorkerOwnership|ScheduleStopsWorkerWhenChildPersistFails)' -count=1
```

Expected: FAIL because the shared stop functions and ownership seams do not exist.

- [ ] **Step 4: Move the durable stop implementation**

Create `pkg/jarvis/runworker.go` and move the existing `stopWorkerORef` logic into:

```go
const RunWorkerSpawnTimeout = 60 * time.Second

func StopRunWorker(ctx context.Context, workerORef string) error

func StopRunWorkers(ctx context.Context, run *waveobj.Run) error {
    var errs []error
    for i := range run.Phases {
        for _, workerORef := range run.Phases[i].WorkerOrefs {
            if err := StopRunWorker(ctx, workerORef); err != nil {
                errs = append(errs, fmt.Errorf("%s: %w", workerORef, err))
            }
        }
    }
    return errors.Join(errs...)
}
```

Update ordinary Run cancellation and `StopRunWorkerCommand` to call these exported functions. Replace the local 60-second constant with `jarvis.RunWorkerSpawnTimeout`.

- [ ] **Step 5: Detach and bound DAG spawn**

Inside `scheduleLocked`, create the spawn context once per scheduling call:

```go
spawnCtx := context.WithoutCancel(ctx)
spawnCtx, cancel := context.WithTimeout(spawnCtx, jarvis.RunWorkerSpawnTimeout)
defer cancel()
```

Use `spawnCtx` only for worktree/spawn/worker cleanup operations. Keep persistence on the caller context unless it has expired; when it has, use a separately bounded `context.WithoutCancel(ctx)` cleanup context so a timed-out RPC cannot prevent ownership cleanup.

- [ ] **Step 6: Attach the worker before persisting the child Run**

Add package seams initialized to production functions:

```go
var appendChildRun = wstore.AppendRun
var stopSpawnedWorker = jarvis.StopRunWorker
var stampSpawnedWorker = wstore.StampWorkerOwner
```

After spawn, find the child Run's running phase and set `WorkerOrefs = []string{oref}`. If no running phase exists, stop the worker and return an error. Persist the child, then stamp owner metadata:

```go
runORef := waveobj.MakeORef(waveobj.OType_Run, childRun.ID).String()
channelORef := waveobj.MakeORef(waveobj.OType_Channel, g.ChannelId).String()
if err := stampSpawnedWorker(spawnCtx, oref, runORef, channelORef); err != nil {
    log.Printf("schedule dag %s task %s: stamp worker %s: %v", g.OID, taskID, oref, err)
}
```

Collect every spawned `{childRun, workerORef}` until the final DAG persistence succeeds. On final persistence failure, stop each worker, cancel each persisted child Run, reload the DAG, and attempt one fresh task-failure mutation. Return `errors.Join(original, cleanup...)`.

- [ ] **Step 7: Replace the manual ask fixture with scheduler ownership**

In `wshserver_dagask_test.go`, create the worker Tab/Block first, stub `jarvis.SpawnRunWorker` to return its tab oref, call `orchestrate.Schedule(ctx, g.OID)`, reload the DAG, and load its child Run. Remove this fixture line:

```go
child.Phases[0].WorkerOrefs = []string{"tab:" + tabId}
```

Keep the existing Ask/List/Answer assertions unchanged; they now prove production ownership.

- [ ] **Step 8: Run focused tests**

Run:

```bash
go test ./pkg/jarvis ./pkg/orchestrate ./pkg/wshrpc/wshserver -run 'Test(StopRun|SchedulePersistsSpawnedWorkerOwnership|ScheduleStopsWorkerWhenChildPersistFails|DagAsksAndAnswerRoundTrip)' -count=1
```

Expected: PASS. Do not commit.

---

### Task 4: Route Actions, Retry, and Cancellation Through One DAG Authority

**Files:**

- Modify: `pkg/orchestrate/mutation.go`
- Modify: `pkg/orchestrate/mutation_test.go`
- Modify: `pkg/orchestrate/scheduler.go:89-175`
- Modify: `pkg/orchestrate/scheduler_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go:91-143`
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go:700-735`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_run_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_childrun_test.go`

**Interfaces:**

- Consumes: DAG lock/Schedule from Task 2 and worker ownership/stop from Task 3.
- Produces: `ApplyAction`, `MarkBlockedMerge`, and `Cancel`; all DAG mutation callers stop using `wstore.UpdateDag` directly.
- Required by: Task 6 frontend cleanup and Task 7 live verification.

- [ ] **Step 1: Write a failing full-cancellation test**

In `mutation_test.go`, seed an owning orchestrator Run, a one-task DAG, and a child Run with one worker oref. Stub the worker stop seam and call `Cancel`:

```go
func TestCancelPersistsBeforeStoppingWorkers(t *testing.T) {
    ctx, dag, owner, child := seedRunningDag(t)
    stopObservedCancelled := false
    old := stopRunWorkers
    stopRunWorkers = func(ctx context.Context, run *waveobj.Run) error {
        gotDag, _ := wstore.GetDag(ctx, dag.OID)
        gotOwner, _ := wstore.GetRun(ctx, dag.ChannelId, owner.ID)
        gotChild, _ := wstore.GetRun(ctx, dag.ChannelId, child.ID)
        stopObservedCancelled = gotDag.Status == DagStatus_Cancelled &&
            gotOwner.Status == jarvis.RunStatus_Cancelled &&
            gotChild.Status == jarvis.RunStatus_Cancelled
        return nil
    }
    t.Cleanup(func() { stopRunWorkers = old })

    if err := Cancel(ctx, dag.OID); err != nil { t.Fatal(err) }
    if !stopObservedCancelled { t.Fatal("worker stop ran before terminal state committed") }
}
```

Add tests for idempotent repeat cancellation, partial stop error with persisted cancellation, two different DAG actions not overwriting scheduler state, and `MarkBlockedMerge` changing only the task whose `RunID` matches the conflicted child.

- [ ] **Step 2: Write failing handler tests for owner and child cancellation**

In `wshserver_dag_test.go`, extend cancellation to assert parent Run, child Run, task, and group are terminal and the worker stop seam was called.

In `wshserver_childrun_test.go`, cancel a DAG child Run and assert:

- the child becomes cancelled;
- the owner is not cancelled;
- the full `Cancel` path is not called;
- `Schedule(ctx, dagID)` derives the task state without spawning another worker.

- [ ] **Step 3: Run the cancellation tests and verify they fail**

Run:

```bash
go test ./pkg/orchestrate ./pkg/wshrpc/wshserver -run 'Test(CancelPersistsBeforeStoppingWorkers|Dag.*Cancel|CancelRun.*Dag)' -count=1
```

Expected: FAIL because state-only `CancelGroup` does not cancel Runs or stop workers.

- [ ] **Step 4: Implement action serialization**

In `mutation.go`, define the accepted actions once and add:

```go
func ApplyAction(ctx context.Context, dagID, taskID, action string) error {
    err := withDagMutation(dagID, func() error {
        return applyActionLocked(ctx, dagID, taskID, action)
    })
    if err != nil {
        return err
    }
    return Schedule(ctx, dagID)
}
```

`applyActionLocked` reloads the DAG and performs approve/send-back/skip with `wstore.UpdateDag`. Unknown actions return `unknown dag action` with the action value.

Add `MarkBlockedMerge` as another guarded mutation. It reloads the group, finds the task whose `RunID` equals `childRunID`, sets that task to `blocked-merge`, recomputes group status, and persists. Return a contextual error when no task owns the child Run.

For retry, do not clear the old `RunID` until its worker is durably stopped:

1. under the DAG lock, atomically mark the old child Run cancelled while leaving the task failed with its old `RunID`;
2. stop the old child workers;
3. only after successful stop, mutate the task to pending, clear `RunID`, and reset failures;
4. call `Schedule` after releasing the lock.

If stop fails, leave the task failed with its old Run ID so the watchdog cannot spawn a second worker. A later retry repeats shutdown safely.

Change the pure scheduler helper to this exact interface:

```go
func RetryTask(g *waveobj.TaskGroup, taskID string) error
```

It only changes the already-stopped task to pending, clears `RunID`, resets `Failures`, and recomputes status. Remove `CancelChildRun`; Run persistence and process shutdown belong to `applyActionLocked`, not a pure state helper.

- [ ] **Step 5: Implement atomic terminal-state persistence**

Implement `Cancel(ctx, dagID)` under `withDagMutation`. Use one outer transaction:

```go
err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
    txCtx := tx.Context()
    g, err := wstore.GetDag(txCtx, dagID)
    if err != nil { return err }
    CancelGroup(g)
    if err := wstore.UpdateDag(txCtx, dagID, func(cur *waveobj.TaskGroup) error {
        *cur = *g
        return nil
    }); err != nil { return err }

    runIDs := append([]string{g.RunID}, childRunIDs(g)...)
    for _, runID := range runIDs {
        if err := wstore.UpdateRun(txCtx, g.ChannelId, runID, func(r *waveobj.Run) error {
            *r = jarvis.CancelRun(*r)
            return nil
        }); err != nil { return err }
    }
    return nil
})
```

After commit, reload child Runs and call `stopRunWorkers` for each. Join stop errors with Run identity and publish committed Run/DAG updates. On repeated cancellation, rerun worker shutdown even though state is already terminal.

- [ ] **Step 6: Rewire RPC handlers**

- `DagActionCommand`: resolve `DagORef`, call `orchestrate.Cancel` for cancel or `orchestrate.ApplyAction` otherwise. Remove its direct `UpdateDag` switch.
- `DagMergeCommand`: replace the merge-conflict `wstore.UpdateDag` block with `orchestrate.MarkBlockedMerge(ctx, run.DagORef, data.RunId)`.
- `CancelRunCommand`: before the ordinary path, load `run.DagORef`; if the linked group's `RunID == run.ID`, call `orchestrate.Cancel` and do not call `Schedule` afterward.
- Individual DAG child cancellation keeps the ordinary Run cancellation, then calls `Schedule(ctx, run.DagORef)`.
- Non-DAG Run cancellation remains unchanged except that worker stop uses `jarvis.StopRunWorkers`.

Preserve lifecycle events, parent notifications, Radar investigation recording, and `publishRunUpdate` after the new state operation.

- [ ] **Step 7: Add rollback coverage**

In `mutation_test.go`, install a temporary SQLite trigger that aborts `db_run` update during cancellation. Call `Cancel`, drop the trigger in `t.Cleanup`, then assert the DAG, owner, and child all retain their pre-cancel states. The worker-stop seam must not be called because the transaction did not commit.

- [ ] **Step 8: Run focused and race tests**

Run:

```bash
go test ./pkg/orchestrate ./pkg/wshrpc/wshserver -run 'Test(Cancel|ApplyAction|DagSubmitAndAction|.*Dag.*Cancel)' -count=1
go test -race ./pkg/orchestrate -run 'Test(ScheduleSerializesSameDag|ApplyAction)' -count=1
```

Expected: PASS. Do not commit.

---

### Task 5: Make DAG Submission Validated, Atomic, and Idempotent

**Files:**

- Modify: `pkg/orchestrate/dag.go:20-145`
- Modify: `pkg/orchestrate/dag_test.go`
- Modify: `pkg/orchestrate/scheduler_test.go`
- Modify: `pkg/wstore/wstore_dag.go`
- Create: `pkg/wstore/wstore_dag_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go:26-84`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag_test.go`

**Interfaces:**

- Consumes: `Schedule` from Task 2.
- Produces: authoritative submission validation, `SameDagProposal`, and `wstore.CreateDagForRun`.
- Required by: Task 6 frontend retry and Task 7 live idempotency check.

- [ ] **Step 1: Write failing domain validation tests**

In `dag_test.go`, add table cases for:

```go
const (
    MaxTasks       = 8
    MaxParallelism = 8
)
```

Reject blank title, blank label, duplicate dependency, 9 tasks, parallelism 0, parallelism 9, and non-default `State`, `RunID`, `Released`, or `LastActivity`. Assert a valid input is deep-copied and each resulting task has `State == TaskState_Pending` without mutating the caller's slice.

Update `groupWith` in `scheduler_test.go` to construct tasks with empty state, call `NewTaskGroup`, then apply requested test states to `g.Tasks` afterward. Tests must no longer rely on submission accepting hand-set state.

Add `TestSameDagProposalIgnoresEngineState` and `TestSameDagProposalDetectsAuthoringChange`. Authoring comparison includes ordered IDs, labels, descriptions, deps, gates, and `RunSpec`; it ignores OID/version/status/failures/timestamps/task state/RunID/release/activity.

- [ ] **Step 2: Run domain tests and verify they fail**

Run:

```bash
go test ./pkg/orchestrate -run 'Test(NewTaskGroup|SameDagProposal|ValidateTasks)' -count=1
```

Expected: FAIL because limits, engine-field rejection, and proposal comparison are absent.

- [ ] **Step 3: Implement backend-authoritative construction**

In `dag.go`:

- add `MaxTasks = 8` and `MaxParallelism = 8`;
- reject parallelism outside 1–8 instead of applying `DefaultParallelism`;
- reject blank trimmed title and labels;
- reject duplicate deps in `ValidateTasks`;
- reject non-default engine fields before copying;
- deep-copy tasks, deps, and RunSpec into a new slice;
- initialize copied task state to pending;
- add `SameDagProposal` using explicit field comparison, not JSON or `reflect.DeepEqual` on the full object.

Keep `ValidateTasks` usable by `ImportPitasks`; title and parallelism checks stay in `NewTaskGroup`.

- [ ] **Step 4: Write failing atomic store tests**

Create `wstore_dag_test.go` with:

1. `TestCreateDagForRunCommitsDagLinkAndTransition` — seed a planning Run, call the new operation with a transition callback that verifies orchestrator mode and sets status executing, then assert DAG row, `DagORef`, row-backed Run, and embedded channel Run agree.
2. `TestCreateDagForRunReturnsExisting` — call twice and assert the second result has `created == false` and the same OID.
3. `TestCreateDagForRunRollsBackAllWrites` — install a temporary trigger:

```sql
CREATE TEMP TRIGGER fail_dag_run_update
BEFORE UPDATE ON db_run
BEGIN
  SELECT RAISE(ABORT, 'forced run update failure');
END;
```

Call the operation and assert no `db_dag` row exists, `DagORef` is empty, and Run status remains planning.

- [ ] **Step 5: Run store tests and verify they fail**

Run:

```bash
go test ./pkg/wstore -run TestCreateDagForRun -count=1
```

Expected: FAIL because `CreateDagForRun` is undefined.

- [ ] **Step 6: Implement the atomic store operation**

In `wstore_dag.go`, implement the locked interface exactly. Inside one `WithTxRtn`:

1. load the Channel and find the Run in `ch.Runs`;
2. if `run.DagORef` is set, load and return the existing DAG with `created=false`;
3. call the transition callback;
4. set `run.DagORef = proposed.OID`;
5. `DBInsert(tx.Context(), proposed)`;
6. `DBUpdate(tx.Context(), ch)` once;
7. `dbUpsertObjTx(tx.Context(), run)`;
8. return the proposed group with `created=true`.

Do not publish broker events or schedule inside this function. Nested wstore calls must receive `tx.Context()` so `txwrap` reuses the outer transaction.

- [ ] **Step 7: Rework `DagSubmitCommand` around create-or-get**

Keep input and route validation before persistence. Build a sanitized proposed group with `NewTaskGroup`, then call:

```go
stored, created, err := wstore.CreateDagForRun(ctx, data.ChannelId, data.RunId, &proposed, func(run *waveobj.Run) error {
    if run.Mode != jarvis.RunMode_Orchestrator {
        return fmt.Errorf("dag requires an orchestrator-mode run")
    }
    if run.Status != jarvis.RunStatus_Planning {
        return fmt.Errorf("dag run %s is %s, want planning", run.ID, run.Status)
    }
    run.Status = jarvis.RunStatus_Executing
    return nil
})
```

If `created == false`, require `orchestrate.SameDagProposal(stored, &proposed)` or return a conflict. Append the phase-start event only when `created`. Publish committed objects, then call `Schedule(ctx, stored.OID)` for both created and identical-retry cases so a retry can recover a post-commit/pre-schedule interruption.

- [ ] **Step 8: Expand handler tests**

Change the deferred submit fixture from `State: "ready"` to `State: ""`. Set every successful submit fixture's owner Run to `planning` before persistence; route-rejection fixtures may remain pre-transition because they fail before storage. Add table-driven rejection for every engine-owned field and boundary limit. Replace the current second-different-submit success expectation with:

- identical retry returns the same DAG and does not append a second phase-start event;
- changed title/task returns conflict and leaves the first DAG unchanged.

- [ ] **Step 9: Run focused package tests**

Run:

```bash
go test ./pkg/orchestrate ./pkg/wstore ./pkg/wshrpc/wshserver -run 'Test(NewTaskGroup|SameDagProposal|CreateDagForRun|DagSubmit)' -count=1
```

Expected: PASS. Do not commit.

---

### Task 6: Submit Authoring-Only Payloads and Retry Once Before Cleanup

**Files:**

- Modify: `frontend/app/view/orchestrate/draftmodel.ts:151-200`
- Modify: `frontend/app/view/orchestrate/draftmodel.test.ts:109-145`
- Modify: `frontend/app/view/orchestrate/daglaunch.ts`
- Modify: `frontend/app/view/orchestrate/daglaunch.test.ts`

**Interfaces:**

- Consumes: idempotent `DagSubmitCommand` and unified owner cancellation from Tasks 4–5.
- Produces: payloads with `state: ""` and exactly two submit attempts before one cleanup call.

- [ ] **Step 1: Change payload expectations first**

In `draftmodel.test.ts`, change each submit task expectation from:

```ts
state: "pending";
```

to:

```ts
state: "";
```

Keep all authoring fields and route omission assertions unchanged.

- [ ] **Step 2: Add retry behavior tests**

In `daglaunch.test.ts`, add:

```ts
it("retries the same submit once before cleanup", async () => {
  const deps: DagLaunchDeps = {
    createDeferredRun: vi.fn().mockResolvedValue(run()),
    submitDag: vi
      .fn()
      .mockRejectedValueOnce("response lost")
      .mockResolvedValueOnce({ oid: "dag-1" } as TaskGroup),
    cancelRun: vi.fn(),
  };
  const result = await launchDagDraft(request, draft, deps);
  expect(result).toEqual({ ok: true, channelId: "channel-1", runId: "run-1", dagOref: "dag:dag-1" });
  expect(deps.submitDag).toHaveBeenCalledTimes(2);
  expect(deps.cancelRun).not.toHaveBeenCalled();
});
```

Update the existing submit-failure tests to expect two submit calls, one cancellation, and an error containing both first and retry failures. Keep the cleanup-failure assertion.

- [ ] **Step 3: Run the frontend tests and verify they fail**

Run:

```bash
npx vitest run frontend/app/view/orchestrate/draftmodel.test.ts frontend/app/view/orchestrate/daglaunch.test.ts
```

Expected: FAIL because payload still sends pending and launch submits once.

- [ ] **Step 4: Emit empty engine state**

In `toDagSubmitPayload`, set the generated-required TaskNode field to an empty value:

```ts
state: "",
```

Do not cast around the generated type and do not omit authoring fields.

- [ ] **Step 5: Retry submit exactly once**

In `launchDagDraft`, retain the created Run and payload, call `submitDag` in a two-attempt loop, and preserve both errors:

```ts
const submitErrors: unknown[] = [];
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    const group = await deps.submitDag(request.channelId, run.id, payload);
    return { ok: true, channelId: request.channelId, runId: run.id, dagOref: `dag:${group.oid}` };
  } catch (error) {
    submitErrors.push(error);
  }
}
```

After both failures, call `cancelRun` once. Format the base error as:

```text
DAG submission failed for run <id>: <first>. Retry failed: <second>
```

Append `. Cleanup also failed: <error>` only when unified cancellation rejects.

- [ ] **Step 6: Run focused frontend tests**

Run:

```bash
npx vitest run frontend/app/view/orchestrate
```

Expected: all orchestrator tests pass. Do not commit.

---

### Task 7: Extend Live Verification and Run the Full Safety Gate

**Files:**

- Modify: `scripts/cdp/scenarios.mjs:4539-4735`
- Modify: `docs/superpowers/specs/2026-08-21-orchestrator-safety-hardening-design.md`
- Verify all files from Tasks 1–6.

**Interfaces:**

- Consumes: all prior tasks.
- Produces: observed idempotent submit and cancellation cascade evidence, final test receipts, and a commit approval request.

- [ ] **Step 1: Extend `dag-lifecycle` idempotency coverage**

After the first `dagstatus`, resubmit the same authoring shape through `h.rpc("dagsubmit", ...)` with empty task state. Record a step asserting:

```js
retry.id === g.id && retry.tasks.length === g.tasks.length;
```

Reload channel runs and assert no extra parent or child Run was created by the identical retry.

- [ ] **Step 2: Make DAG cancellation the only cancellation command**

Remove the second explicit `cancelrun` call from the scenario. After:

```js
await h.rpc("dagaction", { channelid: ctx.channelId, runid: runId, taskid: "", action: "cancel" });
```

reload channel Runs and assert:

- owner status is cancelled;
- every child Run whose `dagoref === g.id` is cancelled;
- `dagstatus.status === "cancelled"`;
- a second `dagaction cancel` succeeds and leaves the same terminal state.

Keep teardown best-effort and independent of assertion success.

- [ ] **Step 3: Run formatting and generation before tests**

Run:

```bash
gofmt -w pkg/util/keyedmutex/keyedmutex.go pkg/util/keyedmutex/keyedmutex_test.go pkg/jarvis/runworker.go pkg/jarvis/runworker_test.go pkg/jarvis/runexec.go pkg/orchestrate/mutation.go pkg/orchestrate/mutation_test.go pkg/orchestrate/engine.go pkg/orchestrate/engine_test.go pkg/orchestrate/control.go pkg/orchestrate/control_test.go pkg/orchestrate/watchdog.go pkg/orchestrate/watchdog_test.go pkg/orchestrate/scheduler.go pkg/orchestrate/scheduler_test.go pkg/orchestrate/dag.go pkg/orchestrate/dag_test.go pkg/wstore/wstore_dag.go pkg/wstore/wstore_dag_test.go pkg/wshrpc/wshserver/wshserver_runs.go pkg/wshrpc/wshserver/wshserver_run_test.go pkg/wshrpc/wshserver/wshserver_childrun_test.go pkg/wshrpc/wshserver/wshserver_dag.go pkg/wshrpc/wshserver/wshserver_dag_test.go pkg/wshrpc/wshserver/wshserver_dagask_test.go
npx prettier --write frontend/app/view/orchestrate/draftmodel.ts frontend/app/view/orchestrate/draftmodel.test.ts frontend/app/view/orchestrate/daglaunch.ts frontend/app/view/orchestrate/daglaunch.test.ts scripts/cdp/scenarios.mjs docs/superpowers/specs/2026-08-21-orchestrator-safety-hardening-design.md docs/superpowers/plans/2026-08-21-orchestrator-safety-hardening.md
task generate
```

Inspect `git status --short` immediately. Generated changes are allowed only when source type changes require them; otherwise revert unexplained generated drift.

- [ ] **Step 4: Run targeted Go suites**

Run from Bash:

```bash
CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc" \
  go test ./pkg/util/keyedmutex ./pkg/jarvis ./pkg/orchestrate ./pkg/wstore ./pkg/wshrpc/wshserver
```

Expected: PASS.

- [ ] **Step 5: Run race coverage**

Run:

```bash
CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc" \
  go test -race ./pkg/orchestrate ./pkg/wshrpc/wshserver
```

Expected: PASS with no race report.

- [ ] **Step 6: Run frontend tests and typecheck**

Run:

```bash
npx vitest run frontend/app/view/orchestrate
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: PASS with zero TypeScript errors.

- [ ] **Step 7: Run live CDP verification**

With the dev app running on the repository's configured CDP port:

```bash
task verify:ui -- dag-lifecycle
```

Expected: every step passes, including identical submit retry, owner/child cancellation cascade, idempotent repeat cancellation, and Stage-local modal behavior.

Inspect `cdp-shots/dag-modal.png` and the contact sheet. Confirm the current visual flow is unchanged; this safety work does not redesign the modal.

- [ ] **Step 8: Perform the required final self-review**

Run:

```bash
git diff --check
git status --short
git diff --stat
git diff -- pkg/orchestrate pkg/jarvis pkg/wstore pkg/wshrpc/wshserver frontend/app/view/orchestrate scripts/cdp/scenarios.mjs
```

Review changed lines for clarity, redundant seams, stale comments, swallowed errors, debug output, and unrelated formatting. Verify no files are staged:

```bash
git diff --cached --quiet
```

Expected: exit 0.

- [ ] **Step 9: Update the spec evidence without changing its decisions**

Change the spec status from `awaiting written review` to `implemented and verified`, and append the exact successful command receipts. Do not add new requirements during this documentation step.

- [ ] **Step 10: Present the commit approval gate**

Show:

- every changed file with `M/A/D` status;
- a one-line summary per file group;
- test and live-verification receipts;
- residual risks;
- proposed message: `fix(orchestrate): enforce safe DAG lifecycle`.

Ask exactly:

```text
Awaiting approval. Proceed? (yes/no)
```

Do not run `git add`, `git commit`, or `git push` until the user explicitly answers yes.
