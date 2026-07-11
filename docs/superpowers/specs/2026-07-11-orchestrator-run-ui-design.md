# Orchestrator run UI: dedicated lead-transcript body + rich dispatched agents

Date: 2026-07-11
Scope: front-end only. A dedicated body layout for **orchestrator-mode** runs in the channel Runs
view, plus a proper dispatched-agent (subagent) presentation. No wire-protocol change, no backend
build, no `task generate`.

Related:
- `docs/superpowers/specs/2026-07-05-channels-runs-orchestrator-mode-design.md` — orchestrator = one
  long-lived lead in a single `orchestrate` phase; subagents are in-process Task-tool children
  surfaced as `SubagentVM` rows. "Reuse, not fork" — the two modes share the Run/phase machine.
- `docs/superpowers/specs/2026-07-11-runs-view-polish-design.md` — the just-shipped polish batch
  (inline steer, editable plan gate, new-run panel, motion). This builds on that `runssurface.tsx`.
- `frontend/app/view/agents/agenttree.tsx` — the existing rich, clickable subagent-row idiom this
  reuses; `agentsurface.tsx` + `subagentinterior.tsx` — where a clicked subagent's transcript opens.

## Problem

The Runs view renders every run through one path: a `CompactStepper` + a vertical `PhaseRail`, one
card per phase, each phase's live worker shown in a `RunWorkerCard` whose transcript feed is
hard-capped at `max-h-[260px]`. That is correct for **pipeline** runs, which stack several phase
cards down a scrolling column.

It is wrong for **orchestrator** runs. An orchestrator run has exactly one phase (`orchestrate`) with
exactly one lead agent. So:

1. **The transcript is cramped.** A single lead owns the whole surface, yet its live narration is
   boxed into 260px while the rest of the wide surface sits empty. The one thing you want to watch —
   what the lead is doing right now — is the smallest thing on screen.
2. **The dispatched-agent UI is poor.** The lead's Task-tool subagents render via `SubagentRows`
   (`runssurface.tsx`) as a thin, non-interactive list: a colored dot + `type` + `model`. They are
   not clickable, show no state label, and look markedly weaker than the subagent rows in the Agents
   tab (`agenttree.tsx`), which have a state pill, hover affordance, and open the child's transcript
   interior on click. In orchestrator mode the subagents *are* the work, so this is the most
   under-served surface in the view.
3. **The pipeline chrome is dead weight here.** A one-step `CompactStepper` ("Playbook:
   [orchestrate]") and a one-node phase rail add visual scaffolding around a single phase for no
   information gain.

## Decisions (locked via brainstorming, 2026-07-11)

- **A dedicated orchestrator body, mode-gated — not a fork.** When `isOrchestrator(run)`, `RunsView`
  renders a purpose-built body: run header → (plan gate / ask, when present) → a **lead transcript
  panel that fills available height** → a **dispatched-agents section** → Cancel. It reuses the same
  underlying pieces (the run header, steer composer, `RunWorkerCard` internals, `ReviewGateCard`,
  `AskCard`, `BlockedCard`, `StartingCard`, `ShipMarker`) — only the layout that arranges them is
  orchestrator-specific. Pipeline runs are untouched: they keep the stepper + rail exactly as today.
- **Fill via a `RunWorkerCard` variant, not a second card.** `RunWorkerCard` gains a `fill?: boolean`
  prop. When set, the card becomes a flex column and its feed uses `min-h-0 flex-1` instead of
  `max-h-[260px]`, so the transcript grows to the viewport. All other behavior (header, flow bar,
  current line, task progress, stick-to-bottom, collapse) is unchanged. This is the DRY choice: one
  transcript component, one narration path.
- **Dispatched agents adopt the `agenttree` idiom.** `SubagentRows` is rewritten in place as a
  richer panel: a section header (`Dispatched · N`), then one clear row per subagent (↳ glyph,
  state-colored dot, `type`, `model`, a state pill). A row with a `transcriptPath` is clickable and
  opens that child's live transcript exactly as the Agents tab does — set `focusIdAtom` = lead, set
  `focusSubagentAtom` = child, switch `surfaceAtom` to `"agent"` (the `agentsurface` then renders
  `SubagentInterior`). No new plumbing; this reuses the wired path verbatim.
- **Show finished subagents.** Unlike `agenttree` (which drops `success`/`done` children so a live
  fan-out tree stays tight), the Runs dispatched section keeps completed children as a `✓ done`
  history — in a run you want to see the whole fan-out, not just what is still live.
- **Drop the pipeline chrome in the orchestrator body.** No `CompactStepper`, no one-node
  `PhaseRail`, no `RunRollup` (the large transcript makes the one-line rollup redundant). The run
  header (status pill + goal + Steer) stays.

## Non-goals

- Any change to pipeline-mode rendering, layout, or motion.
- Any change to the run lifecycle, phase model, gate semantics, subagent tracking/correlation, or the
  `livetranscript` stream ownership already in `RunsView`.
- Inline (in-Runs) expansion of a subagent transcript. Clicking opens the existing cockpit interior;
  an in-place expand was considered and declined (extra stream ownership for no clear gain).
- A new backend command, RPC, or `SubagentVM` field.
- Multi-lead / worktree-isolated orchestrator workers (a separate future piece).

---

## Architecture

Three files change; all front-end.

### 1. `runworkercard.tsx` — `fill` variant

Add `fill?: boolean` to `RunWorkerCard`. When `fill`:
- The outer card gets `flex min-h-0 flex-1 flex-col` (so it can own vertical space in a flex parent).
- The feed scroll container swaps `max-h-[260px]` → `min-h-0 flex-1` (grows to fill, scrolls inside).

Everything else — the header row, the accent flow bar, the current-activity line, the task-progress
footer, `useStickToBottom` + `JumpToLatestPill`, and the collapse toggle — is unchanged and shared
between the capped (pipeline) and fill (orchestrator) uses. Default `fill=false` keeps every existing
call site byte-identical.

### 2. `runssurface.tsx` — dispatched-agents panel + orchestrator body + the branch

**a. `DispatchedAgents` (rewrite of `SubagentRows`).** Same data source
(`subagentsByIdAtom[leadId]`), richer presentation. Reads `model` to drive the click-to-open. Renders
nothing when the lead has no subagents (unchanged from `SubagentRows`). Row shape mirrors
`agenttree.tsx`'s subagent rows: ↳ glyph, `SUB_COLOR[state]` dot, `type`, `model`, state pill;
`cursor-pointer` + click handler only when `transcriptPath` is present. Keeps finished children.

The click handler is the `agenttree` sequence, factored so the intent is obvious:
```
globalStore.set(model.focusIdAtom, leadId);
globalStore.set(focusSubagentAtom, { parentId: leadId, agentId: s.id, transcriptPath: s.transcriptPath!, label: s.type || "subagent" });
globalStore.set(model.surfaceAtom, "agent");
```
(`jumpToAgent` already does the focus-id + surface switch; we set `focusSubagentAtom` immediately
before calling it so the interior opens rather than the parent terminal.)

**b. `OrchestratorBody`.** A local component rendered instead of the scrolling rail body when the
active run is an orchestrator run. It owns a flex-fill column layout:

```
<div className="flex min-h-0 flex-1 flex-col px-6 pb-3 pt-5">
  run header (status pill + goal + Steer)          // flex-none — same markup as pipeline header
  {steering ? inline steer ComposerShell}          // flex-none — reused
  {thread.showGate ? <ReviewGateCard/>}            // flex-none — plan gate (orchestrator: lead held)
  {thread.showAsk  ? <AskCard/>}                   // flex-none — clarify / escalation
  lead transcript / state:                          // min-h-0 flex-1 — the fill region
     - lead present      -> <RunWorkerCard fill .../> + wraps <DispatchedAgents leadId=.../>
     - thread.showStarting -> <StartingCard/>
     - thread.showBlocked  -> <BlockedCard/>
  {thread.showShip ? <ShipMarker/>}                // flex-none — done
  {!isTerminal ? Cancel run}                        // flex-none — reused
</div>
```

The single orchestrate phase is `run.phases[currentPhaseIndex(run)]`; its `thread` comes from the
existing `phaseThread(run, idx, agents, liveTabIds)`, and its lead is `phaseWorkers(phase, agents)[0]`
— identical to what `PhaseRail` computes per phase, just for the one phase. `useSubagentTracking([lead])`
runs here (as it does in `PhaseRail`) so `subagentsByIdAtom` is populated for `DispatchedAgents`.

The dispatched section sits **below** the transcript but is part of the same scroll/flow: the
transcript panel is the fill scroller; `DispatchedAgents` is a `flex-none` block under it with its own
`max-h` + scroll if the fan-out is large. (If the fan-out list ever needs to compete with the
transcript for height, that is a later refinement — YAGNI now.)

**c. The branch in `RunsView`.** Where the body is chosen (`run ? (...pipeline...) : (...new run...)`),
add the orchestrator arm *ahead of* the pipeline arm and *outside* the `overflow-y-auto` scroll
container (the fill layout must own its own scrolling, so it cannot live inside the surface's single
scroller):

```
{run && isOrchestrator(run) ? (
    <OrchestratorBody .../>            // its own flex-fill column, no outer overflow-y-auto
) : (
    <div className="sc min-h-0 flex-1 overflow-y-auto px-6 pb-3 pt-5">
        {run ? (...pipeline rail...) : (...new-run panel...)}
    </div>
)}
```

The run tabs strip, the new-run panel, transcript-stream ownership, the entrance guard, and the
`now` clock in `RunsView` are all unchanged. (The entrance guard/`phaseRailIds` only feeds
`PhaseRail`, which the orchestrator body does not use — harmless no-op for orchestrator runs.)

### 3. `runmodel.ts` — one pure seam

Add `leadWorker(run: Run, agents: AgentVM[]): AgentVM | undefined` — the orchestrate lead: the first
worker of the current phase, or `undefined`. This is the same derivation `steerTarget` already uses
internally (`phaseWorkers(run.phases[currentPhaseIndex(run)], agents)[0]`), extracted so
`OrchestratorBody` stays a thin shell and the derivation is unit-tested. `steerTarget` can be
expressed in terms of it (`isTerminal ? undefined : leadWorker(...)`), keeping one source of truth.

## Data flow (unchanged substrate)

- **Lead transcript:** `RunsView` already opens `livetranscript` streams for the active run's running
  workers (`streamableTranscriptAgents`); the lead is one of those. `RunWorkerCard fill` reads the
  same `liveEntriesByIdAtom[lead.id]` — nothing new to stream.
- **Subagents:** `useSubagentTracking([lead])` in `OrchestratorBody` schedules the disk-backed
  `subagentsByIdAtom[lead.id]` refresh (same as `PhaseRail` does today). `DispatchedAgents` reads it.
- **Open child:** reuses `focusSubagentAtom` + `agentsurface.tsx` interior — the same path
  `agenttree.tsx` uses.
- **Gate / ask / blocked / ship / steer / cancel:** all reuse the existing cards and RPCs; only their
  arrangement differs in the orchestrator body.

## Testing

- **Unit (`runmodel.test.ts`):** `leadWorker` — running phase → its first worker; terminal or no
  worker → `undefined`; and that `steerTarget` still returns `undefined` on a terminal run (guarding
  the refactor). Pure, no render harness (repo has none — see CLAUDE.md).
- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline clean,
  exit 0; `npx tsc` stack-overflows here).
- **Visual (CDP, best-effort):** with `tail -f /dev/null | task dev` running and an orchestrator run
  injected (`node scripts/inject-live-agents.mjs <scenario>`), capture `node scripts/cdp-shot.mjs`:
  the lead transcript fills the surface height; the dispatched section shows rich rows; clicking a
  child with a transcript switches to the agent surface with that child's interior open; a pipeline
  run still renders the stepper + rail unchanged; plan gate / blocked / done states still appear in
  the orchestrator body. If dev is not running, mark the visual step UNVERIFIED — do not claim pass.

## Conventions

- FE-only; reuse existing RPCs; never hand-edit generated files.
- No emojis in code or UI copy. Comments explain "why," lower-case, only when necessary. `// Copyright
  2026, Command Line Inc.` + SPDX header stays on touched files.
- Reduced motion: no new animation is introduced; the reused flow bar already degrades under
  `motion-reduce`.
- Do not commit inside tasks; the repo owner batches one approval-gated commit at the end.
