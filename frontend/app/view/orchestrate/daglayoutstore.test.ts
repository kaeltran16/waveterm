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
        expect(withOffsets({}, "d1", { a: { x: 1, y: 2 } }, 100)).toEqual({
            d1: { at: 100, offsets: { a: { x: 1, y: 2 } } },
        });
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
