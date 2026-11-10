import { describe, expect, it } from "vitest";
import { registerTermScreen, screenRows, termForBlock, type ScreenTerminal } from "./termscreen";

function fakeTerm(lines: string[], rows: number, baseY: number): ScreenTerminal {
    return {
        rows,
        buffer: {
            active: {
                baseY,
                getLine: (y: number) =>
                    y >= 0 && y < lines.length
                        ? { translateToString: (trim?: boolean) => (trim ? lines[y].trimEnd() : lines[y]) }
                        : undefined,
            },
        },
    };
}

describe("termscreen", () => {
    it("returns the live screen rows, not scrollback", () => {
        const lines = ["a0", "a1", "a2", "a3", "a4", "live5  ", "live6", "live7"];
        const off = registerTermScreen("b-live", fakeTerm(lines, 3, 5));
        expect(screenRows("b-live")).toEqual(["live5", "live6", "live7"]);
        off();
    });

    it("returns null for a block with no terminal", () => {
        expect(screenRows("b-none")).toBeNull();
    });

    it("a stale unregister leaves a newer terminal in place", () => {
        const a = fakeTerm(["a"], 1, 0);
        const b = fakeTerm(["b"], 1, 0);
        const offA = registerTermScreen("b-stale", a);
        const offB = registerTermScreen("b-stale", b);
        offA();
        expect(termForBlock("b-stale")).toBe(b);
        offB();
        expect(termForBlock("b-stale")).toBeUndefined();
    });
});
