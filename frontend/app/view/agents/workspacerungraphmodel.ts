// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: the Run tab's Graph view. Lanes lays a dag out as git-graph lanes over its transitively reduced edges; Focus
// shows one task's own deps and dependents; In flight picks the tasks worth a jump.

export type GraphTask = { id: string; deps?: string[] };

export interface LaneLayout {
    rows: string[];
    lane: Record<string, number>;
    laneCount: number;
    edges: [string, string][];
}

export interface FocusView {
    centre: string;
    up: string[];
    upMore: string[];
    down: string[];
    downMore: string[];
    upStage: boolean;
    downStage: boolean;
}

export const IN_FLIGHT_MAX = 5;
const FOCUS_MAX = 3;
const IN_FLIGHT_ORDER = ["asked", "failed", "working"];
// an edge bends into its child's lane over the last BEND px above the child's dot, as the canvas's gutter does
const BEND = 14;
const BEND_C1 = 4;
const BEND_C2 = 8;

function knownDeps(tasks: GraphTask[]): Map<string, string[]> {
    const ids = new Set(tasks.map((t) => t.id));
    return new Map(tasks.map((t) => [t.id, [...new Set(t.deps ?? [])].filter((d) => ids.has(d) && d !== t.id)]));
}

// [dep, dependent] for every dep not already reached through another of the dependent's deps
export function reduceDeps(tasks: GraphTask[]): [string, string][] {
    const deps = knownDeps(tasks);
    const ancestors = new Map<string, Set<string>>();
    // a cycle is not a dag the engine runs; the visiting guard only keeps a bad one from recursing forever
    const visiting = new Set<string>();
    const ancestorsOf = (id: string): Set<string> => {
        const known = ancestors.get(id);
        if (known) return known;
        const out = new Set<string>();
        if (visiting.has(id)) return out;
        visiting.add(id);
        for (const d of deps.get(id) ?? []) {
            out.add(d);
            for (const a of ancestorsOf(d)) out.add(a);
        }
        visiting.delete(id);
        ancestors.set(id, out);
        return out;
    };
    const edges: [string, string][] = [];
    for (const t of tasks) {
        const own = deps.get(t.id) ?? [];
        for (const d of own) {
            if (!own.some((other) => other !== d && ancestorsOf(other).has(d))) edges.push([d, t.id]);
        }
    }
    return edges;
}

function adjacency(edges: [string, string][]): { up: Map<string, string[]>; down: Map<string, string[]> } {
    const up = new Map<string, string[]>();
    const down = new Map<string, string[]>();
    for (const [p, c] of edges) {
        down.set(p, [...(down.get(p) ?? []), c]);
        up.set(c, [...(up.get(c) ?? []), p]);
    }
    return { up, down };
}

// depth first: a ready child of the most recently placed task that still has one, else the next ready task in plan order
function orderRows(tasks: GraphTask[], up: Map<string, string[]>, down: Map<string, string[]>): string[] {
    const placed = new Set<string>();
    const rows: string[] = [];
    const ready = (id: string) => !placed.has(id) && (up.get(id) ?? []).every((p) => placed.has(p));
    while (rows.length < tasks.length) {
        let next: string | undefined;
        for (let i = rows.length - 1; i >= 0 && !next; i--) next = (down.get(rows[i]) ?? []).find(ready);
        next ??= tasks.find((t) => ready(t.id))?.id ?? tasks.find((t) => !placed.has(t.id))!.id;
        placed.add(next);
        rows.push(next);
    }
    return rows;
}

export function laneLayout(tasks: GraphTask[]): LaneLayout {
    const edges = reduceDeps(tasks);
    const { up, down } = adjacency(edges);
    const rows = orderRows(tasks, up, down);
    const rowOf = new Map(rows.map((id, i) => [id, i]));
    const lastChildRow = (id: string) => Math.max(rowOf.get(id)!, ...(down.get(id) ?? []).map((c) => rowOf.get(c)!));
    const lane: Record<string, number> = {};
    // heldUntil[l]: the last row lane l is held to, by the task now in it
    const heldUntil: number[] = [];
    rows.forEach((id, r) => {
        const inherited = (up.get(id) ?? []).filter((p) => lastChildRow(p) === r).map((p) => lane[p]);
        let l = inherited.length ? Math.min(...inherited) : heldUntil.findIndex((until) => until < r);
        if (l < 0) l = heldUntil.length;
        lane[id] = l;
        heldUntil[l] = lastChildRow(id);
    });
    return { rows, lane, laneCount: heldUntil.length, edges };
}

// svg d for an edge: down its parent's lane, curving into the child's lane just above the child's row
export function gutterPath(
    layout: LaneLayout,
    edge: [string, string],
    geo: { rowH: number; laneW: number; x0: number }
): string {
    const [p, c] = edge;
    const x = (id: string) => geo.x0 + layout.lane[id] * geo.laneW;
    const y = (id: string) => layout.rows.indexOf(id) * geo.rowH + geo.rowH / 2;
    const [xp, yp, xc, yc] = [x(p), y(p), x(c), y(c)];
    if (xp === xc) return `M${xp} ${yp} V${yc}`;
    return `M${xp} ${yp} V${yc - BEND} C${xp} ${yc - BEND_C1}, ${xc} ${yc - BEND_C2}, ${xc} ${yc}`;
}

// the task itself plus everything up and downstream of it
export function chainOf(edges: [string, string][], id: string): Set<string> {
    const { up, down } = adjacency(edges);
    const chain = new Set([id]);
    for (const graph of [up, down]) {
        const queue = [id];
        while (queue.length) {
            for (const next of graph.get(queue.pop()!) ?? []) {
                if (!chain.has(next)) {
                    chain.add(next);
                    queue.push(next);
                }
            }
        }
    }
    return chain;
}

function fold(ids: string[], max: number): [string[], string[]] {
    return ids.length > max ? [ids.slice(0, max - 1), ids.slice(max - 1)] : [ids, []];
}

export function focusView(tasks: GraphTask[], id: string, max = FOCUS_MAX): FocusView {
    const deps = knownDeps(tasks);
    const ups = deps.get(id) ?? [];
    const downs = tasks.filter((t) => (deps.get(t.id) ?? []).includes(id)).map((t) => t.id);
    const [up, upMore] = fold(ups, max);
    const [down, downMore] = fold(downs, max);
    return { centre: id, up, upMore, down, downMore, upStage: ups.length === 0, downStage: downs.length === 0 };
}

export function inFlight(planOrder: string[], kind: (id: string) => string): string[] {
    return IN_FLIGHT_ORDER.flatMap((k) => planOrder.filter((id) => kind(id) === k)).slice(0, IN_FLIGHT_MAX);
}
