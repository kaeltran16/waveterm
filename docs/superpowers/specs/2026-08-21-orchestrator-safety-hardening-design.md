# Orchestrator Safety Hardening

Date: 2026-08-21. Status: implementation under review; final verification pending.

Evidence: pending the complete safety gate, including live `dag-lifecycle` verification.

Related:

- `docs/superpowers/specs/2026-08-15-orchestrator-engine-design.md`
- `docs/superpowers/specs/2026-08-20-route-chain-and-dag-modal-design.md`
- `docs/superpowers/specs/2026-08-21-orchestrator-fast-approval-design.md`
- `docs/lead-authored-task-routing-roadmap.md`

## Problem

The structured DAG happy path is implemented and verified, but several engine invariants are not enforced
at the boundaries where concurrent triggers, external worker processes, and persisted state meet.

1. `ScheduleOnce` accepts a detached `TaskGroup` snapshot, performs external spawn work before reserving
   or persisting the task, and finally replaces the current database object with that snapshot. The
   watchdog, DAG actions, child completion, and cancellation can invoke it independently. Two invocations
   can spawn the same task, and a scheduler write can overwrite a concurrent action.
2. The scheduler discards the worker tab oref returned by `SpawnRunWorker`. The child Run therefore does
   not own its worker through `Run.Phases[].WorkerOrefs`, even though DAG ask/answer, evidence, stopping,
   and worker ownership use that field.
3. DAG cancellation changes TaskGroup state but does not stop child workers or cancel child Runs.
   Cancelling the parent Run can call `ScheduleOnce`, allowing a cancelled orchestration to continue.
4. `DagSubmitCommand` accepts client-supplied execution state and enforces fewer structural limits than
   the draft editor. It then inserts the DAG, links the Run, and transitions the Run in separate commits.
   A failure or lost response can leave partial durable state.

These are hidden negative-path failures. The existing happy-path checks remain green:

- `task verify:ui -- surface-smoke dag-lifecycle`: 21/21 steps passed on 2026-08-21.
- `npx vitest run frontend/app/view/orchestrate`: 35/35 tests passed.
- `go test ./pkg/orchestrate`: passed.

The gap is not missing feature breadth. It is that the shipped execution contract is not yet deterministic
under concurrency, cancellation, malformed RPC input, or partial failure.

## Goals

1. At most one worker is spawned for a task transition.
2. Every DAG mutation starts from authoritative persisted state and cannot overwrite another mutation.
3. Every spawned child Run durably owns its worker oref.
4. Cancelling either the DAG or its parent Run cancels child Runs and durably stops child workers.
5. DAG submission is atomic, idempotent for an identical retry, and server-authoritative for execution
   state and limits.
6. Failures at spawn, persistence, cancellation, and notification boundaries are contextual and visible
   to logs or callers; no knowingly orphaned worker is ignored.
7. Preserve the current happy-path product behavior and deferred-Run approval boundary.

## Non-goals

- No new orchestration feature, task state, routing policy, model escalation policy, or planner behavior.
- No persisted spawn reservation or cross-process scheduler lease. Arc has one wavesrv process per store;
  process-crash recovery is a separate design if evidence shows it is needed.
- No live DAG structural editing.
- No channel data-model Phase 3 migration.
- No redesign of the general Run state machine.
- No unrelated frontend accessibility or polish changes; the improvement-scan follow-ons are recorded at
  the end of this document.

## Decisions

### 1. `pkg/orchestrate` owns every DAG mutation

Add a ref-counted keyed lock keyed by DAG OID. The entry owns one in-process mutation at a time and is
removed when no holder or waiter remains.

Public mutation paths become ID-based operations that load the TaskGroup after acquiring the lock:

- schedule/advance;
- approve;
- send back;
- retry;
- skip;
- cancel.

Callers no longer pass a mutable TaskGroup snapshot into scheduling. Pure derivation helpers such as
`ReadyTasks`, `NextToSpawn`, `DeriveTaskStates`, and `RecomputeDagStatus` remain pure and directly testable.

Every current trigger routes through this boundary:

- initial scheduling after DAG submission;
- watchdog ticks;
- child completion/cancellation;
- DAG actions;
- parent-Run cancellation when the Run links to a DAG.

The lock spans the bounded worker spawn attempt. This is deliberate: it avoids a new persisted
`starting` state and makes the current single-process architecture deterministic. The spawn uses
`context.WithoutCancel` plus the existing bounded worker-spawn timeout, so an RPC deadline cannot abandon
a half-created tab. A cancellation arriving mid-spawn waits for that bounded attempt, then stops the newly
attached worker before returning. Independent DAGs remain concurrent because the lock is keyed, not global.

The scheduler reloads the owning Run and TaskGroup after acquiring the lock. Its final persistence cannot
replace state derived outside the lock.

### 2. Child Run ownership includes the spawned worker

The worker oref returned by `jarvis.SpawnRunWorker` is required output, not disposable launch metadata.
For each selected task, scheduling performs this sequence while holding the DAG lock:

1. Resolve route, harness, worktree, prompt, and child Run.
2. Spawn the worker and retain its tab oref.
3. Attach the oref to the child Run's active phase.
4. Persist the child Run.
5. Stamp worker → child Run/channel ownership through `wstore.StampWorkerOwner`.
6. Mark the task running with the child Run ID and persist the TaskGroup.

If worker creation succeeds but child Run persistence fails, the scheduler durably stops the worker before
returning the contextual error. If child Run persistence succeeds but TaskGroup persistence fails, it stops
the worker, cancels the child Run, reloads the group, and records the task failure in a fresh mutation. Any
cleanup failure is returned alongside the original persistence error. It must not knowingly leave a spawned
process unowned.

Move the existing durable worker-stop implementation from `wshserver_runs.go` into the neutral worker
lifecycle boundary in `pkg/jarvis`, beside `SpawnRunWorker`. Both ordinary Runs and DAG Runs reuse it.
The implementation continues to disable `cmd:runonstart` before destroying the controller so a reload
cannot revive a cancelled worker.

Direct child Run ownership fixes the existing consumers without parallel lookup mechanisms:

- `DagAsksCommand` / `DagAnswerCommand`;
- `ReportRunPhaseCommand` ownership resolution and fallback;
- evidence transcript collection;
- worker stop operations;
- liveness/activity projection.

### 3. One cancellation operation owns the full DAG lifecycle

Add an orchestrate cancellation operation under the DAG lock. It:

1. reloads the authoritative TaskGroup;
2. builds the terminal TaskGroup, child Run, and owning Run states;
3. persists those states together in one write transaction;
4. durably stops each child Run's owned workers after commit;
5. publishes the resulting Run/DAG updates.

Persisting terminal state before process shutdown prevents a crash or stop failure from leaving a live-looking
DAG that can schedule more work. The owning orchestrator Run is included when cancellation originated from
the DAG control. The parent-Run path supplies the same owner cancellation to the transaction rather than
performing a second state transition.

Both entry points use this operation:

- `DagActionCommand(action="cancel")`;
- `CancelRunCommand` when the Run is an owning orchestrator Run with `DagORef`.

Parent cancellation must not invoke scheduling afterward. Child Run cancellation may still wake its DAG
when it is an independent child action, but the scheduler reloads the group under the same lock and refuses
to advance a terminal cancelled group.

Persisted cancellation is authoritative even if one process stop fails. The operation returns a contextual
partial-failure error naming the child Run or worker that could not be stopped, while leaving the group and
Runs cancelled. Repeating cancellation is safe and retries durable worker shutdown.

### 4. DAG submission is atomic and idempotent

Keep the current user-visible boundary: planning creates no Run; Launch first creates a deferred
orchestrator Run, then submits its approved DAG. Do not merge planning and launch into one command.

Replace the three independently committed mutations in `DagSubmitCommand` with one `wstore` operation
inside one write transaction:

1. load and validate the deferred owning Run;
2. insert the TaskGroup;
3. link `Run.DagORef`;
4. transition the Run from `planning` to `executing`;
5. update both current Run representations while channel Phase 3 remains unshipped.

No external spawn, broker publication, lifecycle event publication, or model call runs inside the
transaction. Initial scheduling and publication happen only after commit.

Submission is idempotent by owning Run:

- If the Run has no `DagORef`, create and link the group.
- If the Run already links to a DAG whose normalized authoring shape matches the request, return that
  existing group.
- If the linked DAG differs, return a conflict; never replace it silently.

The normalized authoring shape consists of title, parallelism, ordered task IDs, labels, descriptions,
dependencies, gate flags, and child `RunSpec` authoring fields. Engine state, timestamps, failures, release
flags, and child Run IDs are excluded.

The frontend retries `DagSubmitCommand` once with the same deferred Run ID after a rejection. An identical
lost-response retry returns the existing DAG. If the retry also fails, frontend cleanup calls the unified
cancellation path; if the first request actually committed, that cleanup stops the whole DAG rather than
only its parent.

### 5. The server owns initial DAG state and limits

The RPC boundary accepts authoring data only. A submitted task must not carry engine-owned state.

Server validation requires:

- nonblank title;
- 1–8 tasks;
- parallelism from 1 through 8;
- unique, nonblank task IDs;
- nonblank task labels;
- unique dependencies that reference known tasks;
- no self-dependency or cycle;
- runtime and tier supplied together when pinned;
- every effective route resolvable and installed for run-worker operation;
- empty/default `State`, `RunID`, `Released`, and `LastActivity` fields.

Non-default engine fields are rejected rather than silently ignored so stale or direct callers receive a
clear contract error. The server creates a sanitized copy and initializes every task to `pending`; it
initializes group status, failures, timestamps, identity, and version itself.

Backend constants are the authority for the task and parallelism limits. The frontend may mirror the fixed
values for immediate feedback, with contract tests proving parity. Do not add a capability/config API until
the limits need to vary.

## Data and control flow

### Successful launch

1. Frontend plans and edits an ephemeral draft.
2. Launch creates a deferred orchestrator Run.
3. Frontend submits authoring-only DAG data.
4. Backend validates and atomically creates/links/transitions the DAG and Run.
5. Backend publishes committed Run/DAG updates and invokes scheduling by DAG OID.
6. Scheduler acquires the DAG lock, reloads state, spawns one worker per selected task, records ownership,
   persists child Runs/task state, and publishes updates.

### Concurrent trigger

1. Two triggers target the same DAG OID.
2. One acquires the keyed lock; the other waits.
3. The first reloads, spawns, and persists.
4. The second reloads the new state and finds no duplicate work to spawn.

### Cancellation during spawn

1. Scheduler holds the DAG lock during its bounded, RPC-detached spawn attempt.
2. Cancellation waits for that DAG only.
3. Scheduler records ownership or cleans up a failed spawn.
4. Cancellation reloads the resulting state and atomically persists terminal group/Run state.
5. Cancellation durably stops the now-owned workers and reports any partial stop failure.

### Lost submit response

1. The first submit commits but its response is lost.
2. Frontend retries with the same Run ID and proposal.
3. Backend returns the already-linked matching DAG.
4. No duplicate group or worker is created.

## Error handling

| Boundary                            | Required behavior                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Validation or mismatched retry      | Reject before mutation with Run/task context.                                                                                                    |
| Atomic submission                   | Roll back DAG insert, Run link, and status transition together.                                                                                  |
| Route, harness, or worktree setup   | Mark the task failed through the authoritative DAG mutation; do not spawn.                                                                       |
| Spawn before persistence failure    | Durably stop the created worker, cancel any persisted child Run, record task failure from fresh state, and return original plus cleanup context. |
| Cancellation worker-stop failure    | Keep state cancelled; return the specific partial failure; allow idempotent retry.                                                               |
| Notification or lifecycle telemetry | Do not fail scheduling, but log DAG/Run/task context; never discard the error silently.                                                          |
| Broker publication                  | Publish only committed state; a later subscription/read remains authoritative.                                                                   |

## Verification

### Concurrency and state authority

- Persist one pending task, load two independent snapshots, and invoke scheduling concurrently with a
  barrier at the spawn seam. Assert one spawn, one child Run, and one persisted task `RunID`.
- Race a scheduler call with approve/send-back/retry/skip. Assert neither mutation overwrites the other.
- Schedule two different DAGs concurrently. Assert the keyed lock does not serialize unrelated groups.
- Assert lock entries are released after success and failure.

### Worker ownership and ask flow

- Use the real engine path with a spawn seam returning `tab:<id>`; assert the child Run phase contains it.
- Drive DAG ask/list/answer through that child without manually injecting `WorkerOrefs`.
- Assert worker ownership metadata names the child Run and channel.
- Inject child Run or DAG persistence failure after spawn; assert durable worker stop is invoked and any
  persisted child Run is cancelled.
- Expire the initiating RPC context during spawn; assert the bounded detached spawn either completes with
  ownership or cleans up, never leaving a half-created unowned tab.

### Cancellation

- Cancel through `DagActionCommand`; assert parent Run, child Runs, tasks, and group are terminal and every
  owned worker is stopped.
- Cancel the owning Run; assert the same cascade and assert no subsequent worker spawn.
- Repeat cancellation; assert idempotent state and worker cleanup.
- Inject one worker-stop failure; assert persisted cancellation plus contextual partial failure.
- Inject cancellation-transaction failure; assert group, owner, and child Run states all roll back together.
- Cancel an individual child Run; assert it updates its task through scheduling but does not enter the
  owner-only full-DAG cancellation path.

### Submission

- Submit `running`, `done`, stale `RunID`, `Released=true`, and nonzero `LastActivity`; assert rejection.
- Reject blank title/label, duplicate dependency, unknown dependency, self-dependency, cycle, more than
  eight tasks, and parallelism outside 1–8.
- Inject failure at each write within the store operation; assert no partial DAG, link, or status transition.
- Retry an identical proposal; assert the same DAG identity is returned.
- Retry a different proposal for the same Run; assert conflict and no mutation.

### Regression and live verification

Run, at minimum:

```text
go test -race ./pkg/orchestrate ./pkg/wshrpc/wshserver
task generate
npx vitest run frontend/app/view/orchestrate
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
task verify:ui -- dag-lifecycle
```

If the Go package build reaches the sqlite-vec CGO dependency, use the repository-documented include path.
`task generate` must leave no unexplained generated drift. Extend `dag-lifecycle` to cover cancellation
cascade and an idempotent submit retry; planner/action failure UX belongs to the follow-on slice.

## Rollout

1. Implement and independently review this safety spec as one feature commit.
2. Follow with orchestrator failure UX: explicit planner retry, pending/error state for live actions, and
   live-worker cancellation confirmation.
3. Implement independent quick wins separately: EffortCard semantic boundary, shared accessible popovers
   for Radar and Code, and bounded/non-negative-cached favicon fetching.
4. Measure channel blob size and mutation latency before deciding whether to execute the existing channel
   Phase 3 contract design.

No feature flag is required. The safety changes preserve the same commands and happy-path UI; the changed
behavior is stricter invalid-input rejection, idempotent submit retry, complete cancellation, and
single-spawn concurrency.

## Follow-on findings outside this spec

The 2026-08-21 improvement scan also confirmed these bounded items:

- planner rejection can rerun automatically because the planning effect depends on the full
  still-`decomposing` state;
- live DAG actions are fire-and-forget and cancellation bypasses the existing live-worker confirmation;
- `EffortCard` renders nested buttons/inputs inside an outer button, confirmed in the live accessibility
  tree;
- Radar's hand-rolled scope popover lacks local Escape handling and selection semantics; live Escape
  navigated to Cockpit instead of dismissing only the selector;
- Code's handoff popover uses the same hand-rolled interaction pattern;
- favicon fetching reads an unbounded response before checking its size and caches transient failures as
  fresh empty entries for 24 hours;
- channel data-model Phase 3 remains the strategic O(session) write/broadcast improvement, but stays behind
  a measurement gate.

These do not share the safety work's state or failure boundaries and must not be bundled into its
implementation plan.
