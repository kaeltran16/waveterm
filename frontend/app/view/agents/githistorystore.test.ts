// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Selection settling for the Diff surface's history pane. The case that matters here is precedence:
// the pane deliberately remembers where you were (so a nav switch does not throw you back to row
// zero), but a deep link from a sealed run's evidence card names one specific file and has to win.

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gitHistory = vi.fn();
const gitDiff = vi.fn();
const gitCommitChanges = vi.fn();
const gitCommitDiff = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GitHistoryCommand: (...a: any[]) => gitHistory(...a),
        GitDiffCommand: (...a: any[]) => gitDiff(...a),
        GitCommitChangesCommand: (...a: any[]) => gitCommitChanges(...a),
        GitCommitDiffCommand: (...a: any[]) => gitCommitDiff(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { filesStateAtom, requestRunFileSelection } from "./filesstore";
import { historyFailureAtom, loadHistory, resetHistory, selectedCommitAtom, selectedFileAtom } from "./githistorystore";
import { WORKING_TREE } from "./historyrows";

const CWD = "C:/repo";
const RUN = "run-1";
// The run's own change set, as filesstore leaves it after loadFilesForRun: everything since the run's
// base commit, which is what the "Run changes" row lists.
const RUN_CHANGES = {
    files: [
        { path: "docs/open-issues.md", status: "M", adds: 48, dels: 14 },
        { path: "pkg/jarvis/evidence.go", status: "M", adds: 25, dels: 6 },
        { path: "removed/old.ts", status: "D", adds: 0, dels: 30 },
    ],
};

const commit = (hash: string, subject: string) => ({
    hash,
    parents: [],
    subject,
    author: "t",
    email: "t@t",
    ts: 1_700_000_000,
    refs: [],
});

beforeEach(() => {
    gitHistory.mockResolvedValue({
        isrepo: true,
        head: "aaa1111",
        commits: [commit("aaa1111", "tip commit"), commit("bbb2222", "older commit")],
    });
    gitDiff.mockResolvedValue({ diff: "", content: "", untracked: false });
    gitCommitChanges.mockResolvedValue({ isrepo: true, statusz: "M  x.ts\0", numstat: "1\t0\tx.ts\n" });
    gitCommitDiff.mockResolvedValue({ diff: "" });
    globalStore.set(filesStateAtom, {
        cwd: CWD,
        branch: "main",
        isRepo: true,
        changes: RUN_CHANGES as any,
        ref: "base000",
    });
});

afterEach(() => {
    resetHistory();
    gitHistory.mockReset();
    gitDiff.mockReset();
    gitCommitChanges.mockReset();
    gitCommitDiff.mockReset();
    globalStore.set(filesStateAtom, null);
    globalStore.set(selectedCommitAtom, null);
    globalStore.set(selectedFileAtom, null);
});

const settle = () => new Promise((r) => setTimeout(r, 0));

const RUN_OPTS = { anchor: "base000", rowLabel: "Run changes" };

describe("loadHistory selection settling", () => {
    it("opens the deep-linked file on the run's own change set, not the first file", async () => {
        requestRunFileSelection(RUN, "pkg/jarvis/evidence.go");
        await loadHistory(CWD, RUN_OPTS, RUN);
        await settle();
        // a fixture that fails to build rows would make every assertion below vacuous
        expect(globalStore.get(historyFailureAtom)).toBeNull();
        expect(globalStore.get(selectedCommitAtom)).toBe(WORKING_TREE);
        expect(globalStore.get(selectedFileAtom)).toBe("pkg/jarvis/evidence.go");
    });

    it("opens a deleted file the same way — the deletion diff is the point", async () => {
        requestRunFileSelection(RUN, "removed/old.ts");
        await loadHistory(CWD, RUN_OPTS, RUN);
        await settle();
        expect(globalStore.get(selectedCommitAtom)).toBe(WORKING_TREE);
        expect(globalStore.get(selectedFileAtom)).toBe("removed/old.ts");
    });

    it("beats a remembered commit selection — a deep link names one change", async () => {
        // the pane is already parked on the tip commit, as it would be after an earlier visit
        globalStore.set(selectedCommitAtom, "aaa1111");
        globalStore.set(selectedFileAtom, "x.ts");
        requestRunFileSelection(RUN, "pkg/jarvis/evidence.go");
        await loadHistory(CWD, RUN_OPTS, RUN);
        await settle();
        expect(globalStore.get(selectedCommitAtom)).toBe(WORKING_TREE);
        expect(globalStore.get(selectedFileAtom)).toBe("pkg/jarvis/evidence.go");
    });

    it("beats a remembered working-tree row that is already showing a different file", async () => {
        // the case that failed live: the pane was parked on the run-changes row with its first file open
        globalStore.set(selectedCommitAtom, WORKING_TREE);
        globalStore.set(selectedFileAtom, "docs/open-issues.md");
        requestRunFileSelection(RUN, "pkg/jarvis/evidence.go");
        await loadHistory(CWD, RUN_OPTS, RUN);
        await settle();
        expect(globalStore.get(selectedFileAtom)).toBe("pkg/jarvis/evidence.go");
    });

    it("survives the remount load that has no change set yet", async () => {
        // the surface fires one history read per mount against the previous render's state; that read
        // must not eat the link, or the load that can honour it finds nothing pending
        requestRunFileSelection(RUN, "pkg/jarvis/evidence.go");
        globalStore.set(filesStateAtom, null);
        await loadHistory(CWD, RUN_OPTS, RUN);
        await settle();
        globalStore.set(filesStateAtom, {
            cwd: CWD,
            branch: "main",
            isRepo: true,
            changes: RUN_CHANGES as any,
            ref: "base000",
        });
        await loadHistory(CWD, RUN_OPTS, RUN);
        await settle();
        expect(globalStore.get(selectedCommitAtom)).toBe(WORKING_TREE);
        expect(globalStore.get(selectedFileAtom)).toBe("pkg/jarvis/evidence.go");
    });

    it("keeps a remembered commit selection when no deep link was followed", async () => {
        globalStore.set(selectedCommitAtom, "aaa1111");
        globalStore.set(selectedFileAtom, "x.ts");
        await loadHistory(CWD, RUN_OPTS, RUN);
        await settle();
        expect(globalStore.get(selectedCommitAtom)).toBe("aaa1111");
    });

    it("ignores a deep-linked path the scope's change set does not contain", async () => {
        requestRunFileSelection(RUN, "not/in/the/list.ts");
        await loadHistory(CWD, RUN_OPTS, RUN);
        await settle();
        // falls back to the default pick (row zero = the run-changes row), never a blank pane
        expect(globalStore.get(selectedFileAtom)).toBe("docs/open-issues.md");
    });
});
