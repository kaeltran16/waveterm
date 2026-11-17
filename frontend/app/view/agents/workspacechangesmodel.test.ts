// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { GitChange } from "./gitstatus";
import type { RailGitState } from "./railstore";
import { changesLine, changesShown, changesView } from "./workspacechangesmodel";

const file = (path: string, adds: number, dels = 0): GitChange => ({ path, status: "M", adds, dels });
const repo = (files: GitChange[], extra: Partial<RailGitState> = {}): RailGitState => ({
    cwd: "C:/src/demo",
    branch: "main",
    isRepo: true,
    changes: { files, adds: 0, dels: 0 },
    ...extra,
});

describe("what the Changes tab shows", () => {
    it("waits while the rail's read is in flight", () => {
        expect(changesView(null)).toBe("loading");
    });

    it("tells a failed read from a folder that is not a repository", () => {
        expect(changesView({ cwd: "C:/x", branch: "", isRepo: false, changes: null, failure: "boom" })).toBe("failed");
        expect(changesView({ cwd: "C:/x", branch: "", isRepo: false, changes: null })).toBe("norepo");
        expect(changesView({ cwd: null, branch: "", isRepo: false, changes: null })).toBe("norepo");
    });

    it("is clean with no changed files, and lists them otherwise", () => {
        expect(changesView(repo([]))).toBe("clean");
        expect(changesView(repo([file("a.ts", 1)]))).toBe("files");
    });
});

describe("the file whose diff shows", () => {
    const files = [file("src/b.ts", 1), file("a.ts", 2)];

    it("is the tab's selection while the list still has it", () => {
        expect(changesShown(files, "a.ts", false)).toBe("a.ts");
    });

    it("falls back to the list's first file when unset or gone", () => {
        expect(changesShown(files, null, false)).toBe("src/b.ts");
        expect(changesShown(files, "gone.ts", false)).toBe("src/b.ts");
        // the tree draws directories first
        expect(changesShown(files, null, true)).toBe("src/b.ts");
        expect(changesShown([file("z.ts", 1), file("lib/a.ts", 1)], null, true)).toBe("lib/a.ts");
    });

    it("is none with no files", () => {
        expect(changesShown([], "a.ts", false)).toBeNull();
    });
});

describe("the tab's summary line", () => {
    it("counts every listed file and sums its lines", () => {
        expect(changesLine(repo([file("a.ts", 3, 1), file("b.ts", 4, 2)]))).toEqual({
            count: "2 files",
            adds: 7,
            dels: 3,
            where: "main, uncommitted",
        });
        expect(changesLine(repo([file("a.ts", 1)])).count).toBe("1 file");
    });

    it("names the session-start base when the list is read against one", () => {
        expect(changesLine(repo([file("a.ts", 1)], { ref: "abc123" })).where).toBe("main, since session start");
    });

    it("leaves out a branch git did not name", () => {
        expect(changesLine(repo([file("a.ts", 1)], { branch: "" })).where).toBe("uncommitted");
    });
});
