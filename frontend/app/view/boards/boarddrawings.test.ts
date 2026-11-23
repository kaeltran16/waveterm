import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { describe, expect, it } from "vitest";
import { askedDrawing, drawingInView, drawingsOf, type Drawing, type ViewRect } from "./boarddrawings";

function el(id: string, type: string, x: number, y: number, w: number, h: number, extra: object = {}) {
    return { id, type, x, y, width: w, height: h, isDeleted: false, frameId: null, ...extra } as ExcalidrawElement;
}

function frame(id: string, x: number, y: number, w: number, h: number, n: number | null, name: string | null) {
    return el(id, "frame", x, y, w, h, { name, customData: n == null ? undefined : { arcDrawing: n } });
}

describe("drawingsOf", () => {
    it("drawingsOf lists live frames by number, hand frames after in element order", () => {
        const els = [
            frame("hand-b", 0, 900, 10, 10, null, "Mine"),
            frame("d2", 500, 0, 300, 200, 2, "Second"),
            el("r", "rectangle", 0, 0, 10, 10),
            frame("gone", 0, 0, 10, 10, 5, "Deleted"),
            frame("d1", 0, 0, 400, 250, 1, "First"),
            frame("hand-a", 0, 1200, 10, 10, null, null),
        ];
        (els[3] as any).isDeleted = true;
        const drawings = drawingsOf(els);
        expect(drawings.map((d) => d.id)).toEqual(["d1", "d2", "hand-b", "hand-a"]);
        expect(drawings[0]).toEqual({
            id: "d1",
            n: 1,
            title: "First",
            bounds: { minX: 0, minY: 0, maxX: 400, maxY: 250 },
        });
        expect(drawings[1]).toMatchObject({ n: 2, title: "Second" });
        // hand frames number on after the highest drawing
        expect(drawings[2]).toMatchObject({ n: 3, title: "Mine" });
        expect(drawings[3]).toMatchObject({ n: 4, title: "" });
        expect(drawingsOf([el("r", "rectangle", 0, 0, 10, 10)])).toEqual([]);
    });
});

function drawing(id: string, n: number, minX: number, minY: number, maxX: number, maxY: number): Drawing {
    return { id, n, title: id, bounds: { minX, minY, maxX, maxY } };
}

// a view showing scene x in [x, x + width/zoom], y in [y, y + height/zoom]
function view(x: number, y: number, zoom = 1, width = 1000, height = 600): ViewRect {
    return { scrollX: -x, scrollY: -y, zoom, width, height };
}

describe("drawingInView", () => {
    const d1 = drawing("d1", 1, 0, 0, 800, 500);
    const d2 = drawing("d2", 2, 900, 0, 1500, 400);

    it.each([
        ["the drawing covering most of the view", view(0, 0), "d1"],
        ["the other when it covers more", view(700, 0), "d2"],
        ["the newest when zoomed inside it", view(1000, 100, 4), "d2"],
        ["an earlier one when zoomed inside it", view(100, 100, 4), "d1"],
        ["null when no frame is visible", view(0, 2000), null],
    ])("drawingInView returns %s", (_, rect, want) => {
        expect(drawingInView([d1, d2], rect)).toBe(want);
    });

    it("drawingInView prefers the newer of overlapping drawings that cover the view alike", () => {
        const outer = drawing("outer", 1, 0, 0, 2000, 2000);
        const inner = drawing("inner", 2, 500, 500, 1500, 1500);
        expect(drawingInView([outer, inner], view(600, 600, 2))).toBe("inner");
        expect(drawingInView([], view(0, 0))).toBeNull();
    });
});

describe("askedDrawing", () => {
    const els = [
        el("a", "rectangle", 0, 0, 10, 10, { frameId: "f1" }),
        el("a-label", "text", 0, 0, 10, 10, { frameId: "f1", containerId: "a" }),
        el("b", "rectangle", 0, 0, 10, 10, { frameId: "f1" }),
        frame("f1", 0, 0, 100, 100, 1, "One"),
        el("c", "rectangle", 200, 0, 10, 10, { frameId: "f2" }),
        frame("f2", 200, 0, 100, 100, 2, "Two"),
        el("loose", "rectangle", 500, 0, 10, 10),
        el("orphan", "rectangle", 0, 0, 10, 10, { frameId: "f-gone" }),
        el("gone", "rectangle", 0, 0, 10, 10, { frameId: "f2", isDeleted: true }),
    ];

    it.each([
        ["shapes inside one drawing name it", ["a", "a-label", "b"], "f1"],
        ["a selected frame names itself", ["f2", "c"], "f2"],
        ["a selection across drawings leaves the one in view", ["a", "c"], "f9"],
        ["a loose shape leaves the one in view", ["a", "loose"], "f9"],
        ["a shape whose frame is gone leaves the one in view", ["orphan"], "f9"],
        ["deleted and unknown ids are ignored", ["c", "gone", "missing"], "f2"],
        ["no selection leaves the one in view", [], "f9"],
    ])("askedDrawing: %s", (_, selected, want) => {
        expect(askedDrawing(els, selected, "f9")).toBe(want);
    });
});
