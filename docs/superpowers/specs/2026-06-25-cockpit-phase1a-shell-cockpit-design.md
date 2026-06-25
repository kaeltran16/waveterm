# Cockpit Phase 1a — Shell + Cockpit Surface

Date: 2026-06-25
Status: approved-design

> The first sub-spec under [`docs/redesign-meta-spec.md`](../../redesign-meta-spec.md)
> (§3 shell, §4 Cockpit, §8 Phase 1). Reads on top of
> [`docs/redesign-brief.md`](../../redesign-brief.md). **Source of truth:**
> `wave-handoff/wave/project/Wave-cockpit-live.dc.html` (`isCockpit` branch + nav rail).
>
> Phase 1 was split 1a / 1b. **1a** (this doc) = the shell (NavRail + surface router +
> state lift) and the **Cockpit** surface. **1b** = the Agent 3-pane focus surface. 1a
> ships a usable cockpit on its own; the Agent surface routes to the existing `FocusView`
> as an interim stand-in until 1b.

## 1. Scope

**In:**
- A thin **cockpit shell** — `NavRail` (eight surfaces) + a `surfaceAtom`-driven router —
  rendered by `CockpitBody` in place of today's roster + terminal two-pane.
- **State lift:** move `AgentsView`'s orchestration `useState`s onto `AgentsViewModel`
  as jotai atoms; lifecycle effects stay in the surface component.
- The **Cockpit surface**: 2-col live grid with always-on per-card feeds, inline
  answer-in-place, idle + backgrounded sections, keyboard triage, and a collapsible
  Usage rail.

**Out (deferred):**
- The **Agent** 3-pane surface (tree | transcript+composer | details rail) → **1b**. In
  1a, the Agent nav item and "open agent" route to the existing `FocusView`.
- **Card ergonomics polish** — drag-reorder is kept (existing `Reorder`), but per-card
  **widen** (1↔2-col) and per-card **resize** are a fast-follow, not 1a.
- Full **Usage** surface, **Activity**, **Sessions**, **Files**, **Channels**,
  **Memory** → later phases. Their nav items render and route to a placeholder (meta D6).
- New RPC backends. 1a is pure frontend over existing data/streams.

**Hard constraints:**
- The cockpit is the sole frontend (meta D1) — no block/tab framing; the shell mounts
  under `CockpitTitlebar`.
- Pure logic in `agentsviewmodel.ts` is reused, **not** rewritten; its tests stay green.
- Styling uses the `@theme` tokens already landed (`ca1a6c45`); no one-off colors except
  the existing brand provider dots.
- Models own atoms and never call React hooks; effects live in components.

## 2. Reconciliation — current `agents.tsx` → 1a

Today `AgentsView` (635 lines) is a single component holding all state + a vertical
`Reorder` list, with an internal `focusId` → `FocusView` branch. `CockpitBody`
(`cockpit-root.tsx`) wraps it beside a separate terminal pane (`CockpitFocusPane`).

| Item | Disposition | Notes |
|---|---|---|
| Pure VM logic (`groupAgents`, `mergeOrder`, `partitionBackgrounded`, `providerPlanUsage`, `moveCursor`/`nextAskId`/`focusedAskId`, `buildAskAnswers`/`canSubmitAsk`/`hasAnswerableAsk`, `isRecentlyIdle`/`isQuiet`, `groupTimeline`/`summarizeActions`, `withAsk`/`isAskStale`) | **RETAIN** | Unchanged. Surfaces and the model call it. |
| Structured ask UI (`answerbar.tsx`) + free-text composer (`agentcomposer.tsx`) | **RETAIN** | Reused in the card answer-in-place footer; logic unchanged. |
| Live state + transcript streams (`liveagents.ts`, `livetranscript.ts`, `ensurePreviousInfo`, `startTranscriptStream`) | **RETAIN** | Streams already cover all asking+working agents — feeds render existing data. |
| Per-card feed render (`narrationtimeline.tsx`, transcript projections, `statusdot.tsx`) | **RETAIN → relocate** | Was rendered only in expanded rows; now in every live card. |
| Idle + backgrounded sections (`IdleSection`, `BackgroundedSection`) | **RETAIN** | Reused beneath the live grid. |
| Per-provider usage (`ProviderPlan`, `MiniGauge`, `providerPlanUsage`) | **RETAIN → relocate** | Top plan-strip moves into the collapsible right rail. |
| Orchestration state (`useState` for cursor/selection/order/backgrounded/answers/focus/dismissed) | **REDESIGN → lift** | Becomes atoms on `AgentsViewModel` (§4). |
| Keyboard handler + `HINTS` footer + `HelpOverlay` | **RETAIN → extend** | Moves to the shell; gains surface-switch keys. |
| Vertical single-column list | **REDESIGN** | Becomes a 2-col grid; every live card always shows its feed. |
| `maxPanels` / `expandedWorkingIds` / `MaxPanelsControl` | **DROP** | Superseded by the always-on-feed grid. |
| Internal `focusId` → `FocusView` branch | **REDESIGN** | Becomes a surface (`surfaceAtom="agent"` + `focusIdAtom`); in 1a it still renders `FocusView` (interim), in 1b the 3-pane. |
| Status chips (All/Asking/Working/Idle), project filter, Live-only | **ADD** | Header controls; chips + summary are core, filter/Live-only included if cheap. |

## 3. Shell architecture

A new shell component under `frontend/app/view/agents/` that `CockpitBody` renders:

```
CockpitBody (cockpit-root.tsx)
└─ CockpitShell                 cockpitshell.tsx     // NavRail + router (replaces roster+focus 2-pane)
   ├─ NavRail                   navrail.tsx          // 8 surfaces, all shown; active ← surfaceAtom
   └─ <active surface>          by model.surfaceAtom
      ├─ CockpitSurface         cockpitsurface.tsx   // built in 1a
      ├─ (Agent)                FocusView            // interim in 1a; rebuilt in 1b
      └─ PlaceholderSurface     placeholdersurface.tsx // "coming soon" for the rest (D6)
```

- `CockpitBody` stops constructing the roster/`CockpitFocusPane` two-pane directly; it
  builds the `AgentsViewModel` (as today) and renders `<CockpitShell model={…}/>`.
- `NavRail` is presentational: reads `surfaceAtom`, writes it on click, shows the eight
  handoff items (Cockpit · Agent · Activity · Channels · Sessions · Files · Memory ·
  Usage) with the active-item treatment from the design.
- Surface-switch keybindings set `surfaceAtom`; unbuilt surfaces resolve to
  `PlaceholderSurface`.

## 4. State model — lift onto `AgentsViewModel`

The model gains plain `PrimitiveAtom`s for orchestration state (replacing `AgentsView`'s
`useState`s). Surfaces read/write them via `useAtomValue`/`globalStore`; the model exposes
a few action methods so surfaces stay thin.

New atoms: `surfaceAtom` (`"cockpit" | "agent" | "activity" | … `, default `"cockpit"`),
`nowAtom`, `cursorIdAtom`, `cockpitSelIdAtom`, `orderAtom`, `backgroundedIdsAtom`,
`answerSelAtom`, `answerTabAtom`, `sentIdsAtom`, `dismissedAtom`, `focusIdAtom`,
`focusReplyAtom`. Ephemeral, surface-only UI (`showHelp`, `pulseId`) may stay
component-local.

Action methods on the model (operate on atoms via `globalStore`, call RPC where needed):
`setSurface`, `openFocus`, `openTerminal` (exists), `toggleBackground`, `toggleAnswer`,
`submitAnswer` (calls `AnswerAgentCommand`), `selectQuestion`, `moveCursorBy`, `nextAsk`.

**Effects stay in components** (models can't use hooks). The Cockpit surface owns:
the 1s tick → `nowAtom`; `ensurePreviousInfo` seeding; `startTranscriptStream` /
`stopTranscriptStream` lifecycle for asking+working; `mergeOrder` reconciliation →
`orderAtom`; cursor-validity; the asking-overrides-backgrounded reconciliation. Each
reads/writes the model atoms instead of local `useState`.

## 5. Cockpit surface

### 5.1 Layout (`isCockpit` branch of the design)

```
header (sticky): "Cockpit" · "N agents · N need you" · [Hide panel] [project ▾] [Live only]
chips row:       All N · ● Asking N · ● Working N · ● Idle N
main (scroll)                                    right rail (collapsible)
├─ § Live agents  (2-col grid of cards)          ├─ Usage (5h + weekly gauges, → Usage)
├─ § Idle         (rows; expand → answer panel)  └─ Recent activity (P2 — stub/omitted in 1a)
└─ § Backgrounded (collapsible)
footer: ↑↓ move · ⏎ expand · esc · 1–9 answer · R reply · T terminal · M mute · N next
```

Sections render only when non-empty. Status chips filter the grid (reuse `groupAgents`
counts). Project filter / Live-only are included if cheap (reuse `projectname`), else
fast-follow.

### 5.2 Card model

Every **live** card (asking + working + recently-idle grace) always renders, in a 2-col
grid, with its feed visible:

- **Head:** drag handle, status dot (`statusdot`), name, project pill, `needs you` badge
  (asking), `>_` terminal / `⤓` mute buttons.
- **Treatment:** asking → "Waiting on you" + question text; working → activity line +
  quiet cue (`isQuiet`).
- **Feed:** `narrationtimeline` over the live stream (user / narration / tool rows, with
  `groupTimeline` burst collapse).
- **Answer-in-place footer:** for a structured ask, reply-suggestion chips +
  `answerbar` options (`toggleAnswer` / `buildAskAnswers` / `canSubmitAsk`, 1–9 keys,
  multi-question tabs); for a plain ask (`!hasAnswerableAsk`), the `agentcomposer`
  free-text reply + Send.

Idle rows reuse `IdleSection`; selecting one expands an answer panel in place (the
`Wave-answer` treatment — chips + composer). Backgrounded reuses `BackgroundedSection`
(collapsible, Restore).

### 5.3 Keyboard

The existing `onKeyDown` moves to the shell/surface and drives model methods:
`↑↓ / j k` move cursor, `n` next ask, `1–9` answer, `←→ / h l` switch question, `↵`
confirm-or-open, `r` reply, `t` terminal, `m`/`b` mute-background, `esc` back, `?` help.
Adds surface-switch keys. `⏎` on an asking card with a complete selection submits;
otherwise it opens the agent (sets `surfaceAtom="agent"` + `focusIdAtom`).

### 5.4 Usage rail

The current top plan-strip relocates into the collapsible right rail, unchanged logic:
`providerPlanUsage` → one `ProviderPlan` (5h + weekly `MiniGauge`s) per provider, with a
"Details →" affordance (routes to the Usage placeholder in 1a; the full surface is P2).

## 6. Surface routing in 1a

| Nav item | 1a behavior |
|---|---|
| Cockpit | built (this spec) |
| Agent | interim — renders existing `FocusView` for `focusIdAtom`; "Open terminal" reuses `CockpitFocusPane` |
| Usage | placeholder (rail carries usage; full surface is P2) |
| Activity / Sessions / Files / Channels / Memory | placeholder |

**Terminal:** `T` / `>_` keep calling `openTerminal`, which routes to the interim Agent
surface showing that agent's terminal (reuses `CockpitFocusPane`) — preserving today's
behavior until 1b restructures it into the 3-pane.

## 7. Files touched

- `frontend/app/cockpit/cockpit-root.tsx` — `CockpitBody` renders `<CockpitShell/>`;
  drop the inline roster + `CockpitFocusPane` two-pane wiring.
- `frontend/app/view/agents/agents.tsx` — `AgentsViewModel` gains the atoms + action
  methods; `AgentsView` is decomposed (its body becomes `CockpitSurface`).
- **New:** `frontend/app/view/agents/cockpitshell.tsx`, `navrail.tsx`,
  `cockpitsurface.tsx`, `placeholdersurface.tsx`.
- `frontend/app/view/agents/agentrow.tsx` — card adapts to the grid + always-on feed
  (remove `expanded`/`fill`/`maxPanels` coupling).
- Reused unchanged: `answerbar.tsx`, `agentcomposer.tsx`, `narrationtimeline.tsx`,
  `idlesection.tsx`, `backgroundedsection.tsx`, `statusdot.tsx`, `liveagents.ts`,
  `livetranscript.ts`, `agentsviewmodel.ts`.

## 8. Verification

- `agentsviewmodel.test.ts` and peers stay green (pure logic untouched; `maxPanels`
  helpers may lose call sites but keep their tests or are removed with them).
- `npx vitest run` green; `node --stack-size=4000 node_modules/typescript/lib/tsc.js
  --noEmit` shows only the 3 baseline `api.test.ts` errors.
- CDP dev-app check (`task dev`, :9222): NavRail switches `surfaceAtom`; the Cockpit
  renders a 2-col grid with per-card feeds; an asking card answers in place (chips +
  1–9 + Send); idle/backgrounded sections behave; the Usage rail shows gauges and
  collapses; keyboard triage works; unbuilt nav items show the placeholder.

## 9. Success criteria

- The cockpit is a shell + router; the Cockpit surface matches the `isCockpit` layout
  (grid + feeds + answer-in-place + idle/backgrounded + rail + triage bar).
- Orchestration state lives on `AgentsViewModel` as atoms; surfaces are thin; no model
  uses React hooks.
- No new tsc/vitest failures vs baseline; pure-logic tests unchanged.
- `maxPanels` machinery removed; drag-reorder still works; widen/resize deferred.

## 10. Open questions

- **Project filter / Live-only** — confirm in build whether they're cheap enough for 1a
  or slip to the fast-follow with widen/resize.
- **`now` cadence** — keep the 1s tick driving `nowAtom` globally, or scope it to the
  Cockpit surface only (placeholder surfaces don't need it).
- **Idle-row expand** — reuse the inline `answerbar`/composer directly vs. porting the
  `Wave-answer` component's exact treatment. Resolve during implementation.
