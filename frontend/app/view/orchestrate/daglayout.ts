// Layered (longest-path) layout for the dag graph. Pure: same input, same positions.
export interface LayoutOpts {
    width?: number;
    height?: number;
    gapX?: number;
    gapY?: number;
}

export function computeLayeredLayout(
    tasks: { id: string; deps?: string[] }[],
    opts: LayoutOpts = {}
): Map<string, { x: number; y: number }> {
    const { width = 168, height = 64, gapX = 28, gapY = 48 } = opts;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const layer = new Map<string, number>();
    const visit = (id: string): number => {
        const cached = layer.get(id);
        if (cached !== undefined) return cached;
        const t = byId.get(id)!;
        let l = 0;
        for (const d of t.deps ?? []) l = Math.max(l, visit(d) + 1);
        layer.set(id, l);
        return l;
    };
    for (const t of tasks) visit(t.id);
    const byLayer = new Map<number, string[]>();
    for (const t of tasks) {
        const l = layer.get(t.id)!;
        byLayer.set(l, [...(byLayer.get(l) ?? []), t.id]);
    }
    const out = new Map<string, { x: number; y: number }>();
    for (const [l, ids] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
        const sorted = [...ids].sort();
        const total = sorted.length * width + (sorted.length - 1) * gapX;
        sorted.forEach((id, i) => {
            out.set(id, { x: -total / 2 + i * (width + gapX) + width / 2, y: l * (height + gapY) });
        });
    }
    return out;
}

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
        r.forEach(
            (id, i) =>
                (fwd[i] = i === 0 ? desired.get(id)! : Math.max(desired.get(id)!, fwd[i - 1] + sep(r[i - 1], id)))
        );
        for (let i = r.length - 1; i >= 0; i--)
            bwd[i] =
                i === r.length - 1
                    ? desired.get(r[i])!
                    : Math.min(desired.get(r[i])!, bwd[i + 1] - sep(r[i], r[i + 1]));
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
