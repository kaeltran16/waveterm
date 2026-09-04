// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, describe, expect, it, vi } from "vitest";

const divergence = vi.fn();
const compareChanges = vi.fn();
const compareDiff = vi.fn();
const listBranches = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GitDivergenceCommand: (...a: any[]) => divergence(...a),
        GitCompareChangesCommand: (...a: any[]) => compareChanges(...a),
        GitCompareDiffCommand: (...a: any[]) => compareDiff(...a),
        ListBranchesCommand: (...a: any[]) => listBranches(...a),
        GitCommitChangesCommand: vi.fn(),
        GitCommitDiffCommand: vi.fn(),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { compareOnAtom, compareRefsAtom, enterCompare, leaveCompare } from "./comparestore";
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
