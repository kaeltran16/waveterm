# Channels Runs — Dual-Mode / Orchestrator Mode (Piece 5)

**Date:** 2026-07-05
**Status:** Design — awaiting user review
**Surface:** `pkg/jarvis/` + `pkg/waveobj` + `pkg/wshrpc` + `cmd/wsh` + `frontend/app/view/agents/`
**Parent roadmap:** `docs/superpowers/specs/2026-07-04-channels-goal-driven-delegation-design.md` (Delivery item 5)

## Problem

Pieces 1–4 built the **pipeline** run: a goal advances through a fixed playbook (brainstorm → plan → *review gate* → execute), with code routing between phases and one bounded worker per phase. That structure is deterministic and supervisable, but it is also rigid: every run has the same shape regardless of the goal, and the decomposition is decided by the playbook, not by a model reasoning about the specific goal.

Piece 5 adds a second execution style — **orchestrator** — for goals better served by adaptive decomposition: a single long-lived Claude Code *lead* that plans the work itself and spawns its own in-process subagents, with one deliberate checkpoint (an optional plan gate). Pipeline stays the default; orchestrator is a per-run choice.

## Goals

- A `Mode` on each Run (`pipeline | orchestrator`), chosen when the run starts, defaulted from the Jarvis profile.
- **Orchestrator mode:** one continuous adaptive lead that plans and self-decomposes into in-process Task subagents, following the run's principles and propagating them to every subagent.
- **Optional plan gate:** the lead pauses in place after planning for human review, then resumes with its full context intact (pause-and-steer). Gate off → fully hands-off.
- **Reuse, not fork:** the two modes share the `Run`/phase state machine, persistence, escalation substrate, and phase rail. Orchestrator adds one playbook shape, one prompt builder, one runtime pause flag, and a small lead self-report path.
- **Coherent surface:** the channel header's autonomy control becomes view-aware — tier chips in Chat, mode chips in Runs — and the phase rail shows the lead with its live subagents nested beneath it.

## Non-goals (this piece)

- **No recursive gatekeeper coupling.** Because subagents are in-process, their asks bubble up through the lead's own block; the lead's `tab:<id>` is already in `phase.WorkerOrefs`, so `ResolveRunWorker` routes them today. The roadmap's "match a run's workers recursively" concern collapses to a *display* concern (see Architecture). No change to ask routing.
- **No separate Wave worker tabs / worktree workers** for subagents. Helpers are Claude Code Task-tool subagents (surfaced via the existing `AgentSubagentDelta` / `getSubagentsAtom`), not new orefs. Worktree-isolated separate workers are a deliberate later extension.
- **No editable orchestrate instruction.** The *mechanics* of orchestration are fixed; the *judgment* (long-term over band-aid, etc.) lives in the already-editable principles.
- **No real "pause now."** Pipeline's disabled Pause button stays out of scope — `ControllerInputCommand` injects input, it cannot suspend a running turn. The plan gate is the clean stopping point; Steer and Cancel cover the rest. A true suspend/interrupt is its own piece.
- **No DB migration.** All additions are additive JSON on existing objects.
- **No change to pipeline mode's behavior.** Legacy runs (no `Mode`) render and execute exactly as today.

## Decisions (from brainstorming)

1. **Subagents are in-process.** The lead is one `claude` tab; helpers are its Task-tool subagents, reported by the `~/.claude` hooks as `AgentSubagentDelta` and rendered as `SubagentVM` rows. No new orefs. This is the choice that collapses "recursive coupling" to display + cancel.
2. **Orchestrator = one continuous adaptive lead.** Not a plan-worker-then-fresh-execute-worker split (that would just be pipeline with a renamed execute phase and would not earn a distinct `Mode`).
3. **Plan gate via pause-and-steer.** The lead plans, self-reports a hold, the run goes `awaiting-review`; approve steers "proceed" into the *same* lead (via `ControllerInputCommand`) rather than spawning a successor, preserving context. Gate off subsumes "no gate" — the lead never holds and runs hands-off.
4. **`Gate` (static) vs `Held` (runtime).** On the orchestrate phase, `Gate` only means "the lead was told to hold" (it shapes the prompt). The actual pause is `Held`, set at runtime by the lead's self-report. This keeps orchestrator's *intra-phase* pause orthogonal to pipeline's *between-phase* gate.
5. **`recomputeStatus` stays the single source of truth for `Status`.** It gains one clause: any `running` phase with `Held` → `awaiting-review`.
6. **Fixed orchestrate instruction; principles carry judgment.** The instruction references superpowers skills by name (DRY) and directs the lead to propagate the run's principles into every subagent it dispatches. Principles already flow to the lead's prompt and to the escalation classifier.
7. **Lead self-reports via a `wsh jarvis` command group.** `wsh jarvis hold` (plan gate) and `wsh jarvis complete` (done) resolve the caller's run/phase from its tab oref server-side and apply the transition. This makes hands-off orchestrator autonomous end-to-end without depending on the completion hook (which stays the pipeline path). `wsh run` is unavailable — it is the upstream block-runner.
8. **Mode default lives in the Jarvis profile.** `DefaultMode` and `DefaultPlanGate` (default on) are new profile fields, resolved global+override like the rest of the profile. The header mode chips and the profile panel are two views of the same value.
9. **Header autonomy slot is view-aware.** Chat → tier chips (unchanged); Runs → mode chips. The tier selector is redundant/contradictory in the Runs view (a run bypasses the tier ladder — `ResolveRunWorker` is not gated by `MetaKey_GatekeeperEnabled`), so it is scoped to Chat.
10. **Plan gate defaults ON.** Orchestrator is the highest-autonomy mode; review the plan before the lead runs a fleet. Overridable per-run via the inline toggle.

## Architecture

### Data model (`pkg/waveobj/wtype.go`)

Additive JSON, no migration:

```go
type Run struct {
    // ...existing...
    Mode string `json:"mode,omitempty"` // pipeline | orchestrator (empty = pipeline, legacy-safe)
}

type RunPhase struct {
    // ...existing...
    Held bool `json:"held,omitempty"` // orchestrator: lead paused itself at the plan gate
}

type JarvisProfile struct {
    Playbook       []RunPhase `json:"playbook"`
    Principles     string     `json:"principles,omitempty"`
    DefaultMode    string     `json:"defaultmode,omitempty"`    // pipeline | orchestrator (empty = pipeline)
    DefaultPlanGate *bool     `json:"defaultplangate,omitempty"` // nil = on
}

type ProfileOverride struct {
    Playbook        *[]RunPhase `json:"playbook,omitempty"`
    Principles      *string     `json:"principles,omitempty"`
    DefaultMode     *string     `json:"defaultmode,omitempty"`
    DefaultPlanGate *bool       `json:"defaultplangate,omitempty"`
}
```

### Run engine (`pkg/jarvis/run.go`, `runexec.go`)

- **Playbook:** `DefaultOrchestratorPlaybook() []RunPhase` → a single phase `{Kind: "orchestrate", Skill: "superpowers:subagent-driven-development", Gate: <planGate>}`. `NewRun` is unchanged (deep-copies phases, marks phase 0 `running`, `recomputeStatus`).
- **Spawn:** reuses `EnsureWorkers` / `SpawnClaudeWorker` — one lead tab, spawned by the existing "running phase with no worker" path. The only change in `runexec.go`: when `run.Mode == "orchestrator"`, build the prompt with `BuildOrchestratePrompt` instead of `BuildPhasePrompt`.
- **Hold:** new advance action `hold` → `HoldPhase(run, phaseIdx) (Run, error)` sets `Held = true`; `recomputeStatus` → `awaiting-review`. Does **not** mark the phase done or spawn anything — the lead stays alive.
- **Approve-in-place:** `ApproveGate` gains an orchestrator branch — if the current phase is `Held`, clear `Held`, steer `"approved, proceed"` into the lead via `ControllerInputCommand`, `recomputeStatus` → `executing`. (Pipeline's between-phase approve is unchanged.)
- **Complete:** the lead self-reports `complete` when the goal is done → existing `CompletePhase` → phase `done` → run `done`.
- **Cancel/steer:** unchanged. Cancel kills the lead tab; in-process subagents die with it — no descendant bookkeeping.
- **`recomputeStatus`:** add the single clause "any `running` phase with `Held` → `awaiting-review`", ahead of the existing pipeline gate derivation.

### Prompt (`pkg/jarvis/run.go`)

`BuildOrchestratePrompt(goal, principles string, gate bool) string`, sibling to `BuildPhasePrompt`. Composes:
- the reused **principles** block (same `Run.Principles` snapshot pipeline uses),
- the **goal**,
- a **fixed** instruction that: references `superpowers:writing-plans` and `superpowers:subagent-driven-development` / `superpowers:dispatching-parallel-agents` by name; if `gate`, directs "write the plan artifact, run `wsh jarvis hold`, and wait for approval before dispatching subagents"; directs "propagate these principles into every subagent you dispatch"; and directs "run `wsh jarvis complete` when the goal is finished".

Principles are the only variable content — the user's judgment rides in here and (unchanged) into `Classify`.

### Escalation coupling / roster

No routing change — **under one assumption to verify first in the plan:** that the `~/.claude` hook reports an in-process subagent's `AskUserQuestion` under the **lead's** block oref (same Claude Code process → same block), not a synthetic per-subagent oref. Given that, an in-process subagent's ask fires from the lead's **block** oref, `channelOwnerORef` walks it to the lead's **tab** oref, and `ResolveRunWorker` matches it against `phase.WorkerOrefs` (which holds the lead's tab oref). The "recursive" requirement is therefore purely **display**. *If the assumption is false* (subagent asks carry a distinct oref), the plan adds a descendant predicate to `ResolveRunWorker` walking `Block.ParentORef` up to a run's lead — the seam the resolver's own comment already anticipates — and the rest of this design is unaffected.

- **Rail:** for an `orchestrate` phase, the rail renders the lead row (via the existing `phaseWorkers`) and, nested beneath it, the live `SubagentVM[]` from `getSubagentsAtom("tab:" + leadId)`. Additive consumption of an atom that already exists.

### wshrpc + wsh (`pkg/wshrpc`, `cmd/wsh`)

- `CommandCreateRunData` gains `Mode string` and `PlanGate *bool` (nil → resolved profile default). `CreateRunCommand` selects the playbook by mode (`DefaultOrchestratorPlaybook` with the resolved gate vs. the resolved pipeline playbook) and snapshots `Run.Mode`.
- `CommandAdvanceRunData.Action` gains `"hold"`, handled in the existing `AdvanceRunCommand` switch → `HoldPhase`.
- New `wsh jarvis` command group (`cmd/wsh/cmd/wshcmd-jarvis.go`): `hold` and `complete`. Each reads the caller's tab oref from env (`WAVETERM_TABID` / block oref, as `wsh run` and the agent hook do), resolves the run/phase via `ResolveRunWorker` server-side, and applies the transition (`hold` = new action; `complete` = existing `complete`). Introducing a `jarvis` group avoids the `wsh run` collision and leaves room for future lead verbs.
- Regenerate TS/Go bindings (`task generate`).

### Frontend (`frontend/app/view/agents/`)

- **`channelssurface.tsx`** — the header autonomy slot becomes view-aware: `view === "chat"` renders the tier chips (unchanged); `view === "runs"` renders **mode chips** (`pipeline / orchestrator`) that reflect and set the resolved profile `DefaultMode` via `setChannelProfile` (single source of truth with the profile panel). When Orchestrator is selected, a small **plan-gate toggle** appears inline (per-run override, initialized from `DefaultPlanGate`).
- **`runssurface.tsx`** — the composer's static `playbook · Superpowers default` label (line 390) becomes a read-only summary of what "Start run" will do (e.g. `orchestrator · plan gate on`). `PhaseRail` renders lead + nested subagents for the orchestrate phase; the existing `ReviewGateCard` renders on `awaiting-review` with copy adapted to "Plan ready — approve to let the lead proceed", and its Approve maps to the same `approve` action (now approve-in-place server-side).
- **`runmodel.ts`** — a pure helper merging `phaseWorkers` (lead) with the subagent list for the rail; small `mode`/`gate` derivations for the header summary.
- **`runactions.ts`** — `createRun(channelId, goal, { mode, planGate })`; the header chips call `setChannelProfile` to persist `DefaultMode`.
- **`profilepanel.tsx`** — add a **Default mode** selector and a **Default plan gate** toggle, persisted via the existing `setChannelProfile`. The playbook editor stays pipeline-only (orchestrator has no editable structure).

## Data flow (orchestrator run, plan gate on)

1. User selects Orchestrator in the header (persists `DefaultMode`), types a goal, hits Start run → `CreateRunCommand{mode: "orchestrator", planGate: true}` → Run with one `orchestrate` phase (`Gate: true`), lead spawned via `EnsureWorkers` with `BuildOrchestratePrompt`.
2. Lead plans, writes the plan artifact, runs `wsh jarvis hold` → `HoldPhase` → `Held: true` → `recomputeStatus` → `awaiting-review`. The review-gate card renders inline under the phase.
3. User approves → `AdvanceRun{approve}` → `ApproveGate` clears `Held`, steers "approved, proceed" into the lead → `executing`.
4. Lead dispatches Task subagents (principles propagated); subagents appear nested in the rail via `getSubagentsAtom`. A principle-significant subagent ask bubbles to the lead's block → `ResolveRunWorker` → `Classify` (principle-aware) → auto-answer or escalate, keyed to the run.
5. Lead finishes, runs `wsh jarvis complete` → `CompletePhase` → run `done`.

Gate off: step 2's `wsh jarvis hold` directive is omitted from the prompt; the lead runs straight through to `complete` — hands-off.

## Error handling / edge cases

- **Legacy runs** (no `Mode`): empty = pipeline; unchanged rendering and execution.
- **Gate off:** lead never holds; run stays `executing` until `complete`.
- **Lead dies mid-run** (before or after hold): phase → `failed`, run → `blocked` (existing worker-gone path); in-process subagents are already gone.
- **`wsh jarvis hold` on a non-orchestrator / non-gated / already-terminal run:** no-op with a warning; never forces `awaiting-review` where there is no gate.
- **`wsh jarvis complete` on a run not owned by the caller's oref:** no-op with a warning (resolution failure fails safe, as `channelOwnerORef` already does).
- **Approve when not `awaiting-review`:** rejected by `ApproveGate`'s existing status guard.
- **Malformed/empty `DefaultMode`:** falls back to pipeline. **Missing `DefaultPlanGate`:** treated as on.
- **Mixed runs:** orchestrator and pipeline runs coexist in one channel; mode is per-run (snapshotted), so flipping the header default never disturbs a running run.

## Testing

**Go (pure — `pkg/jarvis`):**
- `DefaultOrchestratorPlaybook` shape (single orchestrate phase; `Gate` reflects the flag).
- `recomputeStatus`: a `running` phase with `Held` → `awaiting-review`; cleared → `executing`.
- `HoldPhase` sets `Held` and does not advance or spawn.
- `ApproveGate` orchestrator branch clears `Held` (steers in place) rather than starting a successor; pipeline branch unchanged.
- `CancelRun` skips the lead phase (pending/running → skipped).
- `ResolveProfile` merges `DefaultMode` / `DefaultPlanGate` (override wins, nil inherits, empty → pipeline/on).

**Go (`pkg/wshrpc/wshserver`, `cmd/wsh`):**
- `CreateRunCommand` mode → playbook + gate wiring; `Run.Mode` snapshot.
- `wsh jarvis hold` / `complete` resolve run/phase from the caller's tab oref and apply the right transition; unresolved oref fails safe.

**Vitest (`frontend/app/view/agents`):**
- Header mode chips reflect/set `DefaultMode`; plan-gate toggle visibility (orchestrator only) and value.
- Composer summary text for each mode/gate combination.
- Rail helper merges lead + subagents into lead-with-nested-subagents.
- Gate-card copy/approve wiring for an orchestrator run.

**Final (CDP against the live dev app):** start an orchestrator run with the gate on — watch the lead plan, hit the plan gate, approve, see it dispatch subagents that populate the rail, and complete; then a gate-off run that goes hands-off end-to-end.

## Files touched (indicative)

- `pkg/waveobj/wtype.go` — `Run.Mode`, `RunPhase.Held`, `JarvisProfile` / `ProfileOverride` default-mode + default-plan-gate fields.
- `pkg/jarvis/run.go` — `DefaultOrchestratorPlaybook`, `BuildOrchestratePrompt`, `HoldPhase`, `ApproveGate` orchestrator branch, `recomputeStatus` `Held` clause.
- `pkg/jarvis/runexec.go` — mode-aware prompt selection in `EnsureWorkers`.
- `pkg/jarvis/resolve.go` — `ResolveProfile` merge of the new profile fields.
- `pkg/wshrpc/wshrpctypes.go`, `wshserver/wshserver.go` — `CreateRunData` mode+gate, `AdvanceRunData` `hold`, run/phase resolution for the `wsh jarvis` verbs.
- `cmd/wsh/cmd/wshcmd-jarvis.go` (new) — `wsh jarvis hold` / `complete`.
- `frontend/types/gotypes.d.ts` — regenerated.
- `frontend/app/view/agents/channelssurface.tsx` — view-aware header slot (mode chips in Runs).
- `frontend/app/view/agents/runssurface.tsx` — composer summary, plan-gate inline toggle, rail lead+subagents, gate-card copy.
- `frontend/app/view/agents/runmodel.ts` — lead+subagent rail merge, mode/gate derivations.
- `frontend/app/view/agents/runactions.ts` — `createRun` mode/gate params; header persists `DefaultMode`.
- `frontend/app/view/agents/profilepanel.tsx` — default-mode + default-plan-gate controls.
