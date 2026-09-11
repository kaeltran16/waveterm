// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildFileTree } from "./filetree";
import type { GitChange } from "./gitstatus";

const f = (path: string, adds = 1, dels = 0): GitChange => ({ path, status: "M", adds, dels });

describe("buildFileTree", () => {
    it("groups files under their directory, directory first", () => {
        const rows = buildFileTree([f("retry/policy.go"), f("retry/budget.go")], new Set());
        expect(rows.map((r) => [r.kind, r.label])).toEqual([
            ["dir", "retry"],
            ["file", "budget.go"],
            ["file", "policy.go"],
        ]);
    });

    it("rolls up counts onto the directory row", () => {
        const rows = buildFileTree([f("retry/policy.go", 10, 2), f("retry/budget.go", 5, 3)], new Set());
        const dir = rows[0];
        expect([dir.files, dir.adds, dir.dels]).toEqual([2, 15, 5]);
    });

    // an indented list of single-child directories is not a tree, it is a staircase
    it("collapses a single-child directory chain into one row", () => {
        const rows = buildFileTree([f("a/b/c/deep.go")], new Set());
        expect(rows.map((r) => r.label)).toEqual(["a/b/c", "deep.go"]);
    });

    it("hides the children of a collapsed directory but keeps its row", () => {
        const rows = buildFileTree([f("retry/policy.go"), f("server/submit.go")], new Set(["retry"]));
        expect(rows.map((r) => r.label)).toEqual(["retry", "server", "submit.go"]);
    });

    it("puts root-level files after the directories", () => {
        const rows = buildFileTree([f("README.md"), f("retry/policy.go")], new Set());
        expect(rows.map((r) => r.label)).toEqual(["retry", "policy.go", "README.md"]);
    });

    it("returns nothing for no files", () => {
        expect(buildFileTree([], new Set())).toEqual([]);
    });
});
