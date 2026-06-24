# Agents Tab — Ask-in-Place + Anchored Ordering + Polish (Design)

- **Date:** 2026-06-22
- **Status:** Approved (design); pending implementation plan
- **Scope:** Remove the invasiveness of the asking state. Two structural changes (answer-in-place, anchored ordering) plus a bounded 5-item density/polish pass. All work is in the view + pure layers — no backend, no RPC, no `task generate`.

## Problem

When a working panel transitions to **asking**, the current view does two jarring things at once:

1. The agent is pulled out of the working grid (`groupAgents` separates `asking` from `working`) and re-rendered as a **full-width `AskCard` above the grid** (`agents.tsx:347`) — a tall element materializes on top and shoves everything down.
2. The grid loses a cell and reflows.

So the panel you were reading does not update in place — it **teleports and changes shape**. Compounding it, position is a function of state and response timing, not identity: `sortAgents` ranks `asking(0) → working(1) → idle(2)` and sorts `working` by `activeMs`, and an asking agent that resumes re-enters `gridAgents` as a new id and gets **appended to the end** of the `order` list. Net effect: agents shuffle slots as they respond.

## Locked decisions

| Decision | Choice |
|---|---|
| Ask presentation | **Answer in place** — the asking panel stays in its slot, recolors amber, docks the question in its own body. Zero shift. |
| Grid ordering | **Anchored slots** — position keyed to agent identity; state changes never move a panel. Only the user (drag) reorders. |
| Off-screen ask discovery | **Header pill + manual jump** — "N needs you · jump →"; click scrolls the next ask into view and pulses it. No auto-scroll. |
| Always-on-top for asks | **Removed.** Asks no longer relocate; prominence comes from color/glow + the header pill. |
| Color language | **Amber = "needs you", exclusively.** Quiet/idle move to muted grey. |
| Order/size persistence | In-memory for the session (unchanged from prior decision — YAGNI). |

## Architecture context

The Agents view (`frontend/app/view/agents/`) is a **pure projection** of two upstream sources (`sessionSidebarViewModelAtom` + per-block `agent:status`/`agent:ask` WPS events). Logic lives in import-free, unit-tested pure modules (`agentsviewmodel.ts`, `transcriptprojection.ts`); components are thin. This redesign stays inside that shape — every change is presentation or pure-logic; nothing new is owned and no new write-path back to agents is opened (answering still uses `AnswerAgentCommand`; freeform reply still uses `ControllerInputCommand` via `AgentComposer`).

Relevant current pieces:
- `agents.tsx` `AgentsView` — groups agents; renders focused `AskCard` + "N more waiting" `QueueRow` list above a `gridAgents = [...working, ...recentlyIdle]` grid; `order` state (identity-stable for the grid), `presetById` (per-panel size), `dragId` (reorder); `IdleSection` for parked idle; a 1s `now` tick.
- `askcard.tsx` `AskCard` — standalone amber card: header, `PreviousInfo` narration, `QuestionGroup`s, selection state, submit (single-select auto-submits, multi-select submits on Enter), `AgentComposer`, bespoke drag-resize.
- `outputpanel.tsx` `WorkingPanel` — header (`StatusDot`, name, `project · task`, `model · age · ⟳ since · quiet`, Dismiss, Open terminal), narration body, "↓ N new" pill, `AgentComposer`.
- `agentsviewmodel.ts` — `sortAgents`, `groupAgents`, `resolveFocusedAskId`, `withAsk`, `isAskStale`, `isRecentlyIdle`, `isQuiet`, panel presets, `reorderList`, `buildAskAnswers`, `canSubmitAsk`.
- `statusdot.tsx` — `COLOR` map (asking→warning, working→accent, idle→muted); hollow when working + quiet.

---

## Part 1 — Unified anchored grid

**Goal.** One identity-ordered grid holding all asking + working + recently-idle agents. State changes recolor a panel where it sits; they never change its slot.

**Approach.**
- **Merge asking into the grid set.** `gridAgents` becomes `[...asking, ...working, ...recentlyIdle]` (all non-parked agents). Because the existing `order` effect preserves the prior order of kept ids and only appends genuinely-new ids, simply keeping an asking agent in the grid set means its id never leaves `order` on a working↔asking↔idle-grace transition — so it keeps its slot. This is the core of anchored ordering.
- **`sortAgents` no longer drives grid position.** It is retained only to (a) seed the relative order of agents seen for the first time in the same render, and (b) order asks for the jump-to cycling (below). It must never reorder agents already present in `order`.
- **Extract the order merge to a pure helper.** Move the inline `order` reconciliation (`agents.tsx:304`) into `mergeOrder(prev: string[], ids: string[]): string[]` in `agentsviewmodel.ts` (keep prior order, append new, drop absent) so it can be unit-tested for the identity-stable property.
- **Remove the focused-ask + queue rendering.** Delete the focused `AskCard` block (`agents.tsx:347`), the "N more waiting" section + `QueueRow` component, and `resolveFocusedAskId` usage. Multiple simultaneous asks are simply multiple amber panels in the grid.

**Files.** `agents.tsx` (grid set, header, remove focused/queue), `agentsviewmodel.ts` (`mergeOrder`, `nextAskId`; `resolveFocusedAskId` removed).

**Tests.** `agentsviewmodel.test.ts`: `mergeOrder` keeps existing slots when an id toggles state (present→present), appends new ids in input order, drops removed ids, and is a no-op when the set is unchanged.

## Part 2 — Answer in place

**Goal.** An asking agent's panel transforms in its slot; the question is answered inside the panel. No size or position change by default.

**Approach.**
- **Extract the answer UI** from `askcard.tsx` into a new `answerbar.tsx` (`AnswerBar`): the `QuestionGroup`s, selection state, single/multi-select submit, and the Enter-to-submit handling, reusing `buildAskAnswers` / `canSubmitAsk` unchanged. It renders **pinned at the bottom of the panel body**, above the existing `AgentComposer`.
- **`WorkingPanel` renders the asking state.** When `agent.state === "asking"`: container gets the amber border + glow (`box-shadow`), the header shows a `needs you` tag (the `StatusDot` already renders amber for asking), the narration body **dims** to de-emphasize it against the question, and `<AnswerBar>` appears between the narration and the composer. Working/idle states render exactly as today (minus the polish changes in Part 4).
- **Delete `askcard.tsx`.** Its standalone card form (header, bespoke resize, `PreviousInfo`) is no longer used; the narration it showed is already the panel's own narration body. (Pre-release: no back-compat concern.)
- **Expand-in-place affordance (optional within a panel).** For a large multi-question ask in a small panel, a single control on the asking panel bumps its preset to `l`/`full` (reusing `PANEL_PRESETS` + `presetById`), widening *that panel in its slot* — never relocating it. Default behavior is no auto-grow: the answer bar pins to the bottom and the narration scrolls in the remaining height (zero shift).

**Files.** `answerbar.tsx` (new, extracted), `outputpanel.tsx` (asking styling + render `AnswerBar`), `agents.tsx` (pass the answer callback into the grid; drop the separate `AskCard` import), `askcard.tsx` (deleted).

**Tests.** Answer logic (`buildAskAnswers`/`canSubmitAsk`) is already covered and unchanged. The in-panel rendering is visual.

## Part 3 — Header pill + jump-to

**Goal.** Surface an off-screen ask without relocating it.

**Approach.**
- The `AgentsView` header replaces today's "N asking" count with an amber **pill** `● N needs you` (shown only when `asking.length > 0`) plus a `jump →` control. The "M working" count stays as plain muted text.
- **`jumpToNextAsk`** cycles through asking panels by `blockedMs` (oldest-blocked first via `nextAskId(askingIds, current)` in `agentsviewmodel.ts`): `scrollIntoView` the panel's `[data-agent-id]` element and trigger a brief pulse. Repeated clicks advance to the next ask.
- Sidebar badge (`liveAskingCountAtom` → `askingCount`) is unchanged.

**Files.** `agents.tsx` (pill + jump handler + pulse state), `agentsviewmodel.ts` (`nextAskId`).

**Tests.** `agentsviewmodel.test.ts`: `nextAskId` returns the oldest-blocked first, advances past `current`, and wraps.

## Part 4 — Density & polish pass (5 items)

1. **Reserve amber for "needs you."** In `outputpanel.tsx` the quiet meta currently uses `text-warning`; change quiet/idle meta to muted grey. The hollow `StatusDot` remains the quiet signal. Net: amber appears only on asking panels and the header pill. *(This is also a correctness fix — today a merely-quiet agent wears the asking color.)*
2. **Liveness in the dot, not text.** Drop the per-second `⟳ {since}` ticker and the `quiet` text from the panel header; right-meta becomes just `model · age` (`tabular-nums`). The `StatusDot` already encodes liveness (pulsing green active / hollow quiet / amber asking / grey idle). The 1s `now` tick is retained for the dot's `isQuiet` computation and idle age, but no per-second number renders → also removes a residual layout-shift source.
3. **Hover-reveal actions.** Open terminal / Dismiss become icon buttons revealed on panel hover (`group-hover`) instead of two permanent bordered buttons per panel — less standing button noise.
4. **One type ladder & two radii.** Collapse the ad-hoc sizes (`15/13/12.5/11.5/11/10.5/10`) into **14 / 13 / 12 / 11 / 10**; panels use a 10px radius, controls/chips use 6px. Sweep the `agents/` files.
5. **Tighter empty state.** Subtler "no active agents" treatment. *(The model label is already shortened to the family via `modelLabel` in `agentVMFromInput` — verified; no change needed there.)*

**Files.** `outputpanel.tsx`, `agents.tsx`, `answerbar.tsx`, `statusdot.tsx` (no color change needed — already correct), `narrationtimeline.tsx` / `idlesection.tsx` (type/radius sweep only).

**Tests.** Visual; verified by running the dev app (CDP).

---

## Cross-cutting

- **Pure-first.** New logic (`mergeOrder`, `nextAskId`) lands in `agentsviewmodel.ts` with unit tests; components stay thin. Answer logic is reused unchanged, not rewritten.
- **No backend changes.** No new RPCs, no `task generate`. Answering = existing `AnswerAgentCommand`; freeform reply = existing `ControllerInputCommand` via `AgentComposer`.
- **Transcript streaming** continues for all panels currently in the grid (asking + working).
- **Shared working tree.** Re-check git branch/status before any commit; nothing is committed without explicit approval.
- **New files small and single-purpose:** `answerbar.tsx`. Deleted: `askcard.tsx`.

## Caveats / trade-offs

- **Off-screen asks rely on the header pill** (accepted). A blocked agent no longer grabs the viewport; the pill + jump is the discovery path.
- **Answer bar is bounded by panel width**, so a 4-option question in a small panel wraps; mitigated by the expand-in-place affordance.
- **Dropping the ⟳ ticker** removes the exact "seconds since last activity" readout; the dot's quiet state (>45s via `isQuiet`) still signals staleness. Accepted.

## Out of scope

- Persisting order/sizes across full reload (in-memory only — prior YAGNI decision).
- Auto-scroll to a new ask (rejected in favor of manual jump).
- Any backend / status-reporter / hook changes.
- Wave-native tiling for agents.

## Testing strategy

- Unit tests for all new pure logic: `mergeOrder` (identity-stable ordering across state toggles, append, drop, no-op) and `nextAskId` (oldest-blocked-first cycling with wrap).
- Existing `agentsviewmodel.test.ts` extended, not replaced; answer-building tests unchanged.
- Visual items (ask-in-place styling + glow, amber-reserved color language, hover actions, type/radius sweep, empty state, header pill + jump pulse) verified by running the dev app over CDP.
