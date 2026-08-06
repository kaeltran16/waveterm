// frontend/app/view/code/codetreekeys.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { TreeRow } from "./codetree";
import { treeKeyAction } from "./codetreekeys";

// src/ (expanded) > src/a.ts > src/lib/ (collapsed) > README.md
const rows: TreeRow[] = [
    { kind: "dir", path: "src", name: "src", depth: 0, expanded: true },
    { kind: "file", path: "src/a.ts", name: "a.ts", depth: 1, expanded: false },
    { kind: "dir", path: "src/lib", name: "lib", depth: 1, expanded: false },
    { kind: "file", path: "README.md", name: "README.md", depth: 0, expanded: false },
];

describe("treeKeyAction", () => {
    it("starts on the first row when there is no cursor yet", () => {
        // the old pane derived its cursor from the open file, so with nothing open j did nothing at all
        expect(treeKeyAction(rows, null, "next")).toEqual({ kind: "move", path: "src" });
    });

    it("moves onto a directory row", () => {
        // the bug this module exists to kill: moving onto a directory used to be a silent no-op,
        // which meant the cursor could never get past one
        expect(treeKeyAction(rows, "src/a.ts", "next")).toEqual({ kind: "move", path: "src/lib" });
    });

    it("moves onto a file row", () => {
        expect(treeKeyAction(rows, "src", "next")).toEqual({ kind: "move", path: "src/a.ts" });
    });

    it("moves backwards", () => {
        expect(treeKeyAction(rows, "src/lib", "prev")).toEqual({ kind: "move", path: "src/a.ts" });
    });

    it("does nothing at the end of the list", () => {
        expect(treeKeyAction(rows, "README.md", "next")).toEqual({ kind: "none" });
    });

    it("does nothing at the start of the list", () => {
        expect(treeKeyAction(rows, "src", "prev")).toEqual({ kind: "none" });
    });

    it("opens a file on activate", () => {
        expect(treeKeyAction(rows, "src/a.ts", "activate")).toEqual({ kind: "open", path: "src/a.ts" });
    });

    it("toggles a directory on activate", () => {
        // unreachable in the old pane: it looked the cursor up by the OPEN FILE path, which is never a directory
        expect(treeKeyAction(rows, "src", "activate")).toEqual({ kind: "toggle", path: "src" });
    });

    it("expands a collapsed directory", () => {
        expect(treeKeyAction(rows, "src/lib", "expand")).toEqual({ kind: "toggle", path: "src/lib" });
    });

    it("does not re-expand an already expanded directory", () => {
        expect(treeKeyAction(rows, "src", "expand")).toEqual({ kind: "none" });
    });

    it("collapses an expanded directory", () => {
        expect(treeKeyAction(rows, "src", "collapse")).toEqual({ kind: "toggle", path: "src" });
    });

    it("does not collapse an already collapsed directory", () => {
        expect(treeKeyAction(rows, "src/lib", "collapse")).toEqual({ kind: "none" });
    });

    it("ignores collapse and expand on a file", () => {
        expect(treeKeyAction(rows, "src/a.ts", "collapse")).toEqual({ kind: "none" });
        expect(treeKeyAction(rows, "src/a.ts", "expand")).toEqual({ kind: "none" });
    });

    it("does nothing when the cursor names a row that is no longer visible", () => {
        expect(treeKeyAction(rows, "src/lib/gone.ts", "activate")).toEqual({ kind: "none" });
    });

    it("does nothing on an empty tree", () => {
        expect(treeKeyAction([], null, "next")).toEqual({ kind: "none" });
        expect(treeKeyAction([], null, "activate")).toEqual({ kind: "none" });
    });
});
