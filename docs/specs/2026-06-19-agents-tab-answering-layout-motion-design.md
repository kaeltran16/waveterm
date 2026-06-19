# Agents Tab — Full Answering, Focus/Queue Layout & Motion

**Date:** 2026-06-19
**Status:** Design approved (brainstorm complete); implementation plan pending
**Base:** Builds on the live-output redesign (`docs/specs/2026-06-19-agents-tab-triage-design.md`, already implemented in `frontend/app/view/agents/`). This is a follow-on cut that (1) makes the asking card a faithful AskUserQuestion renderer, (2) reworks the content layout into a focus/queue asks region over a responsive working-panel grid, (3) adds live narration to the asking card, (4) adds liveness polish, and (5) adds motion — both layout-shift easing and purposeful micro-animations — across the agents view **and** the vertical tab strip.

**Key property:** everything except the motion dependency is **frontend-only**. No new RPC, no Go types, no `task generate`. The one external dependency is the answer-delivery hook (§8), which lives outside this repo.

## 1. What this is

The Agents tab today renders a single vertical column of panels (asking `AskCard`s, then live-streaming `WorkingPanel`s). This cut addresses four things surfaced in the brainstorm:

1. **Answering is artificially limited.** The panel only answers a single single-select question; multi-question and multi-select asks dead-end at "Open session to answer." The ask payload and the answer RPC already carry the full shape — only the frontend restricts it.
2. **Single column wastes a full-screen tab.** The tab is pinned full-width beside the ~210px vertical tab strip; a single column stretches narration edge-to-edge (~180 chars) and shows only ~2 agents.
3. **The asking card is frozen.** Its narration is a one-shot snapshot, while working panels already stream live.
4. **Motion.** State changes (agents entering/leaving, working↔asking, narration arriving, actions resolving) currently snap. The design adds `motion` to ease layout shift and to signal events.

## 2. Scope / non-goals

**In scope**
- **Answering:** render every question; support multi-select; submit one answer item per question.
- **Layout:** focus/queue asks region (one ask in full + the rest as one-line rows) over a responsive working-panel grid; friendlier empty state.
- **Live asking-card narration:** stream asks like working panels.
- **Liveness polish:** quiet/stalled cue; "new output" pill.
- **Motion (`motion` / framer-motion):** layout-shift easing + 7 content micro-animations + 5 vertical-tab animations (§7).

**Non-goals (deferred)**
- **Freeform "Other" answers.** The only piece needing a new answer field + the external hook; clean follow-on.
- **Show-tool-output toggle.** (triage spec §11.)
- **Stream cap** for many concurrent agents — measure first.
- **Remote/SSH agent streaming; orchestration/manager layers.**
- **`prefers-reduced-motion` handling** — explicitly skipped (single-user/personal build).

## 3. Answering — faithful AskUserQuestion renderer

The ask payload is already the AskUserQuestion shape: `AgentAskData.questions[]`, each `AgentAskQuestion` with `multiselect` + `options[]`. The answer RPC `CommandAnswerAgentData.Answers` is `[]AgentAnswerItem`, each `{ selectedindexes?: number[] }` — multi-question and multi-select are already representable.

**Changes in `askcard.tsx`:**
- Remove the `panelAnswerable` guard (`askcard.tsx:80`). Always render **all** `questions` via the existing `QuestionGroup` (its `handleToggle` already branches on `q.multiSelect`).
- `handleSubmit`: build one `AgentAnswerItem` per question (today it builds only `answers[0]`).
- `canSubmit`: every question must have ≥1 selection (single-select replaces, so size 1; multi-select needs ≥1).
- Keep "Open terminal" as a secondary action (dual-answer still mirrors to the terminal); drop the "Open session to answer" fallback since all asks are now answerable in-panel.
- **Freeform "Other" is not added** (deferred).

**Extracted pure functions** (to `agentsviewmodel.ts`, unit-tested):
```ts
buildAskAnswers(questions: AgentAskQuestion[], selections: Record<number, Set<number>>): AgentAnswerItem[]
canSubmitAsk(questions: AgentAskQuestion[], selections: Record<number, Set<number>>): boolean
```

## 4. Layout — focus/queue asks over a working grid

```
┌ Agents ─────────────────────────────  3 asking · 2 working ┐
│ ┌ loom · duplicate-session race        oldest · 4m ───────┐ │  focused ask
│ │ <live narration>                                        │ │  (full: narration
│ │ Which cloning approach?  [Deep][Shallow][Ref]  Submit → │ │   + pills, reserved
│ └─────────────────────────────────────────────────────────┘ │   slot)
│ 2 MORE WAITING                                               │
│ ● api-migrator  v2 404s — roll back or patch?   2m · answer→ │  queue rows
│ ● scheduler-bot cron slot priority?             5m · answer→ │  (one-line)
│ ┌ cyber-detector · opus · 8m ─┐ ┌ graphify · sonnet · 2m ─┐ │  working grid
│ │ All 4 fail… creating detector│ │ Clustering 38 nodes now…│ │  (responsive,
│ └──────────────────────────────┘ └─────────────────────────┘ │   reflows to 1 col)
└──────────────────────────────────────────────────────────────┘
```

- **Asks — focus + queue.** The oldest blocked ask (first in `groupAgents().asking`) shows in full in a **reserved slot**: live narration + the question(s) + pills. The rest collapse to clickable one-line rows (name · question · age · "answer →"). Clicking a row promotes it. Answering the focused ask auto-advances focus to the next.
- **Working — responsive grid.** `grid-template-columns: repeat(auto-fill, minmax(360px, 1fr))`; fixed-height cells with internal stick-to-latest scroll; reflows to one column when narrow.
- **Empty state.** Icon + hint ("Agents appear here the moment one starts working or asks.") replacing the bare "No active agents".
- **Focus state.** `AgentsView` holds `focusedAskId`; resolved each render by a pure helper:
```ts
resolveFocusedAskId(asking: AgentVM[], current?: string): string | undefined
// keep current if still asking, else default to oldest (asking[0])
```

**Sizing model:** content area is `flex flex-col`. Asks region is `flex-none`, capped with `max-height` + internal scroll so a pile of asks never pushes the working grid off-screen. Working grid is `flex-1 min-h-0` and scrolls when crowded. (This is the structural layer of §7's shift-easing.)

## 5. Live asking-card narration (③)

- Extend the stream lifecycle in `agents.tsx` (currently `agents.tsx:52` streams only `working` agents) to also open a stream for `asking` agents — reusing `startTranscriptStream` / `liveEntriesByIdAtom` unchanged.
- `AskCard` reads narration from `liveEntriesByIdAtom[agent.id] ?? agent.previousInfo ?? []`.
- `ensurePreviousInfo` stays as the first-paint fallback (the stream backlog supersedes it once it arrives).

**Honest nuance:** a blocked agent's transcript is static until the ask is answered (the agent is paused on the `AskUserQuestion` call). So "live" here means **one unified transport + the freshest pre-ask narration**, not continuously-updating text. The value is architectural unification and eliminating the stale-snapshot race, not constant motion.

## 6. Liveness polish (⑤)

- **Quiet/stalled cue (A).** In `WorkingPanel`'s header, when `now − lastActivity` exceeds a threshold, render a hollow/dim dot and `⟳ Xm · quiet` in amber, so a long-tool-call agent reads as paused, not live.
  ```ts
  isQuiet(lastActivityMs: number | undefined, now: number, thresholdMs = 45_000): boolean
  ```
- **"New output" pill (B).** When the user has scrolled up and new lines arrive, show a floating `↓ N new` pill; click scrolls to bottom and resets. Builds on `WorkingPanel`'s existing `stickRef`/`onScroll`.
- *(Stream cap (D) deferred.)*

## 7. Motion (`motion` / framer-motion)

**Dependency:** `npm i motion` (repo is npm 10.9.2, React 19.2, Vite 6 — no build config needed). `prefers-reduced-motion` intentionally not handled.

### 7a. Layout-shift easing
- **Structural (does most of the work, no motion):** fixed-height grid cells; capped + independently-scrolled asks region; reserved focus slot; stable keys by agent id; age-based sort (monotonic → relative order stable).
- **Motion:**
  - `<AnimatePresence>` + `<motion.div layout>` for panel/queue-row enter/leave and grid reflow.
  - **`layoutId={agent.id}`** for the working↔asking shared-element glide (an agent moving between the grid and the asks region animates across, instead of fade-swapping) and for queue-row → focus-slot promotion.
  - **Linger on completion:** hold a finished agent's panel ~1–2s as a dim "✓ done" before removing.
  - **Debounce status flaps:** ignore sub-~500ms working↔asking toggles so a blip doesn't bounce the layout.

### 7b. Content micro-animations (all 7)
| # | Animation | Trigger |
|---|---|---|
| 1 | **Streaming narration entrance** — each new narration line/action fades + slides in | new transcript entry arrives |
| 2 | **Action outcome pop** — the ✓/✗ pops in | a `tool_result` resolves an action's outcome |
| 3 | **Answer feedback** — pill springs on select; Submit morphs to "✓ Sent" before the card exits | user selects / submits |
| 4 | **Working pulse + spinner** — breathing green dot + rotating ⟳ | agent state = working (ambient) |
| 5 | **New-output pill spring** — the ⑤-B pill springs in/out | scrolled-up + new output |
| 6 | **Count transition** — header "N asking · M working" rolls/cross-fades | counts change |
| 7 | **Empty-state fade-in** — gentle entrance | empty state mounts |

Implementation notes: narration entries are projected fresh per chunk and are append-only, so keying entries by index makes only newly-mounted (appended) entries play the entrance — existing ones don't re-animate. The action-outcome pop keys the ✓/✗ span on the outcome value so it animates when the outcome flips from none → ok/fail.

### 7c. Vertical-tab strip animations (all 5) — shared chrome
Touches `vtab.tsx`, `vtabbar.tsx`, `sessionsidebar/sessionrow.tsx`. **Higher regression surface** than the agents view (drag-reorder, rename, context menus, expand state live here).
| # | Animation | Notes / risk |
|---|---|---|
| 1 | **Active indicator glide** — the active highlight slides between tabs | `layoutId="vtab-active"` on the existing highlight div (`vtab.tsx:171`). Visual-only, low risk. |
| 2 | **Status-dot transitions** — working breathes green, new ask pulses amber, smooth color flip | dot is agent-specific; low–medium risk |
| 3 | **Asking-badge pop** — the "N asking" badge pops on increment | draws attention off-tab; low risk |
| 4 | **Tab enter/leave** — sessions fade+slide in on create, collapse out on close | AnimatePresence around the tab list; interacts with add/remove + drag-reorder — medium risk |
| 5 | **Subagent/group expand-collapse** — height-animate the reveal + chevron rotate | touches expand state in `sessionrow` — medium risk |

## 8. ⚠ External dependency — the answer-delivery hook

Multi-question/multi-select answering is frontend-only **inside this repo**, but the answer travels: `AskCard` → `AnswerAgentCommand` (relays) → the **answer-delivery hook** (in `~/.claude`, outside this repo) → back to Claude Code's `AskUserQuestion`. The current frontend only ever sends one answer with one index, so the hook may have been written for that MVP. **Before implementing, verify the hook maps a full `answers[]` array with multiple `selectedindexes` (and multiple questions) back to AskUserQuestion's expected answer format.** If not, it needs a parallel update. This is the only place the "frontend-only" claim has an external dependency.

## 9. Architecture / files

**Agents view** (`frontend/app/view/agents/`)
- `agentsviewmodel.ts` (+ `agentsviewmodel.test.ts`) — new pure `buildAskAnswers`, `canSubmitAsk`, `isQuiet`, `resolveFocusedAskId`; reuse `groupAgents`. (`outputPanelOrder` likely becomes unused → remove it + its test.)
- `askcard.tsx` — unified answering; live narration; pill/submit motion (micro-anim 3).
- `agents.tsx` — focus/queue layout; working grid; empty state; stream asks; `focusedAskId` state; `AnimatePresence`/`layout`/`layoutId`; debounce; count transition (micro-anim 6); empty-state fade (7).
- `outputpanel.tsx` — grid-cell sizing; quiet cue; new-output pill; working pulse+spinner (4); new-output spring (5).
- `narrationtimeline.tsx` — per-entry entrance (1) and action-outcome pop (2).
- possibly a small `askqueue.tsx` for the queue-row component.

**Shared tab chrome** (`frontend/app/tab/`)
- `vtab.tsx` — active-indicator `layoutId` (vtab-anim 1); status-dot transitions (2) where the dot renders.
- `vtabbar.tsx` — tab enter/leave AnimatePresence (4).
- `sessionsidebar/sessionrow.tsx` — status dot (2), asking-badge pop (3), subagent expand/collapse (5).

**Dependency**
- `package.json` — add `motion`.

**No backend / RPC / codegen changes.**

## 10. Testing

- **Pure units (vitest):** `buildAskAnswers` (multi-question, multi-select, empty), `canSubmitAsk` (all-answered vs partial), `isQuiet` (threshold boundaries), `resolveFocusedAskId` (keep-current, advance-on-leave, empty). Existing `groupAgents`/`sortAgents` cover ordering.
- **Behavior, not internals:** the panel answers a multi-select / multi-question ask (asserts the submitted `answers[]` shape); the working grid shows N agents; the empty state renders with no agents.
- **Live (CDP dev-app flow, `memory/cdp-verify-dev-app.md`):** multi-question ask answerable in-panel; asks stream live; quiet cue appears on a stalled agent; layout transitions glide (no snap) when an agent goes working→asking and when an ask is answered; vertical-tab indicator glides on tab switch.
- **Motion is verified live**, not unit-tested (animation is integration glue).

## 11. Out of scope / follow-ons
- Freeform "Other" answers (new `freeformtext` field + hook).
- Show-tool-output toggle; stream cap; remote/SSH; orchestration.
- `prefers-reduced-motion`.
