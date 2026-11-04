import { describe, expect, it } from "vitest";
import { diffStatsFromChanges, sharedCheckoutCount } from "./cardgitstore";
import type { GitChanges } from "./gitstatus";

describe("diffStatsFromChanges", () => {
    it("counts files from the change list and passes through add/del totals", () => {
        const ch: GitChanges = {
            files: [
                { path: "a.ts", status: "M", adds: 3, dels: 1 },
                { path: "b.ts", status: "A", adds: 10, dels: 0 },
            ],
            adds: 13,
            dels: 1,
        };
        expect(diffStatsFromChanges(ch)).toEqual({ files: 2, adds: 13, dels: 1 });
    });

    it("is zero across the board for a clean repo", () => {
        expect(diffStatsFromChanges({ files: [], adds: 0, dels: 0 })).toEqual({ files: 0, adds: 0, dels: 0 });
    });
});

describe("sharedCheckoutCount", () => {
    it("counts every card in the same checkout, this one included", () => {
        const cwd = { a: "C:/src/demo", b: "C:/src/demo", c: "C:/src/other" };
        expect(sharedCheckoutCount("a", cwd)).toBe(2);
        expect(sharedCheckoutCount("c", cwd)).toBe(1);
    });

    it("does not share across worktrees of one repo", () => {
        const cwd = { a: "C:/src/demo", b: "C:/src/demo-wt/feature", c: "C:/src/demo/.worktrees/x" };
        expect(sharedCheckoutCount("a", cwd)).toBe(1);
        expect(sharedCheckoutCount("b", cwd)).toBe(1);
    });

    it("matches case, slash and trailing-separator variants of one path", () => {
        const cwd = { a: "C:\\Src\\Demo\\", b: "c:/src/demo", c: "C:/SRC/DEMO/" };
        expect(sharedCheckoutCount("a", cwd)).toBe(3);
    });

    it("is 1 for a lone card and 0 for a card with no resolved cwd", () => {
        expect(sharedCheckoutCount("a", { a: "C:/src/demo" })).toBe(1);
        expect(sharedCheckoutCount("z", { a: "C:/src/demo" })).toBe(0);
    });
});
