// frontend/app/view/agents/filesstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Files-surface state + loaders for the focused agent. Mirrors liveagents.ts/previousinfo.ts:
// module-level atoms written by an async loader via globalStore. cwd is read from the agent's
// transcript (zero git); branch + changes + per-file diff come from the git RPCs.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { resolveCwd } from "./agentcwdresolve";
import { parseUnifiedDiff, plainFileView, type FileView } from "./gitdiff";
import { parseGitChanges, type GitChanges } from "./gitstatus";

export interface FilesState {
    cwd: string | null;
    branch: string;
    isRepo: boolean;
    changes: GitChanges | null;
}

export const filesStateAtom = atom<FilesState | null>(null) as PrimitiveAtom<FilesState | null>;
export const filesSelectedPathAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const filesDiffAtom = atom<FileView | null>(null) as PrimitiveAtom<FileView | null>;

// guards against a stale load overwriting a newer one; token distinguishes agent- vs project-scoped
// loads (`agent:<id>` / `project:<name>`) so switching source cancels the in-flight load.
const current = { token: "" };

const EMPTY: FilesState = { cwd: null, branch: "", isRepo: false, changes: null };

// Core: fetch branch + changes for a resolved cwd and select the first file. The caller owns the
// guard token (set before any await) so a newer load short-circuits this one's writes.
async function loadChangesForCwd(token: string, cwd: string | null): Promise<void> {
    if (!cwd) {
        if (current.token === token) {
            globalStore.set(filesStateAtom, EMPTY);
        }
        return;
    }
    try {
        const ch = await RpcApi.GitChangesCommand(TabRpcClient, { cwd });
        if (current.token !== token) {
            return;
        }
        const changes = ch.isrepo ? parseGitChanges(ch.statusz, ch.numstat) : null;
        globalStore.set(filesStateAtom, { cwd, branch: ch.branch, isRepo: ch.isrepo, changes });
        const first = changes?.files[0]?.path;
        if (first) {
            void selectFile(cwd, first);
        }
    } catch {
        if (current.token === token) {
            globalStore.set(filesStateAtom, { ...EMPTY, cwd });
        }
    }
}

function beginLoad(token: string): void {
    current.token = token;
    globalStore.set(filesStateAtom, null);
    globalStore.set(filesSelectedPathAtom, null);
    globalStore.set(filesDiffAtom, null);
}

export async function loadFilesForAgent(
    id: string,
    transcriptPath: string | undefined,
    blockId?: string
): Promise<void> {
    const token = `agent:${id}`;
    beginLoad(token);
    const cwd = await resolveCwd(transcriptPath, blockId);
    if (current.token !== token) {
        return;
    }
    await loadChangesForCwd(token, cwd);
}

// Project-scoped load: the registry path IS the cwd, so no transcript resolution is needed.
export async function loadFilesForProject(name: string, path: string): Promise<void> {
    const token = `project:${name}`;
    beginLoad(token);
    await loadChangesForCwd(token, path || null);
}

export async function selectFile(cwd: string, path: string): Promise<void> {
    globalStore.set(filesSelectedPathAtom, path);
    globalStore.set(filesDiffAtom, null);
    try {
        const d = await RpcApi.GitDiffCommand(TabRpcClient, { cwd, path });
        if (globalStore.get(filesSelectedPathAtom) !== path) {
            return; // selection moved on
        }
        globalStore.set(filesDiffAtom, d.untracked ? plainFileView(d.content) : parseUnifiedDiff(d.diff));
    } catch {
        if (globalStore.get(filesSelectedPathAtom) === path) {
            globalStore.set(filesDiffAtom, null);
        }
    }
}
