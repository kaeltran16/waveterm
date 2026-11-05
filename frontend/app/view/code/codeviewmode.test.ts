// frontend/app/view/code/codeviewmode.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { shownViewMode, showsSourceEditor } from "./codeviewmode";

describe("shownViewMode", () => {
    it("shows Source for a non-markdown file left in preview mode, and the mode itself otherwise", () => {
        expect(shownViewMode("preview", "a.js")).toBe("source");
        expect(shownViewMode("preview", "README.md")).toBe("preview");
        expect(shownViewMode("diff", "a.js")).toBe("diff");
        expect(shownViewMode("source", "README.md")).toBe("source");
    });
});

describe("showsSourceEditor", () => {
    it("showsSourceEditor is false for markdown Preview and for Diff, true for a Go file in preview mode", () => {
        expect(showsSourceEditor("preview", "docs/README.md")).toBe(false);
        expect(showsSourceEditor("diff", "main.go")).toBe(false);
        expect(showsSourceEditor("diff", "docs/README.md")).toBe(false);
        expect(showsSourceEditor("preview", "main.go")).toBe(true);
        expect(showsSourceEditor("source", "docs/README.md")).toBe(true);
        expect(showsSourceEditor("source", "main.go")).toBe(true);
    });
});
