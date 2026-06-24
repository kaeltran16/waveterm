# Agent Cockpit — Meta Spec (App Skeleton)

> Captured 2026-06-24. The umbrella architecture doc for the agent-cockpit redesign.
> Reads on top of [`redesign-brief.md`](./redesign-brief.md) (product intent) and
> [`feature-triage.md`](./feature-triage.md) (what already exists). This doc defines the
> **skeleton** — containment, shell, the surface inventory, and the phasing. Each phase
> gets its own detailed sub-spec; Phase 1 is the first.

## 1. Vision

Wave is a dark desktop terminal becoming an **agent-orchestration cockpit**: one power
user supervising 3–10 AI coding agents across several projects, keyboard-first —
glance, triage, intervene. The terminal foundation (PTY, blocks, layout, SSH) is solid
and out of scope. This redesign is the **agent layer**: a calm control room, not a wall
of logs. A glance must answer "where do I need to step in?" — the *asking-me* state is
the emotional center.

The full visual design exists as `Wave.dc.html` in the Claude Design `wave` project; it
is the visual source of truth. This doc is the implementation skeleton, not a restyle.

## 2. Containment — Option A (evolve the agents block)

The cockpit lives **inside** the existing Wave window, not as a new top-level mode.

- It remains the registered `"agents"` block view (`blockregistry.ts` → `AgentsViewModel`),
  so all existing data wiring, RPC, and `WaveEnv` plumbing stay intact.
- It renders **full-bleed**: `AgentsViewModel` gains `noHeader = atom(true)` (honored at
  `blockframe.tsx:199`); it already sets `noPadding = atom(true)`.
- Wave keeps ownership of the OS titlebar and the tab bar above the view. The cockpit
  draws only the region beneath them.

Rationale: lowest risk, zero regression of recently shipped agent work, and it respects
the brief's "don't redesign Wave's core chrome." A later graduation to a dedicated
non-block "cockpit tab" stays open if the single-block framing ever chafes.

## 3. Shell architecture

Today `AgentsView` is one large component (asks/working/idle regions + inline focus
overlay + usage strip + keyboard hints). It splits into a thin shell plus one component
per surface:

```
AgentsView (shell)                 // full-bleed block, no header
├─ NavRail                         // switches surfaces; renders only implemented ones
├─ TopStrip                        // project filter · ⌘K · usage pill · New agent
└─ <active surface>                // selected by surfaceAtom on the model
   ├─ CockpitSurface
   ├─ FocusSurface (Agent)
   ├─ UsageSurface
   ├─ ActivitySurface             // Phase 2
   ├─ SessionsSurface             // Phase 2
   ├─ ChannelsSurface             // Phase 3
   └─ MemorySurface               // Phase 3
```

- The model gains one atom: `surfaceAtom: PrimitiveAtom<SurfaceKey>`. Rail clicks and
  keybindings set it.
- All existing **pure logic** (sort/group/collapse/cursor) stays in
  `agentsviewmodel.ts`. Surfaces are independently understandable and testable.
- Surfaces are added to the rail as their phase lands — no dead nav items.

## 4. Surface inventory

| Surface | Purpose (skeleton) | Key elements | Reuse | Phase |
|---|---|---|---|---|
| **Cockpit** | All live agents grouped by state; the at-a-glance triage view. | asking-me / working / idle (+ blocked) groups; per-agent activity, project, live usage; **respond-in-place** on select. | reskin existing asks/working/idle grouping | 1 |
| **Agent (Focus)** | One agent in depth. | live transcript with collapsed tool-call bursts; inline reply composer; **subagent tree** (child shows type + working→✓/✗, click-to-open its session); details rail (project, branch, model, runtime, tokens, cost, context window, tools used, files touched). | reskin `focusview`, `agentrow`, `answerbar`, `agentcomposer`, `narrationtimeline`, transcript projections | 1 |
| **Usage** | Live quota/spend. | 5h + weekly gauges per provider with reset timers; spend; by-model breakdown. | promote `ProviderPlan`/`MiniGauge` + statusLine usage bridge to a full surface | 1 |
| **Activity** | One cross-project event stream. | started / finished / asked / errored events; one-click jump to source. | partial — needs an event store/stream (today only inline status dots) | 2 |
| **Sessions** | Browse / search / resume past runs. | sortable table; searchable prompt history; resume. | partial — transcripts + `historyutil.ts` | 2 |
| **Channels** | Human↔agent coordination chat. | channels + DMs; @-mention agents; pinned context. | net-new (backend-heavy) | 3 |
| **Memory** | Persistent agent memory, cross-project. | structured list **and** interactive graph of connections; browse/search/edit. | net-new (graph is the costly half) | 3 |
| **@agent orchestrator** | In-app delegation between agents. | cross-cutting; depends on Channels. | net-new | 3 / future |

## 5. Navigation & interaction model

- **Rail-driven** surface switching; **keyboard-first** throughout (surface-switch keys +
  existing cursor/focus nav), with visible key hints.
- **Focus model = "both"** (subject to confirmation from the Claude Design treatments):
  - *Inline triage* — selecting an agent in the Cockpit expands it in place with a
    transcript peek + reply composer, so a blocked/asking agent is answered without
    leaving the overview (reuses the cursor-row composer).
  - *Deep focus* — the dedicated **Agent** surface, reachable from the rail or an
    "open full" affordance on the expanded card, hosts the subagent tree + details rail.
- The exact respond-in-place treatment (inline-grow / side-panel / spotlight) comes from
  the selected Claude Design variant.

## 6. Data flow

- **Live agent state** (`liveagents.ts`, `livetranscript.ts`, transcript projections) →
  Cockpit + Focus.
- **Usage** ← existing per-provider gauge logic + the statusLine usage bridge.
- **Activity** (P2) ← a new event store fed by the same agent lifecycle signals.
- **Sessions** (P2) ← transcripts + `historyutil.ts`.
- **Channels / Memory** (P3) ← new backends (RPC additions via `wshrpctypes.go` +
  `task generate`).

## 7. Cross-cutting conventions

- Jotai model singleton pattern (atoms on `AgentsViewModel`; simple atoms as fields,
  derived/dependent in ctor; updates via `globalStore`).
- Styling: Tailwind v4 + the `@theme` tokens (the agents palette reskin already aligned
  colors to theme tokens — continue that; avoid one-off colors).
- New RPC via `wshrpctypes.go` + `task generate`; never hand-edit generated files.
- Testing: pure logic stays under unit tests (`agentsviewmodel.test.ts` and peers);
  visual reskin verified via the CDP dev-app check.

## 8. Phasing roadmap

- **Phase 1 — Shell + reskin what exists** *(reuse-heavy, near-term)*: full-bleed shell,
  surface router, NavRail; reskin Cockpit + Agent; promote Usage; land respond-in-place.
- **Phase 2 — Data-mapped surfaces**: Activity feed, Sessions browse/resume.
- **Phase 3 — Net-new lifts**: Channels, Memory (list + graph), @agent orchestrator.

Sorted by how much new backend each phase needs: P1 ≈ none, P2 leans on existing data,
P3 builds new systems. Each phase ships independently and is verifiable on its own.

## 9. Open questions & dependencies

- **Respond-in-place treatment** — pending the Claude Design variants (inline-grow /
  side-panel / spotlight); needed before the Phase 1 composer/layout steps, not before
  the shell/reskin steps.
- **Focus model "both"** — confirm against the chosen treatment.
- **Rail growth** — whether later-phase surfaces appear disabled/"coming soon" or are
  simply absent until their phase lands (current lean: absent).

## 10. Decision log

- **D1 — Containment:** Option A, evolve the agents block (vs. full-screen mode / hybrid
  cockpit tab). *Reuse + no regression + respects brief.*
- **D2 — Reuse boundary:** Cockpit / Focus / Usage = reskin; Activity / Sessions =
  partial; Channels / Memory / @agent = net-new.
- **D3 — Focus interaction:** "both" (inline triage + dedicated Agent surface).
- **D4 — Build scope:** Full Phase 1 now; Phases 2–3 are roadmap.
