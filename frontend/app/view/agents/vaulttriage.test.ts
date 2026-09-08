// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    cursorAfterResolve,
    filterQueue,
    isLong,
    moveCursor,
    overlapping,
    readingTime,
    sameRun,
    scopeChips,
    scopeLabel,
    titleSlug,
    wordCount,
    type QueueItem,
} from "./vaulttriage";

function item(over: Partial<QueueItem> = {}): QueueItem {
    return { path: "p1", scope: "waveterm", source: "claude", title: "t", body: "b", ...over };
}

describe("scopeChips", () => {
    it("derives chips from the live queue, all first", () => {
        const chips = scopeChips([
            item({ path: "a", scope: "waveterm" }),
            item({ path: "b", scope: "shared" }),
            item({ path: "c", scope: "waveterm" }),
        ]);
        expect(chips).toEqual([
            { key: "all", label: "all", count: 3 },
            { key: "shared", label: "shared", count: 1 },
            { key: "waveterm", label: "waveterm", count: 2 },
        ]);
    });

    it("counts a blank scope as shared rather than dropping it", () => {
        expect(scopeChips([item({ scope: "" })])).toEqual([
            { key: "all", label: "all", count: 1 },
            { key: "shared", label: "shared", count: 1 },
        ]);
    });

    it("offers only the all chip for an empty queue", () => {
        expect(scopeChips([])).toEqual([{ key: "all", label: "all", count: 0 }]);
    });
});

describe("filterQueue", () => {
    const items = [
        item({ path: "a", scope: "waveterm", title: "tsc overflows", body: "use --stack-size" }),
        item({ path: "b", scope: "shared", title: "vault write target", body: "memroots owns it" }),
    ];

    it("passes everything through on the all scope with no search", () => {
        expect(filterQueue(items, "all", "")).toHaveLength(2);
    });

    it("filters by scope", () => {
        expect(filterQueue(items, "shared", "").map((p) => p.path)).toEqual(["b"]);
    });

    it("matches the body, not just the title", () => {
        expect(filterQueue(items, "all", "memroots").map((p) => p.path)).toEqual(["b"]);
    });

    it("is case-insensitive and ignores surrounding space", () => {
        expect(filterQueue(items, "all", "  TSC ").map((p) => p.path)).toEqual(["a"]);
    });

    it("intersects scope and search rather than choosing one", () => {
        expect(filterQueue(items, "shared", "tsc")).toHaveLength(0);
    });
});

describe("moveCursor", () => {
    it("clamps at both ends", () => {
        expect(moveCursor(3, 0, -1)).toBe(0);
        expect(moveCursor(3, 2, 1)).toBe(2);
        expect(moveCursor(3, 1, 1)).toBe(2);
    });

    it("holds at zero for an empty queue", () => {
        expect(moveCursor(0, 0, 1)).toBe(0);
        expect(moveCursor(0, 4, -1)).toBe(0);
    });
});

describe("cursorAfterResolve", () => {
    it("keeps the index so the next row shifts under the cursor", () => {
        expect(cursorAfterResolve(["a", "b", "c"], "b")).toBe(1);
    });

    it("steps back when the last row is resolved", () => {
        expect(cursorAfterResolve(["a", "b", "c"], "c")).toBe(1);
    });

    it("lands on zero when the queue empties", () => {
        expect(cursorAfterResolve(["a"], "a")).toBe(0);
    });

    it("returns zero for a path that is not in the queue", () => {
        expect(cursorAfterResolve(["a", "b"], "zzz")).toBe(0);
    });
});

describe("sameRun", () => {
    const items = [
        item({ path: "a", source: "claude" }),
        item({ path: "b", source: "claude" }),
        item({ path: "c", source: "codex" }),
        item({ path: "d", source: "claude" }),
        item({ path: "e", source: "claude" }),
    ];

    it("returns the other candidates from the same agent, capped", () => {
        expect(sameRun(items, items[0]).map((p) => p.path)).toEqual(["b", "d", "e"]);
    });

    it("excludes the current candidate itself", () => {
        expect(sameRun(items, items[0]).some((p) => p.path === "a")).toBe(false);
    });

    it("is empty with no current candidate", () => {
        expect(sameRun(items, undefined)).toEqual([]);
    });
});

describe("readingTime", () => {
    it("floors at a tenth of a minute so a short note still reads as a duration", () => {
        expect(readingTime("one two three")).toBe("0.1 min read");
        expect(readingTime("")).toBe("0.1 min read");
    });

    it("scales with length", () => {
        expect(readingTime(Array.from({ length: 400 }, () => "w").join(" "))).toBe("2 min read");
    });
});

describe("wordCount", () => {
    it("ignores surrounding and repeated whitespace", () => {
        expect(wordCount("  a   b \n c ")).toBe(3);
        expect(wordCount("   ")).toBe(0);
    });
});

describe("isLong", () => {
    it("splits on the preview clip threshold", () => {
        expect(isLong("x".repeat(341))).toBe(true);
        expect(isLong("x".repeat(340))).toBe(false);
    });
});

describe("titleSlug", () => {
    it("collapses punctuation and case into a comparable slug", () => {
        expect(titleSlug("TSC stack-size gotcha!")).toBe("tsc-stack-size-gotcha");
    });

    it("trims leading and trailing separators", () => {
        expect(titleSlug("  --Hello--  ")).toBe("hello");
    });

    it("is empty for a title with nothing comparable in it", () => {
        expect(titleSlug("!!!")).toBe("");
    });
});

describe("overlapping", () => {
    const saved = [{ title: "tsc stack-size gotcha" }, { title: "avoid scss prefer tailwind" }, { title: "memory" }];

    it("matches the same fact re-harvested under a differently punctuated title", () => {
        expect(overlapping("TSC stack-size gotcha!", saved).map((n) => n.title)).toEqual(["tsc stack-size gotcha"]);
    });

    it("matches when one title contains the other", () => {
        expect(overlapping("the tsc stack-size gotcha and its fix", saved).map((n) => n.title)).toEqual([
            "tsc stack-size gotcha",
        ]);
    });

    it("ignores containment on a slug too short to mean anything", () => {
        expect(overlapping("memory vault layout notes", saved)).toEqual([]);
    });

    it("returns nothing when no saved note looks like the candidate", () => {
        expect(overlapping("a completely unrelated finding", saved)).toEqual([]);
    });

    it("returns nothing for an unslugifiable title", () => {
        expect(overlapping("???", saved)).toEqual([]);
    });

    it("caps the result", () => {
        const many = Array.from({ length: 6 }, () => ({ title: "tsc stack-size gotcha" }));
        expect(overlapping("tsc stack-size gotcha", many)).toHaveLength(3);
    });
});

describe("scopeLabel", () => {
    it("leaves a plain namespace alone", () => {
        expect(scopeLabel("shared")).toBe("shared");
        expect(scopeLabel("arc-cockpit")).toBe("arc-cockpit");
    });

    it("shortens a Windows project path to its last segment", () => {
        expect(scopeLabel("C:\\Users\\kael02\\IdeaProjects\\waveterm")).toBe("waveterm");
    });

    it("shortens a POSIX project path to its last segment", () => {
        expect(scopeLabel("/home/k/projects/waveterm")).toBe("waveterm");
    });

    it("ignores a trailing separator", () => {
        expect(scopeLabel("/home/k/projects/waveterm/")).toBe("waveterm");
    });

    it("falls back to shared for an empty scope", () => {
        expect(scopeLabel("")).toBe("shared");
    });
});
