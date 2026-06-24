# Agents Tab Redesign — List + Focus + Keyboard Triage

Date: 2026-06-22
Status: Approved design (pending spec review)
Scope: `frontend/app/view/agents/*` (frontend only; no backend/RPC changes)

## Problem

The Agents tab renders every agent as an equal, full-size panel in a 2-column grid. It works at 2–3 agents but breaks down at 5+: the panels become a wall of streaming boxes, you can only see a few at once, asks get lost among working panels, and there's no overview. Attempts to make a panel more *readable* (bigger type, more breathing room) directly worsen *density* — the grid forces a false trade-off, because every cell competes for the same fixed space.

## Goals

- Hold up at 5+ agents without overwhelming: a stable, scannable overview regardless of how chatty agents are.
- Make the live message readable without sacrificing the overview.
- Make the thing you must act on — an open question — always fully readable.
- Let a user clear a queue of asks quickly from the keyboard.

## Non-goals (explicitly out of scope for this pass)

- Attention/priority ordering (auto-floating stalled/erroring agents).
- First-class stalled/error signals beyond the existing `quiet` cue.
- Idle outcome split (done / stopped / failed).
- Project grouping/filtering; agent-type (claude/codex) surfacing.
- Any backend, RPC, projection, or data-layer change. The live transcript stream, answer encoding, `previousInfo`, and status feed are unchanged.

## Core principle

Decouple the two jobs the grid conflated:

- **Overview** wants a fixed per-item budget so total height is `count × budget` (bounded, predictable) rather than `sum(verbosity)` (unbounded).
- **Reading** wants room, which only exists when one agent owns the screen.

So: a dense list for the overview, a full-bleed focus view for reading, and density that follows **state** (asks are never clamped; working rows are).

---

## 1. Layout

Single-column list replacing the 2-column `DraggablePanel` grid. Top-to-bottom sections:

1. **Header** — unchanged in spirit: `Agents` title, `N needs you · jump →` (amber, when asks > 0), `N working`.
2. **Asks** — pinned at top, full width, never clamped.
3. **Working** — clamped two-column rows.
4. **Idle** — existing collapsible `IdleSection`, unchanged (flat list).
5. **Key-hint bar** — pinned at the bottom of the list area (see §4).

The Agents view continues to sit to the right of the existing vertical tab nav (`vtabbar`); no nav changes. Rows must survive the reduced width (window minus ~232px nav): the working row's two columns collapse to a single stacked column below a width threshold (steps under prose).

## 2. Row treatments

### Ask row (state: `asking`)
- Full width, amber-tinted background, never clamped.
- Header: amber dot, name (15px), `project · task` meta, `needs you` badge.
- The full question text (prose, markdown) at 14px.
- Answer options, each prefixed with a keyboard number (`1`, `2`, …). **Adaptive layout:** options render as **stacked rows** (number + bold label + description per row) when any option carries a description, and as compact **wrapping chips** (label only) when none do. So `Yes/No` stays tight while a rich, descriptive ask reads like the native AskUserQuestion UI.
- This row is the action surface; it always reads in full (never clamped) — a verbose, many-option, multi-question ask simply makes its own row taller.

### Working row (state: `working`)
- Header: teal dot, name (14px), `project · task` meta, age (right).
- Two-column body:
  - **Left** — current message prose, 13px, **clamped to a fixed ~3-line budget** with a bottom fade. Short messages do not pad to the cap.
  - **Right** — recent tool steps: mono `verb target` lines with `✓`/`✗` outcomes, separated by a thin left divider.
- Below a width threshold, the steps column stacks under the prose.
- Clamp is fixed for v1 (KISS). Load-adaptive clamp ("tighten as the list fills") is a noted future enhancement, not built.

### Idle row
- Unchanged. Existing `IdleSection` collapsible list with per-row composer.

## 3. Focus view (new)

Opening an agent (click a row, or `↵` on the cursor with no pending answer) replaces the list with a single-agent reading view filling the Agents view area.

- **Header**: `←` back, dot, name (17px), `project · task`, `model · age` (right), `↗ terminal` (opens the agent's tab via existing `setActiveTab`), `‹ ›` prev/next.
- **Body**: large readable narration — a prominent "Now" (latest message, 16px), "Earlier" prose (14px), and the mono step list. Reuses the existing `NarrationTimeline` projection at a larger scale.
- **Footer**: full-width composer (`AgentComposer`). If the agent is asking, the answer options sit directly above the composer, full and readable.
- **Navigation**: `‹ ›` step to prev/next agent in the current list order; `←` / `Esc` return to the list. Returning restores the list scroll position and cursor.

This is the only place bigger type + breathing room apply, because there is no density to trade against.

## 4. Keyboard triage (new)

A focus-aware keymap with a **visible cursor** (a highlighted row; teal for working, amber for ask). State: the cursor is a row id held in `AgentsView`. Clicking a row sets the cursor; keys move it.

### Focus arbitration (the real risk)
Single-letter keys must fire **only** when:
- the Agents view owns focus (it must be focusable / tied to the block focus model), **and**
- the event target is not an `input` / `textarea` / `contentEditable`, and no composer is focused.

The keydown handler is scoped to the view's DOM subtree (not a global/window listener) so keys never leak to terminal blocks. When a composer is focused, only `Esc` (blur) and the composer's own send shortcut apply.

### Keymap
| Key | Action |
|-----|--------|
| `↑` / `k`, `↓` / `j` | Move cursor through **all** visible rows (asks + working) |
| `n` | Jump cursor to the next ask (cycles); generalizes the existing `jumpToNextAsk` |
| `1`–`9` | **Select** (highlight) the Nth answer option on the cursor's ask — does not send |
| `↵` | If an answer is selected on the cursor's ask → **submit** it; otherwise → open the focus view for the cursor row |
| `r` | Focus the reply composer for the cursor's agent |
| `Esc` | In focus view → back to list; composer focused → blur; else no-op |
| `?` | Toggle a shortcuts cheatsheet overlay |

### Answer commit flow
- Two-step by design: `1–9` selects (safe against fat-finger), `↵` confirms.
- On confirm, call the existing `AnswerAgentCommand`; **stay put** (no auto-advance). The row shows an optimistic confirmed state (e.g. `✓ Answered: Channel`) so the user sees the result before the agent transitions back to `working`. Advancing to the next ask is a deliberate `n`.

## 5. Reorder (kept)

Drag-to-reorder carries over from the grid to the list, reusing the existing `reorderList` / `mergeOrder` / `order` / `dragId` machinery. A drag handle on each row; drop reorders within the working set. **Per-panel resize presets (S/M/L/fill) are removed** along with the grid — rows don't resize; reading happens in the focus view.

## 6. What's removed

- The 2-column grid and `DraggablePanel`'s resize affordance + ghost/preset snapping.
- `PANEL_PRESETS` / `resolveHeight` / `snapToPreset` usage for layout (resize).
- The per-panel "fill the viewport" measurement (`fillPx`, `useDimensions` for panel height).

Kept: reorder, the live `now` tick, the recently-idle grace window, the empty state, all data/atoms.

## 7. Components affected (frontend only)

- **`agents.tsx`** — `AgentsView` restructured from grid to list (sections + cursor + keymap + hint bar); `DraggablePanel` resize removed, drag-reorder retained as a lighter row affordance. New: keydown handler, cursor state, focus-view routing.
- **`outputpanel.tsx`** — `WorkingPanel` splits into a compact **row** component (header + clamped prose + steps) and a **focus view** component (large narration + composer + answer). Likely new files: `agentrow.tsx`, `focusview.tsx`.
- **`narrationtimeline.tsx`** — reused; row uses only the latest message (clamped) + recent action entries; focus view uses the full timeline. May add a small selector to split "latest message" vs "recent steps" from `AgentEntry[]`.
- **`answerbar.tsx`** — numbered answer chips + keyboard select/confirm + optimistic confirmed state.
- **`agentcomposer.tsx`** — reused unchanged in row (`r`) and focus view.
- **`agentsviewmodel.ts`** — keep `groupAgents`, `mergeOrder`, `reorderList`, `isRecentlyIdle`, `isQuiet`, `formatAge`. Possibly add a derived "latest message / recent steps" helper. No state-model change to `AgentVM` required.
- **`idlesection.tsx`, `statusdot.tsx`, `liveagents.ts`, `livetranscript.ts`, `previousinfo.ts`, projections** — unchanged.

## 8. Testing notes

- Unit: clamp budget (short message not padded; long message clamped + fade flag), cursor movement across mixed rows, `n` cycling through asks only, answer select-then-confirm (1–9 selects without sending; ↵ sends once), Esc/back transitions, reorder still produces correct order.
- Interaction guard: keymap is inert when a composer/input is focused and when the view lacks focus (no leakage to other blocks).
- Existing tests for `agentsviewmodel` ordering/grouping must continue to pass.

## 9. Future enhancements (noted, not built)

- Load-adaptive working clamp.
- Attention ordering; first-class stalled/error signals; idle outcome split; project grouping; agent-type badge.
