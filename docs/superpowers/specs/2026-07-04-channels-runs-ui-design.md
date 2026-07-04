# Channels Runs — Run UI (Piece 2)

**Date:** 2026-07-04
**Status:** Design — awaiting user review
**Surface:** `frontend/app/view/agents/` (channels* / new runs* files)
**Parent:** `2026-07-04-channels-goal-driven-delegation-design.md` (Piece 2 of 4)
**Depends on:** Piece 1 — backend Run engine (`bddcca2a`): `Run`/`RunPhase` types, `CreateRun`/`AdvanceRun`/`CancelRun` commands, generated TS types.

## Problem

Piece 1 built a backend-owned Run engine and proved it over RPC, but there is no way to see or drive a Run from the app. The Channels surface is still chat-only. Piece 2 builds the Run UI: make the plan the object and chat the log, per the locked information architecture (`wave-handoff/wave/project/Wave-runs.dc.html`, "Turn 2 · converged", section 2a).

## Goals

- A **Runs view** for a channel: run tabs (multiple runs per channel) + New run, a run header, a collapsible compact stepper, and a vertical phase rail that threads each phase's activity inline.
- A **Chat ⇄ Runs toggle** in the center header; the existing chat timeline becomes the Chat view, unchanged.
- Wire the **human decisions** whose backends already exist: approve / send-back at the review gate (`AdvanceRun`), cancel (`CancelRun`), steer (`ControllerInputCommand`).
- Read Runs from the channel object already mirrored via WOS — no new fetch, no new atom plumbing beyond view/selection state.

**Non-goals (this piece):**

- Phase **completion** from the UI. Completion is reported by the external `~/.claude` hook via `AdvanceRun{complete}` (design decision: reported-in, not auto-detected). The UI never marks a phase done; it owns only human decisions (approve/send-back/cancel/steer).
- **`@jarvis <goal>` chat behavior.** Today's delegator fanout stays exactly as-is; Runs launch only through the explicit New run / Start-run action this piece. Repointing `@jarvis` to `CreateRun` is a later piece. `planMessage` is untouched.
- **Pause, Edit-plan, Re-dispatch.** No backend for these in Piece 1; render them disabled with a tooltip (present so the IA reads true, not functional).
- **Jarvis profile editor** (the slide-in panel) — Piece 3.
- **Principle-aware escalation** (`Classify`) — Piece 4. Escalation/clarify cards render as *display only*, reusing the existing agent-ask UI for answering.

## Decisions

1. **State source = the channel object.** Runs are `channel.runs`, already mirrored via `activeChannelAtom` (WOS). Backend mutations update the channel → WOS pushes → the view re-renders. Worker liveness comes from the existing `model.agentsAtom` roster, matched by `tab:<id>` in `phase.workerorefs` (reusing the `workerFor` / `buildFleetSnapshot` pattern).
2. **UI owns decisions, hook owns completion.** Approve/send-back/cancel/steer are UI actions; "the worker finished this phase" is a fact the hook reports. Clean split; no fake "mark done" control.
3. **Deferred controls are shown disabled, not omitted.** Pause/Edit-plan/Re-dispatch appear per the mockup but are inert with an explanatory tooltip, so the layout matches the locked IA without implying capability that isn't there.
4. **Extract shared primitives.** The atoms the Runs view genuinely reuses move out of `channelssurface.tsx` into `channelsprimitives.tsx` so both surfaces import them: `Avatar`, `Tag`, `OptionList`, `timeLabel`, and the two reused rows `EscalationRow` and `WorkerRow`. Targeted improvement, not a broad refactor. Keeps `channelssurface.tsx` from growing past ~1200 lines. (The exact set to relocate vs. leave in place is finalized in the plan; anything the Runs view imports must be exported/relocated, not duplicated.)
5. **Runs view lives in its own module.** `runssurface.tsx` holds `<RunsView>` and its sub-components; `channelssurface.tsx` only gains the toggle + conditional render.

## Architecture

### Data model & derivations (`runmodel.ts`, pure, unit-tested)

Consumes the generated `Run`/`RunPhase` types. No React, no jotai.

- `runStatusView(status) -> { label, tone }` — pill label + color tone per status (planning | awaiting-review | executing | blocked | done | failed | cancelled).
- `phaseStateView(state) -> { icon, label, color }` — per phase state (pending | running | blocked | done | failed | skipped).
- `currentPhaseIndex(run) -> number` — first running/blocked phase, else the gate-pending phase, else the last.
- `reviewGate(run) -> { phaseIdx } | null` — non-null only when `status === "awaiting-review"`, keyed to the gated phase awaiting approval.
- `phaseWorkers(phase, agents) -> AgentVM[]` — resolve `workerorefs` (`tab:<id>`) against the live roster.
- `phaseThread(run, idx, agents)` — which threaded elements a phase shows:
  - **clarify / fork escalation:** a worker of this phase is live `asking` (reuses `escalationPending`); brainstorm phase → clarify framing, execute phase → fork framing.
  - **context-clear divider:** shown immediately before a `freshctx` phase.
  - **execute worker rows:** the phase's live/known workers.
  - **blocked:** phase state `blocked`, or a recorded worker is gone mid-phase.
  - **ship:** last phase `done` and run `done`.
- `defaultView(channel) -> "runs" | "chat"` — Runs if the channel has any runs, else Chat.
- `defaultRunId(runs) -> string | undefined` — most-recent non-terminal run, else most-recent.

### Components (`runssurface.tsx`)

Mirrors IA section 2a. `<RunsView>` owns local `activeRunId` state.

- **RunTabs** — horizontal, status-dot + truncated goal per run, + New run (opens the Start-run composer).
- **RunHeader** — status pill + goal + **Steer** (wired) + **Pause** (disabled/tooltip).
- **CompactStepper** — collapsible one-line phase summary (chevron + node strip).
- **PhaseRail / PhaseNode** — phases stacked top-to-bottom, each: node icon + connector, name + state label + skill + artifact chip, then the threaded cards from `phaseThread`:
  - **ReviewGateCard** — plan bullets + **Approve & execute** (`AdvanceRun{approve}`) + **Edit plan** (disabled/tooltip) + **Send back** (`AdvanceRun{sendback}`); resolved state with a read-only note.
  - **ClarifyCard / fork escalation** — reuse `EscalationRow` (display); answering uses the existing agent-ask UI.
  - **ContextClearDivider** — dashed "context cleared → fresh worker".
  - **ExecuteWorkers** — worker rows (reuse `WorkerRow` pattern).
  - **BlockedCard** — reason + **Take control** (`jumpToAgent`, exists) + **Cancel run** (`CancelRun`); **Re-dispatch** disabled/tooltip.
  - **ShipMarker** — "merged / done" chip.
- **Start-run composer** — goal input + playbook picker (default only, this piece) + **Start run** (`CreateRun`).

Terminal runs (done/cancelled/failed) render read-only (no gate/steer actions).

### Actions (`runactions.ts`, impure)

Thin wrappers over `RpcApi`, mirroring `channelactions.ts` style:

- `createRun(channelId, workspaceId, goal, playbookId?)` → `CreateRunCommand`.
- `approveGate(channelId, runId, gateIdx)` → `AdvanceRunCommand{action:"approve", phaseidx: gateIdx}`.
- `sendBackGate(channelId, runId, gateIdx)` → `AdvanceRunCommand{action:"sendback", phaseidx: gateIdx}`.
- `cancelRun(channelId, runId)` → `CancelRunCommand`.
- Steer reuses the existing `steerWorker(channelId, workerORef, agents, text)`.

The active `workspaceId` for `CreateRun` is sourced via `globalStore.get(atoms.workspaceId)` (`atoms` from `@/app/store/global-atoms`), matching `agentactions.ts`.

### Toggle wiring (`channelssurface.tsx`)

Add `view: "chat" | "runs"` local state (initialized from `defaultView(active)`, recomputed on channel switch). Render the segmented Chat/Runs toggle in the existing header row; when `view === "runs"` render `<RunsView>` in place of the chat timeline + chat composer, else the existing chat path unchanged. Import `Avatar`/`Tag`/`OptionList`/`timeLabel` from `channelsprimitives.tsx`.

## Data flow

1. **New run:** Start-run composer → `createRun` → backend creates the Run + spawns phase-1's worker → channel updated → WOS → RunsView shows and auto-selects the new run.
2. **Phase completes (external):** `~/.claude` hook → `AdvanceRun{complete}` → channel updated → WOS → the phase rail advances. Not UI-driven.
3. **Gate:** `status → awaiting-review` → ReviewGateCard under the gated phase → **Approve** (`AdvanceRun{approve}`) starts the fresh execute worker, or **Send back** (`AdvanceRun{sendback}`).
4. **Worker asks mid-phase:** live agent `asking` matched to a phase's `workerorefs` → clarify/fork card shown; answering flows through today's agent-ask UI.
5. **Cancel:** `CancelRun` → `status cancelled`, pending phases skipped.
6. **Steer:** `ControllerInputCommand` into the current worker.

## Error handling / edge cases

- **Legacy channels (no runs):** default to Chat; Runs view shows an empty "Start run" state.
- **Gone worker mid-phase:** BlockedCard.
- **Terminal run:** read-only render, no gate/steer actions.
- **Channel switch:** reset `activeRunId` to that channel's `defaultRunId`; reset `view` to `defaultView`.
- **Malformed/absent run fields:** render defensively; never crash the surface (matches existing card-parse fallbacks).

## Testing

Pure vitest — `runmodel.test.ts`:
- `runStatusView` / `phaseStateView` mappings.
- `currentPhaseIndex` across state combinations.
- `reviewGate` — non-null only at `awaiting-review`, correct gated index.
- `phaseWorkers` — oref → roster resolution, missing workers dropped.
- `phaseThread` — correct card selection per phase kind/state (clarify vs fork, boundary before freshctx, blocked, ship).
- `defaultView` / `defaultRunId`.

`channelmessages.test.ts` untouched (no entry-point change this piece).

**Live verification (CDP against the dev app):** New run → phase rail renders; drive completion through the existing `scripts/cdp-e2e-runs.mjs` harness (the hook isn't built, so the harness simulates `AdvanceRun{complete}`) to reach the gate → Approve → execute; Cancel. Capture a CDP screenshot of the Runs view.

## Files touched

- `frontend/app/view/agents/runmodel.ts` (new) — pure derivations.
- `frontend/app/view/agents/runmodel.test.ts` (new) — tests.
- `frontend/app/view/agents/runactions.ts` (new) — Run lifecycle RPC wrappers.
- `frontend/app/view/agents/runssurface.tsx` (new) — `<RunsView>` + sub-components.
- `frontend/app/view/agents/channelsprimitives.tsx` (new) — extracted shared UI atoms.
- `frontend/app/view/agents/channelssurface.tsx` (modified) — Chat/Runs toggle, conditional render, import primitives.
