import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { describe, expect, it } from "vitest";
import { LABEL_MAX_WIDTH, layoutAnswer, textOverlaps, type BoardGraph, type MeasureLabel } from "./boardlayout";

const CHAR_WIDTH = 10;
const LINE_HEIGHT = 25;

// deterministic stand-in for Excalifont 20px: every character the same width
const measure: MeasureLabel = (text) => {
    const lines = text.split("\n");
    return { width: Math.max(...lines.map((l) => l.length)) * CHAR_WIDTH, height: lines.length * LINE_HEIGHT };
};

const lifecycle: BoardGraph = {
    nodes: ["idle", "admitted", "running", "blocked", "reviewing", "done", "failed"].map((id) => ({ id, label: id })),
    edges: [
        { from: "idle", to: "admitted", label: "admit memory" },
        { from: "admitted", to: "running", label: "start" },
        { from: "running", to: "blocked", label: "wait on lock" },
        { from: "blocked", to: "running", label: "lock freed" },
        { from: "running", to: "reviewing", label: "submit" },
        { from: "reviewing", to: "done", label: "approve" },
        { from: "reviewing", to: "running", label: "reject" },
        { from: "running", to: "failed", label: "crash" },
        { from: "failed", to: "idle", label: "retry" },
        { from: "failed", to: "done", label: "give up" },
    ],
};

const grouped: BoardGraph = {
    ...lifecycle,
    nodes: lifecycle.nodes.map((n) =>
        ["running", "blocked", "reviewing"].includes(n.id)
            ? { ...n, group: "pool" }
            : ["done", "failed"].includes(n.id)
              ? { ...n, group: "end" }
              : n
    ),
    groups: [
        { id: "pool", label: "worker pool in the scheduler" },
        { id: "end", label: "finished" },
    ],
};

type Sk = Record<string, any>;

function box(id: string, type: string, x: number, y: number, width: number, height: number): ExcalidrawElement {
    return { id, type, x, y, width, height, isDeleted: false } as unknown as ExcalidrawElement;
}

function centeredText(id: string, text: string, cx: number, cy: number): ExcalidrawElement {
    const { width, height } = measure(text);
    return box(id, "text", cx - width / 2, cy - height / 2, width, height);
}

function middlePoint(arrow: Sk): [number, number] {
    const [px, py] = arrow.points[Math.floor(arrow.points.length / 2)];
    return [arrow.x + px, arrow.y + py];
}

// the boxes Excalidraw lands: node labels centered in their node, arrow labels on the arrow's middle point
function landed(skeletons: readonly unknown[]): ExcalidrawElement[] {
    return (skeletons as readonly Sk[]).flatMap((s, i) => {
        const id = s.id ?? `el${i}`;
        if (s.type === "text") {
            return [box(id, "text", s.x, s.y, measure(s.text).width, measure(s.text).height)];
        }
        if (s.type === "arrow") {
            return s.label ? [centeredText(`${id}:label`, s.label.text, ...middlePoint(s))] : [];
        }
        const shape = box(id, s.type, s.x, s.y, s.width, s.height);
        const label = s.label ? [centeredText(`${id}:label`, s.label.text, s.x + s.width / 2, s.y + s.height / 2)] : [];
        return [shape, ...label];
    });
}

function labels(skeletons: readonly unknown[]): string[] {
    return (skeletons as readonly Sk[]).flatMap((s) => (s.type === "text" ? [s.text] : s.label ? [s.label.text] : []));
}

describe("layoutAnswer", () => {
    it("returns add unchanged without a graph", () => {
        const add = [{ type: "rectangle", id: "a", x: 5, y: 7, width: 10, height: 10 }] as ExcalidrawElementSkeleton[];
        expect(layoutAnswer(null, add, measure)).toEqual(add);
    });

    it.each([
        ["TB", { ...lifecycle, direction: "TB" }],
        ["LR", { ...lifecycle, direction: "LR" }],
        ["grouped TB", { ...grouped, direction: "TB" }],
        ["grouped LR", { ...grouped, direction: "LR" }],
    ] as [string, BoardGraph][])("lays out the lifecycle (%s) with no label overlapping", (_, graph) => {
        const out = layoutAnswer(graph, [], measure);
        const shapeIds = (out as Sk[]).filter((s) => s.type !== "arrow" && s.type !== "text").map((s) => s.id);
        expect(shapeIds).toEqual(expect.arrayContaining(graph.nodes.map((n) => n.id)));
        expect((out as Sk[]).filter((s) => s.type === "arrow")).toHaveLength(graph.edges.length);
        for (const g of graph.groups ?? []) {
            expect(labels(out).map((t) => t.split("\n").join(" "))).toContain(g.label);
        }
        expect(textOverlaps(landed(out))).toEqual([]);
    });

    it("draws each group before its members", () => {
        const out = layoutAnswer(grouped, [], measure) as Sk[];
        const at = (id: string) => out.findIndex((s) => s.id === id);
        expect(at("pool")).toBeLessThan(at("running"));
        expect(at("end")).toBeLessThan(at("done"));
    });

    it("breaks every label into lines no wider than LABEL_MAX_WIDTH", () => {
        const long = "the worker waits here until the scheduler admits it with enough memory";
        const word = "supercalifragilisticexpialidocious-and-then-some";
        const graph: BoardGraph = {
            nodes: [
                { id: "a", label: long },
                { id: "b", label: word, shape: "ellipse" },
                { id: "c", label: "c", shape: "diamond", group: "g" },
            ],
            edges: [
                { from: "a", to: "b", label: long },
                { from: "b", to: "c", label: word },
            ],
            groups: [{ id: "g", label: long }],
        };
        const out = layoutAnswer(graph, [], measure);
        const lines = labels(out).flatMap((t) => t.split("\n"));
        expect(lines.join(" ")).toContain("supercalifr");
        for (const line of lines) {
            expect(measure(line).width).toBeLessThanOrEqual(LABEL_MAX_WIDTH);
        }
        expect(textOverlaps(landed(out))).toEqual([]);
    });

    it("gives every labeled arrow an odd point count, so its label sits on the middle point", () => {
        const out = layoutAnswer({ ...lifecycle, direction: "LR" }, [], measure) as Sk[];
        for (const arrow of out.filter((s) => s.type === "arrow" && s.label)) {
            expect(arrow.points.length % 2).toBe(1);
        }
    });

    it("binds each arrow to its nodes and keeps edge styles", () => {
        const graph: BoardGraph = {
            nodes: [
                { id: "a", label: "a", strokeColor: "#e03131", backgroundColor: "#a5d8ff" },
                { id: "b", label: "b" },
            ],
            edges: [{ from: "a", to: "b", dashed: true, strokeColor: "#1971c2" }],
        };
        const out = layoutAnswer(graph, [], measure) as Sk[];
        expect(out.find((s) => s.id === "a")).toMatchObject({ strokeColor: "#e03131", backgroundColor: "#a5d8ff" });
        expect(out.find((s) => s.type === "arrow")).toMatchObject({
            start: { id: "a" },
            end: { id: "b" },
            strokeStyle: "dashed",
            strokeColor: "#1971c2",
        });
    });

    it("places add as a block right of the graph, top-aligned, keeping its own layout", () => {
        const add = [
            { type: "rectangle", id: "note", x: -50, y: 300, width: 100, height: 40 },
            { type: "text", id: "free", x: -20, y: 400, text: "aside" },
            {
                type: "arrow",
                id: "link",
                x: 0,
                y: 340,
                points: [
                    [0, 0],
                    [0, 60],
                ],
                end: { id: "idle" },
            },
        ] as unknown as ExcalidrawElementSkeleton[];
        const out = layoutAnswer(lifecycle, add, measure) as Sk[];
        const graphBoxes = landed(out.filter((s) => !["note", "free", "link"].includes(s.id)));
        const graphRight = Math.max(...graphBoxes.map((b) => b.x + b.width));
        const graphTop = Math.min(...graphBoxes.map((b) => b.y));
        const placed = ["note", "free", "link"].map((id) => out.find((s) => s.id === id));
        const dx = placed[0].x - -50;
        const dy = placed[0].y - 300;
        expect(placed).toEqual(add.map((a: Sk) => ({ ...a, x: a.x + dx, y: a.y + dy })));
        expect(placed[0].x).toBeGreaterThan(graphRight);
        expect(placed[0].y).toBe(graphTop);
    });
});

describe("textOverlaps", () => {
    const t = (id: string, x: number, y: number) => box(id, "text", x, y, 40, 20);

    it.each([
        ["two intersecting texts", [t("a", 0, 0), t("b", 30, 10)], [["a", "b"]]],
        ["two clear texts", [t("a", 0, 0), t("b", 40, 0)], []],
        ["a text across a rectangle's outline", [box("r", "rectangle", 0, 0, 100, 50), t("a", 80, 10)], [["a", "r"]]],
        ["a text across a diamond's outline", [box("d", "diamond", 0, 0, 100, 50), t("a", -10, 10)], [["a", "d"]]],
        ["a text wholly inside a box", [box("r", "ellipse", 0, 0, 100, 50), t("a", 30, 15)], []],
        ["a text wholly outside a box", [box("r", "rectangle", 0, 0, 100, 50), t("a", 100, 10)], []],
        ["a text across a frame", [box("f", "frame", 0, 0, 100, 50), t("a", 80, 10)], []],
        ["a deleted text", [t("a", 0, 0), { ...t("b", 10, 0), isDeleted: true } as ExcalidrawElement], []],
    ] as [string, ExcalidrawElement[], [string, string][]][])("%s", (_, elements, want) => {
        expect(textOverlaps(elements)).toEqual(want);
    });
});
