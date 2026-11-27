// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: the Run tab's Graph view. Lanes lays a dag out as git-graph lanes over its transitively reduced edges; Focus
// shows one task's own deps and dependents; In flight picks the tasks worth a jump. The tab's graph state (mode, the
// one selection, the Focus back trail) moves only through the transitions below, which the view and Esc share.

import { formatElapsed } from "@/app/view/orchestrate/dagdigest";
import { workerAsk } from "./runlineage";
import { detailOf } from "./runtimeline";
import { tabKey, type RunGraphState, type WorkspaceState } from "./workspacemodel";
import { taskDots, taskRunMs, unmetTaskDeps, type RowDot } from "./workspaceruntabmodel";

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

// a row's label at the board's left: what the centre waits on, what follows it; over a stage node, no count
export function focusRowLabel(view: FocusView, side: "up" | "down"): string {
    if (side === "up") {
        return view.upStage ? "waits on" : `waits on ${view.up.length + view.upMore.length}`;
    }
    return view.downStage ? "then" : `then ${view.down.length + view.downMore.length}`;
}

export interface FocusBox {
    // a task's id; "" for a stage
    id: string;
    side: "up" | "centre" | "down";
    stage?: "plan-review" | "final";
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface FocusLayout {
    boxes: FocusBox[];
    edges: { d: string; arrow: string }[];
    // the last row's bottom
    height: number;
}

// the run-graph-focus boards: rows from 20px down, 190 x 52 neighbours 30px apart, a centre up to 440px, 40px arrows
// ending 4px short of their card. A row keeps LABEL_W clear on both sides, so its label never covers a card and the
// row stays centred under the centre card.
const FOCUS_TOP = 20;
const NODE_W = 190;
const NODE_H = 52;
const NEIGHBOUR_GAP = 30;
const CENTRE_MAX_W = 440;
const ARROW_LEN = 40;
const ARROW_GAP = 4;
const ARROW_HEAD_W = 4.5;
const ARROW_HEAD_H = 6;
const EDGE_BEND = 24;
const LABEL_W = 64;
const MORE_W = 96;

function placeRow(
    ids: string[],
    side: "up" | "down",
    y: number,
    more: boolean,
    width: number,
    stage?: FocusBox["stage"]
): FocusBox[] {
    const n = ids.length;
    const extra = more ? MORE_W : 0;
    const room = width - 2 * LABEL_W;
    const w = Math.min(NODE_W, (room - (n - 1) * NEIGHBOUR_GAP - extra) / n);
    const span = n * w + (n - 1) * NEIGHBOUR_GAP + extra;
    return ids.map((id, i) => ({
        id,
        side,
        stage,
        x: width / 2 - span / 2 + i * (w + NEIGHBOUR_GAP),
        y,
        w,
        h: NODE_H,
    }));
}

// from a's bottom centre to just above b's top centre: straight when aligned, else the boards' s-curve
function edgeOf(a: FocusBox, b: FocusBox): { d: string; arrow: string } {
    const [x1, y1, x2, y2] = [a.x + a.w / 2, a.y + a.h, b.x + b.w / 2, b.y - ARROW_GAP];
    const d =
        Math.abs(x1 - x2) < 0.5
            ? `M${x2} ${y1} V${y2}`
            : `M${x1} ${y1} C${x1} ${y1 + EDGE_BEND}, ${x2} ${y2 - EDGE_BEND}, ${x2} ${y2}`;
    const arrow = `M${x2 - ARROW_HEAD_W} ${y2 - ARROW_HEAD_H} L${x2} ${y2} L${x2 + ARROW_HEAD_W} ${y2 - ARROW_HEAD_H}`;
    return { d, arrow };
}

// Focus's boxes top down: the up row, the centre at its measured height, the down row; a row with nothing in it (a
// stage the run does not have) takes no space, and the board is as tall as its last row
export function focusLayout(
    view: FocusView,
    { width, centreH, planReview, final }: { width: number; centreH: number; planReview: boolean; final: boolean }
): FocusLayout {
    const step = ARROW_LEN + ARROW_GAP;
    const upIds = view.upStage ? (planReview ? [""] : []) : view.up;
    const downIds = view.downStage ? (final ? [""] : []) : view.down;
    const ups = placeRow(
        upIds,
        "up",
        FOCUS_TOP,
        view.upMore.length > 0,
        width,
        view.upStage ? "plan-review" : undefined
    );
    const centreW = Math.min(CENTRE_MAX_W, width);
    const centre: FocusBox = {
        id: view.centre,
        side: "centre",
        x: width / 2 - centreW / 2,
        y: ups.length > 0 ? FOCUS_TOP + NODE_H + step : FOCUS_TOP,
        w: centreW,
        h: centreH,
    };
    const downY = centre.y + centreH + step;
    const downs = placeRow(
        downIds,
        "down",
        downY,
        view.downMore.length > 0,
        width,
        view.downStage ? "final" : undefined
    );
    return {
        boxes: [...ups, centre, ...downs],
        edges: [...ups.map((u) => edgeOf(u, centre)), ...downs.map((d) => edgeOf(centre, d))],
        height: downs.length > 0 ? downY + NODE_H : centre.y + centreH,
    };
}

export function inFlight(planOrder: string[], kind: (id: string) => string): string[] {
    return IN_FLIGHT_ORDER.flatMap((k) => planOrder.filter((id) => kind(id) === k)).slice(0, IN_FLIGHT_MAX);
}

export interface GraphNode {
    id: string;
    name: string;
    deps: string[];
    dot: RowDot;
    // the canvas's short word
    word: string;
    // "4m" working or asked, "1m ago" failed; "" merged, waiting, or with nothing to time from
    time: string;
    // a waiting task's deps neither merged nor done
    waitsOn: string[];
}

const SHORT_WORD: Record<RowDot, string> = {
    merged: "merged",
    working: "working",
    asked: "asked the lead",
    failed: "failed",
    waits: "waits",
};

const FAILURE_EVENTS = new Set(["task-failed", "task-verify-failed", "task-review-failed", "task-merge-failed"]);

function lastFailureTs(events: RunEvent[], taskId: string): number | undefined {
    const ts = events
        .filter((e) => FAILURE_EVENTS.has(e.kind) && detailOf<{ taskid?: string }>(e)?.taskid === taskId)
        .map((e) => e.ts);
    return ts.length > 0 ? Math.max(...ts) : undefined;
}

function nodeTime(task: TaskNode, dot: RowDot, digest: DagStatusDigest | undefined, events: RunEvent[], now: number) {
    const since = (ts: number) => formatElapsed(Math.max(0, now - ts));
    const ran = () => {
        const ms = taskRunMs(task, digest, now);
        return ms == null ? "" : formatElapsed(ms);
    };
    if (dot === "working") {
        return ran();
    }
    if (dot === "asked") {
        return task.askts ? since(task.askts) : ran();
    }
    if (dot === "failed") {
        const at = lastFailureTs(events, task.id);
        return at == null ? "" : `${since(at)} ago`;
    }
    return "";
}

// graphNodes is every task in plan order with its dot, short word and time; a question with the user says so
export function graphNodes(
    dag: TaskGroup | undefined,
    digest: DagStatusDigest | undefined,
    events: RunEvent[],
    now: number
): GraphNode[] {
    const tasks = dag?.tasks ?? [];
    const dots = taskDots(dag, digest);
    const byId = new Map(tasks.map((t) => [t.id, t] as const));
    return tasks.map((t) => {
        const dot = dots[t.id];
        const yours = dot === "asked" && workerAsk(digest, t.id)?.owner === "you";
        return {
            id: t.id,
            name: t.label || t.id,
            deps: t.deps ?? [],
            dot,
            word: yours ? "asking you" : SHORT_WORD[dot],
            time: nodeTime(t, dot, digest, events, now),
            waitsOn: dot === "waits" ? unmetTaskDeps(t, byId) : [],
        };
    });
}

// the word with its time, "working · 4m": the Focus centre's state
export function timedWord(node: GraphNode): string {
    return node.time ? `${node.word} · ${node.time}` : node.word;
}

// a Lanes row's text: what a waiting task waits on, else its word and time
export function laneWord(node: GraphNode): string {
    if (node.dot === "waits" && node.waitsOn.length > 0) {
        return `waits on ${node.waitsOn.join(", ")}`;
    }
    return timedWord(node);
}

// a task's dot is its In flight kind: asked, failed and working are the ones worth a jump
export function flightIds(nodes: GraphNode[]): string[] {
    const dot = new Map(nodes.map((n) => [n.id, n.dot]));
    return inFlight(
        nodes.map((n) => n.id),
        (id) => dot.get(id)
    );
}

export const LANES: RunGraphState = { mode: "lanes", focus: null, trail: [] };

// an In flight chip or a Lanes row: Focus on the task, a fresh trail
export function focusOn(id: string): RunGraphState {
    return { mode: "focus", focus: id, trail: [] };
}

// a Focus move to a neighbour, so back returns to where it came from
export function moveTo(g: RunGraphState, id: string): RunGraphState {
    return { mode: "focus", focus: id, trail: g.focus ? [...g.trail, g.focus] : g.trail };
}

export function backFrom(g: RunGraphState): RunGraphState {
    return g.trail.length === 0 ? g : { ...g, focus: g.trail[g.trail.length - 1], trail: g.trail.slice(0, -1) };
}

// Lanes keeps the selection, which stays tinted there
export function toLanes(g: RunGraphState | undefined): RunGraphState {
    return { ...(g ?? LANES), mode: "lanes" };
}

// the Focus switch returns to the selection; with none, to fallback
export function toFocus(g: RunGraphState | undefined, fallback: string): RunGraphState {
    const base = g ?? LANES;
    return { ...base, mode: "focus", focus: base.focus ?? fallback };
}

// moment 10's side: forward into Focus or deeper, back out to Lanes or up the trail
export function stepDir(prev: RunGraphState | undefined, next: RunGraphState): number {
    if (next.mode === "lanes") {
        return -1;
    }
    if (prev == null || prev.mode === "lanes") {
        return 1;
    }
    return next.trail.length < prev.trail.length && next.focus === prev.trail[prev.trail.length - 1] ? -1 : 1;
}

// the task the run's DAG opens on: the focused one in Focus, else none
export function dagFocusTask(g: RunGraphState | undefined): string | null {
    return g?.mode === "focus" ? g.focus : null;
}

// the active tab's key while it is a run tab on Graph in Focus and on screen: Esc returns it to Lanes then
export function graphEscapeKey(ws: WorkspaceState): string | null {
    if (ws.collapsed || ws.active == null) {
        return null;
    }
    const tab = ws.tabs.find((t) => tabKey(t) === ws.active);
    return tab?.kind === "run" && tab.view === "graph" && tab.graph?.mode === "focus" && tab.graph.focus != null
        ? ws.active
        : null;
}
