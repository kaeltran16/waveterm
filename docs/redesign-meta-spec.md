# Agent Cockpit — Meta Spec (App Skeleton)

> Captured 2026-06-24, **re-grounded 2026-06-25** onto the new Claude Design handoff
> bundle and the completed Tauri migration. The umbrella architecture doc for the
> agent-cockpit redesign. Reads on top of [`redesign-brief.md`](./redesign-brief.md)
> (product intent) and [`feature-triage.md`](./feature-triage.md) (what already exists).
> This doc defines the **skeleton** — shell, the surface inventory, and the phasing.
> Each phase gets its own detailed sub-spec.
>
> **Source of truth:** `wave-handoff/wave/project/Wave-cockpit-live.dc.html`. It contains
> the whole app (all eight surfaces, via `sc-if`) and is the canonical design. The standalone
> answer-treatment explorations (`Wave-inline*.dc.html`, `Wave-panel.dc.html`,
> `Wave-spotlight.dc.html`, `Wave-variants.dc.html`) and the old whole-app `Wave.dc.html`
> lost the bake-off — `cockpit-live` won with inline-in-card — and **have been pruned from
> the bundle** (D5). `Wave-answer.dc.html` is *not* an exploration and was kept: it is a
> reusable component `cockpit-live` imports (`<dc-import name="Wave-answer">`) for the
> expanded idle/selected row, alongside the shared `support.js` that both files load.

## 1. Vision

Wave is a dark desktop terminal becoming an **agent-orchestration cockpit**: one power
user supervising 3–10 AI coding agents across several projects, keyboard-first —
glance, triage, intervene. The terminal foundation (PTY, blocks, layout, SSH) is solid
and out of scope. This redesign is the **agent layer**: a calm control room, not a wall
of logs. A glance must answer "where do I need to step in?" — the *asking-me* state is
the emotional center.

The design-system **foundation** (palette, typography, motion) already landed
(`ca1a6c45`, spec `docs/superpowers/specs/2026-06-25-cockpit-foundation-theme-design.md`):
periwinkle accent, Hanken Grotesk / JetBrains Mono, the handoff keyframes and scrollbar.
Every surface below consumes those `@theme` tokens; none re-derive them.

## 2. Containment — the cockpit *is* the app

This is no longer a choice between containment options. After the Tauri migration
(Phase 5b teardown), **the cockpit is the sole frontend**: `CockpitRoot`
(`frontend/app/cockpit/cockpit-root.tsx`) owns the entire borderless window — there are
no tabs, no block frames, no multi-block layout. The OS titlebar is drawn in React
(`CockpitTitlebar`). The old "evolve the agents *block* / Wave keeps the tab bar above the
view" framing is obsolete and has been removed.

What remains live and intact: the single `AgentsViewModel` instance `CockpitBody` builds
(blockId `cockpit-agents`, a synthetic node model), all its data wiring/RPC, and `WaveEnv`
plumbing. The redesign reshapes *what `CockpitBody` renders*, not how it boots.

Today `CockpitBody` renders a two-pane layout: `cockpit-roster` (a `+ New Agent` toolbar
over the `AgentsViewModel` list view) beside `CockpitFocusPane` (the focused agent's real
**term block**, via `makeViewModel(blockId, "term", …)`). The redesign replaces this two-pane
shape with a **nav-rail + surface router** (§3). The focused-terminal pane survives as one
mode of the Agent surface ("Open terminal"), not as a permanent half of the window.

## 3. Shell architecture

`CockpitBody` splits into a thin shell — a persistent left **NavRail** plus a
**surface router** — over the existing `agents/*` logic, which stays the single owner of
sort/group/collapse/cursor/transcript state.

```
CockpitRoot
└─ cockpit-shell
   ├─ CockpitTitlebar                      // React-drawn OS titlebar (unchanged)
   └─ CockpitBody
      ├─ NavRail (78px)                     // all 8 surfaces, always shown (D6)
      └─ <active surface>                   // selected by surfaceAtom on AgentsViewModel
         ├─ CockpitSurface                  // live grid + idle + backgrounded + Usage rail
         ├─ AgentSurface (Focus)            // tree | transcript+composer | details rail
         ├─ UsageSurface
         ├─ ActivitySurface                 // Phase 2
         ├─ SessionsSurface                 // Phase 2
         ├─ FilesSurface                    // Phase 2
         ├─ ChannelsSurface                 // Phase 3
         ├─ MemorySurface                   // Phase 3
         └─ PlaceholderSurface              // "coming soon" for not-yet-built surfaces (D6)
```

- The model gains one atom: `surfaceAtom: PrimitiveAtom<SurfaceKey>`. Rail clicks and
  surface-switch keybindings set it.
- All existing **pure logic** stays in `agentsviewmodel.ts` and peers
  (`liveagents.ts`, `livetranscript.ts`, transcript projections). Surfaces are
  independently understandable and testable thin views over it.
- The **full eight-item rail renders from Phase 1** to match the design; surfaces whose
  phase hasn't landed route to `PlaceholderSurface` (a calm "coming soon" pane), never a
  dead click (D6).

## 4. Surface inventory

Eight surfaces (the handoff rail). Usage is **dual-homed**: a collapsible rail on the
Cockpit *and* a full nav surface.

| Surface | Purpose (skeleton) | Key elements (from `cockpit-live`) | Reuse | Phase |
|---|---|---|---|---|
| **Cockpit** | All live agents grouped by state; the at-a-glance triage view. | header (`N agents · 5 projects · N need you`); project filter · Live-only toggle · status chips (All/Asking/Working/Idle); **Live agents** 2-col grid — per-card status dot, project pill, `needs you` badge, **inline transcript feed**, asking/working treatments, **answer-in-place** (suggestion chips + composer + Send), widen/terminal/mute, drag-reorder + resize; **Idle** rows (expand → `Wave-answer`); **Backgrounded** (collapsible); keyboard-triage bar; collapsible **Usage & activity** right rail. | reskin/rebuild over existing live grouping (`liveagents`, `agentrow`, `narrationtimeline`, `statusdot`, `idlesection`, `backgroundedsection`, `answerbar`, `agentcomposer`) | 1 |
| **Agent (Focus)** | One agent in depth. | 3-pane: left **agent tree** (grouped by project, parent rows + branch, **subagent** expand → ↳ children w/ type + status); center **transcript** (user/agent/collapsed tool-group bursts/amber question block) + suggestion chips + **composer** (model picker, attach, send); right **Details rail** (Project/Branch/Model/Running/Tokens/Cost, **Context-window** gauge, **Subagents** list, **Tools used**, **Files touched**, Resume/Stop). | reskin `focusview`, transcript projections, `agentcomposer`; `CockpitFocusPane` term block = "Open terminal" mode | 1 |
| **Usage** | Live quota/spend. | per-provider 5h + weekly gauges w/ reset timers; spend; by-model. Cockpit rail is the compact mirror. | promote `ProviderPlan`/`MiniGauge` + statusLine usage bridge | 1 (rail) / 2 (full) |
| **Activity** | One cross-project event stream. | `Activity — every agent event, grouped by project`; type filters (Asked/Errored/Committed/Started/Finished); one-click jump to source. | partial — needs an event store fed by agent-lifecycle signals (today only inline status dots) | 2 |
| **Sessions** | Browse / search / resume past runs. | sortable table; searchable prompt history; resume. | partial — transcripts + `historyutil.ts` | 2 |
| **Files** | Read-only project file context. | left **file tree** (project picker, branch + `+adds −dels`, per-node git status); center **diff viewer** (gutter, +/− hunks) / **plain viewer**; `Read-only`; **Open in editor**. | partial — git status + filesystem; reuse `preview`/`codeeditor` rendering | 2 |
| **Channels** | Human↔agent coordination chat. | channels + DMs; `In this channel`; @-mention agents; pinned context. | net-new (backend-heavy) | 3 |
| **Memory** | Persistent agent memory, cross-project. | header (count, search, **Graph/List** toggle, New memory); **Graph** (clusters per project + `GLOBAL · SHARED`, node types Decision/Fact/Convention/Preference, edges, legend, zoom); **List** (grouped, type pills); detail rail (content, Edit). | net-new (graph is the costly half) | 3 |
| **@agent orchestrator** | In-app delegation between agents. | not a rail item; cross-cutting; depends on Channels. | net-new | 3 / future |

## 5. Navigation & interaction model

- **Rail-driven** surface switching; **keyboard-first** throughout. The Cockpit's triage
  bar is now concrete: `↑↓ move · ⏎ expand · esc collapse · 1–9 answer · R reply ·
  T terminal · M mute · N next-asking`.
- **Focus model = "both"** (confirmed by the handoff, no longer pending):
  - *Inline triage* — on the Cockpit, an asking/working agent's card shows its live feed
    and an **answer-in-place** composer (reply-suggestion chips + input + Send), so a
    blocked agent is answered without leaving the overview. Selecting an idle row expands
    the `Wave-answer` component in place.
  - *Deep focus* — the dedicated **Agent** surface hosts the subagent tree + full
    transcript + details rail, reachable from the rail or an "open full" affordance.
- **Answer treatment = inline-in-card** (D3). The side-panel / spotlight / inline-grow
  variant files lost the bake-off and are not built.
- Cockpit ergonomics from the design: **drag-to-reorder** live cards, per-card **widen**
  (1- vs 2-col), per-card **resize** handle, **mute → Backgrounded**, **collapsible**
  Usage & activity rail.

## 6. Data flow

- **Live agent state** (`liveagents.ts`, `livetranscript.ts`, transcript projections) →
  Cockpit + Agent.
- **Usage** ← existing per-provider gauge logic + the statusLine usage bridge (feeds both
  the Cockpit rail and the full Usage surface).
- **Activity** (P2) ← a new event store fed by the same agent-lifecycle signals.
- **Sessions** (P2) ← transcripts + `historyutil.ts`.
- **Files** (P2) ← filesystem + git status for the focused agent's worktree; diff/plain
  rendering reuses `preview`/`codeeditor`. Read-only (no writes from this surface).
- **Channels / Memory** (P3) ← new backends (RPC additions via `wshrpctypes.go` +
  `task generate`).

## 7. Cross-cutting conventions

- Jotai model singleton pattern (atoms on `AgentsViewModel`; simple atoms as fields,
  derived/dependent in ctor; updates via `globalStore`).
- Styling: Tailwind v4 + the `@theme` tokens — **the handoff foundation is already in**
  (`ca1a6c45`); surfaces consume those tokens and add none of their own one-offs.
- New RPC via `wshrpctypes.go` + `task generate`; never hand-edit generated files.
- Testing: pure logic stays under unit tests (`agentsviewmodel.test.ts` and peers);
  visual reskin verified via the CDP dev-app check.

## 8. Phasing roadmap

Foundation (theme/type/motion) is **done**. Phases are sorted by how much new backend each
needs: P1 ≈ none, P2 leans on existing data, P3 builds new systems. Each ships
independently and is verifiable on its own. The full rail renders from P1; unbuilt
surfaces show the placeholder pane.

- **Phase 1 — Shell + Cockpit + Agent** *(reuse-heavy, near-term)*: NavRail + surface
  router; rebuild the Cockpit live grid with inline answer-in-place, idle/backgrounded
  sections, keyboard triage; rebuild the Agent 3-pane focus; promote the Usage rail.
  Delivered as two sub-specs: **1a** (shell + state lift + Cockpit surface + Usage rail;
  Agent routes to the interim `FocusView`) then **1b** (the Agent 3-pane surface). See
  `docs/superpowers/specs/2026-06-25-cockpit-phase1a-shell-cockpit-design.md`.
- **Phase 2 — Data-mapped surfaces**: Activity feed, Sessions browse/resume, the full
  Usage surface, and Files (read-only tree + diff).
- **Phase 3 — Net-new lifts**: Channels, Memory (list + graph), @agent orchestrator.

## 9. Open questions & dependencies

- **Files data source** — git-diff/status via a new wshrpc call vs. reusing the existing
  `preview`/`codeeditor` plumbing end-to-end. Resolve in the Files sub-spec (P2).
- **Agent surface vs. focus-terminal pane** — confirm "Open terminal" swaps the Agent
  center pane to the `CockpitFocusPane` term block (vs. a separate window region).
- **Activity event store** — schema + whether it persists or is session-live. P2 sub-spec.

## 10. Decision log

- **D1 — Containment:** the cockpit *is* the sole frontend (Tauri). Not a chosen option
  anymore — the block/tab-bar framing was removed by the Phase 5b teardown.
- **D2 — Reuse boundary:** Cockpit / Agent / Usage(rail) = reskin; Activity / Sessions /
  Files = partial; Channels / Memory / @agent = net-new.
- **D3 — Focus interaction:** "both" — inline answer-in-place on the Cockpit **and** a
  dedicated Agent surface. Answer treatment is **inline-in-card** (variant explorations
  rejected).
- **D4 — Build scope / phasing:** foundation done; P1 = shell + Cockpit + Agent;
  P2 = Activity/Sessions/Usage/Files; P3 = Channels/Memory/@agent.
- **D5 — Source of truth:** the handoff bundle is canonical; `Wave-cockpit-live.dc.html`
  is the whole-app design. `Wave-answer.dc.html` (+ `support.js`) are reused components and
  kept; the old `Wave.dc.html` and the standalone variant files were superseded and have
  been pruned from the bundle.
- **D6 — Rail growth:** render all eight rail items from Phase 1; surfaces whose phase
  hasn't landed route to a "coming soon" placeholder pane (faithful to the design; no
  dead nav).
