// frontend/app/view/agents/githistorystore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Commit-history state for the Diff surface. Mirrors filesstore.ts: module-level atoms written by
// async loaders via globalStore, with a guard token so a stale load cannot clobber a newer one.
// Module scope is deliberate — the surface unmounts on nav switch, so anything held in component
// state would be lost; the selected commit and open file survive here.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { filesDiffAtom, filesStateAtom, selectFile } from "./filesstore";
import { parseUnifiedDiff, type FileView } from "./gitdiff";
import { parseGitChanges, type GitChanges } from "./gitstatus";
import { WORKING_TREE, buildRows, defaultSelection, type HistoryRow } from "./historyrows";

export const historyRowsAtom = atom<HistoryRow[] | null>(null) as PrimitiveAtom<HistoryRow[] | null>;
// true = the history read failed, which is deliberately distinct from "this is not a repository"
export const historyErrorAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
// null = nothing selected yet; WORKING_TREE ("") = the uncommitted row; otherwise a commit hash
export const selectedCommitAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const selectedFileAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const graphOnAtom = atom<boolean>(true) as PrimitiveAtom<boolean>;

const commitChangesAtom = atom<GitChanges | null>(null) as PrimitiveAtom<GitChanges | null>;
const commitDiffAtom = atom<FileView | null>(null) as PrimitiveAtom<FileView | null>;

// Panes 2 and 3 read one source regardless of what is selected: the working-tree row reuses the
// scope's already-loaded change set from filesstore, a commit uses its own.
export const activeChangesAtom = atom<GitChanges | null>((get) =>
    get(selectedCommitAtom) === WORKING_TREE ? (get(filesStateAtom)?.changes ?? null) : get(commitChangesAtom)
);
export const activeDiffAtom = atom<FileView | null>((get) =>
    get(selectedCommitAtom) === WORKING_TREE ? get(filesDiffAtom) : get(commitDiffAtom)
);

const current = { token: "" };

export interface LoadHistoryOpts {
    // scope anchor: an agent's session-start commit or a run's base commit
    anchor?: string;
    anchorLabel?: string;
    // What the working-tree row's file count is actually counting — see BuildRowsOpts.rowLabel.
    // Omitted for repo scope, where the count really is working-tree-vs-HEAD.
    rowLabel?: string;
}

export function resetHistory(): void {
    current.token = "";
    globalStore.set(historyRowsAtom, null);
    globalStore.set(historyErrorAtom, false);
    globalStore.set(selectedCommitAtom, null);
    globalStore.set(selectedFileAtom, null);
    globalStore.set(commitChangesAtom, null);
    globalStore.set(commitDiffAtom, null);
}

export async function loadHistory(cwd: string | null, opts: LoadHistoryOpts = {}): Promise<void> {
    const token = `${cwd ?? ""}|${opts.anchor ?? ""}`;
    if (!cwd) {
        resetHistory();
        return;
    }
    current.token = token;
    globalStore.set(historyRowsAtom, null);
    globalStore.set(historyErrorAtom, false);
    try {
        const h = await RpcApi.GitHistoryCommand(TabRpcClient, { cwd });
        if (current.token !== token) {
            return;
        }
        if (!h.isrepo) {
            globalStore.set(historyRowsAtom, []);
            return;
        }
        const rows = buildRows(h.commits ?? [], {
            head: h.head,
            dirtyFileCount: globalStore.get(filesStateAtom)?.changes?.files.length ?? 0,
            rowLabel: opts.rowLabel,
            anchor: opts.anchor,
            anchorLabel: opts.anchorLabel,
            now: Date.now(),
        });
        globalStore.set(historyRowsAtom, rows);
        const pick = defaultSelection(rows);
        if (pick != null) {
            void selectCommit(cwd, pick);
        }
    } catch {
        if (current.token === token) {
            globalStore.set(historyErrorAtom, true);
            globalStore.set(historyRowsAtom, []);
        }
    }
}

export async function selectCommit(cwd: string, hash: string): Promise<void> {
    globalStore.set(selectedCommitAtom, hash);
    globalStore.set(selectedFileAtom, null);
    globalStore.set(commitDiffAtom, null);
    if (hash === WORKING_TREE) {
        // the working tree's file list is already loaded by filesstore for the active scope; just pick
        // its first file so pane 3 is never blank
        const first = globalStore.get(filesStateAtom)?.changes?.files[0]?.path;
        if (first) {
            globalStore.set(selectedFileAtom, first);
            void selectFile(cwd, first);
        }
        return;
    }
    globalStore.set(commitChangesAtom, null);
    try {
        const ch = await RpcApi.GitCommitChangesCommand(TabRpcClient, { cwd, hash });
        if (globalStore.get(selectedCommitAtom) !== hash) {
            return; // selection moved on
        }
        const changes = ch.isrepo ? parseGitChanges(ch.statusz, ch.numstat) : null;
        globalStore.set(commitChangesAtom, changes);
        const first = changes?.files[0]?.path;
        if (first) {
            void selectCommitFile(cwd, hash, first);
        }
    } catch {
        if (globalStore.get(selectedCommitAtom) === hash) {
            globalStore.set(commitChangesAtom, null);
        }
    }
}

export async function selectCommitFile(cwd: string, hash: string, path: string): Promise<void> {
    globalStore.set(selectedFileAtom, path);
    if (hash === WORKING_TREE) {
        void selectFile(cwd, path);
        return;
    }
    globalStore.set(commitDiffAtom, null);
    try {
        const d = await RpcApi.GitCommitDiffCommand(TabRpcClient, { cwd, hash, path });
        if (globalStore.get(selectedFileAtom) !== path || globalStore.get(selectedCommitAtom) !== hash) {
            return; // selection moved on
        }
        globalStore.set(commitDiffAtom, parseUnifiedDiff(d.diff));
    } catch {
        if (globalStore.get(selectedFileAtom) === path) {
            globalStore.set(commitDiffAtom, null);
        }
    }
}
