// frontend/app/view/code/codestore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Code-surface state + loaders. Every atom is module-scoped for the same reason filesstore.ts does
// it: the surface unmounts on nav switch, so component state would silently drop the whole session
// (selected project, expanded tree, history) every time you looked at something else.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { joinRepoPath } from "@/util/paths";
import { base64ToString } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import { classifyFile, hasNulByte } from "./codeclassify";
import { back, currentPath, EMPTY_HISTORY, forward, push, type History } from "./codehistory";
import { ancestorsOf } from "./codetree";

export interface CodeProject {
    name: string;
    path: string;
}

export interface CodeIndex {
    paths: string[];
    isRepo: boolean;
    truncated: boolean;
}

// One union rather than parallel loading/error/tooLarge booleans, so the viewer renders an
// exhaustive switch and cannot land in a contradictory pair of states.
export type CodeFile =
    | { kind: "none" }
    | { kind: "loading"; path: string }
    | { kind: "text"; path: string; text: string }
    | { kind: "binary"; path: string; size: number }
    | { kind: "toolarge"; path: string; size: number }
    | { kind: "missing"; path: string }
    | { kind: "error"; path: string; message: string };

export const codeProjectAtom = atom<CodeProject | null>(null) as PrimitiveAtom<CodeProject | null>;
export const codeIndexAtom = atom<CodeIndex | null>(null) as PrimitiveAtom<CodeIndex | null>;
export const codeIndexErrorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const codeExpandedAtom = atom<Set<string>>(new Set<string>()) as PrimitiveAtom<Set<string>>;
export const codeFileAtom = atom<CodeFile>({ kind: "none" }) as PrimitiveAtom<CodeFile>;
export const codeHistoryAtom = atom<History>(EMPTY_HISTORY) as PrimitiveAtom<History>;
export const codeFinderOpenAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

// Returning to a project you already browsed should not re-shell out to git. Cleared per project
// by refreshIndex, which is the only way a new file appears (there is no watcher, by design).
const indexCache = new Map<string, CodeIndex>();

// guards a slow load against a newer one, same pattern as filesstore.ts
const current = { indexToken: "", fileToken: "" };

export async function selectProject(p: CodeProject | null): Promise<void> {
    globalStore.set(codeProjectAtom, p);
    globalStore.set(codeExpandedAtom, new Set<string>());
    globalStore.set(codeHistoryAtom, EMPTY_HISTORY);
    globalStore.set(codeFileAtom, { kind: "none" });
    globalStore.set(codeIndexErrorAtom, null);
    globalStore.set(codeIndexAtom, null);
    if (p == null) {
        current.indexToken = "";
        return;
    }
    await loadIndex(p);
}

async function loadIndex(p: CodeProject): Promise<void> {
    const token = `index:${p.path}`;
    current.indexToken = token;
    const cached = indexCache.get(p.path);
    if (cached != null) {
        globalStore.set(codeIndexAtom, cached);
        return;
    }
    try {
        const res = await RpcApi.GitListFilesCommand(TabRpcClient, { cwd: p.path });
        if (current.indexToken !== token) {
            return;
        }
        const idx: CodeIndex = {
            paths: res.files ?? [],
            isRepo: res.isrepo,
            truncated: res.truncated ?? false,
        };
        indexCache.set(p.path, idx);
        globalStore.set(codeIndexAtom, idx);
    } catch (e) {
        if (current.indexToken !== token) {
            return;
        }
        // a failed RPC is an error, not an empty repo — the Diff surface once conflated these
        globalStore.set(codeIndexErrorAtom, e instanceof Error ? e.message : String(e));
    }
}

export async function refreshIndex(): Promise<void> {
    const p = globalStore.get(codeProjectAtom);
    if (p == null) {
        return;
    }
    indexCache.delete(p.path);
    globalStore.set(codeIndexAtom, null);
    globalStore.set(codeIndexErrorAtom, null);
    await loadIndex(p);
}

export function toggleDir(path: string): void {
    const next = new Set(globalStore.get(codeExpandedAtom));
    if (next.has(path)) {
        next.delete(path);
    } else {
        next.add(path);
    }
    globalStore.set(codeExpandedAtom, next);
}

// expand everything above `path` so a finder jump into a collapsed subtree shows where you landed
export function revealPath(path: string): void {
    const next = new Set(globalStore.get(codeExpandedAtom));
    for (const dir of ancestorsOf(path)) {
        next.add(dir);
    }
    globalStore.set(codeExpandedAtom, next);
}

export async function openPath(rel: string, opts?: { pushHistory?: boolean }): Promise<void> {
    const project = globalStore.get(codeProjectAtom);
    if (project == null) {
        return;
    }
    if (opts?.pushHistory !== false) {
        globalStore.set(codeHistoryAtom, (h) => push(h, rel));
    }
    const token = `file:${rel}`;
    current.fileToken = token;
    globalStore.set(codeFileAtom, { kind: "loading", path: rel });
    const abs = joinRepoPath(project.path, rel);
    try {
        const info = await RpcApi.FileInfoCommand(TabRpcClient, { info: { path: abs } });
        if (current.fileToken !== token) {
            return;
        }
        if (info?.notfound) {
            // the index is a snapshot; this is the visible consequence of having no watcher
            globalStore.set(codeFileAtom, { kind: "missing", path: rel });
            return;
        }
        const size = info?.size ?? 0;
        const klass = classifyFile(size, info?.mimetype ?? "");
        if (klass === "toolarge") {
            globalStore.set(codeFileAtom, { kind: "toolarge", path: rel, size });
            return;
        }
        if (klass === "binary") {
            globalStore.set(codeFileAtom, { kind: "binary", path: rel, size });
            return;
        }
        const data = await RpcApi.FileReadCommand(TabRpcClient, { info: { path: abs } });
        if (current.fileToken !== token) {
            return;
        }
        const text = base64ToString(data?.data64 ?? "");
        if (hasNulByte(text)) {
            globalStore.set(codeFileAtom, { kind: "binary", path: rel, size });
            return;
        }
        globalStore.set(codeFileAtom, { kind: "text", path: rel, text });
    } catch (e) {
        if (current.fileToken !== token) {
            return;
        }
        globalStore.set(codeFileAtom, {
            kind: "error",
            path: rel,
            message: e instanceof Error ? e.message : String(e),
        });
    }
}

// back/forward re-read from disk rather than replaying cached text: simpler, and it shows the file
// as it is now rather than as it was when you first opened it.
export async function goBack(): Promise<void> {
    const next = back(globalStore.get(codeHistoryAtom));
    globalStore.set(codeHistoryAtom, next);
    const path = currentPath(next);
    if (path != null) {
        await openPath(path, { pushHistory: false });
    }
}

export async function goForward(): Promise<void> {
    const next = forward(globalStore.get(codeHistoryAtom));
    globalStore.set(codeHistoryAtom, next);
    const path = currentPath(next);
    if (path != null) {
        await openPath(path, { pushHistory: false });
    }
}
