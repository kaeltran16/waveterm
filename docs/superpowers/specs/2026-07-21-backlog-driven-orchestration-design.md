# Backlog-driven orchestration — lead drives child runs

**Date:** 2026-07-21
**Status:** Design — awaiting user review
**Surface:** `pkg/jarvis/` + `pkg/waveobj` + `pkg/wshrpc` + `cmd/wsh` (no FE view changes for v1)
**Parent:** `docs/superpowers/specs/2026-07-05-channels-runs-orchestrator-mode-design.md` (Piece 5) — this is the
"separate workers / sub-runs" extension that design explicitly deferred.

## Problem

An `@run` on an **orchestrator**-strategy channel spawns **one continuous lead** in **one context** that plans the
goal and self-decomposes into in-process Task subagents (a stated Piece-5 decision). That is correct for a single
cohesive goal. It breaks for a large, structured backlog — e.g. `docs/open-issues.md`: multiple independent issues,
sub-issues, dependencies (6a before 6b/6c), effort estimates. One lead must then hold the whole backlog, its plan
for every issue, and every subagent's returned narration in a single window. The context balloons, and the run
loses per-issue supervision (no per-issue review gate, no per-issue sealed evidence, no per-issue cancel).

## Approach (mechanism C)

Keep a **thin driver that holds only the index** (issue → status → dependency) and run **each independent unit as
its own first-class `Run`** whose context is reclaimed when it seals. The driver is the existing orchestrator lead;
the units are child runs it creates and is woken by. Nothing ever holds more than one unit's context at a time.

This is additive to the existing `@run` → orchestrator path. It is **not** a new launch command and **not** a new
`RunMode`.

## Goals

- The orchestrator lead can create **child runs** — full first-class `Run`s that reuse the entire run engine (worker
  spawn, phases, review gate, escalation, sealed evidence, cancel) per unit.
- The lead is **woken on each child's terminal transition** (done / cancelled) by a single one-line status steered
  into it — no polling, so the lead's context grows by one line per unit.
- **One human gate on the decomposition**, then hands-off children (the review model the user chose). A stuck child
  is escalated by *you* cancelling it, which wakes the lead to retry-or-continue.
- **Reuse, not fork:** child runs are ordinary runs; the only new state is one pointer field and one prompt clause;
  the wake-up reuses the existing `steerRunLead` primitive.

## Non-goals (this piece)

- **No new launch command / no new `RunMode`.** Entry stays `@run` on an orchestrator-strategy channel. The lead
  decides fan-out at plan time; the gate backstops it.
- **No persisted batch/parent object, no dependency subsystem.** Dependencies live in the lead's in-memory checklist
  (that is what keeps the driver thin). Promoting the index to a persisted parent for restart-survivability and a
  backlog dashboard is the "B" upgrade — deliberately deferred.
- **No DB migration.** The single new field is additive JSON on `Run`.
- **No FE view changes.** Child runs render in the existing Runs list like any run. A dedicated backlog-progress
  surface is out of scope.
- **No change to non-backlog orchestrator runs.** When the lead judges a goal cohesive, it uses in-process subagents
  exactly as today — zero regression.

## Decisions (from brainstorming)

1. **Mechanism C over A/B.** A (in-process subagents per issue) only *reduces* the balloon and loses per-issue
   gate/evidence/cancel. B (persisted run-of-runs batch) eliminates it but needs a whole batch + dependency +
   driver-loop subsystem. C eliminates it by making each unit a real run and keeping the lead as a thin,
   event-woken driver — one new seam.
2. **Reuse `@run` / orchestrator strategy; no new mode.** Fan-out is a runtime behavior of the lead, triggered by
   the goal's shape, confirmed at the plan gate — not a user-selected mode.
3. **Lead judges fan-out (independence + weight, not count).** Fan out to child runs only for units that are
   *independent* (isolatable, non-conflicting) **and** individually heavy. Tightly-coupled parts stay in-process
   subagents. Tiny goals the lead just does. The gate is the safety net for a misjudged call.
4. **One decomposition gate, then hands-off.** Human approves the checklist once at the parent's plan gate; child
   runs are created with the plan gate **off**. Per-issue review happens after the fact via each child's sealed
   evidence card.
5. **Non-blocking create + notify-back.** `wsh jarvis run` returns the child id immediately; the lead is woken on
   the child's terminal transition by `steerRunLead`. No `wsh` call blocks for a run's duration, and nothing polls.
   The real terminal transitions are **done** (worker ran `wsh jarvis complete` → seal) and **cancelled** (human).
   There is **no automatic `blocked`**: `PhaseState_Failed`/`Blocked` are never assigned in the current backend, so
   a worker that dies leaves its phase `running` (surfaced only in the roster). Automatic worker-gone→blocked
   detection is a **named follow-on**, not this piece; until then a stuck child is escalated by the human cancelling
   it (which fires the cancelled notify-back).
6. **Child runs are hands-off in every mode.** `PlanGate=false` makes an orchestrator child hands-off, but the
   pipeline playbook bakes `Gate: true` on its plan phase — so a child's playbook has its phase gates **stripped**
   (`StripPhaseGates`). Children inherit the channel strategy by default; the lead may downgrade a small (S) unit
   with `--mode quick`. Children inherit the parent's snapshotted principles, channel, workspace, and project path.
7. **Child-run asks surface to the human normally** (a child is a normal run in the channel). The lead is notified
   only on terminal status — it is not in the child's ask loop.
8. **Effort→mode is prompt-level, not Go.** The lead maps a unit's effort (S/M/L) to `wsh jarvis run --mode …`; no
   mapping code lives in the backend.
9. **Balloon guard is a load-bearing prompt instruction:** the lead must never read a child's transcript, diff, or
   evidence into its own context; the one-line steer-back is all it gets.

## Architecture

### Data model (`pkg/waveobj/wtype.go`)

Additive JSON, no migration:

```go
type Run struct {
    // ...existing...
    ParentLeadORef string `json:"parentleadoref,omitempty"` // tab:<leadId> of the orchestrator lead that spawned
                                                             // this child run; empty for human-started runs
}
```

No `Mode` change, no dependency field, no batch object.

### The new verb — `wsh jarvis run "<unit>" [--mode quick|pipeline|orchestrator]`

New subcommand in the existing `wsh jarvis` group (`cmd/wsh/cmd/wshcmd-jarvis.go`), sibling to `hold`/`complete`/
`triage`. It resolves the caller's tab oref from `WAVETERM_TABID` (identical to the other verbs) and calls a new
RPC, `CreateChildRunCommand`, then prints the child run id.

`CommandCreateChildRunData`:

```go
type CommandCreateChildRunData struct {
    ORef string `json:"oref"` // caller = the lead's tab oref (tab:<leadId>)
    Goal string `json:"goal"`
    Mode string `json:"mode,omitempty"` // empty = inherit the parent run's / channel strategy
}
```

`CreateChildRunCommand` (server, `wshserver_runs.go`):
1. Resolve the caller's owning run from `ORef` (the resolution `ReportRunPhaseCommand` already uses).
2. Copy `ChannelId`, `WorkspaceId`, `ProjectPath`, and the snapshotted `Principles` from the parent run.
3. `Mode` = requested, else the parent run's mode (which came from the channel strategy).
4. `PlanGate = false` (hands-off — the decomposition was already gated).
5. Set `ParentLeadORef = ORef`.
6. Create the child through the existing `NewRun` + `resolveRunPlan` + persist + `EnsureWorkers` path — nothing new
   in run creation itself.
7. Return the child run id.

Fails safe: an `ORef` that resolves to no run (a non-lead caller) is a no-op with a warning and a nonzero exit, like
`hold`/`complete`.

### Notify-back — reuse `steerRunLead`

Two real terminal transitions carry a parent notify: **done** (in `AdvanceRunCommand`, immediately after
`SealEvidence` sets `run.Evidence`) and **cancelled** (in `CancelRunCommand`, after the cancel persists). A pure
`jarvis.ParentNotifyLine(run) (line string, ok bool)` decides *whether* to notify (`ok = ParentLeadORef != "" &&
status is done|cancelled`) and *formats* the line; the server calls `steerRunLead` only when `ok`:

```go
if line, ok := jarvis.ParentNotifyLine(run); ok {
    steerRunLead(ctx, run.ParentLeadORef, line) // e.g. `[jarvis] child <id> "6a…" → done (3 files +120/-8)\r`
}
```

`steerRunLead(ctx, tabORef, text)` already exists (`wshserver_runs.go:166`) and already steers `"approved, proceed\r"`
into a held lead (`:261`) — same primitive. Keeping the decision + formatting pure (model/code split) makes it
unit-testable without a live PTY. On `done` the suffix is a terse evidence summary (`len(Files)`, `AddTotal`,
`DelTotal`); on `cancelled` it is just the status. There is intentionally **no `blocked` case** (see Decision 5).

### Prompt (`pkg/jarvis/run.go`)

`BuildOrchestratePrompt` gains a standing clause (kept fixed; judgment stays in the principles):

> If the goal decomposes into **independent, individually substantial units** (a backlog, a list of issues, several
> unrelated features), do **not** do them in one context. Write the decomposition as a checklist (unit, chosen
> `--mode`, dependency order) as your plan artifact and `wsh jarvis hold <path>`. After approval, create **one child
> run per ready unit** with `wsh jarvis run "<unit + how to verify>"` (≤ 2–3 in flight; only start a unit whose
> dependencies have reported `done`). You will be woken with a one-line `[jarvis] child …` status per unit —
> **never read a child's transcript, diff, or evidence into your own context; that line is all you need.** If a unit
> reports `cancelled`, use `AskUserQuestion` to ask the human whether to retry it or continue without it. When every
> unit has reported `done` (or been skipped), `wsh jarvis complete`. If the goal is a single cohesive task, ignore
> this and use in-process subagents as usual.

The clause is the only place that leans on model judgment; the plan gate is the backstop.

## Data flow (backlog run, gate on)

1. Channel strategy = orchestrator (⚙). User types `@run work docs/open-issues.md` → `CreateRunCommand{mode:
   orchestrator, planGate: true}` → one lead spawned with `BuildOrchestratePrompt`.
2. Lead reads the backlog, extracts **open** issues only, maps effort→`--mode`, writes the decomposition checklist
   as the plan artifact, `wsh jarvis hold <path>` → run `awaiting-review`. Review-gate card renders.
3. User approves the decomposition → lead resumes in place (existing approve-in-place steer).
4. Lead fires ready units (deps satisfied, ≤ 2–3 in flight): `wsh jarvis run "<6a …>"` → child run created
   (`ParentLeadORef` set, hands-off), executes end-to-end in its own fresh context, seals, dies.
5. `SealEvidence` on 6a → notify-back steers `[jarvis] child <id> "6a…" → done (3 files +120/-8)` into the lead.
   Lead marks 6a done, fires now-unblocked 6b and 6c as two more child runs.
6. A child hangs → *you* cancel it in the Runs list → cancelled notify-back wakes the lead → lead asks you (via
   `AskUserQuestion`) whether to retry that unit or continue without it.
7. All units `done`/skipped → lead `wsh jarvis complete` → parent run `done`. You have one sealed evidence card per
   unit, plus the parent's summary.

## Error handling / edge cases

- **`wsh jarvis run` from a non-lead / non-run oref:** no-op + warning + nonzero exit (fails safe like `hold`).
- **Child worker escalates (AskUserQuestion) mid-run:** surfaces to the human in the cockpit as a normal run ask; the
  lead is *not* notified (it only wakes on terminal status). The human answers on the child directly.
- **Lead dies mid-backlog:** completed child runs survive as real sealed runs; in-flight children keep running and
  their asks still reach the human, but the driver is gone (no further fan-out / completion). Restart-survivability
  is the deferred "B" upgrade. Cancelling the parent does **not** cascade to children in v1 (they are independent
  runs) — note this in the plan; a cascade is a follow-on if wanted.
- **Notify-back to a dead lead oref:** `steerRunLead` already logs and no-ops on a missing block.
- **Stuck child (worker died, no completion):** no automatic notify in v1 (no `blocked` transition). Surfaced in the
  Runs list; the human cancels it → cancelled notify wakes the lead. Automatic worker-gone detection is a follow-on.
- **Duplicate/racing done transitions:** the done notify sits inside the existing `run.Evidence == nil` seal guard,
  which already runs once; cancel is a single command call. So each child notifies at most once without extra state.
- **Non-backlog goal:** the lead ignores the clause; behaves exactly as today (in-process subagents).
- **Legacy / human-started runs:** `ParentLeadORef` empty → no notify-back → unchanged.
- **Recursion:** a child that inherits **orchestrator** mode is itself a lead and could `wsh jarvis run`
  grandchildren — the mechanism recurses cleanly (each carries its own `ParentLeadORef`, notify-back walks one
  level). This is bounded in practice because a *unit* is issue-sized and the effort→mode mapping sends most units
  to `quick`/`pipeline`; only an `L` unit becomes an orchestrator child. The prompt should tell a child lead to
  decompose only if its own unit is genuinely a nested backlog, and the parent gate still gated the top level. No
  depth cap in v1; add one if recursion is ever observed running away.

## Testing

**Go (pure — `pkg/jarvis`):**
- `StripPhaseGates` clears `Gate` on every phase (pipeline child becomes hands-off) and does not mutate its input.
- `ParentNotifyLine`: `ok=false` when `ParentLeadORef` empty or status non-terminal; `ok=true` + a formatted line
  for `done` (with `len(Files)`/`AddTotal`/`DelTotal`) and for `cancelled`.

**Go (`pkg/wshrpc/wshserver`):**
- `CreateChildRunCommand` resolves the caller's run, copies channel/workspace/project/principles, sets hands-off
  playbook + `ParentLeadORef`, appends a child run, and returns its id; unresolved oref fails safe (error, no run).
- On a child reaching `done` via `AdvanceRunCommand`, `steerRunLead` is not called when `ParentLeadORef` is empty
  (exercised through the pure `ParentNotifyLine`; the impure `steerRunLead` stays as-is).

**Vitest (FE):** a child run (with `ParentLeadORef`) renders in the Runs list identically to a human-started run
(no special UI in v1).

**CDP (final, against the live dev app):** a small 2-unit fixture backlog — `@run` on an orchestrator channel,
approve the decomposition, watch two child runs spawn and seal, watch the lead complete, and confirm the **lead's own
transcript stays short** (the balloon proof). Then a single-cohesive-goal `@run` to confirm it still uses in-process
subagents (no regression).

## Files touched (indicative)

- `pkg/waveobj/wtype.go` — `Run.ParentLeadORef`.
- `pkg/jarvis/run.go` — `BuildOrchestratePrompt` backlog clause; `StripPhaseGates`; `ParentNotifyLine`.
- `pkg/wshrpc/wshrpctypes_runs.go` — `CommandCreateChildRunData` (+ rtn); `CreateChildRunCommand` on `RunCommands`.
- `pkg/wshrpc/wshserver/wshserver_runs.go` — `CreateChildRunCommand`; `childRunPlan`; the done + cancelled notify-back
  calls (in `AdvanceRunCommand`'s seal block and `CancelRunCommand`).
- `cmd/wsh/cmd/wshcmd-jarvis.go` — `wsh jarvis run` subcommand.
- `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/types/gotypes.d.ts` —
  regenerated (`task generate`).

## Related

- `docs/superpowers/specs/2026-07-05-channels-runs-orchestrator-mode-design.md` — the in-process-subagent design this
  extends; its "separate workers / worktree workers" non-goal is what this delivers for the backlog case.
- `docs/orchestrator-roadmap.md` — the manager ladder; child runs keep the "one substrate" principle (each unit is a
  normal run the human can see and override).
- `pkg/jarvis/decompose.go` — the **Chat**-tier delegator fan-out (flat, ≤5, single-level worktree workers). Distinct
  from this Runs-side, first-class-run decomposition; not reused.
- `docs/open-issues.md` — the motivating backlog.
