# Cockpit fit-to-viewport resizable card grid — Design

Date: 2026-07-03
Surface: **Cockpit surface** (`frontend/app/view/agents/cockpitsurface.tsx` grid + `agentrow.tsx`)

## Problem

The Cockpit renders live agents as a 2-column grid of **fixed-height cards** (`DEFAULT_CARD_HEIGHT = 280`,
`agentrow.tsx:27`; `grid grid-cols-2 auto-rows-min … overflow-y-auto`, `cockpitsurface.tsx:621`). The
fixed height means the grid scrolls even when only a few agents are live and the screen has room to
spare — you can't glance and see the whole fleet at once. (Confirmed as *the* pain point in the
brainstorm; card content, chrome, and the overall shape were explicitly **not** flagged.)

The user runs **≤6 agents** on a busy day and wants to keep the **rich cards** — so this is not a
density/compaction problem. It's that the grid doesn't size cards to the space available.

Secondary: the current resize UX is two controls for one job — a **widen** toggle button
(`⤢/⤡`, `agentrow.tsx:291`) that spans a card across both columns, plus a **bottom drag-handle**
(`agentrow.tsx:463`) that sets a pixel height. Fiddly and non-obvious.

## North star

**The live fleet fits one screen and fills it.** At N≤6 the cards divide the viewport with no scroll;
each card is as large as the space allows. Resizing is one direct gesture (drag a boundary) and the
other cards reflow to keep the screen full and gap-free.

## Locked decisions (from the brainstorm)

- **Fit-to-viewport, 2 columns.** Live agents (asking + working + just-finished grace) fill the
  height: rows = `ceil(N/2)`. At N≤6 the rows divide the viewport exactly (2×3 at 6, 2×2 at 4,
  2×1 at 2, one full card at 1). Past 6, rows keep their 6-card height and the grid scrolls.
- **Idle / backgrounded stay in the slim footer** (`IdleSection` / `BackgroundedSection`) and do
  **not** count toward the fit — unchanged from today.
- **Resize = drag dividers** (model "B", which for 2 columns reduces to row-height + column-split
  drags plus a full-width span). This **replaces both** the widen button and the bottom drag-handle.
- **Auto by default, manual as override.** The grid fills evenly with zero fiddling; a drag stores a
  per-agent override. Agents entering/leaving renormalize the remaining weights so the screen stays
  full. A **Reset layout** affordance clears overrides.
- **Build lean, do not reuse `frontend/layout`.** That engine is ~3,580 lines (recursive tile tree,
  move/resize/magnify/swap/drop-direction/navigate, tab-coupled) built for drag-dropping arbitrary
  blocks — overkill for a 2-column ≤6-card grid, and it re-opens the tiling-window machinery the
  cockpit deliberately dropped in the Tauri migration.

## Design

### 1. Layout model (pure, cockpit-local)

The ordered live-agent list packs into rows of two, in order. A `fullWidth` card takes a whole row
alone. This is expressed as one **pure function** (the testable core), sibling to the existing pure
helpers in `agentsviewmodel.ts`:

```
computeGridLayout(orderedLive: AgentVM[], prefs: Record<id, CardPref>)
  -> { rows: Array<{ heightWeight: number; cells: Array<{ id; widthWeight }> }> }
```

- **Rows** are derived from order + `fullWidth` flags (greedy pack: a `fullWidth` card forces/fills
  its own row; otherwise two per row).
- **Row height** = normalized `heightWeight` across rows. When `rows ≤ 3` the weights normalize to
  the viewport height so it **fills exactly**; when `rows > 3` each row falls back to the page
  row-height (`viewport / 3`) and the container scrolls. Default `heightWeight = 1` (equal rows).
- **Column split** within a two-card row = the row's `splitWeight` (default `0.5` → 50/50). A
  `fullWidth` row ignores split.

Rendering: replace the CSS `grid-cols-2` + `auto-rows-min` with an explicit rows→cells render driven
by `computeGridLayout`, sizing via `flex`/`grid` proportions (weights, not pixels), so it always
fills and is gap-free by construction. `Reorder.Group`/`Reorder.Item` (drag-to-reorder) is retained.

### 2. Resize interaction (removes the two buttons)

Draggable dividers, no per-card handle and no widen toggle:

- **Row divider** (horizontal, between rows) → drag to grow the row above and shrink the row below
  (adjust the two adjacent `heightWeight`s, sum preserved). Row-mates share the row height.
- **Column divider** (vertical, between the two cards in a row) → drag to change that row's
  `splitWeight`.
- **Full-width span** → drag the column divider to the row edge (or a small affordance) to set
  `fullWidth` (card spans both columns); drag back to restore the split. This is the old "widen",
  now one gesture.

Minimum card size clamps the drag; dragging past it stops (the sibling never disappears). A manual
resize *may* push total rows past the one-screen page and scroll — that is the user's explicit
choice, not the default.

### 3. Auto default, manual override, renormalize on change

- No stored pref → default weights → even fill.
- A drag writes `{ heightWeight | splitWeight | fullWidth }` for the affected agent(s) into
  `cardPrefsAtom` (keyed by agent id, as today).
- When an agent enters/leaves, its pref is dropped and the remaining weights renormalize
  (`computeGridLayout` always normalizes, so no stale absolute sizes) — the screen stays full.
- **Reset layout** control clears `cardPrefsAtom` for the live set.

### 4. State model change

Replace the pixel/boolean prefs with proportional weights:

```
// before                          // after
interface CardPref {               interface CardPref {
  wide?: boolean;                    fullWidth?: boolean;   // was `wide`
  height?: number;   // px           heightWeight?: number; // relative, default 1
}                                    splitWeight?: number;  // 0..1 row column ratio, default 0.5
                                   }
```

`cardSpanStyle()` (`agentsviewmodel.ts:644`) is superseded by `computeGridLayout` + a small
per-cell style mapper. Its unit tests (`agentfilters.test.ts:116-128`) are replaced by
`computeGridLayout` tests.

### 5. Unchanged

Drag-to-reorder (`∷∷` handle), card internals (header chips, narration feed, asking band, `AnswerBar`,
composer), the filter chips, right rail, idle/backgrounded footer, and all keyboard triage. Only the
two resize controls leave the card header/footer.

## Files touched

| File | Change |
|---|---|
| `frontend/app/view/agents/agentsviewmodel.ts` | `CardPref` reshaped (`fullWidth`/`heightWeight`/`splitWeight`); add pure `computeGridLayout`; remove/retire `cardSpanStyle` |
| `frontend/app/view/agents/agentfilters.test.ts` | replace `cardSpanStyle` tests with `computeGridLayout` tests (pack, normalize-to-viewport, split, fullWidth, >6 scroll fallback, renormalize on leave) |
| `frontend/app/view/agents/cockpitsurface.tsx` | render rows→cells from `computeGridLayout` instead of `grid-cols-2 auto-rows-min`; row/column divider components + drag handlers writing `cardPrefsAtom`; **Reset layout** control; drop `wide`/`height` prop wiring |
| `frontend/app/view/agents/agentrow.tsx` | remove widen button (`:291`) + bottom resize handle (`:463`) + `DEFAULT_CARD_HEIGHT`; card fills its cell (no self-imposed height); drop `wide`/`height`/`onToggleWide`/`onResize` props |
| `frontend/app/view/agents/agents.tsx` | `cardPrefsAtom` type follows the new `CardPref` (no structural atom change) |

## Non-goals

- No density/compaction modes, no dense-row view — the fleet is ≤6 rich cards by decision.
- No reuse of `frontend/layout`; no recursive/arbitrary tiling, no row-spanning beyond `fullWidth`,
  no cross-column free placement.
- No backend / RPC / `task generate` change — pure frontend.
- No change to card content, filters, rail, footer, or keyboard triage.
- Motion: reorder animation stays; divider drag is direct (no easing needed). No new motion work.

## Testing / verification

- **Unit (`npx vitest run`):** `computeGridLayout` — row packing for N=1..8; height weights normalize
  to fill at N≤6; fall back to page-height + scroll at N>6; `splitWeight` column ratio; `fullWidth`
  row; renormalize when an agent leaves; min-size clamp helper if extracted.
- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline clean).
- **Visual (CDP, per CLAUDE.md):** inject fixtures (`node scripts/gen-cockpit-fixtures.mjs <scenario>`
  + reload) and screenshot: `mixed` at 2/4/6 live (fills, no scroll), an 8-live scenario (scrolls,
  cards keep 6-card height), a drag of a row divider + column divider + full-width span (siblings
  reflow, gap-free), and Reset layout. Clear with `--clear` when done.

## Open questions (resolve in the plan, not blocking)

- **Keying a row's `heightWeight`/`splitWeight`:** store on the row's first (left) card vs. a derived
  row key. Leaning: store on the dragged card and read the row's left card — simplest, order-stable
  enough for ≤6.
- **Full-width gesture affordance:** edge-drag snap vs. a tiny header pip. Decide during CDP pass.

## Commit note

Per repo convention this spec + its plan fold into the feature commit, not a separate docs-only
commit; nothing is committed without explicit approval.
