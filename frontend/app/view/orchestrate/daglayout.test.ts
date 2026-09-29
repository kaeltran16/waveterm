import { describe, expect, it } from "vitest";
import { CARD_H, CARD_W, computeLayeredLayout, computeLayout, edgeGeo, edgeKey, laneBand, lanesOf } from "./daglayout";

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
