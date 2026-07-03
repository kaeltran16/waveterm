# Cockpit card corner-resize (width + height)

Date: 2026-07-03
Status: Design + implementation (single doc — trivial scope, no separate plan)

## Problem

The two-independent-fill-columns redesign (`19a9b948`) deliberately dropped per-card **width**
control (no `fullWidth`, columns fixed 50/50) and moved height resize onto a hover divider between
stacked cards. The user wants the old "make this card bigger" affordance back: a **bottom-right
corner grip** that resizes a card in **both** dimensions — height and width — like a window resize.

## Decisions (from brainstorming)

- **Width = full-width span** (restore the old `fullWidth`): dragging the corner sideways past a
  threshold pops the card out to span both columns; dragging back returns it to its column.
- **Placement = float to top**: full-width cards render as a full-width stack at the top of the grid;
  the remaining cards fill the two independent columns below.
- The corner grip **replaces** the hover divider (`RowDividers`) — one affordance instead of two.

## Layout model

`shownAgents` is partitioned (preserving order):

- `fullWidthCards` = those with `cardPrefs[id].fullWidth === true`.
- `columnCards` = the rest → `distributeColumns(columnCards)` → `colA` / `colB` (unchanged).

Render is an outer vertical flex (`flex flex-col gap-3.5`):

1. **Full-width stack** (top): each `fullWidthCards[i]` rendered full-width, height
   `fwHeights[i]`.
2. **Two-column area** (below, only if `columnCards.length > 0`): `flex gap-3.5` of `renderColumn(colA)`
   + `renderColumn(colB)`, sized to the **remaining** height so it still fits-to-viewport when there's
   room and scrolls when it overflows.

### Height budget

`pageRowPx = gridViewportPx / GRID_PAGE_ROWS` (the existing page row height; `gridViewportPx` is the
content-box height already measured, per `19a9b948`).

- **Full-width card height:** `fwHeights[i] = clamp(pageRowPx * weight_i, GRID_MIN_ROW_PX, FULLWIDTH_MAX_PX)`
  where `FULLWIDTH_MAX_PX = FULLWIDTH_MAX_VIEWPORT_FRAC * gridViewportPx` (`FULLWIDTH_MAX_VIEWPORT_FRAC =
  0.6`). The clamp is the **Bug-2 guard**: a full-width card can never exceed 60% of the viewport, so it
  cannot swallow the screen the way the old grid did. `weight` defaults to 1 (→ one page row).
- **`fwStackPx`** = Σ`fwHeights` + `GRID_ROW_GAP_PX * (fullWidthCards.length - 1)`.
- **Columns available height:** `columnsAvail = max(0, gridViewportPx - fwStackPx - (fullWidthCards.length ? GRID_ROW_GAP_PX : 0))`.
  `renderColumn`/`columnHeights` take `columnsAvail` instead of reading `gridViewportPx` directly
  (parameterized). Column behavior is otherwise unchanged (≤3 fill, >3 scroll, mean-1 weights).

When there are no full-width cards, `columnsAvail === gridViewportPx` and the layout is identical to
today's.

## Interaction: the corner grip

A small grip absolutely positioned at each card's bottom-right corner (`opacity-0`, fades in on
`group-hover`, matching the removed divider/right-edge styling). It owns a single pointer drag that
tracks both axes **independently** from the pointer-down origin (`dx`, `dy`):

- **Vertical (`dy`) → height.** On pointer-down the parent snapshots the card's column and its current
  pixel heights (a ref); each move applies the **absolute** `dy` to that snapshot (not cumulatively —
  this avoids the drift/compounding seen with fresh reads). Height shifts split-pane against the
  neighbour **below** in the same column via `resizeRowWeights` + `normalizeWeights` (identical math to
  the old divider). If the card is the **last** in its column, it shifts against the neighbour **above**
  instead (boundary `index-1`, delta `-dy`), so the grip always has a partner.
  - Full-width cards: `dy` scales the card's own `weight` directly
    (`weight = clamp(startPx + dy, GRID_MIN_ROW_PX, FULLWIDTH_MAX_PX) / pageRowPx`); the clamp bounds it,
    so no normalization is needed for the full-width set. A lone full-width card is therefore still
    resizable (normalizing a 1-element set would pin it to 1).
- **Horizontal (`dx`) → full-width toggle.** `nextFullWidth(applied, dx)` hysteresis (threshold
  `FULLWIDTH_DRAG_THRESHOLD_PX = 48`) toggles `cardPrefs[id].fullWidth`. The 48px threshold doubles as a
  dead-zone so incidental horizontal wobble during a height drag never flips the state. The card
  reflows to/from the top stack on toggle (a one-frame position jump mid-drag is acceptable, as in the
  old right-edge handle).

The two axes are applied independently in the same handler; in practice a drag is dominated by one
axis and the 48px dead-zone keeps them from interfering.

## Data model & helpers (`agentsviewmodel.ts`)

- `CardPref` regains `fullWidth?: boolean` (keeps `heightWeight?: number`).
- Re-add `FULLWIDTH_DRAG_THRESHOLD_PX = 48`.
- Add `FULLWIDTH_MAX_VIEWPORT_FRAC = 0.6`.
- Re-add pure `nextFullWidth(current, dragDeltaPx, threshold)` (drag hysteresis) — deleted in
  `19a9b948`, restored verbatim.
- Reuse `distributeColumns`, `rowHeightsPx`, `resizeRowWeights`, `normalizeWeights` unchanged.

## Components

### `agentrow.tsx`

- Add a bottom-right corner grip element (hover-revealed) with a pointer-down handler that runs the
  drag loop (window `pointermove`/`pointerup`), tracking `dx`/`dy` and local `applied` hysteresis
  state.
- New props: `onResizeStart?: () => void`, `onResizeHeight?: (dyPx: number) => void`,
  `onToggleFullWidth?: () => void`. (`heightPx` already exists.) AgentRow stays presentational — it
  computes `dx`/`dy` and calls the callbacks; the weight math lives in the parent.
- Keep `motion.div` root, `cardVariants`, `layout="position"`, `AnimatePresence`, `heightPx` fill.

### `cockpitsurface.tsx`

- Partition `shownAgents` into `fullWidthCards` / `columnCards`; compute `fwHeights`, `fwStackPx`,
  `columnsAvail` as above.
- Parameterize `columnHeights(cards, avail)` and `resizeColumn(cards, boundary, deltaPx, avail)` (and
  `renderColumn(cards, colKey, avail)`) to take the available height.
- Add resize handlers:
  - `beginCardResize(cardId)` — snapshot the card's group (column or full-width stack) + current px
    heights into a ref.
  - `resizeCardHeight(cardId, dyPx)` — from the snapshot: column card → split-pane shift against the
    below/above neighbour (`resizeRowWeights` + `normalizeWeights`); full-width card → clamp own weight.
    Writes `cardPrefs`.
  - `toggleCardFullWidth(cardId)` — flip `cardPrefs[id].fullWidth`.
- Remove `RowDividers` usage (component may be deleted if nothing else uses it).
- **Reset-layout button** visibility test becomes `some(p => p.fullWidth || p.heightWeight != null)`
  again.

## Non-goals

- No column-width (50/50 split) adjustment — width control is full-width span only.
- No persistence (cardPrefs stays ephemeral, as today).
- No multi-select / group resize.

## Testing

- `agentfilters.test.ts`: re-add `nextFullWidth` cases (on/off past ±threshold, dead-zone hold). Keep
  all existing helper tests. No new pure helper beyond `nextFullWidth` (the height/full-width height
  math reuses tested helpers; the clamp is inline).
- Typecheck clean; full `frontend/app/view/agents/` suite green.
- CDP visual: (1) corner grip appears on hover; (2) vertical drag grows a card, shrinks its column
  neighbour, other column untouched; (3) horizontal drag past threshold → card spans full width at the
  top, columns re-fill below; drag back → returns; (4) full-width card height capped at ~60% viewport
  (no screen takeover); (5) no weight explosion in the overflow case (regression guard for
  `862a994b`).

## Risks / open tunables

- `FULLWIDTH_MAX_VIEWPORT_FRAC = 0.6` and `FULLWIDTH_DRAG_THRESHOLD_PX = 48` — verify feel via CDP.
- Reflow jump when a card toggles full-width mid-drag (accepted; matches old behavior).
- Corner grip vs the existing per-card controls (terminal `>_`, mute `⤓`, composer) — the grip sits at
  the extreme bottom-right, clear of the header controls and the composer row; verify no overlap via
  CDP.

## Implementation (ordered; each step ends at a verification checkpoint, no commit)

1. **`agentsviewmodel.ts` + test (TDD):** re-add `FULLWIDTH_DRAG_THRESHOLD_PX = 48`, add
   `FULLWIDTH_MAX_VIEWPORT_FRAC = 0.6`, re-add pure `nextFullWidth`; re-add `fullWidth?: boolean` to
   `CardPref`. Re-add the `nextFullWidth` describe block to `agentfilters.test.ts`. Verify: vitest
   `-t nextFullWidth` green, tsc exit 0.
2. **`agentrow.tsx`:** add the bottom-right corner grip (hover-revealed) with a pointer-down drag loop
   tracking `dx`/`dy` + local `applied` hysteresis; new props `onResizeStart?`, `onResizeHeight?(dy)`,
   `onToggleFullWidth?`. Keep everything else. Verify: tsc exit 0.
3. **`cockpitsurface.tsx`:** parameterize `columnHeights(cards, avail)` / `resizeColumn(cards, b, d, avail)`
   / `renderColumn(cards, key, avail)`; partition `fullWidthCards`/`columnCards`; compute `fwHeights`
   (clamped), `fwStackPx`, `columnsAvail`; render the top full-width stack + the two-column area below;
   add `beginCardResize`/`resizeCardHeight`/`toggleCardFullWidth`; wire the three AgentRow callbacks;
   remove `RowDividers` usage; restore the Reset-layout `fullWidth` test. Verify: tsc exit 0, full
   `frontend/app/view/agents/` suite green.
4. **CDP visual verification** (per the Testing section): grip on hover; vertical resize scoped to one
   column; horizontal → full-width top stack + columns re-fill; 60% cap holds; no overflow explosion.
5. **Combined commit (needs approval):** the modified `agentsviewmodel.ts`, `agentfilters.test.ts`,
   `agentrow.tsx`, `cockpitsurface.tsx` + this spec (folds in). Message
   `feat(cockpit): bottom-right corner resize — full-width span + height`.
