// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { GitChange } from "./gitstatus";
import type { RailGitState } from "./railstore";
import { parseUnifiedDiff } from "./unifieddiff";
import { changesGroups, changesLine, changesView, fileOpen, hunkWalk, stepHunk } from "./workspacechangesmodel";

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

const change = (path: string, status = "M"): GitChange => ({ path, status, adds: 1, dels: 0 });
const patchOf = (...parts: string[]) => parseUnifiedDiff(parts.join("\n"));
const modified = (path: string, ...hunks: string[]) =>
    [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks].join("\n");
const opts = { truncated: false, ignoreWs: false };

describe("the groups the tab draws", () => {
    const files = [
        change("src/b.ts"),
        change("README.md"),
        change("pkg/x/z.go"),
        change("src/a.ts"),
        change("go.mod"),
        change("pkg/x/a.go"),
    ];
    const groups = changesGroups(files, null, opts);

    it("puts root files first, then one group per directory by path, files by name", () => {
        expect(groups.map((g) => [g.dir, g.files.map((f) => f.name)])).toEqual([
            ["", ["README.md", "go.mod"]],
            ["pkg/x", ["a.go", "z.go"]],
            ["src", ["a.ts", "b.ts"]],
        ]);
    });

    it("counts each group's files", () => {
        expect(groups.map((g) => g.count)).toEqual(["2 files", "2 files", "2 files"]);
        expect(changesGroups([change("a/b.ts")], null, opts)[0].count).toBe("1 file");
    });
});

describe("a file's facts", () => {
    const [root] = changesGroups(
        [change("a.ts", "M"), change("b.ts", "D"), change("c.ts", "A"), change("d.ts", "?"), change("e.ts", "R")],
        null,
        opts
    );
    const by = (name: string) => root.files.find((f) => f.name === name);

    it("reads an added or untracked file as a new file, letter A", () => {
        expect([by("c.ts")?.isNew, by("c.ts")?.letter]).toEqual([true, "A"]);
        expect([by("d.ts")?.isNew, by("d.ts")?.letter]).toEqual([true, "A"]);
        expect([by("a.ts")?.isNew, by("a.ts")?.letter]).toEqual([false, "M"]);
        expect(by("e.ts")?.letter).toBe("R");
    });

    it("starts a new file closed and any other open, until toggled", () => {
        expect(fileOpen(by("c.ts"), false)).toBe(false);
        expect(fileOpen(by("d.ts"), false)).toBe(false);
        expect(fileOpen(by("c.ts"), true)).toBe(true);
        expect(fileOpen(by("a.ts"), false)).toBe(true);
        expect(fileOpen(by("b.ts"), false)).toBe(true);
        expect(fileOpen(by("a.ts"), true)).toBe(false);
    });
});

describe("a file's hunks", () => {
    it("labels a hunk with the text after its second @@", () => {
        const patch = patchOf(modified("a.go", "@@ -40,7 +41,11 @@ func Groups(bs []Bookmark)", "-a", "+b"));
        const [g] = changesGroups([change("a.go")], patch, opts);
        expect(g.files[0].body).toBe("hunks");
        expect(g.files[0].hunks).toHaveLength(1);
        expect(g.files[0].hunks[0]).toMatchObject({ label: "func Groups(bs []Bookmark)", newStart: 41 });
        expect(g.files[0].hunks[0].rows.map((r) => [r.sign, r.text])).toEqual([
            ["-", "a"],
            ["+", "b"],
        ]);
    });

    it("labels a hunk git found no context for by its line", () => {
        const patch = patchOf(modified("a.go", "@@ -40,1 +41,1 @@", "-a", "+b"));
        expect(changesGroups([change("a.go")], patch, opts)[0].files[0].hunks[0].label).toBe("line 41");
    });

    it("labels a deleted file's hunk by the old side's line", () => {
        const patch = patchOf(
            "diff --git a/gone.go b/gone.go",
            "deleted file mode 100644",
            "--- a/gone.go",
            "+++ /dev/null",
            "@@ -1,2 +0,0 @@",
            "-x",
            "-y"
        );
        const hunk = changesGroups([change("gone.go", "D")], patch, opts)[0].files[0].hunks[0];
        expect(hunk.label).toBe("line 1");
        expect(hunk.newStart).toBe(0);
    });

    it("splits a file's lines at each hunk header", () => {
        const patch = patchOf(modified("a.go", "@@ -1 +1 @@ one", "-a", "+b", "@@ -9 +9,2 @@ two", " c", "+d"));
        const hunks = changesGroups([change("a.go")], patch, opts)[0].files[0].hunks;
        expect(hunks.map((h) => [h.label, h.newStart, h.rows.length])).toEqual([
            ["one", 1, 2],
            ["two", 9, 2],
        ]);
    });

    it("draws a new file's hunk with no label and numbered rows with no sign", () => {
        const patch = patchOf(
            "diff --git a/new.go b/new.go",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/new.go",
            "@@ -0,0 +1,2 @@",
            "+package a",
            "+// new"
        );
        const hunk = changesGroups([change("new.go", "?")], patch, opts)[0].files[0].hunks[0];
        expect(hunk.label).toBeNull();
        expect(hunk.rows.map((r) => [r.sign, r.text, r.newNo])).toEqual([
            ["", "package a", 1],
            ["", "// new", 2],
        ]);
    });
});

describe("a file's body", () => {
    const bodyOf = (patch: ReturnType<typeof patchOf>, o = opts) =>
        changesGroups([change("a.go")], patch, o)[0].files[0].body;
    const patchA = patchOf(modified("a.go", "@@ -1 +1 @@", "-a", "+b"));
    const binary = patchOf("diff --git a/a.go b/a.go", "Binary files a/a.go and b/a.go differ");
    const noHunks = patchOf("diff --git a/a.go b/a.go", "old mode 100644", "new mode 100755");
    // sorts before a.go, so a cut after it leaves a.go out
    const before = patchOf(modified("0.go", "@@ -1 +1 @@", "-a", "+b"));

    it("is loading while the first read is pending", () => {
        expect(bodyOf(null)).toBe("loading");
    });

    it("is hunks, or binary", () => {
        expect(bodyOf(patchA)).toBe("hunks");
        expect(bodyOf(binary)).toBe("binary");
    });

    it("is too large for a file past the cut, never loading", () => {
        expect(bodyOf(before, { ...opts, truncated: true })).toBe("toolarge");
        expect(bodyOf([], { ...opts, truncated: true })).toBe("toolarge");
    });

    // git -w leaves a whitespace-only file out of the patch altogether, so a missing file is cut only when it would
    // come after the patch's last entry: the tracked diff by path, then the untracked files by path
    it("is whitespace, not too large, for a file the cut did not reach", () => {
        const files = [change("a.go"), change("b.go"), change("z.go", "?")];
        const patch = patchOf(modified("b.go", "@@ -1 +1 @@", "-a", "+b"));
        const bodies = changesGroups(files, patch, { truncated: true, ignoreWs: true })[0].files.map((f) => f.body);
        expect(bodies).toEqual(["whitespace", "hunks", "toolarge"]);
    });

    it("orders untracked files after every tracked one when placing the cut", () => {
        const files = [change("z.go"), change("a.go", "?")];
        const patch = patchOf(modified("z.go", "@@ -1 +1 @@", "-a", "+b"));
        const bodies = changesGroups(files, patch, { truncated: true, ignoreWs: false })[0].files.map((f) => f.body);
        expect(bodies).toEqual(["toolarge", "hunks"]);
    });

    it("is whitespace when hiding it leaves no hunks, and empty otherwise", () => {
        expect(bodyOf([], { ...opts, ignoreWs: true })).toBe("whitespace");
        expect(bodyOf(noHunks, { ...opts, ignoreWs: true })).toBe("whitespace");
        expect(bodyOf([])).toBe("empty");
        expect(bodyOf(noHunks)).toBe("empty");
    });
});

describe("the hunk walk", () => {
    const patch = patchOf(
        modified("b.go", "@@ -1 +1 @@", "-a", "+b", "@@ -9 +9 @@", "-c", "+d"),
        modified("src/a.go", "@@ -1 +1 @@", "-a", "+b"),
        modified("a.go", "@@ -1 +1 @@", "-a", "+b")
    );
    const files = [change("b.go"), change("src/a.go"), change("a.go", "?")];
    const groups = changesGroups(files, patch, opts);

    it("lists every hunk of every file in display order, closed files included", () => {
        expect(hunkWalk(groups)).toEqual([
            { path: "a.go", hunk: 0 },
            { path: "b.go", hunk: 0 },
            { path: "b.go", hunk: 1 },
            { path: "src/a.go", hunk: 0 },
        ]);
    });

    it("is empty with no hunks", () => {
        expect(hunkWalk(changesGroups(files, null, opts))).toEqual([]);
    });
});

describe("stepping the change counter", () => {
    it("goes from none yet to the first on next and to the last on previous", () => {
        expect(stepHunk(0, 4, "next")).toBe(1);
        expect(stepHunk(0, 4, "previous")).toBe(4);
    });

    it("steps by one and wraps at both ends", () => {
        expect(stepHunk(2, 4, "next")).toBe(3);
        expect(stepHunk(2, 4, "previous")).toBe(1);
        expect(stepHunk(4, 4, "next")).toBe(1);
        expect(stepHunk(1, 4, "previous")).toBe(4);
    });

    it("stays at none with nothing to step to", () => {
        expect(stepHunk(0, 0, "next")).toBe(0);
        expect(stepHunk(0, 0, "previous")).toBe(0);
    });
});
