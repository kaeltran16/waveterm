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

import { scopeKey } from "./diffscope";
import { filesStateAtom, requestFileLink } from "./filesstore";
import {
    historyCommitsAtom,
    historyFailureAtom,
    historyRowsAtom,
    historyScrollAtom,
    loadHistory,
    resetHistory,
    selectedCommitAtom,
    selectedFileAtom,
    setHistoryOpts,
} from "./githistorystore";
import { WORKING_TREE } from "./historyrows";

const CWD = "C:/repo";
const RUN = scopeKey({
    repo: { origin: { kind: "run", runId: "run-1", cwd: CWD, baseCommit: "base000" }, label: "run base000" },
    range: { kind: "run", runId: "run-1", baseCommit: "base000" },
});
// The run's own change set, as filesstore leaves it after a run-range load: everything since the run's
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
        requestFileLink(RUN, "pkg/jarvis/evidence.go");
        await loadHistory(CWD, RUN_OPTS, RUN);
        await settle();
        // a fixture that fails to build rows would make every assertion below vacuous
        expect(globalStore.get(historyFailureAtom)).toBeNull();
        expect(globalStore.get(selectedCommitAtom)).toBe(WORKING_TREE);
        expect(globalStore.get(selectedFileAtom)).toBe("pkg/jarvis/evidence.go");
    });

    it("opens a deleted file the same way — the deletion diff is the point", async () => {
        requestFileLink(RUN, "removed/old.ts");
        await loadHistory(CWD, RUN_OPTS, RUN);
        await settle();
        expect(globalStore.get(selectedCommitAtom)).toBe(WORKING_TREE);
        expect(globalStore.get(selectedFileAtom)).toBe("removed/old.ts");
    });

    it("beats a remembered commit selection — a deep link names one change", async () => {
        // the pane is already parked on the tip commit, as it would be after an earlier visit
        globalStore.set(selectedCommitAtom, "aaa1111");
        globalStore.set(selectedFileAtom, "x.ts");
        requestFileLink(RUN, "pkg/jarvis/evidence.go");
        await loadHistory(CWD, RUN_OPTS, RUN);
        await settle();
        expect(globalStore.get(selectedCommitAtom)).toBe(WORKING_TREE);
        expect(globalStore.get(selectedFileAtom)).toBe("pkg/jarvis/evidence.go");
    });

    it("beats a remembered working-tree row that is already showing a different file", async () => {
        // the case that failed live: the pane was parked on the run-changes row with its first file open
        globalStore.set(selectedCommitAtom, WORKING_TREE);
        globalStore.set(selectedFileAtom, "docs/open-issues.md");
        requestFileLink(RUN, "pkg/jarvis/evidence.go");
        await loadHistory(CWD, RUN_OPTS, RUN);
        await settle();
        expect(globalStore.get(selectedFileAtom)).toBe("pkg/jarvis/evidence.go");
    });

    it("survives the remount load that has no change set yet", async () => {
        // the surface fires one history read per mount against the previous render's state; that read
        // must not eat the link, or the load that can honour it finds nothing pending
        requestFileLink(RUN, "pkg/jarvis/evidence.go");
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
        requestFileLink(RUN, "not/in/the/list.ts");
        await loadHistory(CWD, RUN_OPTS, RUN);
        await settle();
        // falls back to the default pick (row zero = the run-changes row), never a blank pane
        expect(globalStore.get(selectedFileAtom)).toBe("docs/open-issues.md");
    });
});

// The agent details rail's changed-file rows are the same gesture as a sealed run's evidence rows, but
// they used to go through a separate request that only reached an atom no pane renders — so clicking
// the third file opened the Diff surface on the scope's *first* file. Same settling path now.
describe("agent-scoped file deep link", () => {
    const AGENT = scopeKey({
        repo: { origin: { kind: "agent", id: "agent-9" }, label: "agent-9" },
        range: { kind: "session", agentId: "agent-9" },
    });
    const AGENT_OPTS = { anchor: "base000", rowLabel: "Since session start" };

    it("opens the file clicked in the agent rail, not the scope's first file", async () => {
        requestFileLink(AGENT, "pkg/jarvis/evidence.go");
        await loadHistory(CWD, AGENT_OPTS, AGENT);
        await settle();
        expect(globalStore.get(historyFailureAtom)).toBeNull();
        expect(globalStore.get(selectedCommitAtom)).toBe(WORKING_TREE);
        expect(globalStore.get(selectedFileAtom)).toBe("pkg/jarvis/evidence.go");
    });

    it("beats a remembered row, then stops, so a later return keeps the user's own selection", async () => {
        requestFileLink(AGENT, "pkg/jarvis/evidence.go");
        await loadHistory(CWD, AGENT_OPTS, AGENT);
        await settle();
        // the user moves on to a commit, leaves the surface, and comes back
        globalStore.set(selectedCommitAtom, "aaa1111");
        globalStore.set(selectedFileAtom, "x.ts");
        await loadHistory(CWD, AGENT_OPTS, AGENT);
        await settle();
        expect(globalStore.get(selectedCommitAtom)).toBe("aaa1111");
    });

    it("a run's link is not claimable by the agent load and vice versa", async () => {
        requestFileLink(RUN, "pkg/jarvis/evidence.go");
        await loadHistory(CWD, AGENT_OPTS, AGENT);
        await settle();
        // the agent load must fall back to the default pick and leave the run's link pending
        expect(globalStore.get(selectedFileAtom)).toBe("docs/open-issues.md");
        globalStore.set(selectedCommitAtom, null);
        globalStore.set(selectedFileAtom, null);
        await loadHistory(CWD, RUN_OPTS, RUN);
        await settle();
        expect(globalStore.get(selectedFileAtom)).toBe("pkg/jarvis/evidence.go");
    });
});

describe("range changes do not re-read git", () => {
    // Decision 5 of the design. The anchor never reaches git — it labels a divider and names what the
    // synthetic top row counts — so folding it into the load identity is what made switching range
    // blank the list and throw the reader back to the top.
    it("keeps the reader's scroll offset and the loaded commits when only the anchor changes", async () => {
        gitHistory.mockResolvedValue({
            isrepo: true,
            head: "aaa1111",
            commits: [commit("aaa1111", "tip commit"), commit("bbb2222", "older commit")],
        });

        await loadHistory("/repo", { anchor: "bbb2222", anchorLabel: "session start", rowLabel: "Since session start" });
        globalStore.set(historyScrollAtom, 420);
        const before = globalStore.get(historyCommitsAtom);

        await loadHistory("/repo", {});

        expect(gitHistory).toHaveBeenCalledTimes(2);
        expect(globalStore.get(historyScrollAtom)).toBe(420);
        expect(globalStore.get(historyCommitsAtom)).toEqual(before);
    });

    it("relabels the divider with no git call at all", async () => {
        gitHistory.mockResolvedValue({
            isrepo: true,
            head: "aaa1111",
            commits: [commit("aaa1111", "tip commit"), commit("bbb2222", "older commit")],
        });

        await loadHistory("/repo", {});
        gitHistory.mockClear();

        setHistoryOpts({ anchor: "bbb2222", anchorLabel: "run base", rowLabel: "Run changes" });

        expect(gitHistory).not.toHaveBeenCalled();
        // the divider label and the synthetic top row's name are what the anchor is for; asserting the
        // row merely exists would pass without the setter, because that commit is in the list anyway
        const rows = globalStore.get(historyRowsAtom) ?? [];
        expect(rows.find((r) => r.hash === "bbb2222")?.divider).toBe("run base");
        expect(rows[0]?.subject).toBe("Run changes — 3 files");
    });

    // A different repository IS a different subject: filters and scroll from the old one are
    // meaningless, and a stale path filter would produce an empty history that looks broken.
    it("still starts a different repository at the top", async () => {
        gitHistory.mockResolvedValue({ isrepo: true, head: "aaa1111", commits: [commit("aaa1111", "tip commit")] });

        await loadHistory("/repo", {});
        globalStore.set(historyScrollAtom, 420);
        await loadHistory("/other", {});

        expect(globalStore.get(historyScrollAtom)).toBe(0);
    });
});
