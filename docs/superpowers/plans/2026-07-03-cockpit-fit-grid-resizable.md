# Cockpit Fit-to-Viewport Resizable Card Grid — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Cockpit's live-agent grid size rich cards to fill the viewport (so ≤6 agents always fit one screen, >6 scrolls) and replace the two fiddly resize controls with a single drag-a-divider gesture where the other cards reflow to keep the screen full and gap-free.

**Architecture:** All layout math lives in pure functions in `agentsviewmodel.ts` (unit-tested, no render harness — the repo has no jsdom for the cockpit). `cockpitsurface.tsx` renders a flat `Reorder.Group` (drag-to-reorder preserved) as a CSS grid whose `gridTemplateRows` come from a measured viewport height, and overlays draggable row-dividers that write proportional height weights into the existing `cardPrefsAtom`. `agentrow.tsx` loses its self-imposed height, its widen button, and its bottom resize handle.

**Tech Stack:** React 19, jotai, motion/react (`Reorder`), Tailwind v4, vitest. Visual checks over Chrome DevTools Protocol against the live `cargo tauri dev` app (per `CLAUDE.md`).

---

## Deviations from the spec (flagged for the reviewer)

The spec (`docs/superpowers/specs/2026-07-03-cockpit-fit-grid-resizable-design.md`) listed `splitWeight`
(a per-row left/right column ratio). This plan **drops column-split** and keeps columns a uniform
50/50 grid, for KISS/YAGNI reasons:

- A uniform 2-track grid preserves the existing flat `Reorder.Group` (drag-to-reorder) and renders
  full-width via `grid-column: 1 / -1` exactly as the current `wide` flag already does. A per-row
  split would force a many-track base grid + per-row vertical dividers for marginal benefit in a
  2-column cockpit.
- Horizontal size control is still available: a card can go **full-width** (spans both columns), and
  **row heights are draggable**. That covers "make this card bigger" without per-row column math.

So `CardPref` becomes `{ fullWidth?: boolean; heightWeight?: number }` (spec had a third
`splitWeight`). The **full-width gesture** is a right-edge drag (spec open-question), implemented last
(Task 7) as an independent task so it can be dropped if it feels wrong under CDP without affecting the
core fit + row-resize.

If the reviewer wants true per-row column split, stop and revise the spec before Task 1.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `frontend/app/view/agents/agentsviewmodel.ts` | Pure layout/data logic (existing home of `groupAgents`, `mergeOrder`, `cardSpanStyle`) | Reshape `CardPref`; add `computeGridLayout`, `rowHeightsPx`, `resizeRowWeights`, `nextFullWidth`, constants; remove `cardSpanStyle` (Task 6) |
| `frontend/app/view/agents/agentfilters.test.ts` | Unit tests for the pure helpers | Add tests for the four new helpers; remove `cardSpanStyle` tests (Task 6) |
| `frontend/app/view/agents/cockpitsurface.tsx` | Cockpit shell + the live-agent grid | Replace the fixed-height CSS grid with a measured fill grid; add row-divider overlay; membership-reset effect; Reset-layout button |
| `frontend/app/view/agents/agentrow.tsx` | One agent card | Fill its grid cell (drop self height + `DEFAULT_CARD_HEIGHT`); `spanFull` prop; remove widen button + bottom resize handle (Task 6); right-edge full-width drag (Task 7) |
| `frontend/app/view/agents/agents.tsx` | `AgentsViewModel` atoms | `cardPrefsAtom` type follows the reshaped `CardPref` (no structural change) |

**Constants** (add to `agentsviewmodel.ts`, near the top with the other module constants):

```ts
export const GRID_PAGE_ROWS = 3; // 2 columns × 3 rows = 6 rich cards fill one screen
export const GRID_MIN_ROW_PX = 96; // a row cannot be dragged smaller than this
export const GRID_ROW_GAP_PX = 14; // matches the grid's Tailwind gap-3.5
export const FULLWIDTH_DRAG_THRESHOLD_PX = 48; // right-edge drag past this toggles full-width
```

---

## Task 1: Pure `computeGridLayout` + `rowHeightsPx` (packing + fill/scroll geometry)

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (add near `cardSpanStyle`, ~line 643; add the `CardPref` fields at the interface, ~line 54; add constants near the top)
- Test: `frontend/app/view/agents/agentfilters.test.ts`

- [ ] **Step 1: Add the new `CardPref` fields (keep the old ones for now)**

In `agentsviewmodel.ts`, change the interface at line 54 to add the two new optional fields alongside
the existing `wide`/`height` (both are removed later in Task 6 — keeping them now keeps `cardSpanStyle`
and `agentrow.tsx` compiling):

```ts
export interface CardPref {
    wide?: boolean;
    height?: number;
    fullWidth?: boolean; // card spans both columns
    heightWeight?: number; // relative row height; default 1 (even). Set by dragging a row divider.
}
```

- [ ] **Step 2: Add the constants**

Near the top of `agentsviewmodel.ts` (with other top-level `const`s), add the four constants from the
**File structure → Constants** block above.

- [ ] **Step 3: Write the failing tests**

Add to `agentfilters.test.ts`. First extend the import (line 5-13) to include the new symbols:

```ts
import {
    cardSpanStyle,
    computeGridLayout,
    filterAgents,
    matchesProjectFilter,
    projectOf,
    projectsFromAgents,
    rowHeightsPx,
    topFiveHourPct,
    type AgentVM,
} from "./agentsviewmodel";
```

Then append these `describe` blocks (the file already defines `mk(id, state, extra?)` at line 18):

```ts
describe("computeGridLayout", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => mk(`a${i}`, "working"));

    it("packs an even count into rows of two", () => {
        const rows = computeGridLayout(ids(4), {});
        expect(rows.map((r) => r.cells.map((c) => c.id))).toEqual([
            ["a0", "a1"],
            ["a2", "a3"],
        ]);
    });

    it("leaves the odd trailing card alone in its own row", () => {
        const rows = computeGridLayout(ids(5), {});
        expect(rows.map((r) => r.cells.length)).toEqual([2, 2, 1]);
        expect(rows[2].cells[0].id).toBe("a4");
    });

    it("gives a full-width card its own row and does not pair across it", () => {
        const rows = computeGridLayout(ids(4), { a2: { fullWidth: true } });
        expect(rows.map((r) => r.cells.map((c) => c.id))).toEqual([["a0", "a1"], ["a2"], ["a3"]]);
    });

    it("uses the row's first card for the row height weight (default 1)", () => {
        const rows = computeGridLayout(ids(2), { a0: { heightWeight: 2.5 } });
        expect(rows[0].heightWeight).toBe(2.5);
        expect(rows[0].key).toBe("a0");
        expect(computeGridLayout(ids(2), {})[0].heightWeight).toBe(1);
    });

    it("returns no rows for an empty list", () => {
        expect(computeGridLayout([], {})).toEqual([]);
    });
});

describe("rowHeightsPx", () => {
    it("divides the viewport by weight when rows fit the page", () => {
        expect(rowHeightsPx([1, 1, 1], 300)).toEqual([100, 100, 100]);
        expect(rowHeightsPx([2, 1], 300)).toEqual([200, 100]);
    });

    it("keeps the page row-height and overflows when rows exceed the page", () => {
        // 4 rows, page = 3 -> base 100 each -> total 400 > 300 (scrolls)
        expect(rowHeightsPx([1, 1, 1, 1], 300)).toEqual([100, 100, 100, 100]);
    });

    it("is empty for no rows", () => {
        expect(rowHeightsPx([], 300)).toEqual([]);
    });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/agentfilters.test.ts`
Expected: FAIL — `computeGridLayout` / `rowHeightsPx` are not exported.

- [ ] **Step 5: Implement the two functions**

Add to `agentsviewmodel.ts` just above `cardSpanStyle` (~line 643):

```ts
export interface GridCell {
    id: string;
}
export interface GridRow {
    key: string; // the row's first cell id — the source of the row's height weight
    heightWeight: number; // > 0
    cells: GridCell[]; // 1 or 2 cells; a 1-cell row renders full-width
}

function rowWeight(prefs: Record<string, CardPref>, id: string): number {
    const w = prefs[id]?.heightWeight;
    return typeof w === "number" && w > 0 ? w : 1;
}

/** Pure: pack ordered live agents into rows of two. A `fullWidth` card takes its own row; a lone
 *  trailing card (odd count, or the card before a full-width one) also gets a 1-cell row and renders
 *  full-width, so the grid never has a gap. */
export function computeGridLayout(ordered: AgentVM[], prefs: Record<string, CardPref>): GridRow[] {
    const rows: GridRow[] = [];
    let i = 0;
    while (i < ordered.length) {
        const a = ordered[i];
        const aFull = prefs[a.id]?.fullWidth === true;
        const b = ordered[i + 1];
        const bFull = b != null && prefs[b.id]?.fullWidth === true;
        if (!aFull && b != null && !bFull) {
            rows.push({ key: a.id, heightWeight: rowWeight(prefs, a.id), cells: [{ id: a.id }, { id: b.id }] });
            i += 2;
        } else {
            rows.push({ key: a.id, heightWeight: rowWeight(prefs, a.id), cells: [{ id: a.id }] });
            i += 1;
        }
    }
    return rows;
}

/** Pure: pixel height per row. When rows fit the page they divide `viewportPx` by weight (fills
 *  exactly). Beyond the page, each row keeps the page row-height (`viewportPx / pageRows`) scaled by
 *  its weight, so the total overflows and the container scrolls. `viewportPx` should already exclude
 *  inter-row gaps. */
export function rowHeightsPx(weights: number[], viewportPx: number, pageRows = GRID_PAGE_ROWS): number[] {
    if (weights.length === 0) {
        return [];
    }
    if (weights.length <= pageRows) {
        const total = weights.reduce((s, w) => s + w, 0);
        return weights.map((w) => (viewportPx * w) / total);
    }
    const base = viewportPx / pageRows;
    return weights.map((w) => base * w);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/agentfilters.test.ts`
Expected: PASS (all `computeGridLayout` + `rowHeightsPx` cases green; existing tests still pass).

- [ ] **Step 7: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (baseline is clean).

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentfilters.test.ts
git commit -m "feat(cockpit): pure grid packing + fill/scroll row geometry"
```

---

## Task 2: Pure `resizeRowWeights` + `nextFullWidth` (drag math)

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Test: `frontend/app/view/agents/agentfilters.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend the import in `agentfilters.test.ts` to add `nextFullWidth, resizeRowWeights`, then append:

```ts
describe("resizeRowWeights", () => {
    it("moves height across the dragged boundary, preserving the pair total", () => {
        // [1,1,1] @ vp 300 -> px [100,100,100]; drag boundary 0 by +30
        expect(resizeRowWeights([1, 1, 1], 0, 30, 300)).toEqual([130, 70, 100]);
    });

    it("clamps so neither neighbour drops below the minimum", () => {
        // pair = 200; min 96 -> above clamps to 104, below to 96
        expect(resizeRowWeights([1, 1, 1], 0, 1000, 300, 96)).toEqual([104, 96, 100]);
    });

    it("returns the weights unchanged for an out-of-range boundary", () => {
        expect(resizeRowWeights([1, 1], 1, 30, 300)).toEqual([1, 1]);
        expect(resizeRowWeights([1, 1], -1, 30, 300)).toEqual([1, 1]);
    });
});

describe("nextFullWidth", () => {
    it("turns on past the positive threshold and off past the negative", () => {
        expect(nextFullWidth(false, 60, 48)).toBe(true);
        expect(nextFullWidth(true, -60, 48)).toBe(false);
    });
    it("holds within the deadzone", () => {
        expect(nextFullWidth(false, 10, 48)).toBe(false);
        expect(nextFullWidth(true, 10, 48)).toBe(true);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run frontend/app/view/agents/agentfilters.test.ts`
Expected: FAIL — `resizeRowWeights` / `nextFullWidth` not exported.

- [ ] **Step 3: Implement**

Add to `agentsviewmodel.ts` below `rowHeightsPx`:

```ts
/** Pure: drag the boundary between row `i` and row `i+1` by `deltaPx`. Recomputes every row's height
 *  in pixels (so the returned weights share one scale) and shifts height across the dragged boundary
 *  only, clamping each neighbour to `minPx`. The result is a new pixel-scale weight array; the render
 *  path re-normalises it through `rowHeightsPx`, so absolute scale never matters. */
export function resizeRowWeights(
    weights: number[],
    i: number,
    deltaPx: number,
    viewportPx: number,
    minPx = GRID_MIN_ROW_PX,
    pageRows = GRID_PAGE_ROWS
): number[] {
    const px = rowHeightsPx(weights, viewportPx, pageRows);
    if (i < 0 || i + 1 >= px.length) {
        return weights;
    }
    const pair = px[i] + px[i + 1];
    const above = Math.max(minPx, Math.min(pair - minPx, px[i] + deltaPx));
    const next = px.slice();
    next[i] = above;
    next[i + 1] = pair - above;
    return next;
}

/** Pure: right-edge drag hysteresis for the full-width toggle. */
export function nextFullWidth(current: boolean, dragDeltaPx: number, threshold = FULLWIDTH_DRAG_THRESHOLD_PX): boolean {
    if (dragDeltaPx > threshold) {
        return true;
    }
    if (dragDeltaPx < -threshold) {
        return false;
    }
    return current;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run frontend/app/view/agents/agentfilters.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentfilters.test.ts
git commit -m "feat(cockpit): pure row-resize + full-width drag math"
```

---

## Task 3: Card fills its grid cell (drop self height; add `spanFull`)

Makes each card size to its cell instead of a fixed 280px. No behaviour of the grid container yet —
that's Task 4. After this task the cards look wrong (all stacked at natural height) until Task 4 sets
the row template; that's expected and why Tasks 3–4 land back-to-back.

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx:26-27, 111-159, 225-246`

- [ ] **Step 1: Add the `spanFull` prop to the type and destructure**

In `agentrow.tsx`, add `spanFull` to the props type (after `height?: number;`, ~line 156) and to the
destructured params (after `height,`, ~line 132):

```ts
    // in the destructure list:
    height,
    spanFull,
    onToggleWide,
    // in the props type:
    height?: number;
    spanFull?: boolean;
    onToggleWide: () => void;
```

- [ ] **Step 2: Fill the cell — replace the `Reorder.Item` sizing**

Replace the `Reorder.Item` `style` and `layout` (currently line 234-235):

```tsx
            layout
            ref={cardRef}
            style={{ ...cardSpanStyle({ wide }), height: `${height ?? DEFAULT_CARD_HEIGHT}px` }}
```

with (drop the self height so the card stretches to its grid row; span both columns when `spanFull`;
`layout="position"` animates reorder position but not the height changes that streaming transcripts
cause, avoiding jank):

```tsx
            layout="position"
            ref={cardRef}
            style={{ gridColumn: spanFull ? "1 / -1" : undefined, minHeight: 0 }}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (`cardSpanStyle` and `DEFAULT_CARD_HEIGHT` are now unused in the style but still
imported/defined — that is fine; both are removed in Task 6. `wide`/`height`/`onResize` props are
still declared and passed; removed in Task 6.)

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/agentrow.tsx
git commit -m "refactor(cockpit): card fills its grid cell instead of a fixed height"
```

---

## Task 4: Fill-the-viewport grid render (measured rows) + reorder preserved

**Files:**
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (imports ~line 11-32; the grid block ~line 616-662; add a ref + effect near the other refs ~line 320-323)

- [ ] **Step 1: Import the new helpers**

In the `agentsviewmodel` import (line 11-32) add `computeGridLayout`, `rowHeightsPx`, and the gap
constant:

```ts
    applyAgentOrder,
    computeGridLayout,
    rowHeightsPx,
    GRID_ROW_GAP_PX,
    streamableTranscriptAgents,
```

- [ ] **Step 2: Add a scroll-container ref + measured height state**

Near the other refs (~line 320-323, by `containerRef`), add:

```tsx
    const gridScrollRef = useRef<HTMLDivElement>(null);
    const [gridViewportPx, setGridViewportPx] = useState(0);
    useEffect(() => {
        const el = gridScrollRef.current;
        if (!el) {
            return;
        }
        const ro = new ResizeObserver(() => setGridViewportPx(el.clientHeight));
        ro.observe(el);
        setGridViewportPx(el.clientHeight);
        return () => ro.disconnect();
    }, []);
```

- [ ] **Step 3: Compute rows + heights before the return**

Just after `shownAgents` is derived (~line 330), add:

```tsx
    const gridRows = computeGridLayout(shownAgents, cardPrefs);
    const rowGaps = GRID_ROW_GAP_PX * Math.max(0, gridRows.length - 1);
    const availablePx = Math.max(0, gridViewportPx - rowGaps);
    const gridRowHeights = rowHeightsPx(
        gridRows.map((r) => r.heightWeight),
        availablePx
    );
    const gridContentPx = gridRowHeights.reduce((s, h) => s + h, 0) + rowGaps;
```

- [ ] **Step 4: Replace the grid block**

Replace the whole `<Reorder.Group …>…</Reorder.Group>` (line 616-662) with a scroll container → a
relative content wrapper sized to `gridContentPx` (so it fills at ≤6 and scrolls at >6) → the flat
`Reorder.Group` grid with an explicit `gridTemplateRows`:

```tsx
                    <div
                        ref={gridScrollRef}
                        className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-2.5"
                    >
                        <div className="relative w-full" style={{ height: gridContentPx || "100%" }}>
                            <Reorder.Group
                                as="div"
                                axis="y"
                                values={orderedIds}
                                onReorder={setOrder}
                                className="grid h-full grid-cols-2 gap-3.5"
                                style={{
                                    // fall back to even 1fr rows until the ResizeObserver has a height
                                    // (avoids a one-frame collapse to 0px on first paint)
                                    gridTemplateRows: gridRowHeights.map((h) => (h > 0 ? `${h}px` : "1fr")).join(" "),
                                }}
                            >
                                {shownAgents.map((a) => (
                                    <AgentRow
                                        key={a.id}
                                        agent={a}
                                        now={now}
                                        isCursor={cursorId === a.id}
                                        pulse={pulseId === a.id}
                                        spanFull={cardPrefs[a.id]?.fullWidth}
                                        selections={answerSel[a.id] ?? {}}
                                        sent={sentIds.has(a.id)}
                                        activeQuestion={answerTab[a.id] ?? 0}
                                        composerOpen={openComposerId === a.id}
                                        onCursor={() => setCursorId(a.id)}
                                        onOpen={() => openFocus(a.id, false)}
                                        onOpenTerminal={() => model.openTerminal(a.id)}
                                        onOpenDiff={() => openDiff(a.id)}
                                        onOpenComposer={() => setOpenComposerId(a.id)}
                                        onToggleAnswer={(qi, oi) => toggleAnswer(a.id, qi, oi)}
                                        onSubmitAnswer={() => submitAnswer(a.id)}
                                        onSelectQuestion={(qi) => selectQuestion(a.id, qi)}
                                        onComposerEscape={() => {
                                            setOpenComposerId(undefined);
                                            containerRef.current?.focus();
                                        }}
                                        onBackground={
                                            a.state === "working" || a.state === "asking"
                                                ? () => toggleBackground(a.id)
                                                : undefined
                                        }
                                        onDismiss={
                                            a.state === "idle"
                                                ? () => setDismissed((prev) => new Set(prev).add(dismissKey(a)))
                                                : undefined
                                        }
                                    />
                                ))}
                            </Reorder.Group>
                        </div>
                    </div>
```

Note the removed props: `wide`, `height`, `onToggleWide`, `onResize` are no longer passed (the widen
button + resize handle that consumed them are removed in Task 6; `AgentRow` still declares them as
optional until then, so this compiles).

- [ ] **Step 5: Remove the now-orphaned `toggleWide` / `setCardHeight` helpers**

Because Step 4 stopped passing `onToggleWide`/`onResize`, the helpers at line 288-289 have no callers.
Delete both (leaving them would break the typecheck if `noUnusedLocals` is on):

```tsx
    const toggleWide = (id: string) => setCardPrefs((p) => ({ ...p, [id]: { ...p[id], wide: !p[id]?.wide } }));
    const setCardHeight = (id: string, h: number) => setCardPrefs((p) => ({ ...p, [id]: { ...p[id], height: h } }));
```

(`resizeGridRow`, added in Task 5, is the only writer of `cardPrefs` heights going forward.)

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 7: Unit tests still green**

Run: `npx vitest run`
Expected: PASS (no test touches the render; this confirms nothing else broke).

- [ ] **Step 8: Visual check (CDP) — fills at ≤6, scrolls at >6**

Ensure `cargo tauri dev` is running (see `CLAUDE.md` → Visual verification; if headless, start it as
`tail -f /dev/null | task dev` so wavesrv doesn't get EOF). Then:

```bash
node scripts/gen-cockpit-fixtures.mjs mixed     # a handful of live agents
# reload the dev app (Ctrl+R in the window, or re-inject)
node scripts/cdp-shot.mjs fitgrid-mixed.png
node scripts/gen-cockpit-fixtures.mjs heavy      # 12 agents -> >6 live
node scripts/cdp-shot.mjs fitgrid-heavy.png
node scripts/gen-cockpit-fixtures.mjs --clear
```

Expected in `fitgrid-mixed.png`: the live cards divide the vertical space and **fill it with no
scrollbar**; two columns. Expected in `fitgrid-heavy.png`: cards keep a page-sized row height and the
grid **scrolls** (a scrollbar appears; rows past the third are below the fold). Use the header
filter chips (All/Working/Asking) to narrow `heavy` down to 4 and 6 live and confirm those fill
exactly with no scroll and no empty trailing cell.

- [ ] **Step 9: Commit**

```bash
git add frontend/app/view/agents/cockpitsurface.tsx
git commit -m "feat(cockpit): fill-the-viewport live-agent grid (scrolls past 6)"
```

---

## Task 5: Draggable row dividers (resize, others reflow)

**Files:**
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (import `resizeRowWeights`; add a `RowDividers` local component; render it in the content wrapper from Task 4)

- [ ] **Step 1: Import the resize helper**

Add `resizeRowWeights` to the `agentsviewmodel` import.

- [ ] **Step 2: Add the `RowDividers` overlay component**

Add this local component near the top of `cockpitsurface.tsx` (e.g. after `HelpOverlay`, ~line 168).
It draws a draggable handle centred in each inter-row gap; dragging calls back with the boundary index
and a pixel delta:

```tsx
// One draggable handle per interior row boundary, positioned in the gap between rows. Sits in an
// absolute overlay above the grid; only the handles capture pointer events. `heights` are the row
// pixel heights (Task 4); the handle at boundary i lives between row i and row i+1.
function RowDividers({
    heights,
    gap,
    onResize,
}: {
    heights: number[];
    gap: number;
    onResize: (boundary: number, deltaPx: number) => void;
}) {
    if (heights.length < 2) {
        return null;
    }
    const tops: number[] = [];
    let acc = 0;
    for (let i = 0; i < heights.length - 1; i++) {
        acc += heights[i];
        tops.push(acc + gap * i + gap / 2); // centre of the gap after row i
    }
    return (
        <div className="pointer-events-none absolute inset-0 z-10">
            {tops.map((top, i) => (
                <div
                    key={i}
                    onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const startY = e.clientY;
                        const move = (ev: PointerEvent) => onResize(i, ev.clientY - startY);
                        const up = () => {
                            window.removeEventListener("pointermove", move);
                            window.removeEventListener("pointerup", up);
                        };
                        window.addEventListener("pointermove", move);
                        window.addEventListener("pointerup", up);
                    }}
                    title="Drag to resize rows"
                    className="group pointer-events-auto absolute inset-x-3 flex h-[11px] -translate-y-1/2 cursor-ns-resize items-center justify-center"
                    style={{ top }}
                >
                    <div className="h-[3px] w-[46px] rounded-[3px] bg-edge-strong opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
            ))}
        </div>
    );
}
```

- [ ] **Step 3: Add the resize handler + render the overlay**

In `CockpitSurface`, add a handler that turns a boundary drag into `cardPrefsAtom` writes. Add near
the other handlers (e.g. after `setCardHeight`, ~line 289):

```tsx
    const resizeGridRow = (boundary: number, deltaPx: number) => {
        const weights = gridRows.map((r) => r.heightWeight);
        const next = resizeRowWeights(weights, boundary, deltaPx, availablePx);
        setCardPrefs((p) => {
            const out = { ...p };
            gridRows.forEach((r, idx) => {
                out[r.key] = { ...out[r.key], heightWeight: next[idx] };
            });
            return out;
        });
    };
```

Then render `<RowDividers>` inside the relative content wrapper from Task 4, as a sibling **after** the
`Reorder.Group`:

```tsx
                            </Reorder.Group>
                            <RowDividers heights={gridRowHeights} gap={GRID_ROW_GAP_PX} onResize={resizeGridRow} />
                        </div>
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Visual check (CDP) — drag reflows, screen stays full**

```bash
node scripts/gen-cockpit-fixtures.mjs mixed
# reload; hover a boundary between two rows -> a grab bar fades in
node scripts/cdp-shot.mjs fitgrid-resize-before.png
```

Then drive a drag over CDP (the same `Input.dispatchMouseEvent` pattern `scripts/cdp-shot.mjs` uses to
attach): press at the divider's centre, move down ~60px, release. Screenshot after:

```bash
node scripts/cdp-shot.mjs fitgrid-resize-after.png
node scripts/gen-cockpit-fixtures.mjs --clear
```

Expected: the row above grows, the row below shrinks by the same amount, **no scrollbar appears** (the
screen stays full), and neither row collapses past the ~96px minimum when you drag hard.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/cockpitsurface.tsx
git commit -m "feat(cockpit): drag row dividers to resize, siblings reflow to fill"
```

---

## Task 6: Remove the widen button, the bottom resize handle, `cardSpanStyle`, and dead `CardPref` fields

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx` (remove `DEFAULT_CARD_HEIGHT` ~line 27; `onResizeStart` ~line 168-180; the widen `<button>` ~line 291-301; the resize strip ~line 462-469; the now-unused props + `cardSpanStyle` import)
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (remove `cardSpanStyle` ~line 643-653; drop `wide`/`height` from `CardPref`)
- Modify: `frontend/app/view/agents/agentfilters.test.ts` (remove the `cardSpanStyle` describe block + import)

- [ ] **Step 1: Remove the `cardSpanStyle` tests**

Delete the `describe("cardSpanStyle", …)` block (`agentfilters.test.ts:116-130`) and remove
`cardSpanStyle` from the import (line 6).

- [ ] **Step 2: Remove `cardSpanStyle` and shrink `CardPref`**

In `agentsviewmodel.ts` delete the `cardSpanStyle` function (line 643-653 in the original; now just
above `computeGridLayout`'s new block). Change `CardPref` to drop the legacy fields:

```ts
export interface CardPref {
    fullWidth?: boolean; // card spans both columns
    heightWeight?: number; // relative row height; default 1 (even). Set by dragging a row divider.
}
```

- [ ] **Step 3: Strip the card's resize UI + dead props**

In `agentrow.tsx`:
- Remove the `cardSpanStyle` import (line 10) and `DEFAULT_CARD_HEIGHT` (line 26-27).
- Remove the `onResizeStart` handler (line 168-180).
- Remove the widen `<button>` (the `⤢/⤡` control, line 291-301).
- Remove the bottom resize strip `<div onPointerDown={onResizeStart} …>` (line 462-469).
- Remove `wide`, `height`, `onToggleWide`, `onResize` from the props type and the destructure.
  `spanFull` (added in Task 3) stays.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (`toggleWide`/`setCardHeight` were already removed in Task 4. If tsc flags an unused
import/var, delete it — the baseline is clean, so any error is from this task.)

- [ ] **Step 5: Unit tests green**

Run: `npx vitest run`
Expected: PASS (the `cardSpanStyle` block is gone; the four new helper blocks stay green).

- [ ] **Step 6: Visual check (CDP) — the two controls are gone, card unchanged otherwise**

```bash
node scripts/gen-cockpit-fixtures.mjs mixed
node scripts/cdp-shot.mjs fitgrid-nobuttons.png
node scripts/gen-cockpit-fixtures.mjs --clear
```

Expected: no `⤢` widen button and no bottom drag-bar on cards; the header (drag handle, status dot,
runtime glyph, name, project, diff, needs-you, terminal, mute) and the body (feed, asking band,
answer bar, composer) are otherwise identical.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/agentrow.tsx frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/cockpitsurface.tsx frontend/app/view/agents/agentfilters.test.ts
git commit -m "refactor(cockpit): drop widen button, resize handle, and cardSpanStyle"
```

---

## Task 7: Full-width by right-edge drag + membership reset + Reset-layout

Three small, independent finishers. Full-width is the spec's replacement for the removed widen button;
the reset effect keeps height weights sane as the fleet changes; the button gives an explicit escape
hatch.

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx` (add a right-edge drag strip)
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (add `onToggleFullWidth` prop wiring; membership-reset effect; Reset-layout button in the header)

- [ ] **Step 1: Add the full-width drag strip to the card**

In `agentrow.tsx`, add an `onToggleFullWidth?: () => void` prop (type + destructure), import
`nextFullWidth` from `agentsviewmodel`, and add a right-edge drag strip just before the closing
`</Reorder.Item>` (where the bottom resize strip used to be):

```tsx
            {/* right edge: drag outward to make the card full-width, back to restore */}
            {onToggleFullWidth ? (
                <div
                    onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const startX = e.clientX;
                        const wasFull = !!spanFull;
                        const move = (ev: PointerEvent) => {
                            if (nextFullWidth(wasFull, ev.clientX - startX) !== wasFull) {
                                onToggleFullWidth();
                            }
                        };
                        const up = () => {
                            window.removeEventListener("pointermove", move);
                            window.removeEventListener("pointerup", up);
                        };
                        window.addEventListener("pointermove", move);
                        window.addEventListener("pointerup", up);
                    }}
                    title={spanFull ? "Drag in to un-widen" : "Drag out to widen"}
                    className="group absolute inset-y-0 right-0 flex w-[9px] cursor-ew-resize items-center justify-center"
                >
                    <div className="h-[34px] w-[3px] rounded-[3px] bg-edge-strong opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
            ) : null}
```

(`nextFullWidth` fires the toggle once when the drag crosses the threshold; releasing without crossing
leaves it unchanged.)

- [ ] **Step 2: Wire the toggle from the surface**

In the `<AgentRow>` render (Task 4 block) add:

```tsx
                                        spanFull={cardPrefs[a.id]?.fullWidth}
                                        onToggleFullWidth={() =>
                                            setCardPrefs((p) => ({
                                                ...p,
                                                [a.id]: { ...p[a.id], fullWidth: !p[a.id]?.fullWidth },
                                            }))
                                        }
```

- [ ] **Step 3: Reset height weights when the live set changes**

Add an effect in `CockpitSurface` (near the order effect ~line 274) so a fleet change returns rows to
even (avoids stale weights in a different scale); `fullWidth` is intentionally preserved:

```tsx
    // when the visible membership changes, drop height overrides so rows re-fit evenly (fullWidth kept)
    const shownKey = shownAgents.map((a) => a.id).join(",");
    useEffect(() => {
        setCardPrefs((p) => {
            let changed = false;
            const out: typeof p = {};
            for (const [id, pref] of Object.entries(p)) {
                if (pref.heightWeight != null) {
                    changed = true;
                    const { heightWeight, ...rest } = pref;
                    out[id] = rest;
                } else {
                    out[id] = pref;
                }
            }
            return changed ? out : p;
        });
    }, [shownKey]);
```

- [ ] **Step 4: Add a Reset-layout button**

In the header control cluster (next to the "Live only" button, ~line 538-550), add — shown only when
some override exists:

```tsx
                            {Object.values(cardPrefs).some((p) => p.fullWidth || p.heightWeight != null) ? (
                                <button
                                    type="button"
                                    onClick={() => globalStore.set(model.cardPrefsAtom, {})}
                                    className="cursor-pointer rounded-[8px] border border-edge-mid px-2.5 py-1.5 text-[12px] text-muted hover:border-edge-strong"
                                >
                                    Reset layout
                                </button>
                            ) : null}
```

- [ ] **Step 5: Typecheck + unit tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.
Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Visual check (CDP)**

```bash
node scripts/gen-cockpit-fixtures.mjs mixed
# hover a card's right edge -> a vertical grab bar fades in; drag right past ~48px
node scripts/cdp-shot.mjs fitgrid-fullwidth.png
```

Expected: the dragged card spans both columns; its former row-mate reflows to the next row; a
**Reset layout** button appears in the header; clicking it (or driving it over CDP) returns every card
to the even 2-up grid. Then confirm a fleet change resets heights: with a resized layout showing,
inject a different scenario and reload — rows should be even again while any full-width card stays
full-width.

```bash
node scripts/gen-cockpit-fixtures.mjs --clear
```

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/agentrow.tsx frontend/app/view/agents/cockpitsurface.tsx
git commit -m "feat(cockpit): full-width drag, layout reset, and even re-fit on fleet change"
```

---

## Final verification

- [ ] **Full unit suite:** `npx vitest run` → PASS.
- [ ] **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
- [ ] **CDP sweep** (dev app running): `mixed` fills with no scroll; filter to 4 and 6 live → fills, no
  gap; `heavy` (>6 live) scrolls at page row-height; drag a row divider → reflow, no scroll, min
  clamp; drag a right edge → full-width + row-mate reflow; Reset layout → even grid; fleet change →
  heights reset, full-width kept. Clear the fixture: `node scripts/gen-cockpit-fixtures.mjs --clear`.
- [ ] **Self-review the diff:** no leftover `cardSpanStyle`, `DEFAULT_CARD_HEIGHT`, `wide`, `height`,
  `onToggleWide`, `onResize`, `toggleWide`, or `setCardHeight` references
  (`git grep -nE "cardSpanStyle|DEFAULT_CARD_HEIGHT|onToggleWide"` returns nothing under
  `frontend/app/view/agents/`).

## Commit note

Per repo convention (`CLAUDE.md`) this plan + its spec fold into the feature commits above; there is no
separate docs-only commit, and nothing is committed without explicit approval. The per-task commit
messages above are the intended history; batch or squash per the maintainer's preference at review.
```
