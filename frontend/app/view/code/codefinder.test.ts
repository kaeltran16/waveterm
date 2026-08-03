// frontend/app/view/code/codefinder.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { rankPaths } from "./codefinder";

describe("rankPaths", () => {
    it("ranks a basename hit above a match scattered through directory names", () => {
        const paths = ["a/g/e/n/t/r/o/w/other.ts", "frontend/app/view/agents/agentrow.tsx"];
        expect(rankPaths("agentrow", paths, 10)[0].path).toBe("frontend/app/view/agents/agentrow.tsx");
    });

    it("still matches on directory names when the basename does not match", () => {
        const paths = ["frontend/app/view/agents/row.tsx"];
        expect(rankPaths("agents", paths, 10).map((m) => m.path)).toEqual(["frontend/app/view/agents/row.tsx"]);
    });

    it("drops paths the query cannot match at all", () => {
        expect(rankPaths("zzz", ["src/main.ts"], 10)).toEqual([]);
    });

    it("is case-insensitive", () => {
        expect(rankPaths("MAIN", ["src/main.ts"], 10)).toHaveLength(1);
    });

    it("returns the first paths unranked for an empty query", () => {
        const paths = ["b.ts", "a.ts", "c.ts"];
        expect(rankPaths("", paths, 2).map((m) => m.path)).toEqual(["b.ts", "a.ts"]);
    });

    it("treats a whitespace-only query as empty", () => {
        expect(rankPaths("   ", ["b.ts", "a.ts"], 1).map((m) => m.path)).toEqual(["b.ts"]);
    });

    it("honors the limit", () => {
        const paths = ["m1.ts", "m2.ts", "m3.ts", "m4.ts"];
        expect(rankPaths("m", paths, 2)).toHaveLength(2);
    });

    it("breaks score ties by path so the order is stable", () => {
        const ranked = rankPaths("m", ["z/m.ts", "a/m.ts"], 10);
        expect(ranked[0].path).toBe("a/m.ts");
    });
});
