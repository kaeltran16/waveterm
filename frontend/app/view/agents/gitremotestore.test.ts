// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, describe, expect, it, vi } from "vitest";

const gitFetch = vi.fn();
const gitPush = vi.fn();
const gitChanges = vi.fn();
const gitHistory = vi.fn();
const listBranches = vi.fn();
const divergence = vi.fn();
const compareChanges = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GitFetchCommand: (...a: any[]) => gitFetch(...a),
        GitPushCommand: (...a: any[]) => gitPush(...a),
        GitChangesCommand: (...a: any[]) => gitChanges(...a),
        GitHistoryCommand: (...a: any[]) => gitHistory(...a),
        ListBranchesCommand: (...a: any[]) => listBranches(...a),
        GitDivergenceCommand: (...a: any[]) => divergence(...a),
        GitCompareChangesCommand: (...a: any[]) => compareChanges(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { enterCompare, leaveCompare } from "./comparestore";
import type { DiffScope } from "./diffscope";
import { diffScopeAtom } from "./diffscopeatom";
import { filesStateAtom, loadFilesForScope } from "./filesstore";
import { dismissRemoteFailure, gitRemoteStateOf, gitRemoteStatesAtom, runFetch, runPush } from "./gitremotestore";

const project: DiffScope = {
    repo: { origin: { kind: "project", name: "p", path: "/repo" }, label: "p" },
    range: { kind: "working" },
};
const CLEAN = { isrepo: true, branch: "feat", statusz: "", numstat: "" };
const stateOf = (cwd: string) => gitRemoteStateOf(globalStore.get(gitRemoteStatesAtom), cwd);
const OLD_FAILURE = { action: "fetch" as const, git: { command: "git fetch", exitcode: 1, stderr: "old" } };

// a promise the test settles, so an action can be looked at while it runs
function held() {
    let settle!: (v: unknown) => void;
    const promise = new Promise((r) => (settle = r));
    return { promise, settle };
}

// the surface showing /repo's working tree, its change list and history read once
async function onProject(): Promise<void> {
    gitChanges.mockResolvedValue(CLEAN);
    gitHistory.mockResolvedValue({ isrepo: true, commits: [] });
    globalStore.set(diffScopeAtom, project);
    await loadFilesForScope(project);
    gitChanges.mockClear();
    gitHistory.mockClear();
}

async function inCompare(cwd = "/repo"): Promise<void> {
    await onProject();
    listBranches.mockResolvedValue({ branches: [], default: "main" });
    divergence.mockResolvedValue({ isrepo: true, ahead: [], behind: [], mergebase: "m1" });
    compareChanges.mockResolvedValue({ isrepo: true, statusz: "", numstat: "" });
    await enterCompare(cwd, "feat");
    listBranches.mockClear();
    divergence.mockClear();
}

afterEach(() => {
    for (const f of [gitFetch, gitPush, gitChanges, gitHistory, listBranches, divergence, compareChanges]) {
        f.mockReset();
    }
    leaveCompare();
    globalStore.set(gitRemoteStatesAtom, {});
    globalStore.set(diffScopeAtom, null);
    globalStore.set(filesStateAtom, null);
});

describe("an action while it runs", () => {
    it("a push runs with the last failure cleared and the clocks kept", async () => {
        globalStore.set(gitRemoteStatesAtom, {
            "/repo": { running: null, fetchedAt: 7, pushedAt: 8, failure: OLD_FAILURE },
        });
        const h = held();
        gitPush.mockReturnValue(h.promise);

        const pushing = runPush("/repo");
        expect(stateOf("/repo")).toStrictEqual({ running: "push", fetchedAt: 7, pushedAt: 8, failure: null });

        h.settle({ isrepo: true, pushedat: 9 });
        await pushing;
        expect(stateOf("/repo").running).toBeNull();
    });

    it("a fetch runs with the last failure cleared", async () => {
        globalStore.set(gitRemoteStatesAtom, {
            "/repo": { running: null, fetchedAt: 7, pushedAt: 0, failure: { ...OLD_FAILURE, action: "push" } },
        });
        const h = held();
        gitFetch.mockReturnValue(h.promise);

        const fetching = runFetch("/repo");
        expect(stateOf("/repo")).toStrictEqual({ running: "fetch", fetchedAt: 7, pushedAt: 0, failure: null });

        h.settle({ isrepo: true, fetchedat: 9 });
        await fetching;
    });

    it("refuses the other action while one runs", async () => {
        const h = held();
        gitFetch.mockReturnValue(h.promise);
        const fetching = runFetch("/repo");

        await runPush("/repo");
        await runFetch("/repo");

        expect(gitPush).not.toHaveBeenCalled();
        expect(gitFetch).toHaveBeenCalledTimes(1);
        expect(stateOf("/repo").running).toBe("fetch");
        h.settle({ isrepo: true, fetchedat: 1 });
        await fetching;
    });

    it("runs in one repository while another runs elsewhere", async () => {
        const h = held();
        gitFetch.mockReturnValue(h.promise);
        const fetching = runFetch("/A");
        gitPush.mockResolvedValue({ isrepo: true, pushedat: 3 });

        await runPush("/B");

        expect(gitPush).toHaveBeenCalledTimes(1);
        h.settle({ isrepo: true, fetchedat: 1 });
        await fetching;
    });

    // the client's timeout binds the server's context, so the default would cancel a slow push under git
    it("both talk to the network with the raised budget", async () => {
        gitFetch.mockResolvedValue({ isrepo: true, fetchedat: 1 });
        gitPush.mockResolvedValue({ isrepo: true, pushedat: 1 });

        await runFetch("/repo");
        await runPush("/repo");

        expect(gitFetch).toHaveBeenCalledWith({}, { cwd: "/repo" }, { timeout: 60000 });
        expect(gitPush).toHaveBeenCalledWith({}, { cwd: "/repo" }, { timeout: 60000 });
    });
});

describe("a push that fails", () => {
    it("keeps git's failure as data and the previous push time", async () => {
        globalStore.set(gitRemoteStatesAtom, { "/repo": { running: null, fetchedAt: 0, pushedAt: 42, failure: null } });
        const failure = { command: "git push", exitcode: 1, stderr: " ! [rejected] feat -> feat (fetch first)" };
        gitPush.mockResolvedValue({ isrepo: true, pushedat: 0, failure });

        await runPush("/repo");

        expect(stateOf("/repo")).toStrictEqual({
            running: null,
            fetchedAt: 0,
            pushedAt: 42,
            failure: { action: "push", git: failure },
        });
    });

    // a rejected RPC has no stderr to show; the button must still stop spinning
    it("leaves a failure, not a spinning button, when the call itself fails", async () => {
        globalStore.set(gitRemoteStatesAtom, { "/repo": { running: null, fetchedAt: 0, pushedAt: 42, failure: null } });
        gitPush.mockRejectedValue(new Error("socket closed"));

        await runPush("/repo");

        const s = stateOf("/repo");
        expect(s.running).toBeNull();
        expect(s.pushedAt).toBe(42);
        expect(s.failure?.action).toBe("push");
        expect(s.failure?.git.exitcode).toBe(-1);
    });

    it("re-reads nothing", async () => {
        await onProject();
        gitPush.mockResolvedValue({
            isrepo: true,
            pushedat: 0,
            failure: { command: "git push", exitcode: 1, stderr: "x" },
        });

        await runPush("/repo");

        expect(gitChanges).not.toHaveBeenCalled();
        expect(gitHistory).not.toHaveBeenCalled();
    });

    it("is dismissed without touching the clocks", async () => {
        globalStore.set(gitRemoteStatesAtom, {
            "/repo": { running: null, fetchedAt: 5, pushedAt: 6, failure: OLD_FAILURE },
        });
        dismissRemoteFailure("/repo");
        expect(stateOf("/repo")).toStrictEqual({ running: null, fetchedAt: 5, pushedAt: 6, failure: null });
    });
});

describe("a fetch that fails", () => {
    it("keeps git's failure, the old clock, and re-reads nothing", async () => {
        await inCompare();
        globalStore.set(gitRemoteStatesAtom, { "/repo": { running: null, fetchedAt: 99, pushedAt: 0, failure: null } });
        const failure = { command: "git fetch --prune origin", exitcode: 128, stderr: "no such remote" };
        gitFetch.mockResolvedValue({ isrepo: true, fetchedat: 0, failure });

        await runFetch("/repo");

        expect(stateOf("/repo")).toStrictEqual({
            running: null,
            fetchedAt: 99,
            pushedAt: 0,
            failure: { action: "fetch", git: failure },
        });
        expect(divergence).not.toHaveBeenCalled();
        expect(gitChanges).not.toHaveBeenCalled();
    });

    it("leaves a failure, not a spinning button, when the call itself fails", async () => {
        gitFetch.mockRejectedValue(new Error("socket closed"));

        await runFetch("/repo");

        const s = stateOf("/repo");
        expect(s.running).toBeNull();
        expect(s.failure?.action).toBe("fetch");
        expect(s.failure?.git.exitcode).toBe(-1);
    });

    // the banner and the clocks are about one remote; picking another source must not carry them over
    it("keeps its failure with the repository it ran in", async () => {
        const failure = { command: "git fetch", exitcode: 128, stderr: "no such remote" };
        gitFetch.mockResolvedValue({ isrepo: true, fetchedat: 0, failure });

        await runFetch("/repo");

        expect(stateOf("/repo").failure?.git).toEqual(failure);
        expect(stateOf("/other")).toStrictEqual({ running: null, fetchedAt: 0, pushedAt: 0, failure: null });
    });
});

describe("re-reads after a successful action", () => {
    it("a push records its time and re-reads the change list and the history", async () => {
        await onProject();
        gitPush.mockResolvedValue({ isrepo: true, pushedat: 1_700_000_000 });

        await runPush("/repo");

        expect(stateOf("/repo").pushedAt).toBe(1_700_000_000);
        expect(gitChanges).toHaveBeenCalledWith({}, expect.objectContaining({ cwd: "/repo", remote: true }));
        expect(gitHistory).toHaveBeenCalledWith({}, expect.objectContaining({ cwd: "/repo" }), expect.anything());
    });

    it("a fetch records its time and re-reads the change list", async () => {
        await onProject();
        gitFetch.mockResolvedValue({ isrepo: true, fetchedat: 1_700_000_000 });

        await runFetch("/repo");

        expect(stateOf("/repo").fetchedAt).toBe(1_700_000_000);
        expect(gitChanges).toHaveBeenCalledWith({}, expect.objectContaining({ cwd: "/repo", remote: true }));
    });

    it("a fetch in compare on that repository re-reads the refs and the pair", async () => {
        await inCompare();
        gitFetch.mockResolvedValue({ isrepo: true, fetchedat: 1 });

        await runFetch("/repo");

        expect(listBranches).toHaveBeenCalledWith({}, { projectpath: "/repo", includeremotes: true });
        expect(divergence).toHaveBeenCalledWith({}, expect.objectContaining({ cwd: "/repo" }));
        expect(gitChanges).toHaveBeenCalled();
    });

    it("a push in compare on that repository re-reads the refs and the pair", async () => {
        await inCompare();
        gitPush.mockResolvedValue({ isrepo: true, pushedat: 1 });

        await runPush("/repo");

        expect(listBranches).toHaveBeenCalled();
        expect(divergence).toHaveBeenCalled();
    });

    it("re-reads nothing of a repository the surface moved off while the action ran", async () => {
        await inCompare("/A");
        const h = held();
        gitFetch.mockReturnValue(h.promise);
        const fetching = runFetch("/A");
        await enterCompare("/B", "feat");
        listBranches.mockClear();
        divergence.mockClear();
        gitChanges.mockClear();

        h.settle({ isrepo: true, fetchedat: 1 });
        await fetching;

        expect(listBranches).not.toHaveBeenCalled();
        expect(divergence).not.toHaveBeenCalled();
        // the change list on screen is /repo's, not /A's
        expect(gitChanges).not.toHaveBeenCalled();
    });
});
