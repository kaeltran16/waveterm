import { describe, expect, it } from "vitest";
import { computeLayeredLayout } from "./daglayout";

const tasks = [
    { id: "t-0", deps: [] },
    { id: "t-1", deps: ["t-0"] },
    { id: "t-2", deps: ["t-0"] },
    { id: "t-3", deps: ["t-1", "t-2"] },
];

describe("computeLayeredLayout", () => {
    it("assigns layers by longest path", () => {
        const pos = computeLayeredLayout(tasks, { width: 100, height: 40, gapX: 20, gapY: 30 });
        const y = (id: string) => pos.get(id)!.y;
        expect(y("t-0")).toBeLessThan(y("t-1"));
        expect(y("t-1")).toBe(y("t-2"));
        expect(y("t-2")).toBeLessThan(y("t-3"));
    });
    it("is deterministic and places siblings side by side", () => {
        const a = computeLayeredLayout(tasks);
        const b = computeLayeredLayout(tasks);
        expect([...a.entries()]).toEqual([...b.entries()]);
        const x = (id: string) => a.get(id)!.x;
        expect(x("t-1")).not.toBe(x("t-2"));
    });
});
