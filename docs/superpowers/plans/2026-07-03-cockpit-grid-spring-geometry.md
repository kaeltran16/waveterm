# Cockpit Grid — Single-Tree Spring-Driven Geometry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cockpit card grid's two-column masonry + three `AnimatePresence` trees with one presence tree of absolute-positioned cards whose `x/y/width/height` are spring-driven, so full-width toggles animate width without distortion and re-positioning slides without crossfade ghosting.

**Architecture:** A pure `computeGridLayout` function turns the ordered card list + prefs + container size into per-card pixel rects (reusing `distributeColumns`/`rowHeightsPx`). The cockpit renders every card as an absolute sibling in one `AnimatePresence`; each card's four geometry dimensions are `MotionValue`s (held by the parent, persisted across renders) wrapped in `useSpring` inside `AgentRow`. Motion's `layout`/`layoutId` are dropped entirely — geometry eases on real dimensions, so nothing scales.

**Tech Stack:** React 19, jotai, Motion (`motion/react`, v12), Tailwind 4, Vitest.

## Global Constraints

- **Typecheck command:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (plain `npx tsc` stack-overflows on this repo). Baseline is clean (exit 0).
- **Never hand-edit generated files.** No wire-protocol/type changes here, so `task generate` is not needed.
- **Import motion values from `motiontokens.ts`.** Reuse `resizeSpring`; do not inline spring configs.
- **Reduced motion is mandatory.** Honor `reducedMotion="user"` — geometry springs must jump (not ease) under `useReducedMotion()`.
- **Motion perf rule:** animate transform/opacity/size via `MotionValue`/`style`, never per-frame React re-render for the corner drag (DOM-only writes).
- **Visual verification is via CDP** against the live dev app (`node scripts/cdp-shot.mjs`, `scripts/gen-cockpit-fixtures.mjs heavy`) — there is no jsdom render harness. Only `computeGridLayout` is unit-testable.
- **Preserve exactly:** independent per-column card heights (masonry), full-width cards spanning both columns stacked on top, and corner-drag resize semantics (vertical = height weight; horizontal past ±`FULLWIDTH_DRAG_THRESHOLD_PX` = toggle full-width via `nextFullWidth` hysteresis).

---

## File Structure

- `frontend/app/view/agents/agentsviewmodel.ts` — **Modify.** Add `CardRect`, `GridLayout` types and the pure `computeGridLayout` function. Lifts the full-width/column math currently inline in `cockpitsurface.tsx`. (Existing `distributeColumns`, `rowHeightsPx`, constants stay.)
- `frontend/app/view/agents/agentsviewmodel.test.ts` — **Modify.** Add `computeGridLayout` unit tests.
- `frontend/app/view/agents/agentrow.tsx` — **Modify.** Card `motion.div` → `position: absolute` with four geometry springs; drop `layout`/`layoutId`; add reduced-motion jump. New prop shape (4 `MotionValue`s + `rect`).
- `frontend/app/view/agents/cockpitsurface.tsx` — **Modify.** Measure container width; hold the per-id geometry `MotionValue` map; call `computeGridLayout`; retarget MVs each render; render one absolute `AnimatePresence`; adapt the resize handlers; drop `LayoutGroup`, `renderColumn`, the `fullWidthCards`/`columnCards` render split, and `mode="popLayout"`.

---

## Task 1: Pure `computeGridLayout` + types + tests

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (add near `distributeColumns`, ~line 655)
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

**Interfaces:**
- Consumes: `distributeColumns`, `rowHeightsPx`, `GRID_ROW_GAP_PX`, `GRID_PAGE_ROWS`, `GRID_MIN_ROW_PX`, `FULLWIDTH_MAX_VIEWPORT_FRAC`, `CardPref`, `AgentVM` (all already exported from `agentsviewmodel.ts`).
- Produces:
  ```ts
  export interface CardRect { x: number; y: number; w: number; h: number }
  export interface GridLayout {
      rects: Map<string, CardRect>;
      totalHeight: number;
      columnsAvail: number;         // px available to the two columns (below the FW stack)
      colA: AgentVM[];
      colB: AgentVM[];
      fullWidth: AgentVM[];
  }
  export function computeGridLayout(
      cards: AgentVM[],
      cardPrefs: Record<string, CardPref>,
      containerW: number,
      containerH: number,
  ): GridLayout
  ```

- [ ] **Step 1: Write the failing tests**

Add to `frontend/app/view/agents/agentsviewmodel.test.ts`. If the file already imports from `./agentsviewmodel`, extend that import with `computeGridLayout` and the types rather than adding a second import line.

```ts
import { describe, expect, it } from "vitest";
import {
    computeGridLayout,
    GRID_MIN_ROW_PX,
    GRID_ROW_GAP_PX,
    type AgentVM,
    type CardPref,
} from "./agentsviewmodel";

// minimal AgentVM stand-ins — computeGridLayout only reads `id`
const card = (id: string): AgentVM => ({ id }) as AgentVM;

describe("computeGridLayout", () => {
    const W = 1000;
    const H = 600;

    it("splits non-full-width cards across two equal columns, colB offset by half+gap", () => {
        const cards = [card("a"), card("b"), card("c"), card("d")];
        const { rects, colA, colB, fullWidth } = computeGridLayout(cards, {}, W, H);
        expect(fullWidth).toHaveLength(0);
        expect(colA.map((c) => c.id)).toEqual(["a", "c"]); // distributeColumns: even indices
        expect(colB.map((c) => c.id)).toEqual(["b", "d"]);
        const colW = (W - GRID_ROW_GAP_PX) / 2;
        expect(rects.get("a")!.x).toBe(0);
        expect(rects.get("a")!.w).toBeCloseTo(colW);
        expect(rects.get("b")!.x).toBeCloseTo(colW + GRID_ROW_GAP_PX);
    });

    it("stacks equal-weight column cards top-to-bottom with a gap between them", () => {
        const cards = [card("a"), card("c")]; // both land in colA
        const { rects } = computeGridLayout(cards, {}, W, H);
        const a = rects.get("a")!;
        const c = rects.get("c")!;
        expect(a.y).toBe(0);
        expect(c.y).toBeCloseTo(a.h + GRID_ROW_GAP_PX);
    });

    it("floats full-width cards to a top stack spanning the full width", () => {
        const cards = [card("fw"), card("a"), card("b")];
        const prefs: Record<string, CardPref> = { fw: { fullWidth: true } };
        const { rects, fullWidth, colA } = computeGridLayout(cards, prefs, W, H);
        expect(fullWidth.map((c) => c.id)).toEqual(["fw"]);
        expect(rects.get("fw")!).toMatchObject({ x: 0, y: 0, w: W });
        expect(colA.map((c) => c.id)).toEqual(["a"]); // "a" is first of the remaining
        // columns start below the FW stack + one gap
        expect(rects.get("a")!.y).toBeCloseTo(rects.get("fw")!.h + GRID_ROW_GAP_PX);
    });

    it("clamps full-width height to [GRID_MIN_ROW_PX, FULLWIDTH_MAX_VIEWPORT_FRAC*H]", () => {
        const cards = [card("tall"), card("short")];
        const prefs: Record<string, CardPref> = {
            tall: { fullWidth: true, heightWeight: 100 }, // way over the cap
            short: { fullWidth: true, heightWeight: 0.0001 }, // under the floor
        };
        const { rects } = computeGridLayout(cards, prefs, W, H);
        expect(rects.get("tall")!.h).toBeCloseTo(0.6 * H); // FULLWIDTH_MAX_VIEWPORT_FRAC
        expect(rects.get("short")!.h).toBe(GRID_MIN_ROW_PX);
    });

    it("totalHeight is the viewport when content fits, and grows when a column overflows", () => {
        const fit = computeGridLayout([card("a"), card("b")], {}, W, H);
        expect(fit.totalHeight).toBe(H);

        // 8 cards in one column (>GRID_PAGE_ROWS) overflow -> totalHeight exceeds H
        const many = Array.from({ length: 8 }, (_, i) => card(`c${i}`));
        const over = computeGridLayout(many, {}, W, H);
        expect(over.totalHeight).toBeGreaterThan(H);
    });

    it("returns empty rects for no cards", () => {
        const { rects, totalHeight } = computeGridLayout([], {}, W, H);
        expect(rects.size).toBe(0);
        expect(totalHeight).toBe(H);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t computeGridLayout`
Expected: FAIL — `computeGridLayout is not a function` (not yet exported).

- [ ] **Step 3: Implement `computeGridLayout`**

Add to `frontend/app/view/agents/agentsviewmodel.ts` immediately after `distributeColumns` (~line 655). It reuses the exact math currently inline in `cockpitsurface.tsx`.

```ts
export interface CardRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface GridLayout {
    rects: Map<string, CardRect>;
    totalHeight: number;
    columnsAvail: number;
    colA: AgentVM[];
    colB: AgentVM[];
    fullWidth: AgentVM[];
}

/** Pure: ordered visible cards + prefs + container size -> absolute pixel rect per card id, plus the
 *  column partition (for the resize handlers) and the total content height (for the scroll canvas).
 *  Full-width cards float to a top stack spanning the width; the rest fill two independent columns
 *  below. Mirrors the render math this replaced in cockpitsurface.tsx. */
export function computeGridLayout(
    cards: AgentVM[],
    cardPrefs: Record<string, CardPref>,
    containerW: number,
    containerH: number
): GridLayout {
    const gap = GRID_ROW_GAP_PX;
    const rects = new Map<string, CardRect>();
    const weightOf = (id: string) => cardPrefs[id]?.heightWeight ?? 1;

    const fullWidth = cards.filter((c) => cardPrefs[c.id]?.fullWidth);
    const columnCards = cards.filter((c) => !cardPrefs[c.id]?.fullWidth);

    // full-width stack
    const pageRowPx = containerH / GRID_PAGE_ROWS;
    const fwMaxPx = FULLWIDTH_MAX_VIEWPORT_FRAC * containerH;
    let fwY = 0;
    for (const c of fullWidth) {
        const h = Math.min(fwMaxPx, Math.max(GRID_MIN_ROW_PX, pageRowPx * weightOf(c.id)));
        rects.set(c.id, { x: 0, y: fwY, w: containerW, h });
        fwY += h + gap;
    }
    const fwStackPx = fullWidth.length > 0 ? fwY - gap : 0; // drop trailing gap

    // two columns below the stack
    const colStartY = fwStackPx + (fullWidth.length > 0 ? gap : 0);
    const columnsAvail = Math.max(0, containerH - fwStackPx - (fullWidth.length > 0 ? gap : 0));
    const { colA, colB } = distributeColumns(columnCards);
    const colW = (containerW - gap) / 2;

    const layoutColumn = (col: AgentVM[], x: number): number => {
        const avail = Math.max(0, columnsAvail - gap * Math.max(0, col.length - 1));
        const heights = rowHeightsPx(
            col.map((c) => weightOf(c.id)),
            avail
        );
        let y = colStartY;
        col.forEach((c, i) => {
            rects.set(c.id, { x, y, w: colW, h: heights[i] });
            y += heights[i] + gap;
        });
        return col.length > 0 ? y - gap : colStartY; // column bottom, no trailing gap
    };
    const bottomA = layoutColumn(colA, 0);
    const bottomB = layoutColumn(colB, colW + gap);

    const totalHeight = Math.max(containerH, bottomA, bottomB);
    return { rects, totalHeight, columnsAvail, colA, colB, fullWidth };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t computeGridLayout`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts
git commit -m "feat(cockpit): pure computeGridLayout for absolute card geometry"
```

---

## Task 2: Render the grid as one absolute spring-driven presence tree

This task rewires `AgentRow` and `CockpitSurface` together — they share the new prop contract, so the build only compiles once both are done. There is no unit test (no render harness); the deliverable is verified by typecheck + a CDP burst on the `heavy` fixture.

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx` (geometry springs + absolute positioning)
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (measure width, MV map, single presence tree, resize handlers)

**Interfaces:**
- Consumes: `computeGridLayout`, `CardRect`, `GridLayout` (Task 1); `resizeSpring` from `motiontokens.ts`; `resizeRowWeights`, `normalizeWeights`, `nextFullWidth`, `GRID_ROW_GAP_PX`, `GRID_MIN_ROW_PX`, `GRID_PAGE_ROWS`, `FULLWIDTH_MAX_VIEWPORT_FRAC`.
- Produces (AgentRow's new geometry props — the exact names CockpitSurface must pass):
  ```ts
  rect: CardRect;                 // current target; seeds the springs + fallback pre-measure
  xMV: MotionValue<number>;
  yMV: MotionValue<number>;
  wMV: MotionValue<number>;
  hMV: MotionValue<number>;
  ```
  (Replaces the old `heightPx` / `heightMV` props. `fullWidth`, `resizing`, and all `onResize*`/`onToggleFullWidth` props stay.)

### AgentRow changes

- [ ] **Step 1: Update AgentRow imports**

In `frontend/app/view/agents/agentrow.tsx`, change the motion import to add `useReducedMotion` (keep `useSpring`, `type MotionValue`; drop nothing else):

```ts
import { motion, useReducedMotion, useSpring, type MotionValue } from "motion/react";
```

Add `CardRect` to the existing `agentsviewmodel` type import (alongside `AgentVM`, `CardTask`):

```ts
import {
    hasAnswerableAsk,
    isNearBottom,
    isQuiet,
    nextFullWidth,
    projectOf,
    taskProgress,
    type AgentVM,
    type CardRect,
    type CardTask,
} from "./agentsviewmodel";
```

- [ ] **Step 2: Replace the geometry props in the AgentRow signature**

Find the destructured params and their type block (`agentrow.tsx` ~line 129–165). Remove `heightPx` and `heightMV`; add `rect`, `xMV`, `yMV`, `wMV`, `hMV`. The full-width, resizing, and callback props are unchanged.

Remove from the destructure:
```ts
    heightPx,
    heightMV,
```
Add in their place:
```ts
    rect,
    xMV,
    yMV,
    wMV,
    hMV,
```

Remove from the type block:
```ts
    heightPx?: number;
    heightMV?: MotionValue<number>; // bound to style.height so the corner drag writes DOM-only (no re-render)
```
Add in their place:
```ts
    rect: CardRect; // current target geometry — seeds the springs and is the pre-measure fallback
    xMV: MotionValue<number>; // parent-held; springs below ease toward these on layout change
    yMV: MotionValue<number>;
    wMV: MotionValue<number>;
    hMV: MotionValue<number>; // the corner drag writes this directly (DOM-only, no re-render)
```

- [ ] **Step 3: Replace the height-spring block with four geometry springs**

Find this block (`agentrow.tsx` ~line 166–179):

```ts
    const composerRef = useRef<AgentComposerHandle>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    // height eases toward the parent-driven target motion value (set instantly by the corner drag). The
    // spring is what the eye follows — smooth during drag, settles on release. jump() past the 0->first
    // -measure ease so cards don't grow in on load; structural re-layouts after that ease naturally.
    const fallbackMV = useMotionValue(heightPx ?? 0);
    const springHeight = useSpring(heightMV ?? fallbackMV, resizeSpring);
    const springSeeded = useRef(false);
    useLayoutEffect(() => {
        if (!springSeeded.current && (heightPx ?? 0) > 0) {
            springHeight.jump((heightMV ?? fallbackMV).get());
            springSeeded.current = true;
        }
    });
```

Replace with (drop the now-unused `useMotionValue` import usage — see Step 3b):

```ts
    const composerRef = useRef<AgentComposerHandle>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    // Geometry eases toward parent-driven target motion values (the corner drag writes hMV directly).
    // Springs run off React (no per-frame re-render). Under reduced motion the raw MV drives style so
    // nothing animates. jump() past the 0->first-measure ease so cards don't fly in from the origin on
    // load; structural re-layouts after that ease naturally.
    const reduce = useReducedMotion();
    const springX = useSpring(xMV, resizeSpring);
    const springY = useSpring(yMV, resizeSpring);
    const springW = useSpring(wMV, resizeSpring);
    const springH = useSpring(hMV, resizeSpring);
    const x = reduce ? xMV : springX;
    const y = reduce ? yMV : springY;
    const w = reduce ? wMV : springW;
    const h = reduce ? hMV : springH;
    const springSeeded = useRef(false);
    useLayoutEffect(() => {
        if (!springSeeded.current && rect.w > 0) {
            springX.jump(xMV.get());
            springY.jump(yMV.get());
            springW.jump(wMV.get());
            springH.jump(hMV.get());
            springSeeded.current = true;
        }
    });
```

- [ ] **Step 3b: Drop the now-unused `useMotionValue` import**

In the `motion/react` import (edited in Step 1), `useMotionValue` is no longer referenced. Ensure the import reads exactly:

```ts
import { motion, useReducedMotion, useSpring, type MotionValue } from "motion/react";
```

(If `useLayoutEffect` was only imported for the old block, keep it — it is still used above.)

- [ ] **Step 4: Rewrite the card `motion.div` opening — absolute + geometry springs, no layout**

Find the `motion.div` opening (`agentrow.tsx` ~line 243–264, the `return (` block). Replace the `layout`/`layoutId`/`style` region with absolute positioning driven by the springs. Remove `layout`, `layoutId`, and the old `height`/`flex` style.

Replace:
```tsx
        <motion.div
            // position-only morph (translate, never scale — scaling a content card clips it behind
            // overflow-hidden and reads as distortion). layoutId lets a card crossing presence trees
            // (column↔column, column↔full-width) slide to its new slot instead of exit/enter-swapping.
            // Size is owned by the height-spring (below) + flex, so it changes without a scale morph.
            layout={resizing ? false : "position"}
            layoutId={agent.id}
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            ref={cardRef}
            style={{
                // heightPx until the spring is seeded (avoids a mount flicker), springHeight thereafter —
                // the spring eases real height so structural resizes are smooth without a scale morph.
                height: heightPx && heightPx > 0 ? (springSeeded.current ? springHeight : heightPx) : undefined,
                flex: heightPx && heightPx > 0 ? undefined : "1 1 0",
                minHeight: 0,
            }}
            data-agent-id={agent.id}
```

With:
```tsx
        <motion.div
            // All cards are absolute siblings in one container; x/y/w/h are spring-driven motion values
            // (real dimensions, never transform:scale), so width/height/position change without any
            // content distortion and a move never remounts (no crossfade). variants animate opacity+scale
            // for genuine mount/unmount only.
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            ref={cardRef}
            style={{ position: "absolute", left: 0, top: 0, x, y, width: w, height: h, minHeight: 0 }}
            data-agent-id={agent.id}
```

Note: `overflow-hidden` and `rounded-[13px]` remain in the `className` (unchanged from current). The corner-grip block at the bottom of the component is unchanged.

- [ ] **Step 5: Typecheck AgentRow in isolation (expected: errors point only at the call site)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: FAIL — errors only in `cockpitsurface.tsx` at the `AgentRow` call site (missing `rect`/`xMV`/…, stale `heightPx`/`heightMV`). No errors inside `agentrow.tsx`. This confirms the AgentRow edit is internally consistent; the next steps fix the call site.

### CockpitSurface changes

- [ ] **Step 6: Update CockpitSurface imports**

In `frontend/app/view/agents/cockpitsurface.tsx`:

Remove `LayoutGroup` from the `motion/react` import (no longer used):
```ts
import { AnimatePresence, MotionConfig, motion, motionValue, type MotionValue } from "motion/react";
```

Add `computeGridLayout`, `CardRect`, `GridLayout` to the `agentsviewmodel` import; the many existing named imports stay. Drop `distributeColumns`, `rowHeightsPx` **only if** they become unreferenced after this task — `distributeColumns` and `rowHeightsPx` are now used inside `computeGridLayout`, so remove them from this file's import list. Keep `resizeRowWeights`, `normalizeWeights`, `GRID_ROW_GAP_PX`, `GRID_MIN_ROW_PX`, `GRID_PAGE_ROWS`, `FULLWIDTH_MAX_VIEWPORT_FRAC` (still used by the resize handlers). Add:
```ts
    computeGridLayout,
    type CardRect,
    type GridLayout,
```

- [ ] **Step 7: Measure container width alongside height**

Find the `gridViewportPx` state + ResizeObserver effect (`cockpitsurface.tsx` ~line 368–384). Add a width state and capture it in the same `measure()`.

Replace:
```tsx
    const [gridViewportPx, setGridViewportPx] = useState(0);
    useEffect(() => {
        const el = gridScrollRef.current;
        if (!el) {
            return;
        }
        // fill against the content box (clientHeight includes pt/pb padding — sizing a column to the
        // full clientHeight overflows by exactly that padding and shows a spurious scrollbar)
        const measure = () => {
            const cs = getComputedStyle(el);
            setGridViewportPx(el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
        };
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        measure();
        return () => ro.disconnect();
    }, []);
```

With:
```tsx
    const [gridViewportPx, setGridViewportPx] = useState(0);
    const [gridViewportW, setGridViewportW] = useState(0);
    useEffect(() => {
        const el = gridScrollRef.current;
        if (!el) {
            return;
        }
        // fill against the content box (clientHeight/Width include padding — sizing to the full client
        // box overflows by exactly that padding and shows a spurious scrollbar)
        const measure = () => {
            const cs = getComputedStyle(el);
            setGridViewportPx(el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
            setGridViewportW(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
        };
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        measure();
        return () => ro.disconnect();
    }, []);
```

- [ ] **Step 8: Replace the inline layout math with a `computeGridLayout` call and a geometry MV map**

Find the block computing `fullWidthCards`, `columnCards`, `distributeColumns`, `pageRowPx`, `fwMaxPx`, `fwHeights`, `fwStackPx`, `columnsAvail`, `colAvail`, `columnHeights` (`cockpitsurface.tsx` ~line 392–407). Replace that entire block with the layout call + derived scalars the resize handlers still need:

```tsx
    // full-width cards float to a top stack; the rest fill two independent columns below. One pure pass
    // computes every card's absolute rect (px) + the column partition the resize handlers read.
    const layout: GridLayout = computeGridLayout(shownAgents, cardPrefs, gridViewportW, gridViewportPx);
    const { rects, totalHeight, columnsAvail, colA, colB } = layout;
    const pageRowPx = gridViewportPx / GRID_PAGE_ROWS;
    const fwMaxPx = FULLWIDTH_MAX_VIEWPORT_FRAC * gridViewportPx;
    const colAvail = (n: number) => Math.max(0, columnsAvail - GRID_ROW_GAP_PX * Math.max(0, n - 1));
```

Then replace the geometry-MV plumbing. Find the existing `heightMVs` ref + `getHeightMV` helper (`cockpitsurface.tsx` ~line 359–367):

```tsx
    const heightMVs = useRef(new Map<string, MotionValue<number>>());
    const getHeightMV = (id: string, initial: number) => {
        let mv = heightMVs.current.get(id);
        if (!mv) {
            mv = motionValue(initial);
            heightMVs.current.set(id, mv);
        }
        return mv;
    };
```

Replace with a four-dimension geometry map:

```tsx
    // per-id geometry motion values, persisted across renders (a move retargets these; it never
    // remounts the card). The corner drag writes h/y directly; every other change is retargeted in
    // renderCard below.
    type GeomMV = { x: MotionValue<number>; y: MotionValue<number>; w: MotionValue<number>; h: MotionValue<number> };
    const geomMVs = useRef(new Map<string, GeomMV>());
    const getGeom = (id: string, r: CardRect): GeomMV => {
        let g = geomMVs.current.get(id);
        if (!g) {
            g = { x: motionValue(r.x), y: motionValue(r.y), w: motionValue(r.w), h: motionValue(r.h) };
            geomMVs.current.set(id, g);
        }
        return g;
    };
```

- [ ] **Step 9: Rewrite the resize handlers against the new geometry**

Replace `beginCardResize`, `resizeCardHeight`, and `dragResizeMV` (`cockpitsurface.tsx` ~line 409–470). `endCardResize` and `toggleCardFullWidth` are unchanged. The `resizeSnapRef` type gains `colStartY` for the column case.

First, widen the snap ref type (`cockpitsurface.tsx` ~line 351–353):

```tsx
    const resizeSnapRef = useRef<
        | { kind: "fw"; startPx: number }
        | { kind: "col"; ids: string[]; weights: number[]; avail: number; colStartY: number }
        | null
    >(null);
```

Then the handlers:

```tsx
    const beginCardResize = (cardId: string) => {
        setIsResizing(true);
        if (cardPrefs[cardId]?.fullWidth) {
            resizeSnapRef.current = { kind: "fw", startPx: rects.get(cardId)?.h ?? pageRowPx };
            return;
        }
        const col = colA.some((c) => c.id === cardId) ? colA : colB;
        resizeSnapRef.current = {
            kind: "col",
            ids: col.map((c) => c.id),
            weights: col.map((c) => cardPrefs[c.id]?.heightWeight ?? 1),
            avail: colAvail(col.length),
            colStartY: rects.get(col[0].id)?.y ?? 0,
        };
    };
    // commit the final drag as ratio-scale weights (pointer-up)
    const resizeCardHeight = (cardId: string, dyPx: number) => {
        const snap = resizeSnapRef.current;
        if (!snap) {
            return;
        }
        if (snap.kind === "fw") {
            const px = Math.min(fwMaxPx, Math.max(GRID_MIN_ROW_PX, snap.startPx + dyPx));
            setCardPrefs((p) => ({ ...p, [cardId]: { ...p[cardId], heightWeight: pageRowPx > 0 ? px / pageRowPx : 1 } }));
            return;
        }
        const index = snap.ids.indexOf(cardId);
        if (index === -1 || snap.ids.length < 2) {
            return; // a lone card in its column has no neighbour to shift against
        }
        const last = index === snap.ids.length - 1;
        const boundary = last ? index - 1 : index;
        const delta = last ? -dyPx : dyPx;
        const next = normalizeWeights(resizeRowWeights(snap.weights, boundary, delta, snap.avail));
        setCardPrefs((p) => {
            const out = { ...p };
            snap.ids.forEach((id, i) => (out[id] = { ...out[id], heightWeight: next[i] }));
            return out;
        });
    };
    // live drag: write heights (and the shifted y within the column) straight to the bound motion
    // values (DOM-only, no re-render). resizeRowWeights returns actual pixel heights.
    const dragResizeMV = (cardId: string, dyPx: number) => {
        const snap = resizeSnapRef.current;
        if (!snap) {
            return;
        }
        resizeMoveRef.current = { cardId, dyPx };
        if (snap.kind === "fw") {
            geomMVs.current.get(cardId)?.h.set(Math.min(fwMaxPx, Math.max(GRID_MIN_ROW_PX, snap.startPx + dyPx)));
            return;
        }
        const index = snap.ids.indexOf(cardId);
        if (index === -1 || snap.ids.length < 2) {
            return; // a lone card in its column has no neighbour to shift against
        }
        const last = index === snap.ids.length - 1;
        const px = resizeRowWeights(snap.weights, last ? index - 1 : index, last ? -dyPx : dyPx, snap.avail);
        // only the dragged boundary moves, but recompute the column's y from the live heights so the
        // lower card's top tracks the drag
        let y = snap.colStartY;
        snap.ids.forEach((id, i) => {
            const g = geomMVs.current.get(id);
            g?.h.set(px[i]);
            g?.y.set(y);
            y += px[i] + GRID_ROW_GAP_PX;
        });
    };
```

- [ ] **Step 10: Rewrite `renderCard` to retarget MVs and pass the new props**

Replace `renderCard` (`cockpitsurface.tsx` ~line 662–702). It now takes the card + its rect, retargets the geometry MVs (unless a drag is live), and passes the four MVs.

```tsx
    // one AgentRow with every callback wired — shared by all cards in the single absolute tree
    const renderCard = (a: AgentVM, rect: CardRect) => {
        const g = getGeom(a.id, rect);
        // keep the bound values tracking the computed layout when not dragging; during a drag the
        // resize handlers own h/y for the affected column, so leave them alone
        if (!isResizing) {
            g.x.set(rect.x);
            g.y.set(rect.y);
            g.w.set(rect.w);
            g.h.set(rect.h);
        }
        return (
            <AgentRow
                key={a.id}
                agent={a}
                now={now}
                rect={rect}
                xMV={g.x}
                yMV={g.y}
                wMV={g.w}
                hMV={g.h}
                fullWidth={!!cardPrefs[a.id]?.fullWidth}
                isCursor={cursorId === a.id}
                pulse={pulseId === a.id}
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
                onBackground={a.state === "working" || a.state === "asking" ? () => toggleBackground(a.id) : undefined}
                onDismiss={a.state === "idle" ? () => setDismissed((prev) => new Set(prev).add(dismissKey(a))) : undefined}
                onResizeStart={() => beginCardResize(a.id)}
                onResizeHeight={(dy) => dragResizeMV(a.id, dy)}
                onResizeEnd={endCardResize}
                onToggleFullWidth={() => toggleCardFullWidth(a.id)}
                resizing={isResizing}
            />
        );
    };
```

- [ ] **Step 11: Delete `renderColumn` and rewrite the grid render block**

Delete the `renderColumn` function entirely (`cockpitsurface.tsx` ~line 704–719).

Replace the grid render block (the `<div ref={gridScrollRef}>` and its `<LayoutGroup>`/columns children, ~line 858–872) with a single absolute tree:

```tsx
                    <div ref={gridScrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-2.5">
                        {/* one absolute canvas; every card is a sibling in one AnimatePresence, positioned
                            by its spring-driven rect. A move retargets springs (no remount, no crossfade);
                            only genuine add/remove runs the opacity+scale variants. */}
                        <div style={{ position: "relative", height: totalHeight }}>
                            <AnimatePresence initial={false}>
                                {shownAgents.map((a) => {
                                    const rect = rects.get(a.id);
                                    return rect ? renderCard(a, rect) : null;
                                })}
                            </AnimatePresence>
                        </div>
                    </div>
```

- [ ] **Step 12: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. If errors remain, they name a specific stale reference (e.g. an unused import like `distributeColumns`/`rowHeightsPx`, or a leftover `fwHeights`/`columnHeights`/`renderColumn` use) — remove it.

- [ ] **Step 13: Run the full frontend unit suite (no regressions)**

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS (including Task 1's `computeGridLayout` tests). These are pure-logic tests; the render change doesn't touch them.

- [ ] **Step 14: Visual verification via CDP**

Ensure the dev app is running (`task dev`) with the `heavy` fixture:
```bash
node scripts/gen-cockpit-fixtures.mjs heavy
node scripts/cdp-shot.mjs cdp-shots/after-static.png   # confirm 12 cards render in the 2-col grid
```
Then drive a full-width toggle and capture a burst (reuse the corner-grip PointerEvent driver + `Page.captureScreenshot` loop). Confirm across the frames:
1. **No empty-skeleton scaling** — cards keep their content throughout (no blank rounded boxes).
2. **No double-image** — each agent id appears exactly once at every instant.
3. **Width eases smoothly** — the toggled card's width grows half→full over the spring, not a snap and not a stretch.
4. **End state matches** — after settling, the layout is identical to the pre-change build (same card order, same column split, full-width card on top).

If any fail, stop and diagnose before committing (do not paper over with more animation).

- [ ] **Step 15: Commit**

```bash
git add frontend/app/view/agents/agentrow.tsx frontend/app/view/agents/cockpitsurface.tsx
git commit -m "feat(cockpit): single-tree spring geometry — animated full-width, ghost-free reflow"
```

---

## Self-Review

**1. Spec coverage** (against `docs/superpowers/specs/2026-07-03-cockpit-grid-spring-geometry-design.md`):
- §1 geometry model → Task 1 (`computeGridLayout`, pure, unit-tested). ✓
- §2 one presence tree / drop LayoutGroup/renderColumn/popLayout → Task 2 Steps 11. ✓
- §3 AgentRow absolute + 4 springs, drop layout/layoutId, variants for add/remove only → Task 2 Steps 2–4. ✓
- §4 resize semantics unchanged (vertical weight, horizontal toggle, isResizing suspends retarget) → Task 2 Steps 9–10. ✓
- §5 container width measurement → Step 7; reduced motion → Step 3; exit bookkeeping → AnimatePresence in Step 11 (exiting card keeps last MV values, variants fade it). ✓
- Testing: unit (Task 1 Step 1) + CDP visual (Step 14). ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**3. Type consistency:** `computeGridLayout` return `{ rects, totalHeight, columnsAvail, colA, colB, fullWidth }` is consumed with those exact names in Step 8. AgentRow props `rect/xMV/yMV/wMV/hMV` (Task 2 Interfaces) are passed with those exact names in Step 10. `GeomMV` fields `{x,y,w,h}` used consistently in Steps 8–10. `resizeSnapRef` `col` variant gains `colStartY`, set in Step 9 `beginCardResize` and read in `dragResizeMV`. ✓

**Note on `motionValue` import:** `cockpitsurface.tsx` already imports `motionValue` (used by the old `getHeightMV`); Step 8 keeps using it in `getGeom`, so the import stays. `MotionValue` type import also stays (used in `GeomMV`).
