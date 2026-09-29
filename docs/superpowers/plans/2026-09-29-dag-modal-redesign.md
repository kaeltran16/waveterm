# Route DAG modal redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Verify:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" node scripts/verify.mjs ./pkg/jarvis/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs dag-lifecycle`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/dag-visualizer/project/Main.dc.html

**Goal:** Rebuild the Route DAG modal (graph, node cards, edges, peek, detail rail, lifecycle timeline) to match
the settled interactive mockup, and remove the native tooltip that appears over the hover peek.

**Architecture:** The mockup's `<script type="text/x-dc">` logic is ported into pure, tested `.ts` modules
under `frontend/app/view/orchestrate/`: layout, canvas vocabulary and navigation, description lead, and
timeline grouping. Thin `.tsx` components consume them. ReactFlow stays the canvas: custom node types for
cards and lane bands, a custom edge type drawing the routed path.

**Tech Stack:** React 19, jotai (`atomWithStorage`), `@xyflow/react` 12, Tailwind 4 `@theme` tokens, vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-dag-modal-redesign-design.md`. Read it first; the decisions are
numbered D1 to D13 and the tasks cite them.

## Global Constraints

- The mockup is the visual spec. Serve it from the MAIN checkout (it is gitignored, so worktrees lack it):
  `python -m http.server 8766 --bind 127.0.0.1 --directory C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design`,
  then open `http://127.0.0.1:8766/dag-visualizer/project/Main.dc.html`. Every state of a node is shown in
  `NodeStates.dc.html` beside it. Read the mockup's script for the reference logic; its line numbers are
  cited below.
- Do not delete or edit anything under `.superpowers/design/dag-visualizer`.
- Colours only from the `@theme` tokens in `frontend/tailwindsetup.css`: Tailwind classes (`text-ink-hi`,
  `text-ink-mid`, `text-ink-faint`, `border-edge-mid`, `bg-lane`, `bg-warning/10`, …), or
  `var(--color-*)` / `color-mix(in srgb, var(--color-*) N%, transparent)` in SVG and inline styles. No
  new tokens, no raw hex or rgba, no emoji. The mockup's hex map `C` (Main.dc.html line 363) translates:
  `inkHi`→`ink-hi`, `inkMid`→`ink-mid`, `faint`→`ink-faint`, `muted`→`muted`, `secondary`→`secondary`,
  `raised`→`surface-raised`, `hover`→`surface-hover`, `lane`→`lane`, `code`→`surface-code`,
  `edgeMid`/`edgeStrong`→`edge-mid`/`edge-strong`, `accent`/`accentSoft`→`accent`/`accent-soft`,
  `success`/`warning`/`error`→same, `warningSoft`→`warning-soft`, `onWarning`→`on-warning`,
  `WARN_FILL`→`warning/10`, `WARN_EDGE`→`warning/55`, `WARN_LINE`→`warning/70`, `LIVE_EDGE`→`accent/50`,
  `ACCENT_BG`→`accent/12`, `SUCCESS_BG`→`success/12`, `PILL`→`pill`.
- Text scale (D11): titles 13px `text-ink-hi`; secondary 11.5 to 12.5px; mono meta
  `font-mono text-[10.5px] text-ink-mid` (`MONO_META` in `frontend/app/view/jarvis/briefstyle.ts`).
  Nothing below 10.5px: no `text-xxxs` (8.5px) or `text-xxs` (10px) in any file this plan touches.
- Nothing inside a `.react-flow__node` may carry a `title` attribute (D7).
- Pure logic lives in `foo.ts` with `foo.test.ts` beside it. No jsdom render tests.
- Frontend only; do not change Go types or run `task generate`.
- Comments explain why, never what; lower case; only where needed. Match the surrounding file's idiom
  (4-space indent, double quotes, `Map`/`Set` over plain objects in new modules).
- `tsconfig` is non-strict: a `{ ok: true } | { ok: false; reason }` union does not narrow on `.ok`; use `in`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (plain `npx tsc`
  stack-overflows; `task check:ts` runs a real `npm install` in a worktree). It takes about 2 minutes.
- Run a single test file with `npx vitest run frontend/app/view/orchestrate/<file>.test.ts`.
- Do not run prettier with `--write` across the tree; check only the files you touched.

## Review Focus

- A task group whose `deps` name an id that is not in the group, or (never produced by the engine, but
  possible in a hand-edited store) a cycle: the layout must not throw or hang; unknown deps are ignored.
  Pinned in Task 1.
- An empty task group (a dag created with zero tasks): `computeLayout`, `fitScale` and `openView` must return
  empty or neutral values, not `-Infinity` / `NaN`. Pinned in Tasks 1 and 2.
- A description that opens on `**Files:**` with no list under it, or an empty/undefined description: the peek
  lead must be empty, never a dangling "Touches ". Pinned in Task 3.
- Corrupt or foreign data in the `dag.layout.offsets` localStorage entry (non-numeric offsets, offsets for
  deleted tasks): ignored, the computed layout is used. Pinned in Task 1.
- Events that arrive out of `ts` order, or have no `detail` / malformed JSON `detail`: grouping must sort and
  must treat them as dag-level rather than throwing. Pinned in Task 4.

---

### Task 1: Left-to-right layout, lanes, edge geometry and persisted drag offsets
**Depends on:** none

Ports the mockup's `computeLayout`, `lanesOf` and `edgeGeo` (Main.dc.html lines 511-616) and adds the
per-run drag-offset store (D1, D10). Keep the old `computeLayeredLayout` and its test in place: `daggraph.tsx`
still imports it until Task 7 deletes both.

**Files:**
- Modify: `frontend/app/view/orchestrate/daglayout.ts` (add below the existing `computeLayeredLayout`)
- Modify: `frontend/app/view/orchestrate/daglayout.test.ts` (append a new `describe` block; do not replace the file)
- Create: `frontend/app/view/orchestrate/daglayoutstore.ts`
- Create: `frontend/app/view/orchestrate/daglayoutstore.test.ts`

**Interfaces:**
- Produces (in `daglayout.ts`):
  - `export const CARD_W = 196; export const CARD_H = 64; export const GAP_X = 48;`
  - `export type Point = { x: number; y: number };`
  - `export type LayoutTask = { id: string; deps?: string[] };`
  - `export interface DagLayout { pos: Map<string, Point>; via: Map<string, Point[]>; layer: Map<string, number>; crossings: number }`: `pos` is a card's top-left; `via` is keyed by `edgeKey(from, to)` and holds the dummy points (x = column left edge, y = track centre).
  - `export function edgeKey(from: string, to: string): string` (returns `` `${from}>${to}` ``)
  - `export function computeLayout(tasks: LayoutTask[]): DagLayout`
  - `export function lanesOf(tasks: LayoutTask[]): string[][]`: exactly `jarvis.Lanes`, including single-task lanes.
  - `export type Rect = { x: number; y: number; w: number; h: number };`
  - `export function laneBand(ids: string[], pos: Map<string, Point>): Rect | null`: null when fewer than 2 of the ids have a position.
  - `export function edgeGeo(p: Point, q: Point, via: Point[]): { d: string; head: string }`
- Produces (in `daglayoutstore.ts`):
  - `export const LAYOUT_RUNS_KEPT = 20;`
  - `export type Offsets = Record<string, Point>;`
  - `export type LayoutOffsetStore = Record<string, { at: number; offsets: Offsets }>;`
  - `export const dagLayoutOffsetsAtom` (`atomWithStorage<LayoutOffsetStore>("dag.layout.offsets", {})`)
  - `export function applyOffsets(base: Map<string, Point>, offsets: Offsets | undefined): Map<string, Point>`
  - `export function withOffsets(store: LayoutOffsetStore, dagOid: string, offsets: Offsets, nowMs: number): LayoutOffsetStore`

- [ ] **Step 1: Write the failing layout tests** (append to `daglayout.test.ts`; extend the existing import line
  to `import { CARD_H, CARD_W, computeLayeredLayout, computeLayout, edgeGeo, edgeKey, laneBand, lanesOf } from "./daglayout";`)

```ts
const t = (id: string, ...deps: string[]) => ({ id, deps });

describe("computeLayout", () => {
    const diamond = [t("t-0"), t("t-1", "t-0"), t("t-2", "t-0"), t("t-3", "t-1", "t-2")];

    it("runs left to right by longest path", () => {
        const { pos, layer } = computeLayout(diamond);
        expect(layer.get("t-0")).toBe(0);
        expect(layer.get("t-3")).toBe(2);
        expect(pos.get("t-0")!.x).toBeLessThan(pos.get("t-1")!.x);
        expect(pos.get("t-1")!.x).toBe(pos.get("t-2")!.x);
        expect(pos.get("t-2")!.x).toBeLessThan(pos.get("t-3")!.x);
    });

    it("never overlaps two cards in a column", () => {
        const wide = [t("a"), ...["b", "c", "d", "e", "f"].map((id) => t(id, "a")), t("g", "b", "f")];
        const { pos, layer } = computeLayout(wide);
        const ids = [...pos.keys()];
        for (const x of ids)
            for (const y of ids) {
                if (x === y || layer.get(x) !== layer.get(y)) continue;
                expect(Math.abs(pos.get(x)!.y - pos.get(y)!.y)).toBeGreaterThanOrEqual(CARD_H);
            }
    });

    it("routes a layer-skipping edge through one dummy point per skipped layer", () => {
        const { via } = computeLayout([t("a"), t("b", "a"), t("c", "b"), t("d", "a", "c")]);
        expect(via.get(edgeKey("a", "d"))).toHaveLength(2);
        expect(via.get(edgeKey("c", "d"))).toHaveLength(0);
    });

    it("finds a crossing-free order when one exists", () => {
        // written in an order that crosses if laid out as given
        const tasks = [t("a"), t("b"), t("c", "b"), t("d", "a")];
        expect(computeLayout(tasks).crossings).toBe(0);
    });

    it("is deterministic", () => {
        const a = computeLayout(diamond);
        const b = computeLayout(diamond);
        expect([...a.pos.entries()]).toEqual([...b.pos.entries()]);
    });

    it("ignores deps outside the group and survives a cycle", () => {
        expect(() => computeLayout([t("a", "ghost"), t("b", "a")])).not.toThrow();
        expect(computeLayout([t("a", "ghost")]).layer.get("a")).toBe(0);
        expect(() => computeLayout([t("a", "b"), t("b", "a")])).not.toThrow();
    });

    it("returns an empty layout for no tasks", () => {
        const l = computeLayout([]);
        expect(l.pos.size).toBe(0);
        expect(l.crossings).toBe(0);
    });
});

// mirrors TestLanes in pkg/jarvis/plan_test.go case for case
describe("lanesOf", () => {
    it.each([
        ["chain", [t("t-1"), t("t-2", "t-1"), t("t-3", "t-2")], [["t-1", "t-2", "t-3"]]],
        ["fork", [t("t-1"), t("t-2", "t-1"), t("t-3", "t-1")], [["t-1"], ["t-2"], ["t-3"]]],
        ["join", [t("t-1"), t("t-2"), t("t-3", "t-1", "t-2")], [["t-1"], ["t-2"], ["t-3"]]],
        ["independent", [t("t-1"), t("t-2"), t("t-3", "t-2")], [["t-1"], ["t-2", "t-3"]]],
        [
            "a fork branch continues as its own chain",
            [t("t-1"), t("t-2", "t-1"), t("t-3", "t-1"), t("t-4", "t-3")],
            [["t-1"], ["t-2"], ["t-3", "t-4"]],
        ],
    ])("%s", (_name, tasks, lanes) => {
        expect(lanesOf(tasks)).toEqual(lanes);
    });
});

describe("laneBand", () => {
    it("wraps the lane's cards with room for its label", () => {
        const pos = new Map([
            ["a", { x: 0, y: 0 }],
            ["b", { x: 244, y: 10 }],
        ]);
        expect(laneBand(["a", "b"], pos)).toEqual({ x: -10, y: -24, w: 244 + CARD_W + 20, h: 10 + CARD_H + 34 });
    });
    it("has no band for a single card", () => {
        expect(laneBand(["a"], new Map([["a", { x: 0, y: 0 }]]))).toBeNull();
    });
});

describe("edgeGeo", () => {
    it("leaves the source's right edge and lands on the target's left edge", () => {
        const g = edgeGeo({ x: 0, y: 0 }, { x: 488, y: 100 }, []);
        expect(g.d.startsWith(`M${CARD_W} ${CARD_H / 2}`)).toBe(true);
        expect(g.d.endsWith(`483 ${100 + CARD_H / 2}`)).toBe(true);
        expect(g.head).toBe(`M483 ${100 + CARD_H / 2 - 4} L483 ${100 + CARD_H / 2 + 4} L488 ${100 + CARD_H / 2} Z`);
    });
    it("runs straight along each dummy track", () => {
        const g = edgeGeo({ x: 0, y: 0 }, { x: 488, y: 0 }, [{ x: 244, y: 80 }]);
        expect(g.d).toContain(`L${244 + CARD_W} 80`);
    });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run frontend/app/view/orchestrate/daglayout.test.ts`
Expected: FAIL, `computeLayout` is not exported.

- [ ] **Step 3: Implement in `daglayout.ts`** (append; keep `computeLayeredLayout` above it untouched)

```ts
// Left-to-right layered layout, ported from the design canvas (dag-visualizer/Main.dc.html): longest-path
// layers, a dummy node per skipped layer so a long edge gets its own track, barycenter sweeps that keep the
// ordering with the fewest crossings, then forward/backward packing for coordinates. Pure.
export const CARD_W = 196;
export const CARD_H = 64;
export const GAP_X = 48;
// vertical room between two cards, and between anything and an edge's dummy track
const SEP_CARD = 20;
const SEP_TRACK = 12;
const ORDER_SWEEPS = 12;
const PACK_PASSES = 8;
// a lane band's margin, with room above its cards for the label
const BAND_PAD = 10;
const BAND_LABEL = 24;
const ARROW_LEN = 5;
const ARROW_HALF = 4;
const CURVE_MIN = 16;

export type Point = { x: number; y: number };
export type LayoutTask = { id: string; deps?: string[] };
export type Rect = { x: number; y: number; w: number; h: number };

export interface DagLayout {
    pos: Map<string, Point>;
    via: Map<string, Point[]>;
    layer: Map<string, number>;
    crossings: number;
}

export function edgeKey(from: string, to: string): string {
    return `${from}>${to}`;
}

export function computeLayout(tasks: LayoutTask[]): DagLayout {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const depsOf = (id: string) => (byId.get(id)?.deps ?? []).filter((d) => byId.has(d));
    const layer = new Map<string, number>();
    const visiting = new Set<string>();
    const visit = (id: string): number => {
        const cached = layer.get(id);
        if (cached !== undefined) return cached;
        // the engine refuses a cycle; the guard keeps a malformed group from hanging the modal
        if (visiting.has(id)) return 0;
        visiting.add(id);
        let l = 0;
        for (const d of depsOf(id)) l = Math.max(l, visit(d) + 1);
        visiting.delete(id);
        layer.set(id, l);
        return l;
    };
    tasks.forEach((t) => visit(t.id));
    if (tasks.length === 0) return { pos: new Map(), via: new Map(), layer, crossings: 0 };
    const depth = Math.max(...layer.values()) + 1;

    type Item = { l: number; real: boolean };
    const items = new Map<string, Item>();
    const pred = new Map<string, string[]>();
    const succ = new Map<string, string[]>();
    const chains: { from: string; to: string; chain: string[] }[] = [];
    const add = (id: string, l: number, real: boolean) => {
        items.set(id, { l, real });
        pred.set(id, []);
        succ.set(id, []);
    };
    const link = (a: string, b: string) => {
        succ.get(a)!.push(b);
        pred.get(b)!.push(a);
    };
    tasks.forEach((t) => add(t.id, layer.get(t.id)!, true));
    for (const t of tasks) {
        for (const d of depsOf(t.id)) {
            const chain = [d];
            for (let l = layer.get(d)! + 1; l < layer.get(t.id)!; l++) {
                const vid = `${edgeKey(d, t.id)}@${l}`;
                add(vid, l, false);
                chain.push(vid);
            }
            chain.push(t.id);
            for (let i = 0; i + 1 < chain.length; i++) link(chain[i], chain[i + 1]);
            chains.push({ from: d, to: t.id, chain });
        }
    }

    let order: string[][] = Array.from({ length: depth }, () => []);
    for (const [id, it] of items) order[it.l].push(id);
    const crossings = (ord: string[][]): number => {
        let n = 0;
        for (let l = 0; l + 1 < depth; l++) {
            const at = new Map(ord[l + 1].map((id, i) => [id, i]));
            const es: [number, number][] = [];
            ord[l].forEach((id, i) => succ.get(id)!.forEach((s) => at.has(s) && es.push([i, at.get(s)!])));
            for (let a = 0; a < es.length; a++)
                for (let b = a + 1; b < es.length; b++) if ((es[a][0] - es[b][0]) * (es[a][1] - es[b][1]) < 0) n++;
        }
        return n;
    };
    const layersFrom = (down: boolean): number[] =>
        Array.from({ length: depth - 1 }, (_, i) => (down ? i + 1 : depth - 2 - i));
    const sweep = (ord: string[][], down: boolean): string[][] => {
        const next = ord.map((r) => [...r]);
        for (const l of layersFrom(down)) {
            const at = new Map(next[down ? l - 1 : l + 1].map((id, i) => [id, i]));
            const score = new Map<string, number>();
            next[l].forEach((id, i) => {
                const ns = (down ? pred.get(id)! : succ.get(id)!).filter((x) => at.has(x)).map((x) => at.get(x)!);
                score.set(id, ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : i);
            });
            next[l].sort((a, b) => score.get(a)! - score.get(b)!);
        }
        return next;
    };
    let best = order;
    let bestN = crossings(order);
    for (let i = 0; i < ORDER_SWEEPS; i++) {
        order = sweep(order, i % 2 === 0);
        const n = crossings(order);
        if (n < bestN) {
            best = order;
            bestN = n;
        }
    }

    const size = (id: string) => (items.get(id)!.real ? CARD_H : 0);
    const sep = (a: string, b: string) =>
        size(a) / 2 + size(b) / 2 + (items.get(a)!.real && items.get(b)!.real ? SEP_CARD : SEP_TRACK);
    const y = new Map<string, number>();
    for (const r of best) {
        let acc = 0;
        r.forEach((id, i) => {
            if (i > 0) acc += sep(r[i - 1], id);
            y.set(id, acc);
        });
        r.forEach((id) => y.set(id, y.get(id)! - acc / 2));
    }
    // averaging a forward and a backward packing keeps every gap at least sep while pulling each item
    // toward where its neighbours want it
    const place = (r: string[], desired: Map<string, number>) => {
        const fwd: number[] = [];
        const bwd: number[] = [];
        r.forEach((id, i) => (fwd[i] = i === 0 ? desired.get(id)! : Math.max(desired.get(id)!, fwd[i - 1] + sep(r[i - 1], id))));
        for (let i = r.length - 1; i >= 0; i--)
            bwd[i] = i === r.length - 1 ? desired.get(r[i])! : Math.min(desired.get(r[i])!, bwd[i + 1] - sep(r[i], r[i + 1]));
        r.forEach((id, i) => y.set(id, (fwd[i] + bwd[i]) / 2));
    };
    for (let pass = 0; pass < PACK_PASSES; pass++) {
        const down = pass % 2 === 0;
        for (const l of layersFrom(down)) {
            const desired = new Map<string, number>();
            for (const id of best[l]) {
                const ns = down ? pred.get(id)! : succ.get(id)!;
                desired.set(id, ns.length ? ns.reduce((a, x) => a + y.get(x)!, 0) / ns.length : y.get(id)!);
            }
            place(best[l], desired);
        }
    }

    const colX = (l: number) => l * (CARD_W + GAP_X);
    const pos = new Map<string, Point>();
    for (const t of tasks) pos.set(t.id, { x: colX(layer.get(t.id)!), y: y.get(t.id)! - CARD_H / 2 });
    const via = new Map<string, Point[]>();
    for (const c of chains)
        via.set(
            edgeKey(c.from, c.to),
            c.chain.slice(1, -1).map((vid) => ({ x: colX(items.get(vid)!.l), y: y.get(vid)! }))
        );
    return { pos, via, layer, crossings: bestN };
}

// lanesOf is jarvis.Lanes (pkg/jarvis/plan.go) rule for rule, so the graph's bands and the engine's merge
// lanes cannot disagree. Computed here rather than read from the digest so bands draw while it is stale.
export function lanesOf(tasks: LayoutTask[]): string[][] {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const dependents = new Map<string, string[]>();
    for (const t of tasks) for (const d of t.deps ?? []) dependents.set(d, [...(dependents.get(d) ?? []), t.id]);
    const count = (id: string) => dependents.get(id)?.length ?? 0;
    const lanes: string[][] = [];
    for (const t of tasks) {
        const deps = t.deps ?? [];
        if (deps.length === 1 && count(deps[0]) === 1) continue;
        const lane = [t.id];
        for (let cur = t.id; count(cur) === 1; ) {
            const next = byId.get(dependents.get(cur)![0]);
            if (next == null || (next.deps ?? []).length !== 1) break;
            lane.push(next.id);
            cur = next.id;
        }
        lanes.push(lane);
    }
    return lanes;
}

export function laneBand(ids: string[], pos: Map<string, Point>): Rect | null {
    const ps = ids.map((id) => pos.get(id)).filter((p): p is Point => p != null);
    if (ps.length < 2) return null;
    const x = Math.min(...ps.map((p) => p.x)) - BAND_PAD;
    const y = Math.min(...ps.map((p) => p.y)) - BAND_LABEL;
    const x1 = Math.max(...ps.map((p) => p.x + CARD_W)) + BAND_PAD;
    const y1 = Math.max(...ps.map((p) => p.y + CARD_H)) + BAND_PAD;
    return { x, y, w: x1 - x, h: y1 - y };
}

// edgeGeo draws an edge from a source card's right edge to a target card's left edge, curving into and
// running straight along each dummy track, and returns its arrowhead separately so the head can be filled
export function edgeGeo(p: Point, q: Point, via: Point[]): { d: string; head: string } {
    let x = p.x + CARD_W;
    let y = p.y + CARD_H / 2;
    let d = `M${x} ${y}`;
    const curveTo = (tx: number, ty: number) => {
        const c = Math.max(CURVE_MIN, (tx - x) / 2);
        d += ` C${x + c} ${y} ${tx - c} ${ty} ${tx} ${ty}`;
        x = tx;
        y = ty;
    };
    for (const v of via) {
        curveTo(v.x, v.y);
        d += ` L${v.x + CARD_W} ${v.y}`;
        x = v.x + CARD_W;
    }
    const tx = q.x - ARROW_LEN;
    const ty = q.y + CARD_H / 2;
    curveTo(tx, ty);
    return { d, head: `M${tx} ${ty - ARROW_HALF} L${tx} ${ty + ARROW_HALF} L${q.x} ${ty} Z` };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run frontend/app/view/orchestrate/daglayout.test.ts`
Expected: PASS (the old `computeLayeredLayout` tests still pass too).

- [ ] **Step 5: Write the failing store tests** (`daglayoutstore.test.ts`, new file)

```ts
import { describe, expect, it } from "vitest";
import { applyOffsets, LAYOUT_RUNS_KEPT, withOffsets, type LayoutOffsetStore } from "./daglayoutstore";

describe("applyOffsets", () => {
    const base = new Map([
        ["a", { x: 0, y: 0 }],
        ["b", { x: 244, y: 0 }],
    ]);
    it("moves only the dragged tasks", () => {
        const out = applyOffsets(base, { a: { x: 5, y: -7 } });
        expect(out.get("a")).toEqual({ x: 5, y: -7 });
        expect(out.get("b")).toEqual({ x: 244, y: 0 });
    });
    it("ignores offsets for tasks that are gone and non-numeric values", () => {
        const out = applyOffsets(base, { ghost: { x: 1, y: 1 }, b: { x: "x" as unknown as number, y: 3 } });
        expect([...out.keys()]).toEqual(["a", "b"]);
        expect(out.get("b")).toEqual({ x: 244, y: 0 });
    });
    it("returns the base layout without offsets", () => {
        expect(applyOffsets(base, undefined)).toEqual(base);
    });
});

describe("withOffsets", () => {
    it("stores a dag's offsets with the time they were written", () => {
        expect(withOffsets({}, "d1", { a: { x: 1, y: 2 } }, 100)).toEqual({ d1: { at: 100, offsets: { a: { x: 1, y: 2 } } } });
    });
    it("deletes the entry when no offsets remain (reset layout)", () => {
        expect(withOffsets({ d1: { at: 1, offsets: { a: { x: 1, y: 1 } } } }, "d1", {}, 2)).toEqual({});
    });
    it(`keeps only the ${LAYOUT_RUNS_KEPT} most recently written dags`, () => {
        let store: LayoutOffsetStore = {};
        for (let i = 0; i < LAYOUT_RUNS_KEPT + 3; i++) store = withOffsets(store, `d${i}`, { a: { x: i, y: 0 } }, i);
        expect(Object.keys(store)).toHaveLength(LAYOUT_RUNS_KEPT);
        expect(store.d0).toBeUndefined();
        expect(store[`d${LAYOUT_RUNS_KEPT + 2}`]).toBeDefined();
    });
});
```

- [ ] **Step 6: Run to verify they fail**, then implement `daglayoutstore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Where a person dragged a dag's nodes, kept per dag across modal sessions (atomWithStorage convention from
// themestore.ts). Only dragged nodes are stored, as offsets over the computed layout, so a task added to the
// plan later still gets its computed place.

import { atomWithStorage } from "jotai/utils";
import type { Point } from "./daglayout";

export const LAYOUT_RUNS_KEPT = 20;

export type Offsets = Record<string, Point>;
export type LayoutOffsetStore = Record<string, { at: number; offsets: Offsets }>;

export const dagLayoutOffsetsAtom = atomWithStorage<LayoutOffsetStore>("dag.layout.offsets", {});

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function applyOffsets(base: Map<string, Point>, offsets: Offsets | undefined): Map<string, Point> {
    const out = new Map(base);
    for (const [id, off] of Object.entries(offsets ?? {})) {
        const p = base.get(id);
        if (p == null || !finite(off?.x) || !finite(off?.y)) continue;
        out.set(id, { x: p.x + off.x, y: p.y + off.y });
    }
    return out;
}

export function withOffsets(store: LayoutOffsetStore, dagOid: string, offsets: Offsets, nowMs: number): LayoutOffsetStore {
    const next = { ...store };
    delete next[dagOid];
    if (Object.keys(offsets).length > 0) next[dagOid] = { at: nowMs, offsets };
    const keep = Object.entries(next)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, LAYOUT_RUNS_KEPT);
    return Object.fromEntries(keep);
}
```

Run: `npx vitest run frontend/app/view/orchestrate/daglayoutstore.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/orchestrate/daglayout.ts frontend/app/view/orchestrate/daglayout.test.ts frontend/app/view/orchestrate/daglayoutstore.ts frontend/app/view/orchestrate/daglayoutstore.test.ts
git commit -m "feat(orchestrate): left-to-right dag layout, lanes, routed edges and persisted drag offsets"
```

### Task 2: Canvas vocabulary, edge styles, keyboard navigation and the opening view
**Depends on:** none

Ports the mockup's task-state vocabulary, edge colouring, `relatives`, `keyDown`, `CHIP_GROUPS`/`pickNext`,
`fitView` and `panInto` (Main.dc.html lines 367-426, 618-626, 729-736, 796-848, 883-888, 942-990) into one pure
module (D2, D3, D4, D9), and adds the shared hover atom.

**Files:**
- Create: `frontend/app/view/orchestrate/dagcanvas.ts`
- Create: `frontend/app/view/orchestrate/dagcanvas.test.ts`
- Modify: `frontend/app/view/orchestrate/dagstore.ts` (add `hoveredTaskAtom` below `selectedTaskIdAtom`, line 8)

**Interfaces:**
- Consumes: `formatElapsed(ms: number): string`, `firstLine(text: string | undefined): string` from `./dagdigest`.
  Defines its own `Point` type (`{ x: number; y: number }`), structurally identical to Task 1's, so it does not import `daglayout`.
- Produces (in `dagcanvas.ts`):
  - `export type NodeKind = "attention" | "live" | "ready" | "done" | "inert" | "waiting";`
  - `export function kindOf(t: Pick<TaskNode, "state" | "gate">): NodeKind`
  - `export function wordOf(t: Pick<TaskNode, "state" | "gate">): string`
  - `export type GlyphKind = "done" | "failed" | "stalled" | "attention" | "running" | "live" | "ready" | "inert" | "waiting";`
  - `export function glyphKind(t: Pick<TaskNode, "state" | "gate">): GlyphKind`
  - `export type FactCtx = { byId: Map<string, TaskNode>; digest: DagTaskDigest | undefined; mergeReady: ReadonlySet<string>; nowMs: number };`
  - `export function factOf(t: TaskNode, ctx: FactCtx): string`
  - `export type Relatives = { up: Set<string>; down: Set<string> };`
  - `export function relatives(tasks: { id: string; deps?: string[] }[], id: string): Relatives`
  - `export type EdgeFocus = { id: string; rel: Relatives; selected: boolean };`
  - `export type EdgeKind = "path" | "needs-you" | "waiting" | "live" | "satisfied";`
  - `export type EdgeStyle = { kind: EdgeKind; dashed: boolean; faded: boolean };`
  - `export function edgeStyle(src: TaskNode, dst: TaskNode, focus: EdgeFocus | null): EdgeStyle`
  - `export type GraphKeyCtx = { tasks: { id: string; deps?: string[] }[]; selected: string | null; layer: Map<string, number>; pos: Map<string, Point> };`
  - `export type GraphKeyResult = { kind: "select"; id: string } | { kind: "fit" } | { kind: "zoom"; factor: number } | { kind: "none" };`
  - `export function graphKey(key: string, ctx: GraphKeyCtx): GraphKeyResult`
  - `export type ChipGroup = { key: "attention" | "live" | "done" | "waiting" | "inert"; label: string; kinds: NodeKind[]; count: number };`
  - `export function chipGroups(tasks: Pick<TaskNode, "state" | "gate">[]): ChipGroup[]`: only groups with a non-zero count, in the order need you, working, done, waiting, skipped.
  - `export function pickNext(tasks: TaskNode[], kinds: NodeKind[], selected: string | null): string | null`
  - `export const ZOOM_FLOOR = 0.85; export const ZOOM_MIN = 0.3; export const ZOOM_MAX = 1.6; export const ZOOM_STEP = 1.2; export const FIT_PAD = 20;`
  - `export type Pane = { w: number; h: number };`
  - `export function fitScale(pos: Map<string, Point>, pane: Pane, hasLanes: boolean): number`: 1 when `pos` is empty.
  - `export function openView(tasks: TaskNode[], pos: Map<string, Point>, pane: Pane, hasLanes: boolean): { fitIds: string[] | null; minZoom: number }`: `fitIds: null` means fit every node.
  - `export function nodeInView(viewport: { x: number; y: number; zoom: number }, p: Point, pane: Pane): boolean`
- Produces (in `dagstore.ts`): `export const hoveredTaskAtom = atom<{ id: string; from: "graph" | "timeline" } | null>(null) as PrimitiveAtom<{ id: string; from: "graph" | "timeline" } | null>;`

Rules to implement (the tests pin them):
- `kindOf` maps state as the mockup's `KIND` (line 367); a gated `done` is `attention`. Unknown states are `waiting`.
- `wordOf`: `blocked-merge`→"merge blocked", `verify-failed`→"verify failed", `review-failed`→"review failed", a gated done→"at gate", else the state.
- `glyphKind`: done→`done`; failed→`failed`; stalled→`stalled`; any other attention→`attention`; running→`running`; verifying/reviewing→`live`; ready→`ready`; cancelled/skipped→`inert`; else `waiting`.
- A dependency is finished when its state is `done` or `skipped` (the engine lets dependents of a skipped task start).
- `factOf` follows the spec's D2 table exactly:
  - running: `[elapsed, tool, attempt]` joined by " · ". Elapsed is `formatElapsed(nowMs - firstactivity)`, or "starting" with no `firstactivity`. Tool is `digest?.latesttool || t.latesttool`. Attempt is "attempt N" only when `attempts > 1`. Empty parts are dropped.
  - reviewing: `review round ${(t.reviewround ?? 0) + 1}`, the same numbering `taskPeek` uses.
  - verify-failed: `firstLine(t.verifyerror)`, else "resolve after your fix".
  - stalled: `idle ${formatElapsed(nowMs - lastactivity)} · retry or skip`, or "idle · retry or skip" with no `lastactivity`.
  - pending/ready:
    - With digest `waitreason` "ask": "asked you". With "lead-ask": "asked the lead".
    - Otherwise, by unfinished deps: none gives "next to start"; up to 4 gives "waits on t-1, t-3"; more gives "waits on N tasks".
- `edgeStyle`: base first, then focus.
  - The base: dst kind `attention` gives needs-you, dashed. Else a src not finished gives waiting, dashed. Else a dst kind `live` gives live, solid. Else satisfied, solid.
  - Then focus: the edge is on the path when `(dst === focus.id || rel.up.has(dst)) && rel.up.has(src)`, or `(src === focus.id || rel.down.has(src)) && rel.down.has(dst)`. On the path, kind becomes `path` and dashed is kept. Off the path, faded is `focus.selected`.
- `graphKey` (a port of `keyDown`, lines 796-825, without Enter/Escape):
  - `j`/`k`: next/previous in `tasks` order, clamped at the ends.
  - `ArrowRight`: the dependent nearest in y. `ArrowLeft`: the dependency nearest in y.
  - A tie in y goes to the earlier task in plan order (`tasks` order): collect candidates in `tasks` order and
    use a stable sort by `|y - selectedY|`.
  - `ArrowDown`/`ArrowUp`: next/previous in the same layer sorted by y, clamped.
  - With no selection, every movement key selects `tasks[0]`.
  - `f` gives fit. `+` and `=` zoom by `ZOOM_STEP`; `-` zooms by `1 / ZOOM_STEP`. Anything else is `none`.
  - A movement that lands on the current selection, or has no candidate, is `none`.
- `fitScale` is the mockup's `fitView` scale (line 599): `min(1, (pane.w - 2*FIT_PAD) / bw, (pane.h - 2*FIT_PAD - 24) / bh)`. The bounds use `CARD_W`/`CARD_H` (196/64, redeclared locally as `const CARD_W = 196; const CARD_H = 64;` with a comment that they match daglayout.ts). The top is raised 24 when `hasLanes`.
- `openView`:
  - `fitScale >= ZOOM_FLOOR` returns `{ fitIds: null, minZoom: ZOOM_MIN }`.
  - Otherwise it takes the first non-empty set of attention ids, then live ids, then ready ids, and returns `{ fitIds: set, minZoom: ZOOM_FLOOR }`.
  - With all three empty it returns `{ fitIds: null, minZoom: ZOOM_FLOOR }`.
- `nodeInView` mirrors `panInto`'s test (line 733): `sx >= 16 && sx + CARD_W*zoom <= pane.w - 16 && sy >= 48 && sy + CARD_H*zoom <= pane.h - 36`, where `sx = viewport.x + p.x*zoom` and `sy = viewport.y + p.y*zoom`.

- [ ] **Step 1: Write the failing tests** (`dagcanvas.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import {
    chipGroups,
    edgeStyle,
    factOf,
    fitScale,
    glyphKind,
    graphKey,
    kindOf,
    nodeInView,
    openView,
    pickNext,
    relatives,
    wordOf,
    ZOOM_FLOOR,
    ZOOM_STEP,
    type FactCtx,
} from "./dagcanvas";

const task = (id: string, state: string, extra: Partial<TaskNode> = {}): TaskNode => ({ id, state, ...extra });
const ctx = (tasks: TaskNode[], extra: Partial<FactCtx> = {}): FactCtx => ({
    byId: new Map(tasks.map((t) => [t.id, t])),
    digest: undefined,
    mergeReady: new Set(),
    nowMs: 10 * 60_000,
    ...extra,
});

describe("kindOf / wordOf / glyphKind", () => {
    it("treats a gated done task as needing you", () => {
        const t = task("t-1", "done", { gate: true });
        expect(kindOf(t)).toBe("attention");
        expect(wordOf(t)).toBe("at gate");
        expect(glyphKind(t)).toBe("attention");
    });
    it("names the compound states in words", () => {
        expect(wordOf(task("t", "blocked-merge"))).toBe("merge blocked");
        expect(wordOf(task("t", "verify-failed"))).toBe("verify failed");
    });
    it("maps every state to its glyph", () => {
        expect(["done", "failed", "stalled", "verify-failed", "running", "verifying", "ready", "skipped", "pending"].map((s) => glyphKind(task("t", s)))).toEqual([
            "done", "failed", "stalled", "attention", "running", "live", "ready", "inert", "waiting",
        ]);
    });
    it("reads an unknown state as waiting", () => {
        expect(kindOf(task("t", "mystery"))).toBe("waiting");
    });
});

describe("factOf", () => {
    it("says how long a running task has run, its tool and its attempt", () => {
        const t = task("t-1", "running", { firstactivity: 4 * 60_000, latesttool: "Edit", attempts: 2 });
        expect(factOf(t, ctx([t]))).toBe("6m · Edit · attempt 2");
    });
    it("says starting before any activity", () => {
        const t = task("t-1", "running");
        expect(factOf(t, ctx([t]))).toBe("starting");
    });
    it("tells merged, merge-ready and awaiting-merge apart", () => {
        const a = task("a", "done", { merged: true });
        const b = task("b", "done");
        const c = task("c", "done");
        const c2 = ctx([a, b, c], { mergeReady: new Set(["b"]) });
        expect([factOf(a, c2), factOf(b, c2), factOf(c, c2)]).toEqual(["merged", "merge ready", "awaiting merge"]);
    });
    it("names what a waiting task waits on, counting a skipped dependency as finished", () => {
        const deps = ["t-1", "t-2", "t-3"].map((id) => task(id, "running"));
        const skipped = task("t-4", "skipped");
        const w = task("t-9", "pending", { deps: ["t-1", "t-3", "t-4"] });
        expect(factOf(w, ctx([...deps, skipped, w]))).toBe("waits on t-1, t-3");
        const many = task("t-8", "pending", { deps: ["a", "b", "c", "d", "e"] });
        const five = ["a", "b", "c", "d", "e"].map((id) => task(id, "pending"));
        expect(factOf(many, ctx([...five, many]))).toBe("waits on 5 tasks");
        const free = task("t-7", "ready", { deps: ["t-4"] });
        expect(factOf(free, ctx([skipped, free]))).toBe("next to start");
    });
    it("says a waiting task asked you", () => {
        const t = task("t-1", "pending");
        expect(factOf(t, ctx([t], { digest: { taskid: "t-1", waitreason: "ask", mergestate: "", cleanupstate: "" } }))).toBe("asked you");
    });
    it("shows the first line of a failed Verify", () => {
        const t = task("t-1", "verify-failed", { verifyerror: "exit 1: FAIL\nmore" });
        expect(factOf(t, ctx([t]))).toBe("exit 1: FAIL");
    });
});

describe("relatives / edgeStyle", () => {
    const tasks = [task("a", "done"), task("b", "running", { deps: ["a"] }), task("c", "pending", { deps: ["b"] }), task("x", "failed")];
    const byId = new Map(tasks.map((t) => [t.id, t]));
    it("collects ancestors and descendants", () => {
        const r = relatives(tasks, "b");
        expect([...r.up]).toEqual(["a"]);
        expect([...r.down]).toEqual(["c"]);
    });
    it("styles edges by their endpoints", () => {
        expect(edgeStyle(byId.get("a")!, byId.get("b")!, null)).toEqual({ kind: "live", dashed: false, faded: false });
        expect(edgeStyle(byId.get("b")!, byId.get("c")!, null)).toEqual({ kind: "waiting", dashed: true, faded: false });
        expect(edgeStyle(byId.get("a")!, byId.get("x")!, null)).toEqual({ kind: "needs-you", dashed: true, faded: false });
        expect(edgeStyle(byId.get("a")!, task("d", "done"), null)).toEqual({ kind: "satisfied", dashed: false, faded: false });
    });
    it("marks the focused task's path and fades the rest only while selected", () => {
        const focus = { id: "b", rel: relatives(tasks, "b"), selected: true };
        expect(edgeStyle(byId.get("a")!, byId.get("b")!, focus).kind).toBe("path");
        expect(edgeStyle(byId.get("b")!, byId.get("c")!, focus)).toEqual({ kind: "path", dashed: true, faded: false });
        expect(edgeStyle(byId.get("a")!, byId.get("x")!, focus).faded).toBe(true);
        expect(edgeStyle(byId.get("a")!, byId.get("x")!, { ...focus, selected: false }).faded).toBe(false);
    });
});

describe("graphKey", () => {
    // a -> b, a -> c, b -> d; column 1 holds b (y 0) and c (y 100)
    const tasks = [{ id: "a" }, { id: "b", deps: ["a"] }, { id: "c", deps: ["a"] }, { id: "d", deps: ["b"] }];
    const layer = new Map([["a", 0], ["b", 1], ["c", 1], ["d", 2]]);
    const pos = new Map([["a", { x: 0, y: 50 }], ["b", { x: 244, y: 0 }], ["c", { x: 244, y: 100 }], ["d", { x: 488, y: 0 }]]);
    const key = (k: string, selected: string | null) => graphKey(k, { tasks, selected, layer, pos });
    it("steps through plan order with j and k, clamped", () => {
        expect(key("j", "a")).toEqual({ kind: "select", id: "b" });
        expect(key("k", "a")).toEqual({ kind: "none" });
    });
    it("follows edges with left and right, to the nearest in y, ties to the earlier task", () => {
        // b (y 0) and c (y 100) are both 50 from a (y 50): b comes first in plan order
        expect(key("ArrowRight", "a")).toEqual({ kind: "select", id: "b" });
        expect(key("ArrowRight", "b")).toEqual({ kind: "select", id: "d" });
        expect(key("ArrowLeft", "c")).toEqual({ kind: "select", id: "a" });
        expect(key("ArrowRight", "d")).toEqual({ kind: "none" });
    });
    it("moves within a column with up and down", () => {
        expect(key("ArrowDown", "b")).toEqual({ kind: "select", id: "c" });
        expect(key("ArrowUp", "b")).toEqual({ kind: "none" });
    });
    it("selects the first task when nothing is selected", () => {
        expect(key("ArrowLeft", null)).toEqual({ kind: "select", id: "a" });
    });
    it("fits and zooms", () => {
        expect(key("f", null)).toEqual({ kind: "fit" });
        expect(key("=", null)).toEqual({ kind: "zoom", factor: ZOOM_STEP });
        expect(key("-", null)).toEqual({ kind: "zoom", factor: 1 / ZOOM_STEP });
        expect(key("x", null)).toEqual({ kind: "none" });
    });
});

describe("chipGroups / pickNext", () => {
    const tasks = [task("a", "failed"), task("b", "running"), task("c", "stalled"), task("d", "pending")];
    it("counts only the non-empty groups, need-you first", () => {
        expect(chipGroups(tasks).map((g) => [g.key, g.count])).toEqual([["attention", 2], ["live", 1], ["waiting", 1]]);
    });
    it("cycles through a group", () => {
        expect(pickNext(tasks, ["attention"], null)).toBe("a");
        expect(pickNext(tasks, ["attention"], "a")).toBe("c");
        expect(pickNext(tasks, ["attention"], "c")).toBe("a");
        expect(pickNext(tasks, ["done"], null)).toBeNull();
    });
});

describe("fitScale / openView / nodeInView", () => {
    const pane = { w: 900, h: 700 };
    const row = (n: number) => new Map(Array.from({ length: n }, (_, i) => [`t-${i}`, { x: i * 244, y: 0 }]));
    it("fits a small graph at 1:1", () => {
        expect(fitScale(row(2), pane, false)).toBe(1);
        expect(fitScale(new Map(), pane, false)).toBe(1);
    });
    it("fits everything while that stays above the floor", () => {
        const tasks = [task("t-0", "running"), task("t-1", "pending")];
        expect(openView(tasks, row(2), pane, false).fitIds).toBeNull();
    });
    it("fits the tasks that need you at the floor when everything would be too small", () => {
        const tasks = Array.from({ length: 8 }, (_, i) => task(`t-${i}`, i === 5 ? "failed" : i === 6 ? "running" : "done"));
        expect(openView(tasks, row(8), pane, false)).toEqual({ fitIds: ["t-5"], minZoom: ZOOM_FLOOR });
        const settled = tasks.map((t) => ({ ...t, state: "done" }));
        expect(openView(settled, row(8), pane, false)).toEqual({ fitIds: null, minZoom: ZOOM_FLOOR });
    });
    it("knows whether a node is comfortably on screen", () => {
        expect(nodeInView({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 100 }, pane)).toBe(true);
        expect(nodeInView({ x: 0, y: 0, zoom: 1 }, { x: 800, y: 100 }, pane)).toBe(false);
    });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run frontend/app/view/orchestrate/dagcanvas.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement `dagcanvas.ts`** to the rules above. Start the file with the copyright header and
  this comment: `// The Route DAG canvas as data: what a node says about its task, how an edge is drawn, where a key
  moves the selection, and how the graph opens. Ported from the design canvas (dag-visualizer/Main.dc.html).`
  Constant tables are module-level (`KIND`, `WORD`, `CHIP_GROUPS` with labels "need you", "working", "done",
  "waiting" (kinds waiting + ready), "skipped").

- [ ] **Step 4: Add `hoveredTaskAtom` to `dagstore.ts`** directly below `selectedTaskIdAtom`, with the comment
  `// the task under the pointer, and which pane it is under: a graph hover lights its path and its timeline rows,
  a timeline hover only its node`.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run frontend/app/view/orchestrate/dagcanvas.test.ts frontend/app/view/orchestrate/dagstore.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/orchestrate/dagcanvas.ts frontend/app/view/orchestrate/dagcanvas.test.ts frontend/app/view/orchestrate/dagstore.ts
git commit -m "feat(orchestrate): dag canvas vocabulary, edge styles, key navigation and opening view"
```

### Task 3: Description lead for the hover peek
**Depends on:** none

Ports the block scan from the mockup's `mdBlocks` and `mdLead` (Main.dc.html lines 306-345) as a function
that returns markdown source for the existing `InlineMarkdown` (D6). `mdInline` and `mdView` are NOT ported.

**Files:**
- Create: `frontend/app/view/orchestrate/dagdescription.ts`
- Create: `frontend/app/view/orchestrate/dagdescription.test.ts`

**Interfaces:**
- Produces:
  - `export const LEAD_FILES_MAX = 4;`
  - `export type DescBlock = { kind: "p" | "h" | "li" | "code"; depth: number; text: string; check: "" | "done" | "open" };`
  - `export function descriptionBlocks(src: string | undefined): DescBlock[]`
  - `export function descriptionLead(src: string | undefined): { lead: string; more: boolean }`: `lead` is markdown source; `more` is true when the description has more than one block.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { descriptionBlocks, descriptionLead } from "./dagdescription";

describe("descriptionBlocks", () => {
    it("splits paragraphs, headings, list items and fences", () => {
        const b = descriptionBlocks("Intro line\ncontinued.\n\n## Head\n- [ ] step one\n  - nested\n```\ncode\n```");
        expect(b.map((x) => [x.kind, x.depth, x.check])).toEqual([
            ["p", 0, ""],
            ["h", 0, ""],
            ["li", 0, "open"],
            ["li", 1, ""],
            ["code", 0, ""],
        ]);
        expect(b[0].text).toBe("Intro line continued.");
    });
});

describe("descriptionLead", () => {
    it("leads with the first prose paragraph, skipping bare labels", () => {
        const r = descriptionLead("**Context:**\n\nSpec section 1.1. Today `workerContract` tells workers.\n\n**Files:**\n- Modify: `a.go`");
        expect(r).toEqual({ lead: "Spec section 1.1. Today `workerContract` tells workers.", more: true });
    });
    it("names the files a plan that opens on Files: touches", () => {
        const src = "**Files:**\n- Modify: `a.ts`\n- Modify: `b.ts` (why)\n- Test: `c.test.ts`\n- Create: `d.ts`\n- Create: `e.ts`\n  - `nested.ts`\n\nLater prose.";
        expect(descriptionLead(src).lead).toBe("Touches `a.ts`, `b.ts`, `c.test.ts`, `d.ts` +1 more");
    });
    it("does not count task boxes as files", () => {
        expect(descriptionLead("**Files:**\n- `a.ts`\n- [ ] **Step 1**").lead).toBe("Touches `a.ts`");
    });
    it("falls back to later prose when Files: has no list", () => {
        expect(descriptionLead("**Files:**\n\nThe prose.").lead).toBe("The prose.");
        expect(descriptionLead("**Files:**").lead).toBe("");
    });
    it("is empty for no description", () => {
        expect(descriptionLead(undefined)).toEqual({ lead: "", more: false });
        expect(descriptionLead("  ")).toEqual({ lead: "", more: false });
    });
    it("keeps a one-paragraph description's lead without more", () => {
        expect(descriptionLead("Just this.")).toEqual({ lead: "Just this.", more: false });
    });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run frontend/app/view/orchestrate/dagdescription.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The hover peek's glance at a task description. About half the real plans open straight on **Files:**, so
// those lead with the files the task touches instead of a bare label. Returns markdown source: InlineMarkdown
// renders it, as Markdown renders the full description in the detail rail.

export const LEAD_FILES_MAX = 4;

export type DescBlock = { kind: "p" | "h" | "li" | "code"; depth: number; text: string; check: "" | "done" | "open" };

const INDENT = 2;

export function descriptionBlocks(src: string | undefined): DescBlock[] {
    const blocks: DescBlock[] = [];
    let para: DescBlock | null = null;
    let fence: DescBlock | null = null;
    const flush = () => {
        if (para) blocks.push(para);
        para = null;
    };
    for (const line of (src ?? "").replace(/\r/g, "").split("\n")) {
        if (fence) {
            if (/^\s*```/.test(line)) {
                blocks.push(fence);
                fence = null;
            } else fence.text += (fence.text ? "\n" : "") + line;
            continue;
        }
        const f = line.match(/^(\s*)```/);
        if (f) {
            flush();
            fence = { kind: "code", depth: Math.floor(f[1].length / INDENT), text: "", check: "" };
            continue;
        }
        if (!line.trim()) {
            flush();
            continue;
        }
        const h = line.match(/^#{1,6}\s+(.*)/);
        if (h) {
            flush();
            blocks.push({ kind: "h", depth: 0, text: h[1], check: "" });
            continue;
        }
        const li = line.match(/^(\s*)([-*]|\d+\.)\s+(\[[ xX]\]\s+)?(.*)/);
        if (li) {
            flush();
            const check = li[3] ? (/x/i.test(li[3]) ? "done" : "open") : "";
            para = { kind: "li", depth: Math.floor(li[1].length / INDENT), text: li[4], check };
            continue;
        }
        if (para && (para.kind === "p" || /^\s/.test(line))) {
            para.text += " " + line.trim();
            continue;
        }
        flush();
        para = { kind: "p", depth: 0, text: line.trim(), check: "" };
    }
    flush();
    if (fence) blocks.push(fence);
    return blocks;
}

const isLabel = (b: DescBlock) => b.kind === "p" && /^\*\*[^*]+:\*\*$/.test(b.text.trim());
const isFiles = (b: DescBlock) => b.kind === "p" && /^\*\*Files:\*\*$/.test(b.text.trim());

export function descriptionLead(src: string | undefined): { lead: string; more: boolean } {
    const blocks = descriptionBlocks(src);
    const more = blocks.length > 1;
    const prose = blocks.findIndex((b) => b.kind === "p" && !isLabel(b));
    const files = blocks.findIndex(isFiles);
    if (files < 0 || (prose >= 0 && prose < files)) return { lead: prose >= 0 ? blocks[prose].text : "", more };
    const paths: string[] = [];
    for (let i = files + 1; i < blocks.length && blocks[i].kind === "li" && !blocks[i].check; i++) {
        const m = blocks[i].text.match(/`([^`]+)`/);
        if (m && blocks[i].depth === 0) paths.push(m[1]);
    }
    if (paths.length === 0) return { lead: prose >= 0 ? blocks[prose].text : "", more };
    const shown = paths.slice(0, LEAD_FILES_MAX).map((p) => `\`${p}\``).join(", ");
    const rest = paths.length > LEAD_FILES_MAX ? ` +${paths.length - LEAD_FILES_MAX} more` : "";
    return { lead: `Touches ${shown}${rest}`, more };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run frontend/app/view/orchestrate/dagdescription.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/orchestrate/dagdescription.ts frontend/app/view/orchestrate/dagdescription.test.ts
git commit -m "feat(orchestrate): peek lead line from a task description"
```

### Task 4: Timeline grouping, snippets, gaps and the activity strip
**Depends on:** none

Ports the mockup's lifecycle vocabulary and `groupEvents` (Main.dc.html lines 428-509, and the strip at
lines 1058-1062) onto real `RunEvent`s (D8). Attention comes from `ATTENTION_KINDS`; titles from
`eventKindTitle`; the mockup's own `ATTN`, `GOOD`, `START` and `KIND_TITLE` are replaced as described below.

**Files:**
- Create: `frontend/app/view/orchestrate/timelinegroups.ts`
- Create: `frontend/app/view/orchestrate/timelinegroups.test.ts`
- Modify: `frontend/app/view/orchestrate/timelinefilter.ts` (export the existing private `taskIdOf`, line 46)

**Interfaces:**
- Consumes: `ATTENTION_KINDS`, `taskIdOf(event: RunEvent): string`, `type TimelineFilter` from `./timelinefilter`; `detailOf`, `eventKindTitle` from `../agents/runtimeline`.
- Produces:
  - `export const BURST_MS = 3 * 60_000; export const QUIET_MS = 5 * 60_000;`
  - `export type Phase = "work" | "review" | "land";`
  - `export function phaseOf(kind: string): Phase`
  - `export function priority(kind: string): number`
  - `export const SUPERSEDED: Record<string, string[]>`
  - `export function stepLabel(kind: string): string`
  - `export type EventGroup = { id: string; taskId: string; items: RunEvent[]; first: number; last: number; head: RunEvent; attention: boolean; steps: RunEvent[] };`: `items` oldest first; `first`/`last` are ms.
  - `export function groupEvents(events: RunEvent[]): EventGroup[]`: newest first.
  - `export function filterGroups(groups: EventGroup[], filter: TimelineFilter, selectedTaskId: string | null): EventGroup[]`
  - `export type RailRow = { kind: "gap"; minutes: number } | { kind: "group"; group: EventGroup };`
  - `export function railRows(groups: EventGroup[]): RailRow[]`
  - `export function snippetOf(e: RunEvent): string`
  - `export function groupSnippet(g: EventGroup): string`: the head's snippet, else the first non-empty item snippet.
  - `export function eventDetail(e: RunEvent): { text: string; pre: string }`
  - `export type StripTick = { id: string; frac: number; attention: boolean; taskId: string };`
  - `export function stripTicks(events: RunEvent[], nowMs: number): StripTick[]`: `frac` in [0,1] from the first event's ts to `nowMs`.
  - `export type GlyphName = "play" | "eye" | "merge" | "shield" | "check" | "msg" | "bell" | "alert" | "skip";`
  - `export function glyphOf(kind: string): GlyphName`
  - `export const GLYPH_PATHS: Record<GlyphName, string>`: the SVG path data of the mockup's `G` (line 435), on a 24x24 viewBox.

Rules:
- `phaseOf`: `/review/` gives review; `/done|merge|cleanup|verify/` gives land; else work.
- `priority`:
  - `task-first-activity` is 0.5; `ATTENTION_KINDS` is 4.
  - `task-merged` and `task-verify-passed` are 3.
  - The landed set (`task-done`, `task-review-passed`, `dag-plan-approved`, `task-cleanup-completed`, `task-merge-continued`) is 2.
  - The started set (`task-spawned`, `task-review-started`, `task-verify-started`, `task-merge-started`) is 1.
  - Everything else is 0. These sets rank a burst's head; they are not tones.
- `SUPERSEDED`: exactly the mockup's table (line 434), with every value as an array.
- `stepLabel`: the mockup's `STEP` table (line 429), with any "✓"/"✗" replaced by the words "passed"/"failed" (so "verify passed", "cleanup done"), falling back to `eventKindTitle(kind)`.
- `groupEvents`:
  - Sort a copy by `ts`; the sort is stable. The key is `` `${taskId}:${phaseOf(kind)}` `` for a task event, else `` `dag:${kind}` ``.
  - An event joins its key's open group when `ts - group.last <= BURST_MS`; otherwise it starts a new group with id `` `${key}@${index}` ``.
  - The head is the highest `priority`, with the later event winning ties.
  - `attention` is true when any item is in `ATTENTION_KINDS`.
  - `steps` are the items that no other kind in the group supersedes.
  - The result is sorted by `last` descending.
- `filterGroups`: `attention` keeps groups with `attention`; `task` keeps the selected task's groups, or none with no selection; `all` keeps every group.
- `railRows`: a `gap` row goes between consecutive groups when `prev.first - next.last >= QUIET_MS`; `minutes` is `Math.round(... / 60_000)`.
- `snippetOf`: the mockup's function (line 463), reading `detailOf<Record<string, unknown>>(e)`. `secs(ms)` is `m` minutes and `s` seconds at a minute or more, else seconds to one decimal. It strips `github.com/wavetermdev/waveterm/` from Verify output and turns tabs into spaces. A missing or malformed detail gives "".
- `eventDetail`:
  - A `task-verify-failed` with detail `detail` gives `{ text: "", pre: <shortened detail> }`.
  - A detail with `note` or `downstream` gives those joined by a blank line.
  - Anything else gives `{ text: snippetOf(e), pre: "" }`.
- `glyphOf`: the mockup's `glyphOf` (line 448), with `ATTN.has(kind) && kind !== "task-retried"` replaced by `ATTENTION_KINDS.has(kind)`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
    eventDetail,
    filterGroups,
    glyphOf,
    groupEvents,
    groupSnippet,
    phaseOf,
    railRows,
    snippetOf,
    stepLabel,
    stripTicks,
} from "./timelinegroups";

const MIN = 60_000;
let seq = 0;
const ev = (min: number, kind: string, taskid?: string, extra: Record<string, unknown> = {}): RunEvent => ({
    id: `e${seq++}`,
    runid: "r",
    channelid: "c",
    ts: min * MIN,
    kind,
    detail: JSON.stringify(taskid ? { taskid, ...extra } : extra),
});

describe("phaseOf", () => {
    it("puts review, landing and work kinds in their phases", () => {
        expect(["task-review-started", "task-verify-failed", "task-merged", "task-spawned"].map(phaseOf)).toEqual(["review", "land", "land", "work"]);
    });
});

describe("groupEvents", () => {
    it("bursts one phase of one task within 3 minutes into a row, newest row first", () => {
        const g = groupEvents([
            ev(0, "task-spawned", "t-1"),
            ev(1, "task-first-activity", "t-1"),
            ev(10, "task-done", "t-1"),
            ev(11, "task-verify-started", "t-1"),
            ev(12, "task-verify-passed", "t-1"),
            ev(12.5, "task-merged", "t-1"),
        ]);
        expect(g.map((x) => x.items.length)).toEqual([4, 2]);
        expect(g[0].head.kind).toBe("task-merged");
        expect(g[0].steps.map((e) => e.kind)).toEqual(["task-done", "task-verify-passed", "task-merged"]);
        expect(g[1].steps.map((e) => e.kind)).toEqual(["task-spawned"]);
    });
    it("splits a phase after a pause longer than the burst window", () => {
        expect(groupEvents([ev(0, "task-spawned", "t-1"), ev(4, "task-told", "t-1")])).toHaveLength(2);
    });
    it("flags a burst holding an attention event and heads it with that event", () => {
        const g = groupEvents([ev(0, "task-verify-started", "t-2"), ev(1, "task-verify-failed", "t-2")]);
        expect(g[0].attention).toBe(true);
        expect(g[0].head.kind).toBe("task-verify-failed");
    });
    it("sorts out-of-order events and treats a row without a task as dag-level", () => {
        const bad: RunEvent = { id: "x", runid: "r", channelid: "c", ts: 0, kind: "dag-blocked", detail: "{not json" };
        const g = groupEvents([ev(2, "task-spawned", "t-1"), bad]);
        expect(g.map((x) => x.taskId)).toEqual(["t-1", ""]);
    });
});

describe("filterGroups / railRows", () => {
    const groups = groupEvents([ev(0, "task-spawned", "t-1"), ev(20, "task-failed", "t-2")]);
    it("filters by attention and by the selected task", () => {
        expect(filterGroups(groups, "attention", null).map((g) => g.taskId)).toEqual(["t-2"]);
        expect(filterGroups(groups, "task", "t-1").map((g) => g.taskId)).toEqual(["t-1"]);
        expect(filterGroups(groups, "task", null)).toEqual([]);
        expect(filterGroups(groups, "all", null)).toHaveLength(2);
    });
    it("marks a quiet stretch of 5 minutes or more", () => {
        expect(railRows(groups).map((r) => r.kind)).toEqual(["group", "gap", "group"]);
        expect(railRows(groups)[1]).toEqual({ kind: "gap", minutes: 20 });
    });
});

describe("snippetOf / eventDetail", () => {
    it("picks the failing package from Verify output", () => {
        const e = ev(0, "task-verify-failed", "t-1", { detail: "exit 1: FAIL\nFAIL\tgithub.com/wavetermdev/waveterm/cmd/wsh/cmd\t4.8s" });
        expect(snippetOf(e)).toBe("FAIL cmd/wsh/cmd 4.8s");
        expect(eventDetail(e).pre).toContain("cmd/wsh/cmd");
    });
    it("reports spawn timing and the merge commit", () => {
        expect(snippetOf(ev(0, "task-spawned", "t", { worktreems: 1200, setupms: 65000, spawnms: 300 }))).toBe("worktree 1.2s · setup 1m 5s · spawn 0.3s");
        expect(snippetOf(ev(0, "task-merged", "t", { commit: "f00dcafe12345678" }))).toBe("commit f00dcafe");
    });
    it("falls back to the first item with a snippet", () => {
        const g = groupEvents([ev(0, "task-spawned", "t", { worktreems: 1000 }), ev(1, "task-first-activity", "t")]);
        expect(groupSnippet(g[0])).toBe("worktree 1.0s · setup 0.0s · spawn 0.0s");
    });
    it("is empty for a row with no detail", () => {
        expect(snippetOf({ id: "x", runid: "r", channelid: "c", ts: 0, kind: "task-merged" })).toBe("");
    });
});

describe("stepLabel / glyphOf / stripTicks", () => {
    it("labels steps in words", () => {
        expect(stepLabel("task-verify-passed")).toBe("verify passed");
        expect(stepLabel("dag-done")).not.toBe("");
    });
    it("gives attention kinds the alert glyph", () => {
        expect(glyphOf("task-failed")).toBe("alert");
        expect(glyphOf("task-review-started")).toBe("eye");
        expect(glyphOf("task-merged")).toBe("merge");
    });
    it("places every event on the run's time axis", () => {
        const t = stripTicks([ev(0, "task-spawned", "t-1"), ev(5, "task-failed", "t-1")], 10 * MIN);
        expect(t.map((x) => [x.frac, x.attention])).toEqual([[0, false], [0.5, true]]);
    });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run frontend/app/view/orchestrate/timelinegroups.test.ts`
Expected: FAIL.

- [ ] **Step 3: Export `taskIdOf` from `timelinefilter.ts`** (change `function taskIdOf` to `export function taskIdOf`;
  no other change), then implement `timelinegroups.ts` to the rules above. Header comment:
  `// The lifecycle rail's rows as data: bursts of one phase of one task, the steps worth showing in each, a
  one-line snippet, quiet gaps and the activity strip. Attention is ATTENTION_KINDS and titles are
  runtimeline's, so this rail and the run body's timeline cannot disagree about either.`

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run frontend/app/view/orchestrate/timelinegroups.test.ts frontend/app/view/orchestrate/timelinefilter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/orchestrate/timelinegroups.ts frontend/app/view/orchestrate/timelinegroups.test.ts frontend/app/view/orchestrate/timelinefilter.ts
git commit -m "feat(orchestrate): group lifecycle events into bursts with snippets, gaps and a strip"
```

### Task 5: Node card, lane band, routed edge and hover peek components
**Depends on:** Task 1, Task 2, Task 3

The graph's rendered pieces as ReactFlow node and edge types (D2, D3, D6, D7), in a new file. Match
`NodeStates.dc.html` for each state's fill, border, glyph and word colour (the mockup's `look` and `glyph`,
Main.dc.html lines 372-395), translated to tokens per Global Constraints. This task does not wire them
into the canvas; Task 7 does.

**Files:**
- Create: `frontend/app/view/orchestrate/dagnodes.tsx`

**Interfaces:**
- Consumes:
  - From Task 1: `CARD_W`, `CARD_H`, `edgeGeo`, `type Point`, `type Rect`.
  - From Task 2: `kindOf`, `wordOf`, `glyphKind`, `type NodeKind`, `type GlyphKind`, `type EdgeStyle`.
  - From Task 3: `descriptionLead`.
  - Existing: `taskPeek` (`./dagpeek`), `Tooltip` (`@/app/element/tooltip`), `InlineMarkdown` (`../agents/inlinemarkdown`), `ActivityLine` (`../agents/statusline`), `runAtom`, `dagModalAgentsContextAtom`, `resolveTaskWorker`.
- Produces:
  - `export type DagCardData = { task: TaskNode; view: DagViewNode; fact: string; selected: boolean; dimmed: boolean; hovered: boolean; digestTask: DagTaskDigest | undefined; briefs: Map<string, TaskBrief>; onHover: (id: string | null) => void };`
  - `export function DagCardNode(props: NodeProps): JSX.Element`: node type `dagTask`.
  - `export type LaneBandData = { rect: Rect; dimmed: boolean };`
  - `export function LaneBandNode(props: NodeProps): JSX.Element`: node type `laneBand`, non-interactive.
  - `export type RoutedEdgeData = { via: Point[]; style: EdgeStyle };`
  - `export function RoutedEdge(props: EdgeProps): JSX.Element`: edge type `routed`.
  - `export const dagNodeTypes = { dagTask: DagCardNode, laneBand: LaneBandNode };`
  - `export const dagEdgeTypes = { routed: RoutedEdge };`
  - `export const PEEK_OPEN_DELAY_MS = 400;` (copied from daggraph.tsx; do not edit daggraph.tsx in this task, Task 7 deletes the original)

Component requirements:
- **DagCardNode:** a fixed `CARD_W x CARD_H` box (`w-[196px] h-[64px]`) with `data-dag-node-route` exactly as today (`${view.route.source}:${view.route.runtime}:${view.route.model}`) and `data-dag-node={task.id}`.
  - A 14px SVG state glyph from `glyphKind`, with the mockup's ring, fill and mark paths. `running` pulses using the existing `animate-pulse`, which honours reduced motion through `MotionConfig`.
  - The label clamps to 2 lines (`line-clamp-2`) at 12.5px, coloured by kind.
  - One mono line at 10.5px: `id · word · fact`, with the word coloured by kind.
  - Selected: `border-accent` plus a 1px accent ring. Hovered, when not attention: `bg-surface-hover`. Dimmed: `opacity-40`.
  - `aria-label` of `${id} ${label}, ${word}, ${fact}`, and no `title` attribute anywhere.
  - ReactFlow `Handle`s at `Position.Left` (target) and `Position.Right` (source), made invisible (`!opacity-0`). The custom edge does not use them, but ReactFlow needs them to render edges.
  - It wraps the card in `Tooltip` exactly as today's `DagTaskNode` does (`placement="right"`, `openDelay={PEEK_OPEN_DELAY_MS}`, content `TaskPeekCard`).
  - It calls `data.onHover(task.id)` on pointer enter and `data.onHover(null)` on pointer leave.
- **TaskPeekCard:** copy it here from daggraph.tsx (lines 147-195, with its `NO_RUN_ATOM` / `NO_TICK_ATOM`
  stable atoms). Leave the original in daggraph.tsx: this task does not touch that file, so the typecheck stays
  clean, and Task 7 deletes the original.
  - Replace the `peek.description` block with `descriptionLead(task.description)`, rendered as `<div className="line-clamp-4 text-[11.5px] text-secondary"><InlineMarkdown text={lead} plainLinks /></div>` when `lead` is non-empty.
  - Keep the activity line, the rows and the Verify section, restyled to 10.5px mono (Verify tail `text-[10.5px]`).
  - Add the footer hint from D6 in `text-[10.5px] text-ink-faint`, choosing its text by `more`.
- **LaneBandNode:** an absolutely sized, dashed `border-edge-mid` rounded rectangle (`rect.w x rect.h`), labelled "lane · one merge" at 10.5px mono `text-ink-faint` in its top-left, with `pointer-events-none`. Dimmed gives `opacity-40`.
- **RoutedEdge:** read both endpoints' live positions with `useInternalNode(source)` / `useInternalNode(target)` (`internals.positionAbsolute`), so a dragged node's edges follow. Draw `edgeGeo(p, q, data.via)` as a `<path>` plus the filled `head`.
  - Stroke by `style.kind`:
    - satisfied and waiting: `var(--color-ink-faint)`.
    - live: `var(--color-accent)`.
    - needs-you: `color-mix(in srgb, var(--color-warning) 70%, transparent)`.
    - path: `var(--color-accent-soft)`.
  - Width is 2 on the path, else 1.5. Dashes: `4 4` when waiting, `5 4` for needs-you and for a dashed path. Opacity is 0.2 when faded.

- [ ] **Step 1: Create `dagnodes.tsx`** with the components above. Pull the glyph geometry from the mockup's
  `glyph()` (Main.dc.html line 383): a circle of r 5.25 at 7,7 in a 14x14 viewBox; the `mark` paths per kind.
  - done: `M4.2 7.3l1.9 1.9 3.7-4.1`, success fill, background stroke.
  - failed: `M5 5l4 4M9 5l-4 4`, warning fill, on-warning stroke.
  - stalled: `M5.7 4.6v4.8M8.3 4.6v4.8`.
  - attention: `M7 3.9v3.7M7 9.7v.5`.
  - running: `M7 4.6a2.4 2.4 0 1 0 .01 0Z`, accent fill.
  - live: `M7 1.75a5.25 5.25 0 0 1 0 10.5Z`, accent fill.
  - ready: accent ring only.
  - inert: `M3.8 10.2l6.4-6.4`, muted stroke.
  - waiting: an ink-faint ring only.
- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Confirm no `title` and no sub-10.5px text in the new file**

Run: `grep -nE 'title=|text-xxx?s|text-\[(8|9|10)(\.[0-9])?px\]' frontend/app/view/orchestrate/dagnodes.tsx`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/orchestrate/dagnodes.tsx
git commit -m "feat(orchestrate): dag node card, lane band, routed edge and peek components"
```

### Task 6: Detail rail component with the description toggle
**Depends on:** none

Moves the selected task's rail out of `daggraph.tsx` into its own component and adds the Description
toggle (D5). This task does not edit `daggraph.tsx`; it copies the code it needs. Task 7 switches the
canvas over and deletes the originals.

**Files:**
- Create: `frontend/app/view/orchestrate/dagdetailrail.tsx`

**Interfaces:**
- Consumes (existing): `dagActionError`, `dagActionRoute`, `routeSourceLabel`, `selectedTaskIdAtom`, `type DagViewNode` (`./dagstore`); `escalatePayload` (`./escalate`); `RoutePicker`; `StatusLine`; `resolveTaskWorker`, `openTaskWorker`, `type TaskWorkerView` (`./taskcorrelate`); `closeDagModal`, `dagModalAgentsContextAtom` (`./dagmodalstate`); `Markdown` (`@/app/element/markdown`); `RpcApi`, `TabRpcClient`, `WOS`, `globalStore`.
- Produces:
  - `export function DagDetailRail(props: { group: TaskGroup; view: DagViewNode; task: TaskNode; descOpen: boolean; onToggleDesc: () => void }): JSX.Element`
  - `export async function openTaskFromGraph(task: TaskNode): Promise<void>`: a copy of daggraph.tsx lines 530-535 and its `openFromGraph` helper.

Requirements (layout per the mockup's detail rail):
- Header line: id and state in 10.5px mono `text-ink-mid`, the label at 13px `text-ink-hi`, and the route line in the existing `data-dag-node-route` form (keep the attribute) plus `wave/<runid>` at 10.5px mono.
- Actions: the same buttons, the escalate `RoutePicker` flow, `runAction` / `runEscalate` and the error handling as daggraph.tsx lines 289-306 and 459-520. Copy them verbatim, then restyle to 11.5px. The escalate note text is 10.5px.
  - The escalate / action-error state (`escalating`, `escalateRoute`, `actionError`) lives inside the rail. Reset it when `view.id` changes, with a `useEffect` keyed on `view.id`, so selecting another task closes a half-open picker.
- The worker line: `SelectedTaskWorker`, moved from daggraph.tsx lines 200-254, restyled to 10.5px.
- The Description toggle: a button with `aria-expanded={descOpen}` and a chevron, labelled "Description", shown only when `task.description` is non-blank.
  - Open, it renders `<Markdown text={task.description} scrollable fontSizeOverride={12} />` inside a `max-h-[232px] min-h-0 overflow-y-auto` region. The 232px is the mockup's `RAIL_H_DESC - RAIL_H`; name it `DESC_MAX_PX` with that reason as the comment.
  - Links open through `Markdown`'s default opener.
- No `title` attributes on anything that sits over a node. Buttons may keep `aria-label`.

- [ ] **Step 1: Create `dagdetailrail.tsx`** per the requirements.
- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (`daggraph.tsx` is untouched and still compiles).

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/orchestrate/dagdetailrail.tsx
git commit -m "feat(orchestrate): dag detail rail with actions, worker line and description"
```

### Task 7: Wire the canvas: layout, interactions, keys, zoom floor, persistence, Esc
**Depends on:** Task 1, Task 2, Task 5, Task 6

Rewrites `DagGraphInner` in `daggraph.tsx` to use the new modules and components (D1, D4, D5, D7, D9, D10,
D13), makes Esc clear the selection before closing (D4), deletes the old layout, and updates the
keyboard docs.

**Files:**
- Modify: `frontend/app/view/orchestrate/daggraph.tsx` (replace the node, peek, rail and layout code; keep `DagGraphView`, the `ReactFlowProvider` wrapper, `DagGraphHeader`, and the "Run route" strip)
- Modify: `frontend/app/view/orchestrate/daggraph-header.tsx` (add the summary chips)
- Modify: `frontend/app/view/orchestrate/dagmodal.tsx` (Escape handler, lines 31-37; `ModalSubtitle`'s `text-xxs`, line 116)
- Modify: `scripts/cdp/orchestrator-e2e.mjs` (step "14-run-body", lines 412-415: send Escape twice)
- Modify: `frontend/app/view/orchestrate/dagmodalstate.ts` (add `escapeDagModal`)
- Modify: `frontend/app/view/orchestrate/dagmodalstate.test.ts`
- Modify: `frontend/app/view/orchestrate/daglayout.ts`, `daglayout.test.ts` (delete `computeLayeredLayout`, `LayoutOpts` and their `describe`)
- Modify: `docs/keyboard-shortcuts.md` (Route DAG section, line 152)

**Interfaces:**
- Consumes:
  - Task 1: `computeLayout`, `lanesOf`, `laneBand`, `edgeKey`, `dagLayoutOffsetsAtom`, `applyOffsets`, `withOffsets`.
  - Task 2: `factOf`, `relatives`, `edgeStyle`, `graphKey`, `chipGroups`, `pickNext`, `openView`, `nodeInView`, `kindOf`, `ZOOM_MIN`, `ZOOM_MAX`, `hoveredTaskAtom`.
  - Task 5: `dagNodeTypes`, `dagEdgeTypes`, `type DagCardData`, `type LaneBandData`, `type RoutedEdgeData`.
  - Task 6: `DagDetailRail`, `openTaskFromGraph`.
- Produces: `export function escapeDagModal(): void` in `dagmodalstate.ts`. It clears `selectedTaskIdAtom` when a task is selected, else calls `closeDagModal()`.

Requirements:
- **Layout:** memoise `computeLayout(group.tasks)` and `lanesOf(group.tasks)` on the task id/deps shape only (a key from `tasks.map(t => t.id + ":" + (t.deps ?? []).join(","))`), so a state change does not re-run the layout.
  - Positions are `applyOffsets(layout.pos, store[group.oid]?.offsets)`, where `store = useAtom(dagLayoutOffsetsAtom)`.
  - Bands are `laneBand(ids, positions)` for lanes of length at least 2, as `laneBand` nodes with `zIndex: -1`, `selectable: false`, `draggable: false`, and `focusable: false`.
- **Nodes:** `type: "dagTask"` with `DagCardData`.
  - `fact` comes from `factOf` (`nowMs` from `agentsCtx.model.nowAtom` when present, else `Date.now()` at render).
  - `dimmed` is true when a task is selected and the node is neither it nor in its `relatives`.
  - `hovered` is true when `hoveredTaskAtom?.id` is this node.
  - `onHover` sets `hoveredTaskAtom` to `{ id, from: "graph" }`, or null. On null it only clears the atom while `from === "graph"`.
- **Edges:** `type: "routed"`, `data: { via: layout.via.get(edgeKey(d, t.id)) ?? [], style }`.
  - The style is `edgeStyle(src, dst, focus)`. Focus is the selection, or else a graph hover, with `selected` true only for the selection.
- **ReactFlow props:**
  - `nodesDraggable`, `nodesConnectable={false}`, `elementsSelectable={false}`, `disableKeyboardA11y`, `zoomOnDoubleClick={false}`.
  - `minZoom={ZOOM_MIN}`, `maxZoom={ZOOM_MAX}`, and `panOnDrag` (the default), so dragging empty canvas pans.
  - Keep `onNodeClick` (select), `onNodeDoubleClick` (the `openTaskFromGraph` from Task 6), and `onPaneClick` (clear the selection).
  - `onNodeDragStop` writes `withOffsets(store, group.oid, offsetsFromPositions, Date.now())`, where offsets are each moved node's position minus `layout.pos`. Keep only nodes whose offset is non-zero.
  - Drive `nodes` through `useNodesState` / `onNodesChange` so drags render live; the edges follow through `useInternalNode`.
- **Opening view:** the first time a group's nodes render (per dag oid), run `openView(tasks, positions, pane, lanes.some(l => l.length > 1))` with `pane` measured from the canvas container (`getBoundingClientRect`).
  - Then call `fitView({ padding: 0.1, minZoom, maxZoom: 1, nodes: fitIds?.map(id => ({ id })) })` (all nodes when `fitIds` is null).
  - `f` and the fit button call `fitView({ padding: 0.1, minZoom: ZOOM_MIN, maxZoom: 1 })`.
- **Zoom cluster:** keep the three buttons, with `aria-label`s "Fit graph", "Zoom in" and "Zoom out" (the `title`s may stay: they are not on nodes).
  - Replace the unicode glyphs with small SVG icons at `text-ink-mid`.
  - Show the zoom percentage (`Math.round(zoom*100)%`, 10.5px mono) from `useViewport()`.
  - A "Reset layout" button appears when the dag has a stored entry. It writes `withOffsets(store, group.oid, {}, Date.now())` and refits.
- **Keys:** replace the j/k `useEffect` with `graphKey`.
  - Skip when a modifier is held or `isEditableTarget(document.activeElement)`.
  - `select` sets `selectedTaskIdAtom` and focuses `[data-dag-node="<id>"]`'s ReactFlow wrapper without scrolling. `fit` fits. `zoom` calls `zoomTo(clamp(zoom*factor))`.
  - Enter keeps the existing `enterOpensTask` path. Call `preventDefault` only when the key was handled.
- **Pan into view:** when the selection changes, or the description toggles, and `!nodeInView(viewport, pos, pane)`, call `setCenter(pos.x + CARD_W/2, pos.y + CARD_H/2, { zoom, duration: 200 })`.
- **Detail rail:** render `DagDetailRail` below the canvas when a task is selected. `descOpen` is `useState` in `DagGraphInner`, reset to false when the selection changes.
- **Header chips (daggraph-header.tsx):** render `chipGroups(group.tasks)` as buttons: a coloured dot, then `${count} ${label}` at 11.5px. A click runs `pickNext(group.tasks, g.kinds, selected)` and selects the result.
  - Chips may keep `title="Select the next task that is <label>"`: they are not on nodes.
- **Delete** from daggraph.tsx: `STATE_TONE`, `DagTaskNode`, `DagTaskCard`, `TaskPeekCard`, `SelectedTaskWorker`, the inline rail, `openTaskFromGraph`, `openFromGraph`, `runEscalate`, `runAction`, `NO_TICK_ATOM` if unused, `PEEK_OPEN_DELAY_MS`, and the `computeLayeredLayout` import.
  - Delete `computeLayeredLayout` and `LayoutOpts` from `daglayout.ts`, and the old `describe("computeLayeredLayout")` block (and its import names) from `daglayout.test.ts`.
- **Esc (dagmodal.tsx):** the Escape branch calls `escapeDagModal()` instead of `closeDagModal()`. The Close button still calls `closeDagModal()`.
- **Subtitle (dagmodal.tsx):** `ModalSubtitle`'s `text-xxs` becomes `text-[10.5px]` (D11).
- **orchestrator-e2e.mjs step "14-run-body":** step 13 clicked a node, so that task is selected and one Escape
  now only clears the selection. Send the keyDown/keyUp Escape pair twice, with `await sleep(200)` between the pairs,
  and update the step's comment to say the first Escape clears the selection and the second closes the modal.
- **Docs (docs/keyboard-shortcuts.md):** replace the Route DAG table with:

```markdown
| Keys | Action |
|---|---|
| `j` / `k` | Next / previous task, in plan order |
| `←` / `→` | Follow an edge to the nearest dependency / dependent |
| `↑` / `↓` | Previous / next task in the same column |
| `Enter` (or double-click a task) | Open the task's worker in the Agent surface, or its child run once the session is gone |
| `f` | Fit the whole graph |
| `+` / `-` | Zoom in / out |
| `Esc` | Clear the selection; with nothing selected, close the graph |

Resting the pointer on a task shows its peek: the full title, the description's first paragraph (or the files
it touches), what it is waiting on, its latest activity, and why it failed. Drag a task to move it (its place is
kept for that run until Reset layout); drag empty canvas to pan. A dashed band marks a lane: tasks that merge as one.
```

- [ ] **Step 1: Write the failing Esc test** (append to `dagmodalstate.test.ts`)

```ts
describe("escapeDagModal", () => {
    it("clears a selection before it closes the modal", () => {
        openDagTask("c", "r", "dag:x", "t-1");
        escapeDagModal();
        expect(globalStore.get(selectedTaskIdAtom)).toBeNull();
        expect(globalStore.get(dagModalStateAtom)).not.toBeNull();
        escapeDagModal();
        expect(globalStore.get(dagModalStateAtom)).toBeNull();
    });
});
```

(Add `escapeDagModal`, `openDagTask` and `dagModalStateAtom` to the file's import from `./dagmodalstate`,
`selectedTaskIdAtom` from `./dagstore`, and `globalStore` from `@/app/store/jotaiStore`, reusing whichever of
these the file already imports.)

Run: `npx vitest run frontend/app/view/orchestrate/dagmodalstate.test.ts`
Expected: FAIL, `escapeDagModal` is not exported.

- [ ] **Step 2: Implement `escapeDagModal`** in `dagmodalstate.ts`:

```ts
// escapeDagModal is Esc inside the modal: a selection is the nearer thing to dismiss, so it goes first
export function escapeDagModal(): void {
    if (globalStore.get(selectedTaskIdAtom) != null) {
        resetSelection();
        return;
    }
    closeDagModal();
}
```

Run: `npx vitest run frontend/app/view/orchestrate/dagmodalstate.test.ts`
Expected: PASS.

- [ ] **Step 3: Rewrite `daggraph.tsx`, update the header, dagmodal.tsx and daglayout.ts / its test, and update the docs** per the requirements.
- [ ] **Step 4: Typecheck and run the orchestrate tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run frontend/app/view/orchestrate/daglayout.test.ts frontend/app/view/orchestrate/dagmodalstate.test.ts frontend/app/view/orchestrate/dagstore.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the native tooltip is gone and no sub-10.5px text remains**

Run: `grep -nE 'title=\{view|text-xxx?s|text-\[(8|9|10)(\.[0-9])?px\]' frontend/app/view/orchestrate/daggraph.tsx frontend/app/view/orchestrate/daggraph-header.tsx frontend/app/view/orchestrate/dagmodal.tsx`
Expected: no output.

Run: `node --check scripts/cdp/orchestrator-e2e.mjs`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/orchestrate/daggraph.tsx frontend/app/view/orchestrate/daggraph-header.tsx frontend/app/view/orchestrate/dagmodal.tsx frontend/app/view/orchestrate/dagmodalstate.ts frontend/app/view/orchestrate/dagmodalstate.test.ts frontend/app/view/orchestrate/daglayout.ts frontend/app/view/orchestrate/daglayout.test.ts docs/keyboard-shortcuts.md scripts/cdp/orchestrator-e2e.mjs
git commit -m "feat(orchestrate): left-to-right Route DAG canvas with drag, keys, zoom floor and detail rail"
```

### Task 8: Lifecycle timeline rail
**Depends on:** Task 2, Task 4

Rebuilds `timelinerail.tsx` on `timelinegroups.ts` (D8), and moves the observability e2e script off DOM-shape
selectors. Match the mockup's lifecycle rail for layout: header, strip, filters, spine, rows and expanded
detail.

**Files:**
- Modify: `frontend/app/view/orchestrate/timelinerail.tsx`
- Modify: `scripts/cdp/orchestrator-observability-e2e.mjs` (steps "lifecycle-history", line 196, and "event-deeplink", line 223)

**Interfaces:**
- Consumes:
  - Task 4: `groupEvents`, `filterGroups`, `railRows`, `groupSnippet`, `eventDetail`, `stepLabel`, `glyphOf`, `GLYPH_PATHS`, `stripTicks`, `type EventGroup`.
  - Task 2: `hoveredTaskAtom`.
  - Existing: `eventClickTarget`, `ATTENTION_KINDS`, `type TimelineFilter`, `eventTitle`, `toneFor`, `tsLabel`, `relaunchLeadAction`, `useRunEventsState`, `retryRunEvents`, `selectedTaskIdAtom`.
- Produces: `TimelineRail` keeps its props, `{ channelId, runId, layout }`, and its `data-timeline-rail={layout}`.

Requirements:
- **Header:** "Lifecycle" at 10.5px mono uppercase, the event count, and `StatusPill`, with its text raised to 10.5px. The drawer toggle is kept for `layout === "drawer"`.
- **Activity strip:** under the header, a full-width SVG of `stripTicks(events, nowMs)`.
  - Tick heights: attention 20, a success-toned kind 12, and other kinds 5 to 9. Tick colour is the kind's `toneFor` class applied as `currentColor`.
  - While a task is selected, or hovered from the graph, that task's ticks are at full opacity and the rest at 0.2.
  - Below it: the start `tsLabel`, then the run span, then "now", at 10.5px mono `text-ink-faint`. It has an `aria-label` like the mockup's `stripLabel`.
  - `nowMs` comes from `dagModalAgentsContextAtom`'s `model.nowAtom` when present, else `Date.now()`.
- **Filters:** All / Task / Attention with counts from `filterGroups(...).length`.
  - The Task count is shown only with a selection; its label is `Task · <id>` as today.
  - The Attention count is `text-warning` when non-zero.
  - Keep `aria-pressed`.
- **Rows:** `railRows(filterGroups(groupEvents(events), filter, selectedTaskId))`, newest first, under a "now" marker row.
  - The marker is shown unless the Task filter is empty.
- **Gap rows:** `N min quiet`, at 10.5px mono `text-ink-faint`, centred between rules.
- **Group rows:** a `<button type="button" data-timeline-row data-timeline-task={group.taskId || undefined} aria-expanded={open}>`.
  - A 20px spine glyph (`GLYPH_PATHS[glyphOf(head.kind)]`), coloured by `toneFor(head.kind)`, with an attention fill of `bg-warning/10 border-warning/55` when `group.attention`.
  - The title `eventTitle(head)`, at 12px `text-ink-hi`, or `text-warning` for attention.
  - The task chip: `bg-accent/12 text-accent-soft` when it is the selected task, else `bg-pill text-ink-mid`.
  - The time: `tsLabel(first)`, or a range `tsLabel(first)–tsLabel(last)` when they differ.
  - Step chips (`stepLabel`, coloured by `toneFor`) when `steps.length > 1`, and `groupSnippet(group)` on one truncated line at 10.5px mono.
  - Row hover sets `hoveredTaskAtom` to `{ id: taskId, from: "timeline" }`, and clears it on leave only while `from === "timeline"`.
  - A graph hover (`from: "graph"`) on the row's task gives the row `bg-surface-hover`.
  - No `border-l-2`.
- **Click a row:** toggle it open (one open at a time, in `useState`), and call `applyTarget(eventClickTarget(group.head), channelId)` (keep `applyTarget` as is).
- **Expanded detail:** under the row, one entry per item, newest first: `tsLabel`, `eventTitle`, and `eventDetail(e)` (text as `whitespace-pre-line`, pre as a `max-h-[160px] overflow-auto` mono block at 10.5px).
  - When `relaunchLeadAction(item, events, relaunching)` is non-null for any item, the Relaunch lead button and its error render there, as `EventDetail` does today.
  - The old bottom `EventDetail` panel is removed.
- **Empty states:** keep `EmptyRows`' texts and the loading skeleton.
- No text below 10.5px: remove every `text-xxxs` and `text-[9px]` from the file.
- **e2e:** in `orchestrator-observability-e2e.mjs`, "lifecycle-history" reads rows as `[...panel.querySelectorAll('[data-timeline-row]')]`. It checks there is at least 1 row, not `<= 3`, and drops the `- 3` filter adjustment in its message.
  - "event-deeplink" picks the first `[data-timeline-task]` row and reads its task from `getAttribute('data-timeline-task')`.
  - "narrow-drawer" finds the toggle as the header's `button[aria-expanded]` that is not a `[data-timeline-row]`.

- [ ] **Step 1: Rewrite `timelinerail.tsx`** per the requirements.
- [ ] **Step 2: Update the e2e selectors** per the requirements.
- [ ] **Step 3: Typecheck and run the timeline tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run frontend/app/view/orchestrate/timelinegroups.test.ts frontend/app/view/orchestrate/timelinefilter.test.ts`
Expected: PASS.

- [ ] **Step 4: Confirm the ribbon and small text are gone**

Run: `grep -nE 'border-l-2|text-xxx?s|text-\[(8|9|10)(\.[0-9])?px\]' frontend/app/view/orchestrate/timelinerail.tsx`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/orchestrate/timelinerail.tsx scripts/cdp/orchestrator-observability-e2e.mjs
git commit -m "feat(orchestrate): lifecycle rail with bursts, activity strip, quiet gaps and filter counts"
```

### Task 9: CDP checks for the redesigned modal
**Depends on:** Task 7, Task 8

Extends the `dag-lifecycle` scenario (`scripts/cdp/scenarios.mjs`, `name: "dag-lifecycle"`, line 3659) so
the Final stage proves the behaviours unit tests cannot (D7, D12). Insert the new steps after step 5's
`h.shot("cdp-shots/dag-modal.png")` (line 3844) and before step 6's Escape.

**Files:**
- Modify: `scripts/cdp/scenarios.mjs`

Steps to add (each a `rec(label, pass, JSON.stringify(evidence))`, in the file's existing style; scope every
query to `[data-dag-modal-kind]`, per the memory note on unscoped button queries):

- [ ] **Step 1: "5a. No node carries a native tooltip"**:
  `document.querySelectorAll('[data-dag-modal-kind] .react-flow__node [title]').length === 0`.
- [ ] **Step 2: "5b. Hover opens the peek"**:
  - Dispatch `pointerover`, `pointerenter`, `mouseover` and `mouseenter` (bubbling) on the first `[data-dag-node]`, then wait 700ms.
  - Pass when `document.querySelector('[data-dag-peek]')` exists and no element under `.react-flow__node` has a `title`.
  - Then dispatch `pointerleave` and `mouseleave`.
- [ ] **Step 3: "5c. Dependents sit to the right of their dependencies"**:
  - Read the dag from `h.rpc("dagstatus", …)`. For each `task.deps` pair, compare the two nodes' `getBoundingClientRect().left` through `[data-dag-node="<id>"]`.
  - Pass when every dependent's left is greater. Evidence: the pairs.
- [ ] **Step 4: "5d. Esc clears a selection before closing"**:
  - Click the first `[data-dag-node]` and wait 200ms. Dispatch Escape on `window`, as step 6 does, and wait 300ms.
  - Pass when `[data-dag-modal-kind]` still exists and no `[data-dag-node]` wrapper has the selected border (read `selectedTaskIdAtom` through the dev fixture if simpler).
  - Step 6's single Escape then closes the modal as before.
- [ ] **Step 5: Keep the lifecycle rail check honest:** after 5d, assert `document.querySelectorAll('[data-dag-modal-kind] [data-timeline-row]').length > 0` as "5e. Timeline rows render".
- [ ] **Step 6: Syntax check**

Run: `node --check scripts/cdp/scenarios.mjs`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add scripts/cdp/scenarios.mjs
git commit -m "test(cdp): dag modal hover peek, no native tooltip, left-to-right order and Esc"
```
