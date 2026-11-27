// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The workspace pane's Changes tab state: the change set's patch (one read, for the focused agent, as the rail's is),
// and per agent the open files (with the one a step opened) and the change counter's position, so both survive the
// tab unmounting when another tab shows and a switch to another agent.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import type { EditFile } from "./agentsviewmodel";
import { ignoreWsAtom } from "./diffoptions";
import { railStateAtom, type RailGitState } from "./railstore";
import { parseUnifiedDiff } from "./unifieddiff";
import {
    changesGroups,
    hunkWalk,
    isFileOpen,
    NONE_OPEN,
    openFile,
    stepHunk,
    stepInto,
    toggleAll,
    toggleFile,
    toggleFolder,
    type ChangesGroup,
    type ChangesOpen,
} from "./workspacechangesmodel";

// above the server's 10 s git timeout, so a slow read fails with git's message rather than the 5 s rpc default's
export const PATCH_RPC_TIMEOUT_MS = 15_000;

// files null: the first read is pending, or it failed
export interface ChangesPatch {
    agentId: string;
    files: EditFile[] | null;
    truncated: boolean;
    // whether the read hid whitespace, so a file it left without hunks reads as whitespace-only
    ignoreWs: boolean;
    failure?: string;
}

export const changesPatchAtom = atom<ChangesPatch | null>(null) as PrimitiveAtom<ChangesPatch | null>;

// a scroll the tab owes: n differs on every request, so a second step to the same hunk scrolls again
export interface ChangesScroll {
    path: string;
    hunk: number;
    n: number;
}

function perAgent<T>(init: T): (agentId: string) => PrimitiveAtom<T> {
    const atoms = new Map<string, PrimitiveAtom<T>>();
    return (agentId) => {
        let a = atoms.get(agentId);
        if (a == null) {
            a = atom(init) as PrimitiveAtom<T>;
            atoms.set(agentId, a);
        }
        return a;
    };
}

export const changesOpenAtom = perAgent<ChangesOpen>(NONE_OPEN);
// 1-based, 0 = no step yet
export const changesAtAtom = perAgent<number>(0);
export const changesScrollAtom = perAgent<ChangesScroll | null>(null);

// guards against an older read overwriting a newer one, as the rail's loadSeq does
let readSeq = 0;
let scrollSeq = 0;

// the same agent's re-read keeps its rows until the new ones land; another agent's blanks them
export async function loadChangesPatch(agentId: string, cwd: string, ref: string, end = ""): Promise<void> {
    const seq = ++readSeq;
    const ignoreWs = globalStore.get(ignoreWsAtom);
    if (globalStore.get(changesPatchAtom)?.agentId !== agentId) {
        globalStore.set(changesPatchAtom, { agentId, files: null, truncated: false, ignoreWs });
    }
    try {
        const rtn = await RpcApi.GitPatchCommand(
            TabRpcClient,
            { cwd, ref, end: end || undefined, ignorews: ignoreWs },
            { timeout: PATCH_RPC_TIMEOUT_MS }
        );
        if (seq !== readSeq) {
            return;
        }
        globalStore.set(changesPatchAtom, {
            agentId,
            files: parseUnifiedDiff(rtn.patch) ?? [],
            truncated: rtn.truncated ?? false,
            ignoreWs,
        });
    } catch (e) {
        if (seq === readSeq) {
            globalStore.set(changesPatchAtom, {
                agentId,
                files: null,
                truncated: false,
                ignoreWs,
                failure: (e instanceof Error ? e.message : String(e ?? "")) || "The read failed with no message.",
            });
        }
    }
}

// the rail blanked for another agent's read: the next read starts from nothing, and any in flight is dropped
export function clearChangesPatch(): void {
    readSeq++;
    globalStore.set(changesPatchAtom, null);
}

// what the tab draws for the agent: its rail files, with the patch only when the loaded one is this agent's
export function changesGroupsFor(
    agentId: string,
    rail: RailGitState | null,
    patch: ChangesPatch | null
): ChangesGroup[] {
    const own = patch?.agentId === agentId ? patch : null;
    return changesGroups(rail?.changes?.files ?? [], own?.files ?? null, {
        truncated: own?.truncated ?? false,
        ignoreWs: own?.ignoreWs ?? false,
        own: rail?.merge?.own,
    });
}

function updateOpen(agentId: string, f: (s: ChangesOpen) => ChangesOpen): void {
    const a = changesOpenAtom(agentId);
    globalStore.set(a, f(globalStore.get(a)));
}

export function isChangesFileOpen(agentId: string, path: string): boolean {
    return isFileOpen(globalStore.get(changesOpenAtom(agentId)), path);
}

export function toggleChangesFile(agentId: string, path: string): void {
    updateOpen(agentId, (s) => toggleFile(s, path));
}

export function openChangesFile(agentId: string, path: string): void {
    updateOpen(agentId, (s) => openFile(s, path));
}

// paths: the folder's listed files
export function toggleChangesFolder(agentId: string, paths: string[]): void {
    updateOpen(agentId, (s) => toggleFolder(s, paths));
}

// paths: every listed file
export function toggleAllChangesFiles(agentId: string, paths: string[]): void {
    updateOpen(agentId, (s) => toggleAll(s, paths));
}

// one step of the change counter over every hunk in display order; false, and no change, with none to walk
export function stepChangesHunk(agentId: string, dir: "next" | "previous"): boolean {
    const groups = changesGroupsFor(agentId, globalStore.get(railStateAtom), globalStore.get(changesPatchAtom));
    const walk = hunkWalk(groups);
    if (walk.length === 0) {
        return false;
    }
    const at = stepHunk(Math.min(globalStore.get(changesAtAtom(agentId)), walk.length), walk.length, dir);
    const target = walk[at - 1];
    updateOpen(agentId, (s) => stepInto(s, target.path));
    globalStore.set(changesAtAtom(agentId), at);
    globalStore.set(changesScrollAtom(agentId), { ...target, n: ++scrollSeq });
    return true;
}
