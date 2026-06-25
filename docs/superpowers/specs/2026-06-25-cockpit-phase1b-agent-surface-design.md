# Cockpit Phase 1b — Agent 3-Pane Focus Surface

Date: 2026-06-25
Status: approved-design

> The second sub-spec under [`docs/redesign-meta-spec.md`](../../redesign-meta-spec.md)
> (§3 shell, §4 Agent surface, §8 Phase 1). Builds on
> [`2026-06-25-cockpit-phase1a-shell-cockpit-design.md`](./2026-06-25-cockpit-phase1a-shell-cockpit-design.md),
> which shipped the shell (NavRail + `surfaceAtom` router + state lift) and the Cockpit
> surface, and routed the Agent nav item to the interim `FocusView`. **Source of truth:**
> `wave-handoff/wave/project/Wave-cockpit-live.dc.html` (`isFocus` branch, lines 356–542).
>
> **1b** replaces the interim Agent surface with the real **3-pane focus**:
> `AgentTree` | `AgentTranscript` (+ composer) | `AgentDetailsRail`. It is pure frontend
> over existing data + streams — **no new RPC, no new Go**.
>
> **Companion specs (parallel, disjoint scope):**
> [`2026-06-25-cockpit-handoff-parity-design.md`](./2026-06-25-cockpit-handoff-parity-design.md)
> brings the **Cockpit** surface + shell chrome to handoff parity (it lists this Agent surface
> as a non-goal — clean partition); 1b touches none of its files and adds no model atoms.
> [`2026-06-25-cockpit-testdata-injection-design.md`](./2026-06-25-cockpit-testdata-injection-design.md)
> supplies the mock roster used to eyeball this surface. **Coordination:** when handoff-parity
> adds the `replySuggestions` field to the ask, 1b's footer chips should consume it (§5.2 / §8)
> instead of static placeholders. **Verification caveat:** the test-data FE JSON mock populates
> `agentsAtom` (so the tree/transcript/rail/AnswerBar render) but **not** `getSubagentsAtom`, so
> 1b's subagent children + Subagents rail are exercised only by the live injector (Mechanism 2)
> or a mock extension that seeds subagents.

## 1. Scope

**In:**
- A `surface === "agent"` router target: **`AgentSurface`** — a flex row of three panes
  laid out per the `isFocus` design.
- **`AgentTree`** (left, 248px): the live roster grouped by project; parent rows with an
  expandable **subagent** branch; click selects focus.
- **`AgentTranscript`** (center, flex): the focused agent's header, scrolling transcript
  (with burst-collapse + "↓ N new" pill), amber answer bar, suggestion chips + composer.
  Absorbs `FocusView`'s center logic; `FocusView` is then deleted.
- **`AgentDetailsRail`** (right, 296px): Details, Context-window gauge, Subagents, Tools
  used, Files touched, and the lifecycle actions.
- **`buildAgentTree`** — a pure helper (its own file + node-env test) that turns the agent
  roster into ordered tree rows (group / parent / child).
- **"Open terminal"** keeps swapping the center pane to the `CockpitFocusPane` term block
  (the interim mechanism; meta §9 confirmed).

**Out (deferred):**
- Any **new backend / RPC**. 1b is a view-composition phase.
- **Live git branch** and **per-file git status** — rendered as placeholders (§6 / §8).
- **Pause / Resume / Stop** — rendered disabled; no lifecycle RPC yet (§6 / §8).
- **Selectable subagent children** with their own transcript — children are display-only
  in 1b (no per-child transcript exists).
- Per-pane **resize / widen**; full Usage / Activity / Sessions / Files / Channels /
  Memory surfaces (later phases; their nav items keep routing to `PlaceholderSurface`).

**Hard constraints:**
- The cockpit is the sole frontend (meta D1); the surface mounts under `CockpitTitlebar`
  via `CockpitShell`.
- Pure logic in `agentsviewmodel.ts` and `sessionviewmodel.ts` is **reused, not rewritten**;
  their tests stay green.
- **Handoff visual fidelity is a first-class goal** (1a drifted; 1b must not). Reproduce the
  `isFocus` markup faithfully: exact pane widths (248/296px), spacing, and the mono uppercase
  section-label typography (`font-mono`, `tracking-[.1em]`, `uppercase`, size/weight per the
  prototype). Use `@theme` tokens for every palette value that maps (they *are* the handoff
  palette by design — `bg-surface` = `#0e1116`, `bg-surface-raised` = `#13171d`,
  `text-muted` = `#6b7178`, `text-accent`/`bg-accent` = `#7c95ff`, `text-warning` = `#e6b450`,
  `text-success` = `#54c79a`, `border-border` = `#1c2128`, `border-edge-mid` = `#20262e`,
  etc.). For the handoff's finer surface-depth and ink shades that have **no** token
  (`#0d1014`, `#0f1217`, `#1a1f26`, `#181d23`, `#161a20`, `#0a0c0f`, `#8aa0ff`, `#bdc4cc`,
  `#8b939d`, `#5f666f`, …), use exact Tailwind arbitrary values (`bg-[#0f1217]`) to match —
  do **not** approximate by snapping to the nearest token (that is the drift to avoid). No new
  SCSS (project convention); no expanding the token set in 1b (foundation work).
- Models own atoms and never call React hooks; effects live in components.
- Routing stays **shell-side** (`cockpitshell.tsx` imports `CockpitFocusPane`), preserving
  the 1a fix for the `agents → focus-pane → blockregistry → agents` TDZ-eval cycle.

## 2. Reconciliation — interim Agent surface → 1b

Today (1a) `CockpitShell` renders `AgentSurfaceInterim`: with a `terminalTargetAtom` it
shows `CockpitFocusPane`; otherwise it wraps `FocusView` (single-column transcript +
answer bar + composer) for `focusIdAtom`, falling back to `CockpitSurface`.

| Item | Disposition | Notes |
|---|---|---|
| `AgentSurfaceInterim` wrapper (terminal-vs-focus branch, keydown: esc/←→/t) | **REDESIGN → `AgentSurface`** | Same routing semantics; gains the 3-pane layout and `↑↓` tree moves. |
| `FocusView` center (scroll-stick, "↓ N new" pill, `NarrationTimeline`, ctx bar, `AnswerBar`, `AgentComposer`) | **RETAIN → relocate** into `AgentTranscript` | Logic unchanged; the ctx bar collapses into the Details rail's Context-window gauge. |
| `FocusView` header (back ‹›, name, model, terminal) | **REDESIGN** | Re-shaped into the center-pane header (status badge, project · branch, Open terminal, Pause/Stop). Prev/next ‹› become tree selection + `←→`. |
| `FocusView` (the file) | **DELETE** | Fully absorbed; no other caller (`cockpitshell` is the only importer). |
| `getSubagentsAtom` / `getSubagentExpandAtom` / `toggleSubagentExpand` | **RETAIN → reuse** | Already feed the legacy sidebar; now feed the tree + rail. |
| `summarizeActions`, `groupTimeline`, `formatAge`, `formatTokens`, `usageLevel`, `moveCursor` | **RETAIN → reuse** | Pure helpers; `summarizeActions` powers the Tools-used pills. |
| `projectNameFromTranscriptPath` | **RETAIN → reuse** | Tree grouping key. |
| Interim `←→` step over `model.orderAtom` | **RETAIN → extend** | Kept as keyboard nav; the tree is the pointer-driven equivalent. |

## 3. Surface architecture

```
CockpitShell (cockpitshell.tsx)
└─ surface === "agent"  →  AgentSurface              agentsurface.tsx   // new (replaces AgentSurfaceInterim)
   ├─ terminalTarget set →  CockpitFocusPane                            // unchanged "Open terminal" mode
   └─ else (3-pane row):
      ├─ AgentTree         agenttree.tsx     (248px)  // grouped roster + subagent branch
      ├─ AgentTranscript   in agentsurface.tsx        // header + transcript + answer + composer
      └─ AgentDetailsRail  agentdetailsrail.tsx (296px)
```

- `CockpitShell` swaps the `AgentSurfaceInterim` branch for `<AgentSurface model={…}
  tabId={…}/>`. The `CockpitFocusPane` import stays in `cockpitshell.tsx` (or is re-exported
  from `agentsurface.tsx`, which is itself only imported shell-side) to keep `agents.tsx`
  free of the focus-pane import.
- `AgentSurface` owns the terminal-vs-3-pane branch and the surface keydown handler; the
  three panes are presentational over the model atoms.
- With no `focusIdAtom` (nothing selected) `AgentSurface` falls back to `CockpitSurface`,
  matching the interim.

## 4. State model

**No new model atoms are required.** 1b consumes what 1a lifted onto `AgentsViewModel`:
`surfaceAtom`, `focusIdAtom`, `focusReplyAtom`, `terminalTargetAtom`, `nowAtom`,
`agentsAtom`, `orderAtom`, `answerSelAtom`, `answerTabAtom`, `sentIdsAtom` — plus the
existing per-block atoms `getSubagentsAtom`, `getSubagentExpandAtom`, `getAgentUsageAtom`
(keyed by `termBlockOref`; the focused agent's oref is `block:<agent.blockId>`).

Action methods reused unchanged: `openFocus`, `openTerminal`, `submitAnswer`,
`setSurface`. Tree expand uses the existing `toggleSubagentExpand(oref, expanded)`.

Effects (in `AgentSurface`, since models can't use hooks): keyboard focus pull (as the
interim does), and the transcript scroll-stick effect (migrated from `FocusView`). The 1s
`nowAtom` tick is already driven globally by the Cockpit surface.

## 5. The three panes

### 5.1 `AgentTree` (left, 248px)

- **Header:** "Agents" (uppercase mono label) + total count.
- **Rows** from `buildAgentTree(agents, order)`:
  - **group** — project header: `projectNameFromTranscriptPath` label · divider · optional
    attn count (asking agents in group) · group count.
  - **parent** — status dot (`StatusDot`) · name · `placeholder` branch subtitle ·
    subagent-expand pill (`caret + subCount`, shown iff the parent has live subagents) ·
    status label. Click → `globalStore.set(focusIdAtom, id)` (+ clear `focusReplyAtom`).
    The focused row carries the active background treatment.
  - **child** — ↳ indent, smaller dot, subagent name, `type` label, state label. Sourced
    from `getSubagentsAtom(parentOref)`; visible only while the parent expand is on.
    **Display-only** in 1b.
- **Grouping/order:** parents follow `model.orderAtom` (anchored order from 1a) within
  their project group; project groups appear in first-seen order. `buildAgentTree` is pure
  and unit-tested (group boundaries, child interleaving, empty/append cases).

### 5.2 `AgentTranscript` (center, flex)

- **Header:** status dot · name · status-label badge (colored border) · `project · `
  `placeholder branch` · "↳ subagent · spawned by X" note when the focused agent is a child
  (1b: only if such a relationship is known; otherwise omitted) · spacer · **Open terminal**
  (live → `openTerminal`) · **Pause** + **Stop** (disabled, "coming soon" title).
- **Body:** the scroll container migrated from `FocusView` — `NarrationTimeline` over
  `liveEntriesByIdAtom[agent.id] ?? agent.previousInfo ?? []` with `groupTimeline`
  burst-collapse, `accentLatest`, `active` while working, plus the scroll-stick + "↓ N new"
  pill behavior. Centered max-width column (~720px) per the design.
- **Amber ask:** `AnswerBar` for asking agents (numbered options, multi-question tabs),
  wired to `answerSelAtom` / `answerTabAtom` / `sentIdsAtom` / `submitAnswer` exactly as
  the interim does.
- **Footer:** `placeholder` suggestion chips (reuse the structured ask options as chips when
  asking; otherwise omitted/static) + `AgentComposer` (`blockId`, placeholder, existing
  model-picker / attach affordances).

### 5.3 `AgentDetailsRail` (right, 296px)

- **Details** rows: **Project** (live) · `Branch` (placeholder) · **Model** (live
  `agent.model`) · **Running** (live `formatAge(activeMs)` / idle age) · *Tokens* (derived
  `formatTokens(contextpct/100 × (contextmax||200000))`, else placeholder) · **Cost** (live
  `usage.costusd`, hidden when 0 — matches existing behavior).
- **Context window** gauge: live `usage.contextpct` (% label + bar; reuse `usageLevel`
  banding). This replaces `FocusView`'s inline ctx bar.
- **Subagents** (shown iff live subagents exist): count badge + list (dot · name · activity
  · state) from `getSubagentsAtom`.
- **Tools used:** derived pills from `summarizeActions(actions).byVerb` over the focused
  agent's entries (e.g. `read ×6`, `grep ×4`). Live.
- **Files touched:** `placeholder` list with fake M / + gutters (no git status source).
- **Resume / Stop** buttons: disabled, "coming soon" title.

## 6. Data sourcing — live / derived / placeholder

| Field | Source in 1b |
|---|---|
| Project, Model, Running, Cost | **live** (`AgentVM`, `usage.costusd`) |
| Context-window gauge | **live** (`usage.contextpct` / `contextmax`) |
| Subagents (tree children + rail list) | **live** (`getSubagentsAtom`; ephemeral — see §9) |
| Tools used (pills) | **derived** (`summarizeActions` per-verb counts) |
| Tokens (Details row) | **derived** from context (`contextpct × contextmax`), else placeholder |
| git **Branch** | **placeholder** (no data source) |
| **Files touched** + M/+/− gutters | **placeholder** (no git status source) |
| Suggestion chips | reuse ask options when asking; else **placeholder/omitted** |
| Open terminal | **live** (`openTerminal` → `CockpitFocusPane`) |
| Pause / Resume / Stop | **disabled** (no lifecycle RPC) |

Per the approved decisions: render the full surface (visual parity with the handoff), wire
live data where it exists, mark not-yet-live fields as placeholders, and disable actions
with no backing RPC.

## 7. Files touched

- **New:** `frontend/app/view/agents/agentsurface.tsx` (container + terminal swap +
  keyboard), `agenttree.tsx`, `agenttranscript.tsx`, `agentdetailsrail.tsx`,
  `agenttreemodel.ts` (+ `agenttreemodel.test.ts`). (The pure helper is `agenttreemodel.ts`,
  not `agenttree.ts`, so its basename doesn't collide with the `agenttree.tsx` component —
  `./agenttree` resolves `.ts` before `.tsx`.)
- **Modify:** `frontend/app/view/agents/cockpitshell.tsx` — replace `AgentSurfaceInterim`
  with `<AgentSurface/>`; keep `CockpitFocusPane` shell-side.
- **Delete:** `frontend/app/view/agents/focusview.tsx`.
- **Reused unchanged:** `narrationtimeline.tsx`, `answerbar.tsx`, `agentcomposer.tsx`,
  `statusdot.tsx`, `agentsviewmodel.ts`, `liveagents.ts`, `livetranscript.ts`,
  `projectname.ts`, `session-models/agentstatusstore.ts`, `session-models/sessionviewmodel.ts`.

## 8. Deferred / placeholder seams (the backlog to wire later)

Each item is rendered now (placeholder or disabled) and is an explicit insertion point for
a later phase. Tracked in memory `cockpit-phase1b-placeholder-seams`.

- **git Branch** (tree subtitle + Details row) — needs a git-branch source; arrives with the
  **P2 Files** surface (which needs git anyway).
- **Files touched + per-file git status** (M/+/−) — same P2 git source. Paths may be
  partially derivable from transcript edit/write/create actions in a fast-follow; gutters
  still need git.
- **Tokens-total** — only context-derived input tokens exist today; a cumulative total
  needs a usage extension.
- **Pause / Resume / Stop** — need an agent-lifecycle control RPC (P2/P3). Disabled until then.
- **Suggestion chips** — need a generator; reuse ask options for now.

## 9. Known limitations

- **Subagents are ephemeral.** `agentstatusstore` clears the per-block subagent list on the
  parent's idle transition and TTLs completed children after 60s. So the tree's children and
  the rail's Subagents list populate only while a parent is actively working — correct for a
  "live" surface, but an idle focused agent shows no subagents.
- **Subagent children are display-only** (no per-child transcript). Clicking a child is a
  no-op (or highlight) in 1b.

## 10. Verification

- `agenttreemodel.test.ts` (pure) covers grouping, child interleaving, empty/append, anchored
  order. `agentsviewmodel.test.ts` / `sessionviewmodel.test.ts` and peers stay green
  (logic untouched).
- `npx vitest run` green; `node --stack-size=4000 node_modules/typescript/lib/tsc.js
  --noEmit` shows only the 3 baseline `api.test.ts` errors.
- `npx vite build --config frontend/tauri/vite.config.ts` succeeds (proves the import graph
  stays acyclic after the `FocusView` delete + `AgentSurface` add).
- CDP/visual check deferred to the user's `task dev`: the Agent surface renders three panes;
  the tree groups by project and expands subagents; clicking a parent re-focuses; the
  transcript streams with burst-collapse and the "↓ N new" pill; an asking agent answers via
  the amber bar; the Details rail shows live ctx/cost/tools and the marked placeholders;
  "Open terminal" swaps the center to the term block and `esc` returns; Pause/Stop are
  visibly disabled.

## 11. Success criteria

- `surface === "agent"` renders the 3-pane focus matching the `isFocus` design; the interim
  `AgentSurfaceInterim` + `FocusView` are gone.
- Tree, transcript, and rail are independent thin views over `AgentsViewModel` atoms +
  existing per-block atoms; no model uses React hooks; no new model atoms.
- No new RPC / Go. Live data flows where it exists; placeholders/disabled affordances are
  clearly the not-yet-live fields enumerated in §8.
- No new tsc/vitest failures vs baseline; `vite build` succeeds; pure-logic tests unchanged.

## 12. Open questions

- **"↳ subagent · spawned by X" header note** — 1b has no parent→focused-child link for a
  top-level focus (children aren't focusable). Confirm during build that this note simply
  never shows in 1b (it lights up when children become focusable in a later phase).
- **`AgentTranscript` file boundary** — keep it inline in `agentsurface.tsx` or split to its
  own file. Decide during implementation based on file size (split if `agentsurface.tsx`
  grows past ~200 lines).
