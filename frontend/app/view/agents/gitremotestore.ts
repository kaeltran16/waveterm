// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Diff surface's two network actions, Fetch and Push, and the one state they share per repository.
// One state rather than one per action: "one network action at a time per repository" and "one failure
// banner" are then a field each, not a cross-check between two atoms. Named git* because remotestore.ts
// is Remote mode's.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { compareCwd, compareOnAtom, loadCompareRefsMeta, refreshCompare } from "./comparestore";
import { filesStateAtom, reloadChanges } from "./filesstore";
import { refreshHistory } from "./githistorystore";

export type RemoteAction = "fetch" | "push";

export interface GitRemoteState {
    running: RemoteAction | null;
    // unix seconds of the last success in this session; 0 = none. A failure keeps the previous one: it
    // still happened, so the clock keeps reading it.
    fetchedAt: number;
    pushedAt: number;
    // the last action's failure, cleared when the next action starts or the banner is dismissed
    failure: { action: RemoteAction; git: GitFailure } | null;
}

export const GIT_REMOTE_IDLE: GitRemoteState = { running: null, fetchedAt: 0, pushedAt: 0, failure: null };

// keyed by repository: a fetch or a push is a fact about one remote, so its clock and its failure must not
// follow the surface to the next source picked
export const gitRemoteStatesAtom = atom<Record<string, GitRemoteState>>({}) as PrimitiveAtom<
    Record<string, GitRemoteState>
>;

export function gitRemoteStateOf(
    states: Record<string, GitRemoteState>,
    cwd: string | null | undefined
): GitRemoteState {
    return (cwd && states[cwd]) || GIT_REMOTE_IDLE;
}

function stateOf(cwd: string): GitRemoteState {
    return gitRemoteStateOf(globalStore.get(gitRemoteStatesAtom), cwd);
}

function setState(cwd: string, patch: Partial<GitRemoteState>): void {
    const states = globalStore.get(gitRemoteStatesAtom);
    globalStore.set(gitRemoteStatesAtom, { ...states, [cwd]: { ...gitRemoteStateOf(states, cwd), ...patch } });
}

// The client's timeout binds the SERVER's context, so at the 5s default a merely-slow fetch or push would be
// cancelled underneath a git process that is still running. 60s sits just outside gitinfo's own 55s budget,
// so git's answer arrives first and a real timeout is reported by the side that knows what it was doing.
const NETWORK_RPC_TIMEOUT_MS = 60_000;

// what a failed RPC (not git refusing: the call itself) leaves, which has no stderr to show
function rpcFailure(command: string, what: string): GitFailure {
    return { command, exitcode: -1, stderr: `the ${what} did not complete` };
}

// Returns false, starting nothing, while another action runs in this repository.
function begin(cwd: string, action: RemoteAction): boolean {
    if (stateOf(cwd).running != null) {
        return false;
    }
    setState(cwd, { running: action, failure: null });
    return true;
}

// A remote-tracking ref is only as fresh as the last fetch, so comparing against origin/main without one
// silently compares against yesterday's origin/main.
export async function runFetch(cwd: string): Promise<void> {
    if (!begin(cwd, "fetch")) {
        return;
    }
    try {
        const r = await RpcApi.GitFetchCommand(TabRpcClient, { cwd }, { timeout: NETWORK_RPC_TIMEOUT_MS });
        if (r.failure != null) {
            setState(cwd, { running: null, failure: { action: "fetch", git: r.failure } });
            return;
        }
        setState(cwd, { running: null, fetchedAt: r.fetchedat || stateOf(cwd).fetchedAt });
    } catch {
        setState(cwd, { running: null, failure: { action: "fetch", git: rpcFailure("git fetch", "fetch") } });
        return;
    }
    await rereadAfter(cwd, "fetch");
}

// Pushes the checked-out branch, or publishes it to origin when it has no upstream (gitinfo.Push decides).
export async function runPush(cwd: string): Promise<void> {
    if (!begin(cwd, "push")) {
        return;
    }
    try {
        const r = await RpcApi.GitPushCommand(TabRpcClient, { cwd }, { timeout: NETWORK_RPC_TIMEOUT_MS });
        if (r.failure != null) {
            setState(cwd, { running: null, failure: { action: "push", git: r.failure } });
            return;
        }
        setState(cwd, { running: null, pushedAt: r.pushedat || stateOf(cwd).pushedAt });
    } catch {
        setState(cwd, { running: null, failure: { action: "push", git: rpcFailure("git push", "push") } });
        return;
    }
    await rereadAfter(cwd, "push");
}

export function dismissRemoteFailure(cwd: string): void {
    setState(cwd, { failure: null });
}

// Either action moves @{u}, so the change list's ahead/behind moved with it; a push also moves the history's
// origin/<branch> chip, and in compare the refs the picker offers and what the pair means. An action takes
// seconds: each read is only for the repository still on screen, since re-reading this one into a surface
// that moved on would put its list or its branches there.
async function rereadAfter(cwd: string, action: RemoteAction): Promise<void> {
    const reads: Promise<void>[] = [];
    if (globalStore.get(filesStateAtom)?.cwd === cwd) {
        reads.push(reloadChanges(cwd));
        // compare reads no history
        if (action === "push" && !globalStore.get(compareOnAtom)) {
            refreshHistory();
        }
    }
    if (compareCwd() === cwd) {
        reads.push(loadCompareRefsMeta(cwd).then(() => refreshCompare(cwd)));
    }
    await Promise.all(reads);
}
