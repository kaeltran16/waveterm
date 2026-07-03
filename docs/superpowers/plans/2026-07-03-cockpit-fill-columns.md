# Cockpit Fill-Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cockpit's single shared-row card grid with two independent fill-columns so each card owns its height (resizing one never touches the other column) and full-width no longer eats the viewport.

**Architecture:** Cards are distributed round-robin into column A/B. Each column divides its own height among its cards by weight (reusing the existing, tested `rowHeightsPx`/`resizeRowWeights` helpers, now applied per column). A per-column horizontal divider between adjacent cards does split-pane resize. The shipped cockpit motion (entrance/exit + `layout="position"` reflow + `AnimatePresence`) is preserved; only reorder-drag and full-width are removed.

**Tech Stack:** React 19, jotai, Tailwind 4, `motion/react`, vitest. Frontend-only — no Go/Rust/wshrpc changes.

**Spec:** `docs/superpowers/specs/2026-07-03-cockpit-masonry-grid-design.md`

**Git policy (user override):** Per the user's global rules, do NOT commit per task and NEVER commit without explicit approval. Each task ends at a **verification checkpoint**, not a commit. After all tasks verify, present one combined commit (the spec + plan docs fold into it) for approval.

**Baseline gotchas (from repo memory / CLAUDE.md):**
- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows). Baseline is clean (exit 0).
- Unit tests: `npx vitest run frontend/app/view/agents/agentfilters.test.ts`.
- Visual check is CDP-only (no render harness): dev app via `task dev`, screenshot with `node scripts/cdp-shot.mjs out.png`. Headless dev needs `tail -f /dev/null | task dev` (wavesrv dies on stdin EOF). Populate cockpit with `node scripts/inject-live-agents.mjs <scenario>`. Do NOT CDP `Page.reload` (breaks Tauri boot) — touch `src-tauri/` to trigger rebuild instead.

---

## File Structure

- `frontend/app/view/agents/agentsviewmodel.ts` — add `distributeColumns`; later remove dead layout helpers + `fullWidth` field.
- `frontend/app/view/agents/agentfilters.test.ts` — add `distributeColumns` tests; later remove `computeGridLayout`/`nextFullWidth` tests.
- `frontend/app/view/agents/cockpitsurface.tsx` — swap the single grid for two fill-columns.
- `frontend/app/view/agents/agentrow.tsx` — root `Reorder.Item` → `motion.div`; drop reorder-drag + full-width; add `heightPx`.

---

## Task 1: `distributeColumns` pure helper (TDD)

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (add near the other grid helpers, ~line 682 after `computeGridLayout`)
- Test: `frontend/app/view/agents/agentfilters.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `agentfilters.test.ts` (a new `describe` block; use plain strings since the helper is generic):

```ts
describe("distributeColumns", () => {
    it("splits round-robin: even index -> A, odd -> B", () => {
        expect(distributeColumns(["a0", "a1", "a2", "a3"])).toEqual({
            colA: ["a0", "a2"],
            colB: ["a1", "a3"],
        });
    });

    it("puts a lone card in A with an empty B", () => {
        expect(distributeColumns(["a0"])).toEqual({ colA: ["a0"], colB: [] });
    });

    it("gives A the extra card on an odd count", () => {
        expect(distributeColumns(["a0", "a1", "a2"])).toEqual({ colA: ["a0", "a2"], colB: ["a1"] });
    });

    it("fills 2x3 for six cards", () => {
        expect(distributeColumns(["a0", "a1", "a2", "a3", "a4", "a5"])).toEqual({
            colA: ["a0", "a2", "a4"],
            colB: ["a1", "a3", "a5"],
        });
    });

    it("is empty for an empty list", () => {
        expect(distributeColumns([])).toEqual({ colA: [], colB: [] });
    });
});
```

Add `distributeColumns` to the import block at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentfilters.test.ts -t distributeColumns`
Expected: FAIL — `distributeColumns is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

Add to `agentsviewmodel.ts`:

```ts
/** Pure: split an ordered list round-robin into two columns (even index -> A, odd -> B). */
export function distributeColumns<T>(ordered: T[]): { colA: T[]; colB: T[] } {
    const colA: T[] = [];
    const colB: T[] = [];
    ordered.forEach((item, i) => (i % 2 === 0 ? colA : colB).push(item));
    return { colA, colB };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentfilters.test.ts -t distributeColumns`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean baseline; `distributeColumns` is exported and used by the test).

**Checkpoint:** helper added + green. No commit yet.

---

## Task 2: Rewrite the grid as two fill-columns (`cockpitsurface.tsx` + `agentrow.tsx`)

These two files change together — the AgentRow prop contract (`spanFull`/`onToggleFullWidth` out, `heightPx` in) and the removal of `Reorder.Group`/`Reorder.Item` are one atomic change, so the build only stays green if both move at once.

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx`
- Modify: `frontend/app/view/agents/cockpitsurface.tsx`

### 2a — `agentrow.tsx`

- [ ] **Step 1: Fix imports**

Replace line 6:
```ts
import { Reorder, useDragControls, motion } from "motion/react";
```
with:
```ts
import { motion } from "motion/react";
```

Replace line 7:
```ts
import { cardVariants, composerReveal, reorderLift } from "@/app/element/motiontokens";
```
with:
```ts
import { cardVariants, composerReveal } from "@/app/element/motiontokens";
```

In the `agentsviewmodel` import block (lines 10-19), remove `nextFullWidth,` (leave the rest).

- [ ] **Step 2: Drop the drag controls hook**

Remove line 154:
```ts
    const controls = useDragControls();
```

- [ ] **Step 3: Update the props type**

In the destructured props (around lines 128-129) remove `spanFull,` and `onToggleFullWidth,`. In the props type (around lines 150-151) remove:
```ts
    spanFull?: boolean;
    onToggleFullWidth?: () => void;
```
and add:
```ts
    heightPx?: number;
```
Add `heightPx` to the destructure list alongside the other props.

- [ ] **Step 4: Swap the root element**

Replace the opening tag (lines 221-235):
```tsx
        <Reorder.Item
            as="div"
            value={agent.id}
            dragListener={false}
            dragControls={controls}
            dragMomentum={false}
            dragTransition={{ bounceStiffness: 600, bounceDamping: 30 }}
            layout="position"
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            whileDrag={reorderLift}
            ref={cardRef}
            style={{ gridColumn: spanFull ? "1 / -1" : undefined, minHeight: 0 }}
```
with:
```tsx
        <motion.div
            layout="position"
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            ref={cardRef}
            style={{
                height: heightPx && heightPx > 0 ? heightPx : undefined,
                flex: heightPx && heightPx > 0 ? undefined : "1 1 0",
                minHeight: 0,
            }}
```

- [ ] **Step 5: Update the stale row-stretch comment (line 240)**

Replace:
```tsx
                // cards stretch to fill their grid row (align-items: stretch) — the fit-to-viewport goal
```
with:
```tsx
                // each card fills the height its column allotted (heightPx); overflow clipped
```

- [ ] **Step 6: Remove the reorder grip span**

Delete lines 253-260 (the `∷∷` grip):
```tsx
                <span
                    onPointerDown={(e) => controls.start(e)}
                    onClick={(e) => e.stopPropagation()}
                    title="Drag to reorder"
                    className="shrink-0 cursor-grab select-none font-mono text-[12px] leading-none tracking-[-1px] text-feed-glyph active:cursor-grabbing"
                >
                    ∷∷
                </span>
```

- [ ] **Step 7: Remove the right-edge full-width handle**

Delete the whole block at lines 470-500 (`{/* right edge: drag outward ... */}` through the closing `) : null}` of `onToggleFullWidth`).

- [ ] **Step 8: Close the root as `motion.div`**

Change the final closing tag (line 501) from:
```tsx
        </Reorder.Item>
```
to:
```tsx
        </motion.div>
```

### 2b — `cockpitsurface.tsx`

- [ ] **Step 9: Fix imports**

Line 7 stays as-is (`AnimatePresence, MotionConfig, Reorder` — `Reorder` will be unused after this task; remove it from the import in Step 12 once the render no longer uses it). In the `agentsviewmodel` import block (lines 21-23), remove `computeGridLayout,` — keep `rowHeightsPx,` and `resizeRowWeights,`. Add `distributeColumns,` to that block.

- [ ] **Step 10: Replace the layout computation (lines 394-412)**

Replace:
```tsx
    const gridRows = computeGridLayout(shownAgents, cardPrefs);
    const rowGaps = GRID_ROW_GAP_PX * Math.max(0, gridRows.length - 1);
    const availablePx = Math.max(0, gridViewportPx - rowGaps);
    const gridRowHeights = rowHeightsPx(
        gridRows.map((r) => r.heightWeight),
        availablePx
    );
    const gridContentPx = gridRowHeights.reduce((s, h) => s + h, 0) + rowGaps;
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
with:
```tsx
    const { colA, colB } = distributeColumns(shownAgents);
    const columnHeights = (cards: AgentVM[]) => {
        const weights = cards.map((c) => cardPrefs[c.id]?.heightWeight ?? 1);
        const avail = Math.max(0, gridViewportPx - GRID_ROW_GAP_PX * Math.max(0, cards.length - 1));
        return rowHeightsPx(weights, avail);
    };
    const resizeColumn = (cards: AgentVM[], boundary: number, deltaPx: number) => {
        const weights = cards.map((c) => cardPrefs[c.id]?.heightWeight ?? 1);
        const avail = Math.max(0, gridViewportPx - GRID_ROW_GAP_PX * Math.max(0, cards.length - 1));
        const next = resizeRowWeights(weights, boundary, deltaPx, avail);
        setCardPrefs((p) => {
            const out = { ...p };
            cards.forEach((c, idx) => {
                out[c.id] = { ...out[c.id], heightWeight: next[idx] };
            });
            return out;
        });
    };
```

- [ ] **Step 11: Remove the membership-reset effect (lines 413-430)**

Delete the block starting with the comment `// when the visible membership changes, drop height overrides ...` through the closing `}, [shownKey]);`. Also delete the now-unused `const shownKey = shownAgents.map((a) => a.id).join(",");` line that feeds it (line 414). (Grep for other `shownKey` uses first; if none remain, remove it.)

- [ ] **Step 12: Add the `renderColumn` closure**

Add just before the `return (` of the component's JSX (after the other local handlers such as `openDiff`/`onKeyDown`, before `const empty = ...`):

```tsx
    const renderColumn = (cards: AgentVM[], colKey: string) => {
        if (cards.length === 0) {
            return null;
        }
        const heights = columnHeights(cards);
        const contentPx = heights.reduce((s, h) => s + h, 0) + GRID_ROW_GAP_PX * Math.max(0, cards.length - 1);
        return (
            <div key={colKey} className="relative flex-1" style={{ height: contentPx || "100%" }}>
                <div className="flex h-full flex-col gap-3.5">
                    <AnimatePresence mode="popLayout" initial={false}>
                        {cards.map((a, i) => (
                            <AgentRow
                                key={a.id}
                                agent={a}
                                now={now}
                                heightPx={heights[i]}
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
                    </AnimatePresence>
                </div>
                <RowDividers heights={heights} gap={GRID_ROW_GAP_PX} onResize={(b, d) => resizeColumn(cards, b, d)} />
            </div>
        );
    };
```

- [ ] **Step 13: Replace the grid render (lines 733-793)**

Replace the whole block:
```tsx
                    <div ref={gridScrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-2.5">
                        <div className="relative w-full" style={{ height: gridContentPx || "100%" }}>
                            <Reorder.Group
                                ... (through) ...
                            </Reorder.Group>
                            <RowDividers heights={gridRowHeights} gap={GRID_ROW_GAP_PX} onResize={resizeGridRow} />
                        </div>
                    </div>
```
with:
```tsx
                    <div ref={gridScrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-2.5">
                        <div className="flex gap-3.5">
                            {renderColumn(colA, "colA")}
                            {renderColumn(colB, "colB")}
                        </div>
                    </div>
```

- [ ] **Step 14: Drop the now-unused `Reorder` import + `orderedIds` prop use**

Line 7: change `import { AnimatePresence, MotionConfig, Reorder } from "motion/react";` to `import { AnimatePresence, MotionConfig } from "motion/react";`. Confirm `orderedIds` is still used (it feeds `navigableIds`) — keep it; only its use as `Reorder.Group values` is gone. Also confirm `onReorder={setOrder}` was the only `setOrder` render use; `setOrder` is still called by the order-maintenance effect, so keep `order`/`setOrder`.

- [ ] **Step 15: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. If it reports an unused `Reorder`/`useDragControls`/`nextFullWidth`/`reorderLift`/`computeGridLayout`, remove that import — it means a Step above missed one.

- [ ] **Step 16: Unit tests still green**

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS (existing filter/order/group + the new `distributeColumns` tests). `computeGridLayout`/`nextFullWidth` tests still exist and still pass (removed in Task 3).

- [ ] **Step 17: Visual verification (CDP)**

With the dev app running (`task dev`, or `tail -f /dev/null | task dev` headless), populate and screenshot:
```bash
node scripts/inject-live-agents.mjs six          # or a scenario with 1, 2, 3, 6 agents
node scripts/cdp-shot.mjs scratch/fill-6.png
```
Expected: 6 agents render as 2 columns × 3 rows filling the viewport. Verify by scenario:
- 1 agent → single card fills full width + height.
- 2 agents → two half-width, full-height cards.
- 3 agents → left column split in two, right column one tall card.
- Hover the gap between two stacked cards in one column → the clay divider appears; drag it → only that column's two cards resize, the other column is unchanged.
- No `∷∷` grip, no right-edge widen handle.

**Checkpoint:** grid rewritten, typecheck + tests + CDP green. No commit yet.

---

## Task 3: Remove the dead layout helpers, `fullWidth` field, and old tests

Now nothing references the old helpers, so delete them.

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Modify: `frontend/app/view/agents/agentfilters.test.ts`

- [ ] **Step 1: Remove the old tests first (keeps the suite honest)**

In `agentfilters.test.ts`: delete the entire `describe("computeGridLayout", …)` block (lines ~119-151) and the entire `describe("nextFullWidth", …)` block (starts ~line 187 to its closing). Remove `computeGridLayout` and `nextFullWidth` from the import block at the top. **Keep** `resizeRowWeights`, `rowHeightsPx`, and `distributeColumns` imports and their tests.

- [ ] **Step 2: Run tests to confirm the suite still passes without them**

Run: `npx vitest run frontend/app/view/agents/agentfilters.test.ts`
Expected: PASS — remaining `distributeColumns`, `rowHeightsPx`, `resizeRowWeights`, filter/order tests.

- [ ] **Step 3: Delete the dead source**

In `agentsviewmodel.ts`:
- Drop `fullWidth?: boolean;` from `CardPref` (leave `heightWeight?: number;`).
- Delete `export const FULLWIDTH_DRAG_THRESHOLD_PX = ...`.
- Delete `export interface GridCell`, `export interface GridRow`.
- Delete `function rowWeight(...)` (only `computeGridLayout` used it).
- Delete `export function computeGridLayout(...)`.
- Delete `export function nextFullWidth(...)`.
- **Keep** `GRID_PAGE_ROWS`, `GRID_MIN_ROW_PX`, `GRID_ROW_GAP_PX`, `rowHeightsPx`, `resizeRowWeights`, `distributeColumns`.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. A `has no exported member 'computeGridLayout'`/`'nextFullWidth'`/`'fullWidth'` error means a consumer was missed in Task 2 — fix there.

- [ ] **Step 5: Full unit suite**

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS.

**Checkpoint:** dead code gone, green.

---

## Final: combined commit (needs approval)

- [ ] Show `git status` (M `agentsviewmodel.ts`, `agentfilters.test.ts`, `cockpitsurface.tsx`, `agentrow.tsx`; A the spec + this plan) with a one-line change summary and the message:

`feat(cockpit): two independent fill-columns with per-card split-pane resize`

(body: WHY — resizing a card no longer resizes its neighbour; full-width removed; reuses per-column weight math; motion preserved. Spec + plan fold into this commit.)

- [ ] Ask: "Awaiting approval. Proceed? (yes/no)" — do not commit until the user says yes.

---

## Self-review notes (author)

- **Spec coverage:** fill-by-default (Task 2 `renderColumn` + `rowHeightsPx`), per-card/per-column resize (Task 2 `resizeColumn` + `RowDividers`), Bug 1 fix (columns independent), Bug 2 / full-width removed (Task 2 handle removed + Task 3 field removed), reorder dropped (Task 2 grip/Reorder removed), motion preserved (Task 2a keeps `cardVariants`/`layout`/`AnimatePresence`). All covered.
- **Type consistency:** `distributeColumns` returns `{colA, colB}` used verbatim in Task 2; `heightPx?: number` defined in 2a Step 3 and passed in 2b Step 12; `resizeColumn(cards, boundary, deltaPx)` signature matches its `RowDividers onResize={(b,d)=>resizeColumn(cards,b,d)}` call.
- **Risk:** `RowDividers` line numbers shift as edits land — anchor by the block content, not the numbers. If a parallel session moves HEAD again, re-read the two `.tsx` files before editing.
