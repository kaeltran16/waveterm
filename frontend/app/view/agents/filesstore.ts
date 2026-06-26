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
import { agentCwd } from "./agentcwd";
import { parseUnifiedDiff, plainFileView, type FileView } from "./gitdiff";
import { parseGitChanges, type GitChanges } from "./gitstatus";

const CWD_TAIL_LINES = 200;

export interface FilesState {
    cwd: string | null;
    branch: string;
    isRepo: boolean;
    changes: GitChanges | null;
}

export const filesStateAtom = atom<FilesState | null>(null) as PrimitiveAtom<FilesState | null>;
export const filesSelectedPathAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const filesDiffAtom = atom<FileView | null>(null) as PrimitiveAtom<FileView | null>;

// guards against a stale focus's load overwriting a newer one
const current = { id: "" };

const EMPTY: FilesState = { cwd: null, branch: "", isRepo: false, changes: null };

export async function loadFilesForAgent(id: string, transcriptPath: string | undefined): Promise<void> {
    current.id = id;
    globalStore.set(filesStateAtom, null);
    globalStore.set(filesSelectedPathAtom, null);
    globalStore.set(filesDiffAtom, null);

    const cwd = await resolveCwd(transcriptPath);
    if (current.id !== id) {
        return;
    }
    if (!cwd) {
        globalStore.set(filesStateAtom, EMPTY);
        return;
    }
    try {
        const ch = await RpcApi.GitChangesCommand(TabRpcClient, { cwd });
        if (current.id !== id) {
            return;
        }
        const changes = ch.isrepo ? parseGitChanges(ch.statusz, ch.numstat) : null;
        globalStore.set(filesStateAtom, { cwd, branch: ch.branch, isRepo: ch.isrepo, changes });
        const first = changes?.files[0]?.path;
        if (first) {
            void selectFile(cwd, first);
        }
    } catch {
        if (current.id === id) {
            globalStore.set(filesStateAtom, { ...EMPTY, cwd });
        }
    }
}

async function resolveCwd(transcriptPath: string | undefined): Promise<string | null> {
    if (!transcriptPath) {
        return null;
    }
    try {
        const rtn = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path: transcriptPath, maxlines: CWD_TAIL_LINES });
        return agentCwd(rtn?.lines ?? []);
    } catch {
        return null;
    }
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
