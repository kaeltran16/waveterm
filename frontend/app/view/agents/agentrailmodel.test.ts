// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { contextNote, filesSummary, linkedWorktree, railAction, toolChips } from "./agentrailmodel";

describe("contextNote", () => {
    it("says how much of the window is used, in the window's own size", () => {
        expect(contextNote(62, 200_000)).toBe("124k of 200k tokens");
        expect(contextNote(38, 1_000_000)).toBe("380k of 1M tokens");
    });

    it("warns instead once the window is nearly full", () => {
        expect(contextNote(90, 200_000)).toBe("Near the limit.");
    });

    it("says nothing when the window size is unknown", () => {
        expect(contextNote(40, undefined)).toBe("");
    });
});

describe("railAction", () => {
    it("offers Resume for an idle agent and Stop for one mid-turn", () => {
        expect(railAction("idle", "38m", true)).toEqual({ kind: "resume", hint: "idle 38m · nudge to continue" });
        expect(railAction("working", "4m", true)).toEqual({ kind: "stop", hint: "working 4m · Esc also stops" });
        expect(railAction("asking", "2m", true)?.kind).toBe("stop");
    });

    it("offers nothing without a live terminal", () => {
        expect(railAction("working", "4m", false)).toBeNull();
    });
});

describe("toolChips", () => {
    it("sorts by use and dims the rarely used", () => {
        expect(
            toolChips([
                { verb: "Edit", count: 2 },
                { verb: "Bash", count: 11 },
            ])
        ).toEqual([
            { verb: "Bash", count: 11, dim: false },
            { verb: "Edit", count: 2, dim: true },
        ]);
    });
});

describe("filesSummary", () => {
    it("totals the changed lines", () => {
        expect(
            filesSummary([
                { adds: 30, dels: 2 },
                { adds: 7, dels: 15 },
            ])
        ).toBe("2 files · +37 −17");
        expect(filesSummary([{ adds: 1, dels: 0 }])).toBe("1 file · +1 −0");
    });
});

describe("linkedWorktree", () => {
    const main = { path: "C:\\src\\arc-api", branch: "main", ismain: true };
    const wt = { path: "C:\\src\\arc-api\\.waveterm\\worktrees\\r-1\\t-3", branch: "run/t-3" };
    const outside = { path: "D:/wt/arc-api-agent", branch: "arc-api-agent" };

    it("names a worktree under the main checkout by its path from there", () => {
        expect(linkedWorktree("C:/src/arc-api/.waveterm/worktrees/r-1/t-3", [main, wt])).toBe(
            ".waveterm/worktrees/r-1/t-3"
        );
        expect(linkedWorktree("c:\\src\\arc-api\\.waveterm\\worktrees\\r-1\\t-3\\pkg", [main, wt])).toBe(
            ".waveterm/worktrees/r-1/t-3"
        );
    });

    it("names a worktree outside the main checkout by its full path", () => {
        expect(linkedWorktree("D:/wt/arc-api-agent", [main, outside])).toBe("D:/wt/arc-api-agent");
    });

    it("says nothing in the main checkout or outside every worktree", () => {
        expect(linkedWorktree("C:/src/arc-api/pkg", [main, wt])).toBeUndefined();
        expect(linkedWorktree("C:/elsewhere", [main, wt])).toBeUndefined();
        expect(linkedWorktree("C:/src/arc-api", [])).toBeUndefined();
    });
});
