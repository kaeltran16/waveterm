// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { fuzzyScore, rankPaletteItems } from "./palette-match";

describe("fuzzyScore", () => {
    it("returns null when query chars are not a subsequence", () => {
        expect(fuzzyScore("xyz", "New agent")).toBeNull();
    });
    it("matches a gapped subsequence", () => {
        expect(fuzzyScore("nag", "New agent")).not.toBeNull();
    });
    it("is case-insensitive", () => {
        expect(fuzzyScore("NEW", "new agent")).not.toBeNull();
    });
    it("empty query scores 0 (not null)", () => {
        expect(fuzzyScore("", "anything")).toBe(0);
    });
    it("scores a contiguous run higher than a gapped one", () => {
        const contiguous = fuzzyScore("abc", "abcxyz")!;
        const gapped = fuzzyScore("abc", "axbxcx")!;
        expect(contiguous).toBeGreaterThan(gapped);
    });
});

describe("rankPaletteItems", () => {
    const items = [
        { search: "Profile" },
        { search: "Go to Files" },
        { search: "axbxcx" },
        { search: "abcxyz" },
    ];

    it("passes items through unchanged for an empty query", () => {
        expect(rankPaletteItems(items, "").map((i) => i.search)).toEqual(items.map((i) => i.search));
    });
    it("drops non-matches", () => {
        expect(rankPaletteItems(items, "zzz")).toEqual([]);
    });
    it("ranks a word-boundary match above a mid-word match", () => {
        // "file" starts a word in "Go to Files" but is mid-word in "Profile"
        const ranked = rankPaletteItems(items, "file").map((i) => i.search);
        expect(ranked[0]).toBe("Go to Files");
    });
    it("ranks a contiguous match above a gapped match", () => {
        const ranked = rankPaletteItems(items, "abc").map((i) => i.search);
        expect(ranked.indexOf("abcxyz")).toBeLessThan(ranked.indexOf("axbxcx"));
    });
});
