// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { WORKING_TREE } from "./historyrows";
import { authorInitial, branchesState } from "./projectbranchesmodel";

const NOW = 1_800_000_000_000;

const commit = (hash: string, parents: string[], refs: string[] = []): HistoryCommit => ({
    hash,
    parents,
    subject: `subject ${hash}`,
    author: "kael",
    email: "k@k",
    ts: NOW - 120_000,
    refs,
});

const reply = (patch: Partial<CommandGitHistoryRtnData>): CommandGitHistoryRtnData => ({
    isrepo: true,
    head: "aaa1111",
    commits: [],
    ...patch,
});

describe("branchesState", () => {
    it("is loading before the reply lands", () => {
        expect(branchesState(null, 0, NOW)).toEqual({ kind: "loading" });
    });

    it("reads a folder git does not know as no repository", () => {
        expect(branchesState(reply({ isrepo: false }), 3, NOW)).toEqual({ kind: "norepo" });
    });

    it("carries a git failure's stderr as the reason", () => {
        const failure = { command: "git log", exitcode: 128, stderr: "fatal: bad object refs/remotes/origin/HEAD" };
        expect(branchesState(reply({ failure }), 0, NOW)).toEqual({
            kind: "failed",
            reason: "fatal: bad object refs/remotes/origin/HEAD",
        });
    });

    it("names the exit code when git said nothing on stderr", () => {
        const failure = { command: "git log", exitcode: 128, stderr: "  " };
        expect(branchesState(reply({ failure }), 0, NOW)).toEqual({
            kind: "failed",
            reason: "git exited with code 128",
        });
    });

    it("is empty for a repository with no commits, whatever the change count", () => {
        expect(branchesState(reply({ head: "", commits: [] }), 2, NOW)).toEqual({ kind: "empty" });
        expect(branchesState(reply({ head: "", commits: undefined }), 0, NOW)).toEqual({ kind: "empty" });
    });

    it("puts the uncommitted row first, hanging off HEAD", () => {
        const s = branchesState(reply({ commits: [commit("aaa1111", ["bbb2222"]), commit("bbb2222", [])] }), 3, NOW);
        expect(s.kind).toBe("rows");
        const rows = s.kind === "rows" ? s.rows : [];
        expect(rows.map((r) => r.hash)).toEqual([WORKING_TREE, "aaa1111", "bbb2222"]);
        expect(rows[0].workingTree).toBe(true);
        expect(rows[0].parents).toEqual(["aaa1111"]);
        expect(rows[0].fileCount).toBe(3);
        expect(rows[0].subject).toBe("Uncommitted changes");
    });

    it("draws no uncommitted row for a clean checkout", () => {
        const s = branchesState(reply({ commits: [commit("aaa1111", [])] }), 0, NOW);
        expect(s.kind === "rows" ? s.rows.map((r) => r.hash) : null).toEqual(["aaa1111"]);
    });

    it("turns ref decorations into chips", () => {
        const s = branchesState(
            reply({
                commits: [
                    commit("aaa1111", ["bbb2222"], ["HEAD -> refs/heads/main", "refs/remotes/origin/main"]),
                    commit("bbb2222", [], ["refs/heads/feat/side", "tag: refs/tags/v1"]),
                ],
            }),
            0,
            NOW
        );
        const rows = s.kind === "rows" ? s.rows : [];
        expect(rows[0].refs).toEqual([
            { label: "main", kind: "head" },
            { label: "origin/main", kind: "remote" },
        ]);
        expect(rows[1].refs).toEqual([
            { label: "feat/side", kind: "branch" },
            { label: "v1", kind: "tag" },
        ]);
    });
});

describe("authorInitial", () => {
    it("is the author's first letter, upper-cased", () => {
        expect(authorInitial("kael")).toBe("K");
        expect(authorInitial("  ánh")).toBe("Á");
    });

    it("is a question mark for no author", () => {
        expect(authorInitial("")).toBe("?");
        expect(authorInitial("   ")).toBe("?");
    });
});
