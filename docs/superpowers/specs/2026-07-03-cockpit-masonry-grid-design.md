# Cockpit grid → two independent fill-columns

Date: 2026-07-03
Status: Design approved (pending spec review)

## Problem

The cockpit "fit-to-viewport resizable card grid" (shipped `266df043` / merge `3674e092`) is a single
2-column CSS grid with an explicit `grid-template-rows`. Two consequences read as bugs:

1. **Height is row-scoped.** Both cards in a visual row occupy the *same* grid row track, so dragging a
   row divider (`RowDividers` → `resizeRowWeights`) resizes *both* cards. There is no per-card height.
2. **Full-width takes over the screen.** A full-width card is forced into its own row
   (`computeGridLayout`), and because rows are sized to fill the viewport (`rowHeightsPx` fill branch),
   that row expands to a large slice — the whole screen when it is the only row.

Both are the shared-row grid colliding with a per-card mental model.

## Goals

- **Keep fill-by-default.** 1 card fills the whole area; 2 cards → half each; 4 → 2×2; 6 → 2×3. Same as
  today's nice behavior.
- Each card owns its height. Dragging a card's height must not affect the *other* column.
- Resize is **split-pane fill**: growing a card shrinks its column-neighbour so the column stays exactly
  full (no scroll until neighbours hit their minimum).

## Non-goals

- **Full-width / widen is removed.** A lone card already fills the width; there are no bands and no
  `fullWidth` pref. (Reverses the earlier band design — user chose to drop it.)
- **Manual drag-to-reorder (∷∷ grip) is dropped this pass.** 1-D `motion` `Reorder.Group` does not map
  onto two independent columns. Order still comes from status/recency + anchored slots (unchanged).
- No persistence of layout prefs across reload (same as today — `cardPrefs` stays ephemeral).
- The shipped cockpit motion (`b3ccce07`: `cardVariants` entrance/exit, `layout="position"` reflow,
  `composerReveal`, `AnimatePresence` popLayout, `MotionConfig`) is **preserved**. Only the
  reorder-drag pieces go with reorder: `whileDrag`/`reorderLift`, `dragControls`, the `∷∷` grip.

## Layout model

Two **independent columns** side by side, each filling the scroll area's height.

- **Distribute** the ordered, filtered cards round-robin: even index → column A, odd → column B.
  Deterministic, balances the count (differ by ≤1), preserves left-to-right reading order.
- If column B is empty (exactly 1 card after filtering), column A spans the **full width**.
- Each column divides its own height among its cards **by weight** (default weight 1 = equal fill),
  reusing `rowHeightsPx` per column:
  - ≤ `GRID_PAGE_ROWS` (3) cards → fill the column exactly (no scroll).
  - > 3 cards → each card keeps a page row-height × weight, the column overflows, the scroll area
    scrolls. Columns are independent, so the taller column drives the scroll (ragged bottom is fine).

Card-count → look (all filling, no scroll up to 6):

| cards | column A | column B | result |
|---|---|---|---|
| 1 | [c0] | — | c0 full width + full height |
| 2 | [c0] | [c1] | two half-width, full-height |
| 3 | [c0,c2] | [c1] | left split in two, right one tall |
| 4 | [c0,c2] | [c1,c3] | 2×2 |
| 6 | [c0,c2,c4] | [c1,c3,c5] | 2×3 |

## Resize (split-pane fill)

Dividers move from *between grid rows* to *between stacked cards within a single column*:

- Each column renders one horizontal divider between each pair of adjacent cards (reuse the existing
  `RowDividers` component, one instance per column, positioned in that column's relative container).
- Dragging divider `i` in a column calls `resizeRowWeights(columnWeights, i, deltaPx, columnAvailablePx)`
  — the **existing, tested** helper — and writes the returned weights back to `cardPrefs[id].heightWeight`
  for that column's cards only. The other column is never touched → Bug 1 fixed.
- `resizeRowWeights` already clamps each neighbour to `GRID_MIN_ROW_PX` (96) and preserves the pair's
  combined height, i.e. exactly split-pane fill.
- A column with one card has no divider (nothing to split against); it just fills.

## Data model

`CardPref` (in `agentsviewmodel.ts`):

```ts
export interface CardPref {
    heightWeight?: number; // relative height within its column; default 1 (even fill)
}
```

- `fullWidth` is **removed**. `heightWeight` is **kept**, reinterpreted as a per-card weight within its
  column (was: per-row weight). Keyed by agent id, so a card keeps its relative size while it exists.
- The current effect that drops `heightWeight` on membership change is **removed** — weights are per
  card now and `rowHeightsPx` normalises by total, so a departed card needs no cleanup.

## Constants (`agentsviewmodel.ts`) — all kept

- `GRID_PAGE_ROWS` (3) — cards-per-column that fill before the column scrolls.
- `GRID_MIN_ROW_PX` (96) — minimum card height when dragging.
- `GRID_ROW_GAP_PX` (14) — matches the grid gap.
- **Remove** `FULLWIDTH_DRAG_THRESHOLD_PX` (no full-width).

## Pure helpers (`agentsviewmodel.ts`, TDD)

- **Add** `distributeColumns(ordered: AgentVM[]): { colA: AgentVM[]; colB: AgentVM[] }` — round-robin.
- **Keep** `rowHeightsPx`, `resizeRowWeights` (now applied per column — no change to the functions).
- **Remove** `computeGridLayout`, `GridRow`/`GridCell` types, `nextFullWidth`.

## Components

### `cockpitsurface.tsx`

- Keep the scroll container (`gridScrollRef`, `overflow-y-auto`), the `gridViewportPx`
  `ResizeObserver` (still needed to size the fill), and the outer `MotionConfig`.
- Replace the single `Reorder.Group` grid with a **flex row of two columns**, via a local
  `renderColumn(cards, colKey)` closure (avoids prop-drilling ~15 AgentRow callbacks into a new
  component):
  - `const { colA, colB } = distributeColumns(shownAgents)`.
  - Per column: `weights = cards.map(c => cardPrefs[c.id]?.heightWeight ?? 1)`;
    `avail = Math.max(0, gridViewportPx - GRID_ROW_GAP_PX * Math.max(0, cards.length - 1))`;
    `heights = rowHeightsPx(weights, avail)`; `contentPx = Σheights + gaps`.
  - Each column: a `relative flex-1` container of height `contentPx || "100%"`, an inner
    `flex h-full flex-col gap-3.5` holding an `<AnimatePresence mode="popLayout" initial={false}>` of
    `<AgentRow heightPx={heights[i]} …>`, plus one `RowDividers` overlay wired to
    `resizeColumn(cards, i, delta)`.
  - `colB` empty → `renderColumn` returns `null`, so only column A renders → it fills full width.
- Remove: the old single-grid render + its `gridContentPx` wrapper, `resizeGridRow` (→ `resizeColumn`),
  the whole-grid `gridRowHeights`/`gridContentPx`, the membership-reset effect, and the
  `computeGridLayout` import. `resizeColumn(cards, i, delta)` runs `resizeRowWeights` on that column's
  weights and writes them back via `setCardPrefs` for that column's ids only.
- "Reset layout" button: unchanged (`setCardPrefs({})`); visibility test becomes
  `Object.values(cardPrefs).some(p => p.heightWeight != null)`.
- Ordering (`orderAtom`, `mergeOrder`, `applyAgentOrder`, cursor/keyboard nav) unchanged — order drives
  distribution.

### `agentrow.tsx`

- Change the root from `Reorder.Item` to `motion.div`, **keeping** `variants={cardVariants}`,
  `initial`/`animate`/`exit`, `layout="position"`, `ref`, `data-agent-id`, `onClick`, `onDoubleClick`,
  `className`. **Drop** the reorder props (`as`, `value`, `dragListener`, `dragControls`,
  `dragMomentum`, `dragTransition`, `whileDrag`) and the `gridColumn` style.
- Remove `useDragControls`/`controls` and the `∷∷` grip span in the header; remove the right-edge
  width handle block and the `spanFull` / `onToggleFullWidth` props. Drop the now-unused imports
  (`Reorder`, `useDragControls`, `reorderLift`, `nextFullWidth`); keep `motion`, `cardVariants`,
  `composerReveal`.
- Add a `heightPx?: number` prop. Card fill: `style={{ height: heightPx > 0 ? heightPx : undefined,
  flex: heightPx > 0 ? undefined : "1 1 0", minHeight: 0 }}` — explicit height once measured, flex-fill
  fallback for the first frame before the `ResizeObserver` fires. Keep `overflow-hidden`.

## Testing

- `agentfilters.test.ts`: **add** `distributeColumns` cases (0/1/2/3/4/6 cards → expected A/B split);
  **keep** the existing `rowHeightsPx` and `resizeRowWeights` cases (still used); **remove**
  `computeGridLayout` and `nextFullWidth` cases.
- Keep all existing filter/order/group tests green.

## Risks / open tunables

- **`GRID_PAGE_ROWS` = 3** governs when a column starts scrolling; verify it feels right at common
  viewport sizes via CDP.
- **No reflow animation** — cards snap when the set changes. Acceptable for this pass.
- Round-robin means adding/removing a card can shift a card between columns; its weight then applies in
  the new column. Harmless (weight is relative), noted for awareness.
