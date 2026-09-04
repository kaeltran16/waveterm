// frontend/app/view/code/codestatus.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { parseGitChanges } from "@/app/view/agents/gitstatus";
import { describe, expect, it } from "vitest";
import { changedDirs, statusByPath, statusGlyph } from "./codestatus";

// porcelain -z: NUL-separated "XY path" entries; a rename carries its source path in the next field
const STATUS_Z = " M frontend/app/a.ts\0A  docs/new.md\0?? scratch.txt\0R  src/new.ts\0src/old.ts\0";
const NUMSTAT = "3\t1\tfrontend/app/a.ts\n10\t0\tdocs/new.md\n2\t2\tsrc/{old.ts => new.ts}\n";

describe("statusByPath", () => {
    it("keys every change by its path and carries the counts", () => {
        const m = statusByPath(parseGitChanges(STATUS_Z, NUMSTAT));
        expect(m.get("frontend/app/a.ts")).toEqual({ status: "M", adds: 3, dels: 1 });
        expect(m.get("docs/new.md")).toEqual({ status: "A", adds: 10, dels: 0 });
        expect(m.get("scratch.txt")).toEqual({ status: "?", adds: 0, dels: 0 });
    });

    it("keys a rename by its new path, which is the path the tree renders", () => {
        const m = statusByPath(parseGitChanges(STATUS_Z, NUMSTAT));
        expect(m.get("src/new.ts")).toEqual({ status: "R", adds: 2, dels: 2 });
        expect(m.has("src/old.ts")).toBe(false);
    });

    it("is empty when nothing changed", () => {
        expect(statusByPath(parseGitChanges("", "")).size).toBe(0);
    });
});

describe("changedDirs", () => {
    it("marks every ancestor of a changed file and nothing else", () => {
        const dirs = changedDirs(["frontend/app/a.ts", "docs/new.md"]);
        expect([...dirs].sort()).toEqual(["docs", "frontend", "frontend/app"]);
    });

    it("marks nothing for a file at the root", () => {
        expect(changedDirs(["scratch.txt"]).size).toBe(0);
    });
});

describe("statusGlyph", () => {
    it("gives each porcelain letter a token class, never a hex value", () => {
        expect(statusGlyph("A").className).toBe("text-success");
        expect(statusGlyph("M").className).toBe("text-warning");
        expect(statusGlyph("D").className).toBe("text-error");
        expect(statusGlyph("?").className).toBe("text-muted");
        expect(statusGlyph("R").className).toBe("text-secondary");
        expect(statusGlyph("C").className).toBe("text-secondary");
    });

    it("labels each letter for the row title", () => {
        expect(statusGlyph("A").label).toBe("Added");
        expect(statusGlyph("?").label).toBe("Untracked");
    });

    it("falls back to the letter itself for a status it does not know", () => {
        expect(statusGlyph("X")).toEqual({ letter: "X", className: "text-muted", label: "Changed" });
    });
});
