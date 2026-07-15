# Cancel run — partial-failure warning surface — design

## Context

The core "Cancel actually stops its live workers" work shipped (spec
`docs/superpowers/specs/2026-07-14-cancel-run-stops-workers-design.md`): `CancelRunCommand` mutates the
run to `cancelled` then calls `stopRunWorkers`, which flips each worker block's `cmd:runonstart` off and
`DestroyBlockController`s it (killing the `claude` process; the idle-on-exit backstop flips the roster
row `working → idle`). That pass was **silent best-effort** — `stopRunWorkers` is `void` and swallows
every boundary error.

The 2026-07-14 Addendum explicitly deferred the **partial-failure warning surface** (recorded in
`docs/deferred.md`): "if any worker cannot be stopped: visible warning, list survivors, per-worker stop
action, never report a clean cancellation while owned workers are still active." This spec closes that.

## Problem statement

After a Cancel, a worker can still be alive — because a boundary step failed (a `cmd:runonstart=false`
meta-write failed, so a later resync revives it), or because the process outlived the attempt. When that
happens the run must **not** present as a clean "cancelled": it must show a visible warning listing the
surviving workers and offer a per-worker stop action, so the user can finish the cancellation.

## Key realization: liveness is already derivable, not missing

The original deferral imagined reworking the backend into *failure-reporting* — a return value / durable
status the FE surfaces. But the frontend **already holds the truth**: `liveWorkers(run, agents)`
(`runmodel.ts`) derives, from the mirrored roster, exactly which of a run's recorded workers are still
alive (state `!== "idle"`; an exited worker reports `idle` via the backstop, a torn-down one has no
roster row at all). So "never report a clean cancellation while owned workers are still active" is a
**pure derivation over live state**, not a new persisted field.

The only capability genuinely missing today is a way to stop **one** surviving worker.

Rejected alternatives (see the Addendum's own framing):
- **Durable `Run.CancelSurvivors` field** — a second source of truth that drifts from the live roster
  (a survivor that dies on its own leaves a stale entry), plus a DB migration + `task generate` churn,
  for no truth the roster doesn't already have. Rejected on single-source-of-truth / YAGNI.
- **Backend post-kill verification** (re-poll `GetBlockControllerRuntimeStatus` / OS process) —
  duplicates what the roster + idle-on-exit backstop already provide. YAGNI.

## Design

### Backend (`pkg/wshrpc/wshserver/wshserver.go` + wshrpc types + generated bindings)

1. **Extract `stopWorkerORef(ctx, workerORef) error`** — the per-worker kill currently inlined in
   `stopRunWorkers`'s inner loop (parse the `tab:<id>` oref; load the tab; for each block flip
   `cmd:runonstart=false` and `DestroyBlockController`). Returns an error for the boundary failures
   (bad oref, missing tab) so a caller that wants them can see them. `stopRunWorkers` keeps calling it
   in its loop with the same logged, best-effort, never-fatal posture (the run's cancelled state is
   already persisted).

2. **Pure `runOwnsWorker(run *waveobj.Run, workerORef string) bool`** — true iff `workerORef` appears in
   some phase's `WorkerOrefs`. Unit-testable; guards the new command so it can only stop a worker the
   run actually owns (never an arbitrary tab).

3. **New RPC `StopRunWorkerCommand(ctx, {ChannelId, RunId, WorkerORef})`**:
   - Validate the three fields are non-empty.
   - Load the run (`wstore.GetRun`); if `!runOwnsWorker(run, WorkerORef)`, return an error (the run does
     not own this worker).
   - Call `stopWorkerORef`; then `wcore.SendWaveObjUpdate(channel)`.
   - The kill's *success* is observed via the roster flipping to `idle` (the idle-on-exit backstop), so
     the FE re-derives survivors and the row drops out — the command returns an error only for
     validation / ownership failures, consistent with the roster-as-truth model.
   - Register in `wshrpctypes.go`; run `task generate` to regen `wshclient.go` + `wshclientapi.ts`.
     **No new `Run` field, no DB migration.**

### Frontend

4. **`runmodel.ts`** — pure `cancelSurvivors(run, agents): AgentVM[]`:
   `run.status === "cancelled" ? liveWorkers(run, agents) : []`. This is the single place the warning
   keys off. Unit-tested in `runmodel.test.ts`.

5. **`runactions.ts`** — `stopRunWorker(channelId, runId, workerORef)` wrapper over the new RPC, plus a
   `stoppingWorkerIdsAtom` (a `Set<string>` of in-flight worker tab ids, mirroring the existing
   `cancellingRunIdsAtom` pattern) so the per-worker button can read "Stopping…" (disabled) while its
   RPC is in flight.

6. **`runbody.tsx`**:
   - **`CancelSurvivorsCard`** — rendered once at run-body level when
     `run.status === "cancelled" && cancelSurvivors(run, agents).length > 0`. Error-toned, mirroring
     the existing `BlockedCard` styling: heading "Cancelled — N worker(s) still running", one line of
     copy, then per survivor a row with **[Take control]** (`jumpToAgent(model, worker.id)`) and
     **[Stop]** (`stopRunWorker`, showing "Stopping…" while its tab id is in `stoppingWorkerIdsAtom`).
   - **Header status pill** — when `cancelSurvivors` is non-empty, the pill reads
     `cancelled · N still running` in an error tone (reusing the `blocked` tone class) instead of the
     clean muted "cancelled", so the header itself never lies. `runStatusView` stays pure/status-only;
     the survivor annotation is applied at the pill call site from `cancelSurvivors`.

### Data flow

```
Cancel → CancelRunCommand (unchanged): status→cancelled, stopRunWorkers best-effort
   │
   ├─ a worker survives (meta-write failed → resync-revivable, or process outlived the attempt)
   │     → its roster row stays non-idle
   │
FE render of the cancelled run:
   cancelSurvivors(run, agents) = liveWorkers(run, agents)   (status===cancelled)
     │  non-empty →
     ├─ header pill: "cancelled · N still running" (error tone)
     └─ CancelSurvivorsCard: per survivor [Take control] [Stop]
             Stop → stopRunWorker → StopRunWorkerCommand
                      runOwnsWorker guard → stopWorkerORef (runonstart=false + DestroyBlockController)
                      → process dies → idle-on-exit backstop → roster row → idle
                      → cancelSurvivors recomputes → row drops out; card empties → unmounts
```

### Error handling & self-healing

- Kill-path boundary errors (bad oref, missing tab, meta-write failure) stay logged and best-effort in
  `stopWorkerORef` / `stopRunWorkers`. `StopRunWorkerCommand` surfaces only the ownership/validation
  error to the caller.
- No state to reconcile: a survivor that later exits on its own → roster `idle` → row drops out; a
  resync-revived worker → roster `working` → row reappears. The warning tracks reality because it is
  derived from reality.

## Testing

- **Pure unit tests:** `cancelSurvivors` (`runmodel.test.ts`) — cancelled+live→survivors,
  non-cancelled→[], idle excluded, deduped across phases; `runOwnsWorker` (Go) — owned vs. not-owned
  oref. Frontend typecheck clean (`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`).
- **Impure kill path:** not unit-tested in isolation — consistent with `stopRunWorkers` /
  `spawnRunWorkers` / `SpawnClaudeWorker`, which are untested for the same in-memory-registry +
  process-lifecycle reason.
- **Live (CDP, dev app):** a genuinely un-killable backend survivor is hard to force (the kill blocks on
  `DoneCh`), so drive the **FE surface** via an injected fixture — a `cancelled` run whose worker roster
  row is still `working` — to verify the header pill, the `CancelSurvivorsCard`, and the per-worker Stop
  wiring. Real backend-survivor reproduction is best-effort and may be deferred, matching the repo norm
  for the impure run commands.

## Touchpoints

- `pkg/wshrpc/wshserver/wshserver.go` — `stopWorkerORef` (extracted), `runOwnsWorker`,
  `StopRunWorkerCommand`.
- `pkg/wshrpc/wshrpctypes.go` — `StopRunWorkerCommand` interface entry + `CommandStopRunWorkerData`.
- Generated: `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts` (via
  `task generate`).
- `frontend/app/view/agents/runmodel.ts` (+ `runmodel.test.ts`) — `cancelSurvivors`.
- `frontend/app/view/agents/runactions.ts` — `stopRunWorker`, `stoppingWorkerIdsAtom`.
- `frontend/app/view/agents/runbody.tsx` — `CancelSurvivorsCard`, header pill annotation.
- `docs/deferred.md` — remove the "Cancel run — partial-failure warning surface" entry.

## Non-goals

- No change to `jarvis.CancelRun` (pure state machine stays state-only).
- No new confirmation dialog (the pre-cancel confirm already exists).
- No durable survivor field / status / DB migration (roster is the source of truth).
- No graceful-interrupt negotiation — stop is terminal, reusing the same kill path as Cancel.
