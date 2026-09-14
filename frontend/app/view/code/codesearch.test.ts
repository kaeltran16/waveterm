// frontend/app/view/code/codesearch.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { groupMatches, stepRow, summarize } from "./codesearch";

const m = (path: string, line: number, text = "hit"): GitGrepMatch => ({ path, line, text });

describe("groupMatches", () => {
    it("groups consecutive matches in one file", () => {
        const groups = groupMatches([m("a.ts", 1), m("a.ts", 9)]);
        expect(groups).toHaveLength(1);
        expect(groups[0].path).toBe("a.ts");
        expect(groups[0].matches.map((x) => x.line)).toEqual([1, 9]);
    });

    it("keeps git's file order rather than sorting", () => {
        const groups = groupMatches([m("z.ts", 1), m("a.ts", 1)]);
        expect(groups.map((g) => g.path)).toEqual(["z.ts", "a.ts"]);
    });

    it("regroups a file that reappears later instead of duplicating it", () => {
        const groups = groupMatches([m("a.ts", 1), m("b.ts", 2), m("a.ts", 3)]);
        expect(groups.map((g) => g.path)).toEqual(["a.ts", "b.ts"]);
        expect(groups[0].matches.map((x) => x.line)).toEqual([1, 3]);
    });

    it("returns nothing for no matches", () => {
        expect(groupMatches([])).toEqual([]);
    });
});

describe("summarize", () => {
    it("counts matches and files", () => {
        expect(summarize(groupMatches([m("a.ts", 1), m("a.ts", 2), m("b.ts", 1)]), false)).toBe("3 matches in 2 files");
    });

    it("uses the singular for one of each", () => {
        expect(summarize(groupMatches([m("a.ts", 1)]), false)).toBe("1 match in 1 file");
    });

    it("says so when the result was truncated", () => {
        expect(summarize(groupMatches([m("a.ts", 1)]), true)).toBe("1 match in 1 file (truncated)");
    });

    it("says nothing matched for an empty result", () => {
        expect(summarize([], false)).toBe("No matches");
    });
});

describe("stepRow", () => {
    it("moves from the query input onto the first row", () => {
        expect(stepRow(-1, 1, 3)).toBe(0);
    });

    it("walks down the rows and stops at the last one", () => {
        expect(stepRow(0, 1, 3)).toBe(1);
        expect(stepRow(2, 1, 3)).toBe(2);
    });

    it("walks up from the first row back to the input, and no further", () => {
        expect(stepRow(0, -1, 3)).toBe(-1);
        expect(stepRow(-1, -1, 3)).toBe(-1);
    });

    it("stays on the input when there are no rows", () => {
        expect(stepRow(-1, 1, 0)).toBe(-1);
    });
});
