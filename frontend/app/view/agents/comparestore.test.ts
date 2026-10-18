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
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import {
    compareAggregateAtom,
    compareErrorAtom,
    compareOnAtom,
    compareRefsAtom,
    compareSelectedFileAtom,
    compareSidesAtom,
    enterCompare,
    fetchStateOf,
    fetchStatesAtom,
    leaveCompare,
    runFetch,
    setCompareForm,
    setCompareRefs,
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
    globalStore.set(fetchStatesAtom, {});
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

    it("carries when the refs split, 0 when the read has no time", async () => {
        globalStore.set(diffScopeAtom, base);
        listBranches.mockResolvedValue({ branches: [], default: "main" });
        compareChanges.mockResolvedValue({ isrepo: true, statusz: "", numstat: "" });

        divergence.mockResolvedValue({ isrepo: true, ahead: [], behind: [], mergebase: "m1", mergebasets: 42 });
        await enterCompare("/repo", "feat");
        expect(globalStore.get(compareSidesAtom)).toMatchObject({ mergeBase: "m1", mergeBaseTs: 42 });

        divergence.mockResolvedValue({ isrepo: true, ahead: [], behind: [], mergebase: "" });
        await enterCompare("/repo", "feat");
        expect(globalStore.get(compareSidesAtom)).toMatchObject({ mergeBase: "", mergeBaseTs: 0 });
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

        expect(fetchStateOf(globalStore.get(fetchStatesAtom), "/repo")).toEqual({
            running: false,
            at: 1_700_000_000,
            failure: null,
        });
        expect(divergence.mock.calls.length).toBeGreaterThan(before);
    });

    // git's own words, and the comparison on screen is still valid — it is merely not freshened.
    it("keeps the failure as data, the old clock, and does not re-read", async () => {
        await entered();
        globalStore.set(fetchStatesAtom, { "/repo": { running: false, at: 1_699_000_000, failure: null } });
        const before = divergence.mock.calls.length;
        const failure = { command: "git fetch --prune origin", exitcode: 128, stderr: "no such remote" };
        gitFetch.mockResolvedValue({ isrepo: true, fetchedat: 0, failure });

        await runFetch("/repo");

        expect(fetchStateOf(globalStore.get(fetchStatesAtom), "/repo")).toEqual({
            running: false,
            at: 1_699_000_000,
            failure,
        });
        expect(divergence.mock.calls.length).toBe(before);
    });

    // A rejected RPC has no stderr to show; the button must still stop spinning.
    it("stops running and keeps the previous clock when the call itself fails", async () => {
        globalStore.set(fetchStatesAtom, { "/repo": { running: false, at: 42, failure: null } });
        gitFetch.mockRejectedValue(new Error("socket closed"));

        await runFetch("/repo");

        const st = fetchStateOf(globalStore.get(fetchStatesAtom), "/repo");
        expect(st.running).toBe(false);
        expect(st.at).toBe(42);
        expect(st.failure?.exitcode).toBe(-1);
    });

    // the banner and the clock are about one remote; picking another source must not carry them over
    it("keeps a fetch's failure and clock with the repository it ran in", async () => {
        const failure = { command: "git fetch --prune origin", exitcode: 128, stderr: "no such remote" };
        gitFetch.mockResolvedValue({ isrepo: true, fetchedat: 0, failure });

        await runFetch("/repo");

        expect(fetchStateOf(globalStore.get(fetchStatesAtom), "/repo").failure).toEqual(failure);
        expect(fetchStateOf(globalStore.get(fetchStatesAtom), "/other")).toEqual({
            running: false,
            at: 0,
            failure: null,
        });
    });
});

describe("setCompareRefs", () => {
    const changed = (...paths: string[]) => ({
        isrepo: true,
        statusz: paths.map((p) => `M  ${p}\0`).join(""),
        numstat: paths.map((p) => `1\t0\t${p}\n`).join(""),
    });
    const commit = (hash: string) => ({ hash }) as unknown as HistoryCommit;
    const split = { isrepo: true, ahead: [], behind: [], mergebase: "m1" };
    const comparing: DiffScope = {
        ...base,
        range: { kind: "compare", base: "main", head: "feat", form: "mergebase", from: base.range },
    };

    it("writes the pair into a comparing scope, which stays the one source of truth", async () => {
        globalStore.set(diffScopeAtom, comparing);
        divergence.mockResolvedValue(split);
        compareChanges.mockResolvedValue(changed());

        await setCompareRefs("/repo", "x", "y");

        expect(globalStore.get(diffScopeAtom)!.range).toStrictEqual({
            kind: "compare",
            base: "x",
            head: "y",
            form: "mergebase",
            from: base.range,
        });
    });

    it("leaves a scope that is not comparing, and a missing scope, as they were", async () => {
        divergence.mockResolvedValue(split);
        compareChanges.mockResolvedValue(changed());

        globalStore.set(diffScopeAtom, base);
        await setCompareRefs("/repo", "x", "y");
        expect(globalStore.get(diffScopeAtom)).toStrictEqual(base);

        globalStore.set(diffScopeAtom, null);
        await setCompareRefs("/repo", "x", "y");
        expect(globalStore.get(diffScopeAtom)).toBeNull();
    });

    it("asks for two refs and reads nothing when either is blank", async () => {
        for (const [from, to] of [
            ["", "feat"],
            ["main", ""],
        ]) {
            globalStore.set(compareErrorAtom, null);
            await setCompareRefs("/repo", from, to);
            expect(globalStore.get(compareErrorAtom)).toBe("Pick two refs to compare.");
        }
        expect(divergence).not.toHaveBeenCalled();
        expect(compareChanges).not.toHaveBeenCalled();
    });

    it("says it is not a repository when either read says so, and shows no sides", async () => {
        for (const [div, agg] of [
            [{ ...split, isrepo: false }, changed("a.ts")],
            [split, { ...changed("a.ts"), isrepo: false }],
        ]) {
            divergence.mockResolvedValue(div);
            compareChanges.mockResolvedValue(agg);
            await setCompareRefs("/repo", "main", "feat");
            expect(globalStore.get(compareErrorAtom)).toBe("Not a git repository.");
            expect(globalStore.get(compareSidesAtom)).toBeNull();
            expect(globalStore.get(compareAggregateAtom)).toBeNull();
        }
    });

    it("keeps both commit columns as read, and reads absent ones as empty", async () => {
        compareChanges.mockResolvedValue(changed());

        divergence.mockResolvedValue({
            isrepo: true,
            ahead: [commit("a1")],
            behind: [commit("b1"), commit("b2")],
            mergebase: "m1",
            mergebasets: 5,
        });
        await setCompareRefs("/repo", "main", "feat");
        expect(globalStore.get(compareSidesAtom)).toStrictEqual({
            ahead: [commit("a1")],
            behind: [commit("b1"), commit("b2")],
            mergeBase: "m1",
            mergeBaseTs: 5,
        });

        divergence.mockResolvedValue({ isrepo: true });
        await setCompareRefs("/repo", "main", "feat");
        expect(globalStore.get(compareSidesAtom)).toStrictEqual({
            ahead: [],
            behind: [],
            mergeBase: "",
            mergeBaseTs: 0,
        });
    });

    it("opens the first changed file, and none when nothing changed", async () => {
        divergence.mockResolvedValue(split);

        compareChanges.mockResolvedValue(changed("a.ts", "b.ts"));
        await setCompareRefs("/repo", "main", "feat");
        expect(globalStore.get(compareSelectedFileAtom)).toBe("a.ts");

        compareChanges.mockResolvedValue(changed());
        await setCompareRefs("/repo", "main", "feat");
        expect(globalStore.get(compareSelectedFileAtom)).toBeNull();
    });

    it("drops a read the refs have moved past", async () => {
        let releaseFirst: (v: any) => void = () => {};
        divergence.mockImplementationOnce(() => new Promise((res) => (releaseFirst = res)));
        divergence.mockResolvedValue({ ...split, mergebase: "m-second" });
        compareChanges.mockResolvedValue(changed("b.ts"));

        const slow = setCompareRefs("/repo", "a", "a2");
        await setCompareRefs("/repo", "b", "b2");
        releaseFirst({ ...split, mergebase: "m-first" });
        await slow;

        expect(globalStore.get(compareSidesAtom)!.mergeBase).toBe("m-second");
    });
});

describe("runFetch while and after it runs", () => {
    it("shows the fetch running with the last failure cleared and the clock kept", async () => {
        const old = { command: "git fetch", exitcode: 1, stderr: "old" };
        globalStore.set(fetchStatesAtom, { "/repo": { running: false, at: 7, failure: old } });
        globalStore.set(compareRefsAtom, null);
        let release: (v: any) => void = () => {};
        gitFetch.mockImplementation(() => new Promise((res) => (release = res)));

        const pending = runFetch("/repo");
        expect(fetchStateOf(globalStore.get(fetchStatesAtom), "/repo")).toStrictEqual({
            running: true,
            at: 7,
            failure: null,
        });

        release({ isrepo: true, fetchedat: 9 });
        await pending;
    });

    // the client's timeout binds the server's context, so the default would cancel a slow fetch under git
    it("fetches this repository with the raised budget", async () => {
        globalStore.set(compareRefsAtom, null);
        gitFetch.mockResolvedValue({ isrepo: true, fetchedat: 1 });

        await runFetch("/repo");

        expect(gitFetch).toHaveBeenCalledWith({}, { cwd: "/repo" }, { timeout: 60000 });
    });

    it("has no comparison to re-read when no pair was ever picked", async () => {
        globalStore.set(compareRefsAtom, null);
        gitFetch.mockResolvedValue({ isrepo: true, fetchedat: 5 });

        await runFetch("/repo");

        expect(fetchStateOf(globalStore.get(fetchStatesAtom), "/repo")).toEqual({
            running: false,
            at: 5,
            failure: null,
        });
        expect(divergence).not.toHaveBeenCalled();
    });
});
