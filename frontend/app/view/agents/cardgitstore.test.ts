import { describe, expect, it } from "vitest";
import { diffStatsFromChanges } from "./cardgitstore";
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
