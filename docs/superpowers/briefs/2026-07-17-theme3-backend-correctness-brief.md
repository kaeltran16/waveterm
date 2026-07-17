# Design brief — Theme 3: Backend correctness (ask delivery + run spawn)

**Date:** 2026-07-17
**Status:** Design approved (brief) — ready for a downstream agent to write spec + plan and execute
**Source:** Net-new improvement scan, `docs/deferred.md` §"Net-new improvement scan (2026-07-17)" Theme 3
**Handoff:** Resolved design-decision record, not the formal spec. A downstream agent expands it into
`docs/superpowers/specs/` + `docs/superpowers/plans/` and implements it.

## A1 — `DeliverAnswer` is not atomic and never claims the pending ask

**Root cause.** The registry is keyed by block ORef and exposes only `Get`/`Set`/`Drop`
(`pkg/agentask/agentask.go:35-52`); `PendingAsk` carries an `AskId` (`:18`). `DeliverAnswer` does
`Get(oref)` → `EncodeAnswer` → inject keystrokes, and **never drops/claims** the entry
(`pkg/agentask/deliver.go:23-41`) — it stays pending until the external clear hook fires
`AgentAskClearCommand` → `Drop` (`wshserver.go:2347-2358`). In that window two deliveries both see
`ok=true` and both inject a full keystroke sequence into the same picker. Concrete trigger: the Gatekeeper
publishes the ask, then spends seconds in `Classify` (headless claude, `watcher.go:103`); a human answers
from the terminal or panel during that latency; `Classify` returns "answer" and delivers a second,
possibly stale selection into whatever ask now sits at that oref. `ctx.Err()` (`watcher.go:104`) guards
cancellation, not this window. Simpler triggers: two cockpit sessions, or a double-click.

**Resolved design (chosen: no wire change).**

1. **Atomic claim.** Add `Registry.Claim(oref, askid string) (PendingAsk, bool)`: under one lock, look up
   the pending ask; return `(_, false)` **without deleting** if absent, or if `askid != "" && pending.AskId
   != askid`; otherwise `delete` and return `(pending, true)`. This makes "who delivers" a single atomic
   decision — only the first caller wins.
2. **`DeliverAnswer` uses `Claim`.** New signature `DeliverAnswer(oref, askid string, answers ...)`.
   Order: `Claim` first (atomic gate) → if `!ok` return `false, nil` (preserves the idempotent no-op
   contract) → `EncodeAnswer`; on an **encode** error, re-`Set` the pending back (no keystrokes sent yet, so
   retry is safe) and return the error → then the inject loop. On a **mid-inject** `sendInput` error, do
   **not** restore (a partial keystroke prefix already reached the picker; restoring would risk a
   double-send on retry) — return the error, entry stays claimed/dropped, logged.
3. **Callers.**
   - Gatekeeper (`pkg/jarvis/watcher.go:110`): pass `data.AskId` (already in-process, free) → gets both the
     double-inject guard and the staleness guard (a stale answer can't land on a replaced ask).
   - `AnswerAgentCommand` (`wshserver.go:2339-2345`): pass `askid = ""` → atomic double-inject guard only.
     **No change** to `CommandAnswerAgentData` / no `task generate` / no FE change.

**Rejected (A1-b, full askid threading):** adding `AskId` to `CommandAnswerAgentData` so the panel path
also gets the staleness match. Declined — the panel path delivers synchronously inside `AnswerAgentCommand`
(a tiny replacement window), so it isn't worth the wire-type change + regen + FE edit. Revisit only if a
stale-panel-answer is ever observed.

**Acceptance.** Two concurrent `DeliverAnswer` calls for one pending ask inject exactly once (the second
returns `delivered=false`); a Gatekeeper delivery whose `askid` no longer matches the pending ask is a
no-op; the idempotent "no ask pending → `delivered=false, nil`" contract is preserved.

## A2 — `spawnRunWorkers` can double-spawn a phase worker

**Root cause.** `spawnRunWorkers` runs `GetRun` (tx1) → `EnsureWorkers` (spawns tabs/blocks) → `UpdateRun`
(attach orefs) across separate transactions (`wshserver.go:1523-1541`). The double-spawn guard is
`len(p.WorkerOrefs) > 0` (`runexec.go:114`), but `WorkerOrefs` is persisted only after all spawns complete.
The DB serializes single transactions (`SetMaxOpenConns(1)`) but not this multi-step sequence, and each RPC
runs in its own goroutine (`wshutil/wshrpc.go:434-439`) — so two concurrent `CreateRun`/`AdvanceRun` calls
for the same run (`wshserver.go:1641,1743`) can both read empty `WorkerOrefs` and both spawn → two Claude
processes redundantly executing one phase, both attached.

**Resolved design (chosen: include the guard).** Serialize `spawnRunWorkers` per `runId` with a keyed
mutex held across the whole read→spawn→attach sequence (e.g. a `map[string]*sync.Mutex` guarded by a small
lock, or a keyed-lock helper). This makes the guard-check and the attach effectively atomic per run without
nesting tab-creation inside the run's state-transition write.

**Rejected:** doing spawn+attach inside one `UpdateRun` transaction — the code deliberately keeps
tab-creation *outside* the run's state-transition write (`wshserver.go:1516-1522`: EnsureWorkers mutates
the workspace tab list and must flush its own update events), so a per-run lock is the fitting fix.

**Acceptance.** Two concurrent `spawnRunWorkers` for the same run spawn a phase's worker exactly once.

## Non-goals

- No `CommandAnswerAgentData` wire change (A1-b declined).
- No restructuring of the run spawn into the state-transition transaction.
- No change to `EncodeAnswer` (already covered by `encode_test.go`) or the keystroke protocol.

## Testing

- **A1:** `pkg/agentask` unit tests (the package already has `encode_test.go`): concurrent `Claim` → exactly
  one `true`; `Claim` with a mismatched `askid` → `false` and entry retained; `DeliverAnswer` restores the
  pending on encode error and does not on mid-inject error (using the existing `sendInput` indirection at
  `deliver.go:14` to inject a failure).
- **A2:** focused test that concurrent `spawnRunWorkers` invocations for one run spawn once (assert
  `SpawnClaudeWorker` — or its EnsureWorkers seam — is called a single time per phase under the lock).
- **Coordination note:** Theme 4 separately adds the first `watcher_test.go`; A1 touches the Gatekeeper
  deliver path in `watcher.go` — sequence these so the tests land against the post-A1 signature.

## Files in play

`pkg/agentask/agentask.go` (`Claim`), `pkg/agentask/deliver.go` (use `Claim`, `askid` param,
restore-on-encode-error), `pkg/jarvis/watcher.go:110` (pass `data.AskId`),
`pkg/wshrpc/wshserver/wshserver.go` (`AnswerAgentCommand` passes `""`; per-run mutex around
`spawnRunWorkers`). `pkg/jarvis/runexec.go` guard unchanged.
