// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, describe, expect, it, vi } from "vitest";

const divergence = vi.fn();
const compareChanges = vi.fn();
const listBranches = vi.fn();
const gitFetch = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GitDivergenceCommand: (...a: any[]) => divergence(...a),
        GitCompareChangesCommand: (...a: any[]) => compareChanges(...a),
        ListBranchesCommand: (...a: any[]) => listBranches(...a),
        GitFetchCommand: (...a: any[]) => gitFetch(...a),
        GitCommitChangesCommand: vi.fn(),
        GitCommitDiffCommand: vi.fn(),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import {
    compareOnAtom,
    compareRefsAtom,
    enterCompare,
    fetchStateAtom,
    leaveCompare,
    runFetch,
    setCompareForm,
    swapCompareRefs,
} from "./comparestore";
import type { DiffScope } from "./diffscope";
import { diffScopeAtom } from "./diffscopeatom";

const base: DiffScope = {
    repo: { origin: { kind: "agent", id: "a1" }, label: "jarvis-recall" },
    range: { kind: "session", agentId: "a1" },
};

afterEach(() => {
    divergence.mockReset();
    compareChanges.mockReset();
    listBranches.mockReset();
    gitFetch.mockReset();
    globalStore.set(fetchStateAtom, { running: false, at: 0, failure: null });
    globalStore.set(diffScopeAtom, null);
});

describe("comparison as a range", () => {
    it("is off until the stored range says otherwise", () => {
        globalStore.set(diffScopeAtom, base);
        expect(globalStore.get(compareOnAtom)).toBe(false);
    });

    it("turns on by writing the range, and remembers what it interrupted", async () => {
        globalStore.set(diffScopeAtom, base);
        listBranches.mockResolvedValue({ branches: [], default: "main" });
        divergence.mockResolvedValue({ isrepo: true, ahead: [], behind: [], mergebase: "m1" });
        compareChanges.mockResolvedValue({ isrepo: true, statusz: "", numstat: "" });

        await enterCompare("/repo", "feat");

        expect(globalStore.get(compareOnAtom)).toBe(true);
        const range = globalStore.get(diffScopeAtom)!.range;
        expect(range.kind).toBe("compare");
        expect(range.kind === "compare" && range.from).toEqual({ kind: "session", agentId: "a1" });
    });

    // Escape used to call exitCompare, which cleared a boolean and left the surface to work out what
    // to show. The interrupted range is carried, so leaving is a restore rather than a guess.
    it("restores the interrupted range on the way out", async () => {
        globalStore.set(diffScopeAtom, base);
        listBranches.mockResolvedValue({ branches: [], default: "main" });
        divergence.mockResolvedValue({ isrepo: true, ahead: [], behind: [], mergebase: "m1" });
        compareChanges.mockResolvedValue({ isrepo: true, statusz: "", numstat: "" });

        await enterCompare("/repo", "feat");
        leaveCompare();

        expect(globalStore.get(compareOnAtom)).toBe(false);
        expect(globalStore.get(diffScopeAtom)!.range).toEqual({ kind: "session", agentId: "a1" });
    });

    it("does nothing when there is no scope to compare within", async () => {
        await enterCompare("/repo", "feat");
        expect(divergence).not.toHaveBeenCalled();
        expect(globalStore.get(compareOnAtom)).toBe(false);
    });

    it("offers the pair last used when re-entering the same repository", async () => {
        globalStore.set(diffScopeAtom, base);
        listBranches.mockResolvedValue({ branches: [], default: "main" });
        divergence.mockResolvedValue({ isrepo: true, ahead: [], behind: [], mergebase: "m1" });
        compareChanges.mockResolvedValue({ isrepo: true, statusz: "", numstat: "" });

        await enterCompare("/repo", "feat");
        leaveCompare();
        globalStore.set(diffScopeAtom, base);
        await enterCompare("/repo", "other");

        expect(globalStore.get(compareRefsAtom)).toEqual({ base: "main", head: "feat" });
    });

    // The remembered pair is a convenience for the repository it was picked in. Carried into another
    // one it names branches that do not resolve there — the summary line was seen naming a branch the
    // freshly-picked repository does not have.
    it("forgets that pair when the source moves to another repository", async () => {
        globalStore.set(diffScopeAtom, base);
        listBranches.mockResolvedValue({ branches: [], default: "main" });
        divergence.mockResolvedValue({ isrepo: true, ahead: [], behind: [], mergebase: "m1" });
        compareChanges.mockResolvedValue({ isrepo: true, statusz: "", numstat: "" });

        await enterCompare("/repo-a", "feat/a");
        leaveCompare();

        globalStore.set(diffScopeAtom, base);
        listBranches.mockResolvedValue({ branches: [], default: "trunk" });
        await enterCompare("/repo-b", "feat/b");

        expect(globalStore.get(compareRefsAtom)).toEqual({ base: "trunk", head: "feat/b" });
    });
});

describe("the range form", () => {
    async function entered() {
        globalStore.set(diffScopeAtom, base);
        listBranches.mockResolvedValue({ branches: [], default: "main" });
        divergence.mockResolvedValue({ isrepo: true, ahead: [], behind: [], mergebase: "m1" });
        compareChanges.mockResolvedValue({ isrepo: true, statusz: "", numstat: "" });
        await enterCompare("/repo", "feat");
    }

    it("starts merge-base anchored — the file list matches the ahead count beside it", async () => {
        await entered();
        const range = globalStore.get(diffScopeAtom)!.range;
        expect(range.kind === "compare" && range.form).toBe("mergebase");
        expect(compareChanges).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ tips: false }));
    });

    // The form is a different question about the same two refs, so the aggregate has to be re-read.
    // A file list built three-dot beside a pane read two-dot is the failure this exists to prevent.
    it("re-reads the aggregate tip-to-tip and records the form in the range", async () => {
        await entered();
        await setCompareForm("/repo", "tips");

        const range = globalStore.get(diffScopeAtom)!.range;
        expect(range.kind === "compare" && range.form).toBe("tips");
        expect(compareChanges).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ tips: true }));
    });

    it("does not re-read when the form is already the active one", async () => {
        await entered();
        const before = compareChanges.mock.calls.length;
        await setCompareForm("/repo", "mergebase");
        expect(compareChanges.mock.calls.length).toBe(before);
    });
});

describe("remote refs, swap and fetch", () => {
    async function entered() {
        globalStore.set(diffScopeAtom, base);
        listBranches.mockResolvedValue({ branches: [], default: "main" });
        divergence.mockResolvedValue({ isrepo: true, ahead: [], behind: [], mergebase: "m1" });
        compareChanges.mockResolvedValue({ isrepo: true, statusz: "", numstat: "" });
        await enterCompare("/repo", "feat");
    }

    // origin/* is the review base most of the time, and T2 made the backend's default branch prefer it
    it("asks for remote-tracking refs, not just local branches", async () => {
        await entered();
        expect(listBranches).toHaveBeenCalledWith(expect.anything(), { projectpath: "/repo", includeremotes: true });
    });

    it("swaps by re-reading the inverted pair, not by redrawing", async () => {
        await entered();
        await swapCompareRefs("/repo");

        expect(globalStore.get(compareRefsAtom)).toEqual({ base: "feat", head: "main" });
        expect(divergence).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ base: "feat", head: "main" })
        );
    });

    it("has nothing to swap before both refs are set", async () => {
        globalStore.set(compareRefsAtom, null); // the pair survives across compares on purpose
        await swapCompareRefs("/repo");
        expect(divergence).not.toHaveBeenCalled();
    });

    // The refs moved, so what the comparison means moved with them — re-reading is the point.
    it("re-reads the comparison after a successful fetch", async () => {
        await entered();
        const before = divergence.mock.calls.length;
        gitFetch.mockResolvedValue({ isrepo: true, fetchedat: 1_700_000_000 });

        await runFetch("/repo");

        expect(globalStore.get(fetchStateAtom)).toEqual({ running: false, at: 1_700_000_000, failure: null });
        expect(divergence.mock.calls.length).toBeGreaterThan(before);
    });

    // git's own words, and the comparison on screen is still valid — it is merely not freshened.
    it("keeps the failure as data, the old clock, and does not re-read", async () => {
        await entered();
        globalStore.set(fetchStateAtom, { running: false, at: 1_699_000_000, failure: null });
        const before = divergence.mock.calls.length;
        const failure = { command: "git fetch --prune origin", exitcode: 128, stderr: "no such remote" };
        gitFetch.mockResolvedValue({ isrepo: true, fetchedat: 0, failure });

        await runFetch("/repo");

        expect(globalStore.get(fetchStateAtom)).toEqual({ running: false, at: 1_699_000_000, failure });
        expect(divergence.mock.calls.length).toBe(before);
    });

    // A rejected RPC has no stderr to show; the button must still stop spinning.
    it("stops running and keeps the previous clock when the call itself fails", async () => {
        globalStore.set(fetchStateAtom, { running: false, at: 42, failure: null });
        gitFetch.mockRejectedValue(new Error("socket closed"));

        await runFetch("/repo");

        const st = globalStore.get(fetchStateAtom);
        expect(st.running).toBe(false);
        expect(st.at).toBe(42);
        expect(st.failure?.exitcode).toBe(-1);
    });
});
