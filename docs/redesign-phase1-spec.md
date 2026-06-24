# Agent Cockpit — Phase 1 Spec (Shell + Cockpit/Focus/Usage)

> Captured 2026-06-24. The first detailed sub-spec under
> [`redesign-meta-spec.md`](./redesign-meta-spec.md). Reads on top of
> [`redesign-brief.md`](./redesign-brief.md) and [`feature-triage.md`](./feature-triage.md).
> Visual source of truth: the Claude Design `wave` project — `Wave.dc.html` (full app),
> `Wave-inline.dc.html` (cockpit respond-in-place), and `Wave-answer.dc.html` (the
> reusable answer component). This spec is the implementation contract for Phase 1.

## 1. Scope

**In:** turn the single `AgentsView` component into a thin full-bleed shell with a left
**NavRail**, a **TopStrip**, and a `surfaceAtom`-driven router rendering three surfaces:

- **Cockpit** — all live agents grouped by state (asking / blocked / working / idle +
  backgrounded), keyboard-first triage, **respond-in-place** via inline-grow.
- **Agent (Focus)** — one agent in depth: live transcript with tool-burst collapse,
  subagent tree, reply composer, details rail.
- **Usage** — per-provider 5h/weekly gauges promoted from the current plan strip.

**Out (deferred to later phases):** Activity feed, Sessions, Channels, Memory, @agent
orchestrator (meta spec §4). No new RPC backends in Phase 1 except the one reporter
status addition called out in §8.

**Hard constraints (from the brief and rules):**
- Stays the registered `"agents"` block (Option A, meta spec §2). No new top-level mode.
- All existing **pure logic** in `agentsviewmodel.ts` is reused, not rewritten.
- Reskin uses Tailwind v4 + `@theme` tokens (continue the palette reskin already shipped).
- Models never use React hooks; per-block atoms on the ViewModel; updates via `globalStore`.

## 2. Reconciliation — current Agents tab → cockpit

The current `AgentsView` (`frontend/app/view/agents/agents.tsx`) already implements most
of the cockpit. Phase 1 is mostly **rearrangement + reskin**, plus a few net-new pieces.

| Item | Disposition | Notes |
|---|---|---|
| Structured ask: single/multi-select, multi-question tabs, 1–9 keys, recommended, submit gate (`answerbar.tsx`, `buildAskAnswers`, `canSubmitAsk`) | **RETAIN** | Re-housed inside the inline-grow expansion (the `Wave-answer` component). Logic unchanged. |
| Free-text PTY composer (`agentcomposer.tsx`, `ControllerInputCommand`) | **RETAIN** | Rendered below the options in the expansion; shown alone when there is no answerable ask (`hasAnswerableAsk`). |
| Anchored ordering (`mergeOrder`) | **RETAIN** | Still governs card order within a section. |
| Tool-call burst collapse (`groupTimeline`, `CollapseRunThreshold`) | **RETAIN** | Moves to the Focus transcript + the expansion's transcript peek. |
| Per-provider usage gauges (`ProviderPlan`, `MiniGauge`, `providerPlanUsage`) | **RETAIN → relocate** | Promoted into the Cockpit right rail + the Usage surface; the top plan strip goes away. |
| Status dots + quiet detection (`isQuiet`, `statusdot`) | **RETAIN** | Per-state dots on cards; quiet cue on working cards. |
| Recently-idle grace (`isRecentlyIdle`, `IDLE_GRACE_MS`) | **RETAIN** | A just-finished agent keeps a card in Working until the grace window expires. |
| Backgrounded lane (`partitionBackgrounded`, `b` key) | **RETAIN** | Collapsible "Backgrounded · muted · still running" section with Restore. |
| Keyboard-first nav + hints footer + help overlay | **RETAIN → extend** | Add `surface`-switch keys; footer gains `T terminal` / `M mute` / `N next`. |
| Working region layout: always-expanded rows | **REDESIGN** | Becomes a **compact card grid**; only the selected card expands (inline-grow). Live narration moves to the peek + Focus. |
| Focus interaction | **REDESIGN** | `FocusView` becomes the **Agent surface** reachable from the rail or "Open agent →"; gains the subagent tree + details rail. |
| Count tiles (Asking / Blocked / Working / Idle) | **ADD** | Header summary tiles. |
| Blocked group (Retry / View trace) | **ADD** | New `blocked` state — see §8 (carries a reporter dependency). |
| Sub-agent badge (`⑂ N sub`) | **ADD** | Badge on cards; full tree on Focus. |
| Working sparkline + activity bar | **ADD** | Cosmetic; low cost. |
| Multi-panel divider + `MaxPanels` control (`dividerRatio`, `expandedWorkingIds`, `MaxPanelsControl`) | **DROP** | Superseded by card grid + single inline-expand + Focus. **User-confirmed.** |

## 3. Shell architecture

`AgentsView` splits into a thin shell + one component per surface (meta spec §3). New files
live under `frontend/app/view/agents/`.

```
AgentsView (shell)                     // full-bleed block, no header
├─ NavRail            navrail.tsx       // surface switcher (Cockpit · Agent · Usage)
├─ TopStrip          topstrip.tsx       // project filter · live-only · "needs you" · ⌘K placeholder
└─ <active surface>  by surfaceAtom
   ├─ CockpitSurface  cockpit/cockpit.tsx
   ├─ FocusSurface    focus/focussurface.tsx   (reskin of focusview.tsx)
   └─ UsageSurface    usage/usagesurface.tsx
```

- **`surfaceAtom`** — new instance field on `AgentsViewModel`:
  `surfaceAtom = atom<SurfaceKey>("cockpit")` where
  `type SurfaceKey = "cockpit" | "focus" | "usage"`. Rail clicks and keybindings set it.
- **`noHeader`** — `AgentsViewModel` gains `noHeader = atom(true)` (honored at
  `blockframe.tsx:199`). It already sets `noPadding = atom(true)`. The shell draws the rail
  + surfaces full-bleed beneath Wave's titlebar/tab bar.
- The big block of cockpit state currently inlined in `AgentsView` (cursor, selection,
  backgrounded set, order, answer selections, streaming effects) moves **into
  `CockpitSurface`**, keeping the shell thin. Focus state moves into `FocusSurface`.
  `focusId` becomes a navigation between surfaces (set `surfaceAtom="focus"` + a
  `focusIdAtom`), not a branch inside one component.

## 4. Cockpit surface

### 4.1 Layout

A two-column flex: a scrollable main column + a fixed 332px right rail (matches
`Wave-inline.dc.html`).

```
main column (scroll)                         right rail (fixed)
├─ header: "Cockpit" + "N agents · M need you"   ├─ Usage (5h + weekly gauges, → Usage)
├─ count tiles: Asking · Blocked · Working · Idle └─ Recent activity peek (→ Activity, P2)
├─ § Asking you   (amber cards, grid)
├─ § Blocked      (red cards, grid)        [if any]
├─ § Working      (compact cards, grid)
├─ § Idle         (compact rows)
└─ § Backgrounded (collapsible)            [if any]
footer: keyboard hints (↑↓ move · ⏎ expand · esc · 1–9 answer · r reply · t term · m mute · n next)
```

Sections render only when non-empty (Blocked, Backgrounded). The Asking/Blocked/Working
grids are 2-column; a card grows to full width (`grid-column: 1/-1`) when selected.

### 4.2 Card model per state

All cards share: agent name, project chip, sub badge (`hasSubs`), per-card `>_` terminal +
`⤓` mute buttons, click-to-select. State-specific:

- **Asking** (amber): waiting time, the question text, `Reply ⏎` / `Snooze`, model. Driven
  by `state === "asking"` + `ask`.
- **Blocked** (red): error/activity line, `Retry` / `View trace`, model. New state — §8.
- **Working** (neutral): live activity line + quiet cue, animated progress bar, `model ·
  tokens · ⑂ subs`, sparkline. Compact; no inline narration until selected.
- **Idle** (muted rows, not cards): activity/reason, `idle <age>`, `Resume`, mute.
- **Backgrounded** (collapsible, dimmed rows): muted age, `Restore`.

### 4.3 Selection & respond-in-place (inline-grow)

- New cockpit state `cockpitSelId` (the selected card). Selecting a card sets it; the card
  expands to full width and renders the **answer panel** (§5) beneath its summary. `Esc` /
  the panel's `✕` clears it (`closeCockpitSel`).
- `cockpitSelId` and the keyboard `cursorId` are distinct: the cursor highlights for
  keyboard nav; selection expands. `⏎` on a cursor card sets selection (or submits an
  answer if one is fully selected — preserving today's `Enter` behavior in `onKeyDown`).
- The expansion hosts the answer panel for **any** state; for blocked/idle/working with no
  pending question it degrades to transcript-peek + composer (no option block).

### 4.4 Keyboard model

Reuse the existing `onKeyDown` dispatch (`agents.tsx:378`). Mapping:

- `↑↓ / j k` move cursor (`moveCursor`); `n` next ask (`nextAskId`); `←→ / h l` switch
  question tab; `1–9` select option (`toggleAnswer`); `⏎` confirm/expand; `r` focus reply;
  `t` open terminal (`setActiveTab`); `b`/`m` background; `esc` clear selection / back; `?`
  help. **Add:** surface-switch (rail) keys, and `o`/"Open agent →" to set Focus surface.
- Selection (`cockpitSelId`) replaces today's always-expanded working rows as the thing the
  answer/compose keys act on.

## 5. Answer + composer component (`AgentAnswerPanel`)

The heart of the reconciliation. Mirrors `Wave-answer.dc.html`; new file
`cockpit/agentanswerpanel.tsx`, reused by every card's expansion **and** the Focus surface.
It is a reskin/repackage of the existing `answerbar.tsx` + `agentcomposer.tsx`, not new
logic.

Structure (top → bottom):
1. **Header row** — "Live transcript" label + `>_ term` / `⤓ mute` / `Open agent →` / `✕`.
2. **Transcript peek** — last few entries via `groupTimeline`; user/agent/tool/question
   rows; the pending question shown as an amber "Awaiting your reply" callout. Scrollable,
   capped height.
3. **Answer block** (only when `hasAnswerableAsk(agent)`):
   - Multi-question **tabs** when `ask.questions.length > 1`; tab dot shows number or ✓.
   - Active question prompt + **numbered options** (1–9), each with optional description and
     a `recommended` pill (accent). `multiSelect` → checkboxes + `Confirm N`; single →
     pick-to-answer, advancing to the next unanswered question.
   - Wired to `toggleAnswer` / `selectQuestion` / `submitAnswer` / `buildAskAnswers` /
     `canSubmitAsk` — unchanged from today.
4. **Free-text composer** — the existing PTY composer (`ControllerInputCommand` via
   `agentcomposer`). Placeholder: "Or type a different reply…" when a question exists, else
   "Reply to <agent>…". `Enter` sends, `Shift+Enter` newline, `Esc` blurs.

Accent is parameterized (amber asking / red blocked / accent otherwise) so one component
serves all states.

## 6. Agent (Focus) surface

Reskin of `focusview.tsx` into `focus/focussurface.tsx`, reached by setting
`surfaceAtom="focus"` + `focusIdAtom`. Adds two regions over today's focus view:

- **Subagent tree** — parent + children (type, working→✓/✗); selecting a child opens its
  session (`setActiveTab`). Cockpit shows only the `⑂ N sub` badge; the tree lives here.
- **Details rail** — project, branch, model, runtime, tokens, cost, context window, tools
  used, files touched (from `agent.usage` + transcript projections).

Retains: the live transcript with tool-burst collapse (`groupTimeline` /
`narrationtimeline.tsx`), the inline reply composer, prev/next agent nav, `t` to terminal.

## 7. Usage surface

`usage/usagesurface.tsx`. Promotes `ProviderPlan` / `MiniGauge` / `providerPlanUsage` from
the plan strip into a full surface: per-provider 5h + weekly gauges with reset timers
(`formatReset`), spend, and a by-model breakdown. The Cockpit right rail shows a compact
version with "Details →" routing here (`surfaceAtom="usage"`). Data source is unchanged —
the statusLine usage bridge already feeding `agent.usage`.

## 8. New `blocked` state — dependency

The mockup's Blocked group is net-new. Today `AgentState = "asking" | "working" | "idle"`
and the reporter emits only `working | waiting | idle` (`agentVMFromInput`). Phase 1:

- **Frontend (in scope):** add `"blocked"` to `AgentState`; `groupAgents` returns a
  `blocked` section; `agentVMFromInput` maps a new reporter status (e.g. `"error"`) →
  `"blocked"`; the Cockpit renders the Blocked group + card (Retry / View trace).
- **Reporter (small dependency, outside the repo):** the agent-status reporter must emit the
  new status when an agent errors/blocks. Until it does, the Blocked section simply never
  renders (it is gated on a non-empty `blocked` list) — so this ships safely "dark" and
  lights up when the reporter is taught the status. `Retry` / `View trace` actions are
  placeholders wired to existing affordances (re-open terminal / focus transcript) until a
  dedicated signal exists.

This keeps Phase 1 self-contained: zero regression if the reporter is unchanged.

## 9. State & data flow

**New atoms on `AgentsViewModel`** (per-block instance fields):
- `surfaceAtom: PrimitiveAtom<SurfaceKey>` — active surface.
- `focusIdAtom: PrimitiveAtom<string>` — agent shown on the Focus surface.

**Cockpit-local React state** (moves from `AgentsView` into `CockpitSurface`): `cursorId`,
`cockpitSelId` (new; replaces always-expanded), `answerSel`, `answerTab`, `sentIds`,
`backgroundedIds`, `dismissed`, `order`, `now` tick, transcript-stream effects.

**Reused unchanged from `agentsviewmodel.ts`:** `groupAgents`, `sortAgents`, `mergeOrder`,
`partitionBackgrounded`, `groupTimeline`, `summarizeActions`, `moveCursor`, `nextAskId`,
`focusedAskId`, `buildAskAnswers`, `canSubmitAsk`, `hasAnswerableAsk`, `isQuiet`,
`isRecentlyIdle`, `providerPlanUsage`, `withAsk`, `agentVMFromInput`, formatters.

**Removed:** `expandedWorkingIds`, `MaxPanels`, `MaxPanelsControl`, `dividerRatio` and the
divider pointer handlers. (`expandedWorkingIds` is pure and unit-tested — delete it and its
tests together.)

**Live data unchanged:** `liveAgentsAtom`, `livetranscript.ts`, transcript projections feed
Cockpit + Focus exactly as today.

## 10. File plan

**New:**
- `navrail.tsx`, `topstrip.tsx`
- `cockpit/cockpit.tsx`, `cockpit/agentcard.tsx` (per-state card), `cockpit/agentanswerpanel.tsx`
- `focus/focussurface.tsx` (split from `focusview.tsx`), `focus/subagenttree.tsx`, `focus/detailsrail.tsx`
- `usage/usagesurface.tsx`

**Modified:**
- `agents.tsx` — shrink `AgentsView` to the shell; `AgentsViewModel` gains `noHeader`,
  `surfaceAtom`, `focusIdAtom`.
- `agentsviewmodel.ts` — add `"blocked"` to `AgentState` + `blocked` section in
  `groupAgents` + `blocked` mapping in `agentVMFromInput`; remove `expandedWorkingIds` /
  `MaxPanels`.
- `agentrow.tsx` / `answerbar.tsx` / `agentcomposer.tsx` — refactor reusable bits into
  `agentanswerpanel.tsx` / `agentcard.tsx`; keep behavior.
- `backgroundedsection.tsx`, `idlesection.tsx` — reskin to card-grid language; keep props.

**Removed:** `MaxPanelsControl` (in `agents.tsx`); `expandedWorkingIds` + its tests.

## 11. Testing

- **Pure logic:** extend `agentsviewmodel.test.ts` for the `blocked` state in `groupAgents`
  / `sortAgents` / `agentVMFromInput`. All retained pure functions keep their tests.
- **Component behavior:** selection model (`cockpitSelId` expand/collapse), answer
  submission gate inside the panel, keyboard dispatch incl. new surface keys. Test behavior,
  not internals.
- **Visual:** CDP dev-app check (memory: "CDP verify dev app") against the three surfaces;
  confirm `@theme` token colors, not one-offs.

## 12. Open questions / risks

- **Blocked signal** — confirmed shipping "dark" until the reporter emits an error status
  (§8). No Phase 1 blocker.
- **Idle/backgrounded inline-expand** — the mockup lets idle rows expand into the answer
  panel too. Harmless (peek + composer), but confirm it is wanted vs. a plain Resume.
- **Right-rail Activity peek** — the rail shows a recent-activity list that belongs to the
  P2 Activity surface. Phase 1 can render it from existing status events as a read-only peek,
  or omit it until P2. Lean: render a thin peek from live status, no new store.
- **Surface-switch keybindings** — exact keys (e.g. `g c` / `g a` / `g u`, or number keys)
  TBD during writing-plans; not a design blocker.

## 13. Out of scope (deferred)

Activity feed, Sessions browse/resume, Channels, Memory (list + graph), @agent orchestrator
(meta spec §4, Phases 2–3). The NavRail shows only the three implemented surfaces; later
surfaces appear when their phase lands (meta spec §9 lean: absent until implemented).

## 14. Next step

This is non-trivial, multi-file work → transition to **writing-plans** for the ordered
implementation plan. Suggested implementation order (each independently shippable):
1. Shell + `surfaceAtom` router + `noHeader` (Cockpit = today's view, unmoved) — no visual change yet.
2. `AgentAnswerPanel` extraction (reuse in current layout) — de-risks the answer/composer move.
3. Cockpit card grid + inline-grow + count tiles + Blocked group; drop divider/MaxPanels.
4. Focus surface (subagent tree + details rail).
5. Usage surface + rail relocation.
6. Reskin pass (`@theme` tokens) + CDP visual check.
