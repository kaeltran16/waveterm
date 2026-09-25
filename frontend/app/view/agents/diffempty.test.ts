// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { emptyDiffState } from "./diffempty";

const pair = (
    over: Partial<{ binary: boolean; tooLarge: boolean; original: string; modified: string; size: number }> = {}
) => ({
    path: "a.ts",
    binary: false,
    tooLarge: false,
    original: "x",
    modified: "y",
    size: 0,
    ...over,
});

describe("emptyDiffState", () => {
    it("says two refs that agree are an answer, not a blank", () => {
        expect(
            emptyDiffState({ path: null, pair: null, nothingToCompare: { base: "main", head: "origin/main" } })
        ).toEqual({
            kind: "nothing",
            title: "Nothing to compare",
            body: "main and origin/main have no file differences.",
        });
    });
    it("asks for a file when none is selected", () => {
        expect(emptyDiffState({ path: null, pair: null, nothingToCompare: null })?.kind).toBe("nofile");
    });
    it("is null while the pair is still loading, so the pane shows its skeleton", () => {
        expect(emptyDiffState({ path: "a.ts", pair: null, nothingToCompare: null })).toBeNull();
        expect(emptyDiffState({ path: "b.ts", pair: pair(), nothingToCompare: null })).toBeNull();
    });
    it("names the 2 MB limit for a file too large to diff", () => {
        expect(emptyDiffState({ path: "a.ts", pair: pair({ tooLarge: true }), nothingToCompare: null })).toEqual({
            kind: "toolarge",
            title: "Too large to show here",
            body: "Diffs stop at 2 MB. Open it in Code to read the file.",
        });
    });
    it("explains a binary file", () => {
        expect(emptyDiffState({ path: "a.ts", pair: pair({ binary: true }), nothingToCompare: null })?.body).toBe(
            "Git records a change here, but there is no text to compare."
        );
    });
    it("explains a rename or mode change", () => {
        expect(
            emptyDiffState({
                path: "a.ts",
                pair: pair({ original: "same", modified: "same" }),
                nothingToCompare: null,
            })
        ).toEqual({
            kind: "unchanged",
            title: "Contents unchanged",
            body: "Only the name or the file mode changed.",
        });
    });
    it("is null when there is a diff to draw", () => {
        expect(emptyDiffState({ path: "a.ts", pair: pair(), nothingToCompare: null })).toBeNull();
    });
});
