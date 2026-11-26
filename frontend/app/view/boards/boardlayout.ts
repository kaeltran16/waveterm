// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Lays out the drawer's graph (spec D4-D7) and checks the overlap rule (D6). Pure: the caller supplies text
// measurement, so this module never loads the Excalidraw runtime.

import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { layout } from "dagre-d3-es/src/dagre/index.js";
import { Graph } from "dagre-d3-es/src/graphlib/index.js";

export type NodeShape = "rectangle" | "ellipse" | "diamond";

export interface GraphNode {
    id: string;
    label: string;
    shape?: NodeShape;
    group?: string;
    strokeColor?: string;
    backgroundColor?: string;
}

export interface GraphEdge {
    from: string;
    to: string;
    label?: string;
    dashed?: boolean;
    strokeColor?: string;
}

export interface GraphGroup {
    id: string;
    label: string;
}

export interface BoardGraph {
    direction?: "TB" | "LR" | "BT" | "RL";
    nodes: GraphNode[];
    edges?: GraphEdge[];
    groups?: GraphGroup[];
}

// one Excalifont 20px text, newlines kept
export type MeasureLabel = (text: string) => { width: number; height: number };

// Excalidraw wraps an arrow label at max(0.7 x the arrow's width, 220px); a vertical arrow is ~0 wide, so a line
// over 220px would re-wrap after layout and outgrow its slot
export const LABEL_MAX_WIDTH = 220;

const NODE_PADDING = 20; // between a node's label and the rectangle it would sit in
const EDGE_LABEL_MARGIN = 10; // around an arrow label's slot
const GROUP_PADDING = 16; // between a group's outline and its title
const NODE_SEP = 50;
const RANK_SEP = 60; // dagre halves it when edges carry labels, as a label takes its own rank
const EDGE_SEP = 20;
const MIX_GAP = 80; // between the graph and the drawer's own add shapes

// the rectangle a label needs, scaled to the box whose inner area holds that rectangle
const SHAPE_SCALE: Record<NodeShape, number> = { rectangle: 1, ellipse: Math.SQRT2, diamond: 2 };

// --- labels: Arc breaks lines, so the measured box is the box that lands

function fits(text: string, measure: MeasureLabel): boolean {
    return measure(text).width <= LABEL_MAX_WIDTH;
}

// a word too wide for one line breaks between characters, as Excalidraw's own wrap would
function splitWord(word: string, measure: MeasureLabel): string[] {
    if (fits(word, measure)) {
        return [word];
    }
    const pieces: string[] = [];
    let piece = "";
    for (const ch of Array.from(word)) {
        if (piece !== "" && !fits(piece + ch, measure)) {
            pieces.push(piece);
            piece = "";
        }
        piece += ch;
    }
    return [...pieces, piece];
}

function breakLine(line: string, measure: MeasureLabel): string[] {
    const lines: string[] = [];
    let current = "";
    const words = line.split(/\s+/).filter((w) => w !== "");
    for (const word of words.flatMap((w) => splitWord(w, measure))) {
        const next = current === "" ? word : `${current} ${word}`;
        if (current !== "" && !fits(next, measure)) {
            lines.push(current);
            current = word;
        } else {
            current = next;
        }
    }
    return [...lines, current];
}

interface Label {
    text: string;
    width: number;
    height: number;
}

function breakLabel(text: string, measure: MeasureLabel): Label {
    const broken = text
        .split("\n")
        .flatMap((line) => breakLine(line, measure))
        .join("\n");
    return { text: broken, ...measure(broken) };
}

// --- the laid-out graph is points: node, slot and title centers, group corners and arrow vertices. Opening room
// is a push of every point past a line, which keeps any two boxes that were apart apart and any box that held
// another holding it.

interface Pt {
    x: number;
    y: number;
}

type Axis = "x" | "y";

interface Placed {
    center: Pt;
    width: number;
    height: number;
}

interface Bounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

function push(points: Iterable<Pt>, axis: Axis, past: number, by: number): void {
    for (const p of points) {
        if (p[axis] > past) {
            p[axis] += by;
        }
    }
}

function placedBounds(p: Placed): Bounds {
    return {
        minX: p.center.x - p.width / 2,
        minY: p.center.y - p.height / 2,
        maxX: p.center.x + p.width / 2,
        maxY: p.center.y + p.height / 2,
    };
}

function union(bs: readonly Bounds[]): Bounds {
    return {
        minX: Math.min(...bs.map((b) => b.minX)),
        minY: Math.min(...bs.map((b) => b.minY)),
        maxX: Math.max(...bs.map((b) => b.maxX)),
        maxY: Math.max(...bs.map((b) => b.maxY)),
    };
}

function pointBounds(p: Pt): Bounds {
    return { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
}

// splits the longest segments until the path has `extra` more points; the drawn path does not change
function subdivide(path: Pt[], extra: number): Pt[] {
    const out = [...path];
    const len = (k: number) => Math.hypot(out[k + 1].x - out[k].x, out[k + 1].y - out[k].y);
    for (let n = 0; n < extra; n++) {
        let longest = 0;
        for (let i = 1; i < out.length - 1; i++) {
            longest = len(i) > len(longest) ? i : longest;
        }
        const [a, b] = [out[longest], out[longest + 1]];
        out.splice(longest + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
    return out;
}

// Excalidraw anchors a label on an arrow's middle point when the count is odd: pad the shorter side of the
// label's point so it is the middle one
function centeredOn(points: Pt[], label: Pt): Pt[] {
    const k = points.indexOf(label);
    const before = k;
    const after = points.length - 1 - k;
    const head = subdivide(points.slice(0, k + 1), Math.max(0, after - before));
    const tail = subdivide(points.slice(k), Math.max(0, before - after));
    return [...head, ...tail.slice(1)];
}

interface LaidEdge {
    edge: GraphEdge;
    points: Pt[];
    label: (Label & { center: Pt }) | null;
}

interface LaidGroup {
    group: GraphGroup;
    lo: Pt;
    hi: Pt;
    title: Label;
    titleCenter?: Pt;
}

interface Laid {
    nodes: { node: GraphNode; label: Label; at: Placed }[];
    edges: LaidEdge[];
    groups: LaidGroup[];
}

function nodeSize(node: GraphNode, label: Label): { width: number; height: number } {
    const scale = SHAPE_SCALE[node.shape ?? "rectangle"];
    return { width: (label.width + 2 * NODE_PADDING) * scale, height: (label.height + 2 * NODE_PADDING) * scale };
}

// dagre puts an edge's label center among its points; take that very point so a push moves both together
function labelPoint(points: Pt[], x: number, y: number): Pt {
    return points.reduce((best, p) => (Math.hypot(p.x - x, p.y - y) < Math.hypot(best.x - x, best.y - y) ? p : best));
}

function runDagre(graph: BoardGraph, measure: MeasureLabel): Laid {
    const g = new Graph({ multigraph: true, compound: true });
    g.setGraph({
        rankdir: graph.direction ?? "TB",
        nodesep: NODE_SEP,
        ranksep: RANK_SEP,
        edgesep: EDGE_SEP,
        marginx: 0,
        marginy: 0,
    });
    const groups = (graph.groups ?? []).map((group) => ({ group, title: breakLabel(group.label, measure) }));
    const hasMembers = (id: string) => graph.nodes.some((n) => n.group === id);
    for (const { group, title } of groups) {
        // an empty group is just its title in its outline
        const size = { width: title.width + 2 * GROUP_PADDING, height: title.height + 2 * GROUP_PADDING };
        g.setNode(group.id, hasMembers(group.id) ? {} : size);
    }
    const nodes = graph.nodes.map((node) => {
        const label = breakLabel(node.label, measure);
        g.setNode(node.id, nodeSize(node, label));
        if (node.group) {
            g.setParent(node.id, node.group);
        }
        return { node, label };
    });
    const edges = (graph.edges ?? []).map((edge, i) => {
        const label = edge.label ? breakLabel(edge.label, measure) : null;
        const slot = label
            ? {
                  width: label.width + 2 * EDGE_LABEL_MARGIN,
                  height: label.height + 2 * EDGE_LABEL_MARGIN,
                  labelpos: "c",
              }
            : {};
        g.setEdge(edge.from, edge.to, slot, String(i));
        return { edge, label, name: String(i) };
    });
    layout(g, {});
    return {
        nodes: nodes.map(({ node, label }) => {
            const n = g.node(node.id);
            return { node, label, at: { center: { x: n.x, y: n.y }, width: n.width, height: n.height } };
        }),
        edges: edges.map(({ edge, label, name }) => {
            const e = g.edge(edge.from, edge.to, name);
            const points: Pt[] = e.points.map((p: Pt) => ({ x: p.x, y: p.y }));
            return { edge, points, label: label ? { ...label, center: labelPoint(points, e.x, e.y) } : null };
        }),
        groups: groups.map(({ group, title }) => {
            const n = g.node(group.id);
            const lo = { x: n.x - n.width / 2, y: n.y - n.height / 2 };
            return { group, title, lo, hi: { x: lo.x + n.width, y: lo.y + n.height } };
        }),
    };
}

function allPoints(laid: Laid): Set<Pt> {
    return new Set<Pt>([
        ...laid.nodes.map((n) => n.at.center),
        ...laid.edges.flatMap((e) => e.points),
        ...laid.groups.flatMap((g) => [g.lo, g.hi, ...(g.titleCenter ? [g.titleCenter] : [])]),
    ]);
}

// D5: each group is widened to its title, and one with members grows a top band the title sits in
function placeTitles(laid: Laid, graph: BoardGraph): void {
    for (const g of laid.groups) {
        const short = g.title.width + 2 * GROUP_PADDING - (g.hi.x - g.lo.x);
        if (short > 0) {
            push(allPoints(laid), "x", (g.lo.x + g.hi.x) / 2, short);
        }
        if (graph.nodes.some((n) => n.group === g.group.id)) {
            push(allPoints(laid), "y", g.lo.y, g.title.height + GROUP_PADDING);
        }
        g.titleCenter = {
            x: g.lo.x + GROUP_PADDING + g.title.width / 2,
            y: g.lo.y + GROUP_PADDING + g.title.height / 2,
        };
    }
}

function laidBounds(laid: Laid): Bounds {
    return union([
        ...laid.nodes.map((n) => placedBounds(n.at)),
        ...laid.edges.flatMap((e) => [
            ...e.points.map(pointBounds),
            ...(e.label
                ? [
                      placedBounds({
                          center: e.label.center,
                          width: e.label.width + 2 * EDGE_LABEL_MARGIN,
                          height: e.label.height + 2 * EDGE_LABEL_MARGIN,
                      }),
                  ]
                : []),
        ]),
        ...laid.groups.map((g) => ({ minX: g.lo.x, minY: g.lo.y, maxX: g.hi.x, maxY: g.hi.y })),
    ]);
}

// optional style keys are left out rather than set undefined, so the converter's defaults apply
function styled<T extends object>(props: T, style: Record<string, string | undefined>): T {
    const set = Object.entries(style).filter(([, v]) => v != null);
    return { ...props, ...Object.fromEntries(set) };
}

function toSkeletons(laid: Laid): ExcalidrawElementSkeleton[] {
    const groups = laid.groups.flatMap((g) => [
        {
            type: "rectangle",
            id: g.group.id,
            x: g.lo.x,
            y: g.lo.y,
            width: g.hi.x - g.lo.x,
            height: g.hi.y - g.lo.y,
            strokeStyle: "dashed",
            backgroundColor: "transparent",
        },
        {
            type: "text",
            text: g.title.text,
            x: g.titleCenter.x - g.title.width / 2,
            y: g.titleCenter.y - g.title.height / 2,
        },
    ]);
    const nodes = laid.nodes.map(({ node, label, at }) =>
        styled(
            {
                type: node.shape ?? "rectangle",
                id: node.id,
                x: at.center.x - at.width / 2,
                y: at.center.y - at.height / 2,
                width: at.width,
                height: at.height,
                label: { text: label.text },
            },
            { strokeColor: node.strokeColor, backgroundColor: node.backgroundColor }
        )
    );
    const arrows = laid.edges.map(({ edge, points, label }) => {
        const path = label ? centeredOn(points, label.center) : points;
        const [x0, y0] = [path[0].x, path[0].y];
        const xs = path.map((p) => p.x - x0);
        const ys = path.map((p) => p.y - y0);
        return styled(
            {
                type: "arrow",
                x: x0,
                y: y0,
                width: Math.max(...xs) - Math.min(...xs),
                height: Math.max(...ys) - Math.min(...ys),
                points: xs.map((x, i) => [x, ys[i]]),
                start: { id: edge.from },
                end: { id: edge.to },
                ...(label ? { label: { text: label.text } } : {}),
            },
            { strokeStyle: edge.dashed ? "dashed" : undefined, strokeColor: edge.strokeColor }
        );
    });
    return [...groups, ...nodes, ...arrows] as unknown as ExcalidrawElementSkeleton[];
}

// --- D7: the add block keeps its own layout and sits right of the graph, top-aligned

interface Positioned {
    x: number;
    y: number;
    width?: number;
    height?: number;
    points?: readonly (readonly number[])[];
}

function isPositioned(s: ExcalidrawElementSkeleton): s is ExcalidrawElementSkeleton & Positioned {
    return typeof (s as Positioned).x === "number" && typeof (s as Positioned).y === "number";
}

function skeletonBounds(s: Positioned): Bounds {
    const corners = s.points?.length
        ? s.points.map(([px, py]) => pointBounds({ x: s.x + px, y: s.y + py }))
        : [pointBounds({ x: s.x + (s.width ?? 0), y: s.y + (s.height ?? 0) })];
    return union([pointBounds(s), ...corners]);
}

function besideGraph(add: readonly ExcalidrawElementSkeleton[], graph: Bounds): ExcalidrawElementSkeleton[] {
    const movable = add.filter(isPositioned);
    if (movable.length === 0) {
        return [...add];
    }
    const block = union(movable.map(skeletonBounds));
    const dx = graph.maxX + MIX_GAP - block.minX;
    const dy = graph.minY - block.minY;
    return add.map((s) => (isPositioned(s) ? { ...s, x: s.x + dx, y: s.y + dy } : s));
}

export function layoutAnswer(
    graph: BoardGraph | null,
    add: readonly ExcalidrawElementSkeleton[],
    measure: MeasureLabel
): ExcalidrawElementSkeleton[] {
    if (graph == null) {
        return [...add];
    }
    const laid = runDagre(graph, measure);
    placeTitles(laid, graph);
    return [...toSkeletons(laid), ...besideGraph(add, laidBounds(laid))];
}

// --- D6: no text on another text, and no text across a shape's outline

const OUTLINED = new Set(["rectangle", "ellipse", "diamond"]);

function elBounds(el: ExcalidrawElement): Bounds {
    return { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height };
}

function intersects(a: Bounds, b: Bounds): boolean {
    return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

function holds(outer: Bounds, inner: Bounds): boolean {
    return outer.minX <= inner.minX && inner.maxX <= outer.maxX && outer.minY <= inner.minY && inner.maxY <= outer.maxY;
}

export function textOverlaps(elements: readonly ExcalidrawElement[]): [string, string][] {
    const live = elements.filter((el) => !el.isDeleted);
    const texts = live.filter((el) => el.type === "text");
    const shapes = live.filter((el) => OUTLINED.has(el.type));
    const found: [string, string][] = [];
    texts.forEach((t, i) => {
        const tb = elBounds(t);
        for (const other of texts.slice(i + 1)) {
            if (intersects(tb, elBounds(other))) {
                found.push([t.id, other.id]);
            }
        }
        for (const s of shapes) {
            const sb = elBounds(s);
            if (intersects(tb, sb) && !holds(sb, tb)) {
                found.push([t.id, s.id]);
            }
        }
    });
    return found;
}
