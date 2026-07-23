import { describe, expect, it, vi } from "vitest";
import { buildAskItems } from "./palette-ask";

describe("buildAskItems", () => {
    it("returns nothing for an empty goal", () => {
        expect(buildAskItems("", { ask: () => {} })).toEqual([]);
        expect(buildAskItems("   ", { ask: () => {} })).toEqual([]);
    });
    it("returns one ask row echoing the trimmed goal", () => {
        const items = buildAskItems("  why did we drop worktrees  ", { ask: () => {} });
        expect(items).toHaveLength(1);
        expect(items[0].key).toBe("ask-jarvis");
        expect(items[0].desc).toBe("why did we drop worktrees");
        expect(items[0].mode).toBe("Ask Jarvis");
    });
    it("run() forwards the trimmed goal to deps.ask", () => {
        const ask = vi.fn();
        buildAskItems("  q  ", { ask })[0].run();
        expect(ask).toHaveBeenCalledWith("q");
    });
});
