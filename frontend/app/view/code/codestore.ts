// frontend/app/view/code/codestore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Code-surface state + loaders. Every atom is module-scoped for the same reason filesstore.ts does
// it: the surface unmounts on nav switch, so component state would silently drop the whole session
// (selected project, expanded tree, history) every time you looked at something else.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { projectsAtom } from "@/app/view/agents/projectsstore";
import { joinRepoPath, repoBasename, sameRepoPath } from "@/util/paths";
import { base64ToString, stringToBase64 } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { classifyFile, hasNulByte } from "./codeclassify";
import { conflictMessage, conflictOf, nextDrafts, withoutDraft, type Draft, type FileBase } from "./codedraft";
import { back, currentPath, EMPTY_HISTORY, forward, push, type History } from "./codehistory";
import { resetSearch } from "./codesearchstore";
import { ancestorsOf, buildTree, visibleRows } from "./codetree";

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
// exhaustive switch and cannot land in a contradictory pair of states. Only the text variant is
// editable, and it carries the size/modtime it was read at so a save can detect a disk change.
export type CodeFile =
    | { kind: "none" }
    | { kind: "loading"; path: string }
    | { kind: "text"; path: string; text: string; size: number; modtime: number }
    | { kind: "binary"; path: string; size: number }
    | { kind: "toolarge"; path: string; size: number }
    | { kind: "missing"; path: string }
    | { kind: "error"; path: string; message: string };

// Save is a separate axis from CodeFile: the file can be a perfectly good text buffer while the last
// write is still in flight, or refused, or failed.
export type SaveState =
    | { kind: "idle" }
    | { kind: "saving"; path: string }
    | { kind: "saved"; path: string }
    | { kind: "conflict"; path: string; message: string }
    | { kind: "error"; path: string; message: string };

export const codeProjectAtom = atom<CodeProject | null>(null) as PrimitiveAtom<CodeProject | null>;
// The last browsed project, persisted across launches so a restart lands on the same repo the way a
// nav switch already does. getOnInit: without it the stored value arrives one render after the first
// read, so the surface flashes "No project selected" before the restore lands. Only a real selection
// writes it — never the null reset.
export const lastCodeProjectAtom = atomWithStorage<CodeProject | null>("code.project.last", null, undefined, {
    getOnInit: true,
}) as PrimitiveAtom<CodeProject | null>;
export const codeIndexAtom = atom<CodeIndex | null>(null) as PrimitiveAtom<CodeIndex | null>;
export const codeIndexErrorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const codeExpandedAtom = atom<Set<string>>(new Set<string>()) as PrimitiveAtom<Set<string>>;
export const codeFileAtom = atom<CodeFile>({ kind: "none" }) as PrimitiveAtom<CodeFile>;
export const codeHistoryAtom = atom<History>(EMPTY_HISTORY) as PrimitiveAtom<History>;
export const codeFinderOpenAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
// Unsaved edits, keyed by ABSOLUTE path so two projects cannot collide, and deliberately not cleared
// on project switch — losing typed-but-unsaved work to a nav click would be the worst kind of bug.
export const codeDraftsAtom = atom<Map<string, Draft>>(new Map<string, Draft>()) as PrimitiveAtom<Map<string, Draft>>;
export const codeSaveAtom = atom<SaveState>({ kind: "idle" }) as PrimitiveAtom<SaveState>;

// The tree's highlighted row — a file OR a directory. Deliberately separate from codeFileAtom: the
// cursor used to BE the open file, which is why the cursor could never rest on a directory.
export const codeCursorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
// A line a jump wants revealed once the file's text is in place. The store never touches Monaco;
// codeviewer.tsx consumes this and clears it.
export const codePendingLineAtom = atom<number | null>(null) as PrimitiveAtom<number | null>;
// Whether the tree pane holds focus. An atom rather than a document.activeElement query because the
// keybinding `when` predicates are evaluated by store.test.ts in vitest's node environment, where
// there is no document — and because this codebase keeps DOM reads in `run`, never in `when`.
export const codeTreeFocusedAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

// Markdown files render as documents by default; Source switches to the editable Monaco view.
// Ignored for non-markdown files, which are always Source. Reset on project switch, but not on
// file switch — a reader who prefers source stays in source across files.
export const codeViewModeAtom = atom<"preview" | "source">("preview") as PrimitiveAtom<"preview" | "source">;

// The rendered row list. Derived rather than memoized inside the pane, because the keyboard bindings
// have to agree with the pane about which rows exist and cannot see a component's useMemo.
export const codeRowsAtom = atom((get) =>
    visibleRows(buildTree(get(codeIndexAtom)?.paths ?? []), get(codeExpandedAtom))
);

// the absolute path is the draft key; every draft-facing helper goes through this
export function draftKey(project: CodeProject, rel: string): string {
    return joinRepoPath(project.path, rel);
}

// Returning to a project you already browsed should not re-shell out to git. Cleared per project
// by refreshIndex, which is the only way a new file appears (there is no watcher, by design).
const indexCache = new Map<string, CodeIndex>();

// guards a slow load against a newer one, same pattern as filesstore.ts
const current = { indexToken: "", fileToken: "" };

export async function selectProject(p: CodeProject | null): Promise<void> {
    globalStore.set(codeProjectAtom, p);
    // only a real selection is worth remembering; the null reset must not clobber the last good one
    if (p != null) {
        globalStore.set(lastCodeProjectAtom, p);
    }
    globalStore.set(codeExpandedAtom, new Set<string>());
    globalStore.set(codeHistoryAtom, EMPTY_HISTORY);
    globalStore.set(codeFileAtom, { kind: "none" });
    globalStore.set(codeIndexErrorAtom, null);
    globalStore.set(codeIndexAtom, null);
    globalStore.set(codeSaveAtom, { kind: "idle" });
    globalStore.set(codeCursorAtom, null);
    globalStore.set(codePendingLineAtom, null);
    globalStore.set(codeViewModeAtom, "preview");
    resetSearch(); // results belong to the repository they were found in
    // drafts survive on purpose — they are keyed by absolute path, so coming back to this project
    // brings your unsaved edits back with it
    if (p == null) {
        current.indexToken = "";
        return;
    }
    await loadIndex(p);
}

// A stored selection restores only while the registry still knows its path — a project that was
// renamed or removed must not silently reopen under a stale path (same rule as jarvis.subject.last).
export function canRestoreProject(stored: CodeProject | null, registry: Record<string, ProjectKeywords>): boolean {
    if (stored == null) {
        return false;
    }
    for (const v of Object.values(registry ?? {})) {
        if (v?.path != null && sameRepoPath(v.path, stored.path)) {
            return true;
        }
    }
    return false;
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
    globalStore.set(codeSaveAtom, { kind: "idle" });
    const abs = joinRepoPath(project.path, rel);

    // A file you have unsaved edits in is restored from its pinned base rather than re-read. Re-reading
    // would silently re-point the base at whatever is on disk NOW, which is exactly the state the
    // conflict guard exists to notice — a reopen would launder someone else's write into "no conflict".
    const draft = globalStore.get(codeDraftsAtom).get(abs);
    if (draft != null) {
        globalStore.set(codeFileAtom, {
            kind: "text",
            path: rel,
            text: draft.base.text,
            size: draft.base.size,
            modtime: draft.base.modtime,
        });
        return;
    }

    globalStore.set(codeFileAtom, { kind: "loading", path: rel });
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
        globalStore.set(codeFileAtom, { kind: "text", path: rel, text, size, modtime: info?.modtime ?? 0 });
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

export function editDraft(text: string): void {
    const project = globalStore.get(codeProjectAtom);
    const file = globalStore.get(codeFileAtom);
    if (project == null || file.kind !== "text") {
        return; // binary/toolarge/missing are not editable, so there is nothing to draft
    }
    const key = draftKey(project, file.path);
    const base: FileBase = { text: file.text, size: file.size, modtime: file.modtime };
    globalStore.set(codeDraftsAtom, (d) => nextDrafts(d, key, base, text));
    // a fresh keystroke invalidates whatever the last save attempt said
    const save = globalStore.get(codeSaveAtom);
    if (save.kind !== "idle" && save.path === file.path) {
        globalStore.set(codeSaveAtom, { kind: "idle" });
    }
}

export function revertDraft(): void {
    const project = globalStore.get(codeProjectAtom);
    const file = globalStore.get(codeFileAtom);
    if (project == null || file.kind !== "text") {
        return;
    }
    globalStore.set(codeDraftsAtom, (d) => withoutDraft(d, draftKey(project, file.path)));
    globalStore.set(codeSaveAtom, { kind: "idle" });
}

// Stat, compare against the base the draft pinned, and only then write. The stat is not belt-and-
// braces: agents run against this same working tree, so "changed since you opened it" is the normal
// case, not the exotic one. On conflict we refuse and keep the draft — the user's text is never the
// thing we throw away.
export async function saveCurrent(): Promise<void> {
    const project = globalStore.get(codeProjectAtom);
    const file = globalStore.get(codeFileAtom);
    if (project == null || file.kind !== "text") {
        return;
    }
    const rel = file.path;
    const abs = draftKey(project, rel);
    const draft = globalStore.get(codeDraftsAtom).get(abs);
    if (draft == null) {
        return; // nothing unsaved
    }
    globalStore.set(codeSaveAtom, { kind: "saving", path: rel });
    try {
        const latest = await RpcApi.FileInfoCommand(TabRpcClient, { info: { path: abs } });
        const conflict = conflictOf(draft.base, latest);
        if (conflict !== "none") {
            globalStore.set(codeSaveAtom, { kind: "conflict", path: rel, message: conflictMessage(conflict) });
            return;
        }
        await RpcApi.FileWriteCommand(TabRpcClient, { info: { path: abs }, data64: stringToBase64(draft.text) });
        // re-stat so a second save compares against what we just wrote rather than the pre-save state
        const after = await RpcApi.FileInfoCommand(TabRpcClient, { info: { path: abs } });
        globalStore.set(codeFileAtom, {
            kind: "text",
            path: rel,
            text: draft.text,
            size: after?.size ?? draft.text.length,
            modtime: after?.modtime ?? 0,
        });
        globalStore.set(codeDraftsAtom, (d) => withoutDraft(d, abs));
        globalStore.set(codeSaveAtom, { kind: "saved", path: rel });
    } catch (e) {
        globalStore.set(codeSaveAtom, {
            kind: "error",
            path: rel,
            message: e instanceof Error ? e.message : String(e),
        });
    }
}

// Discard the pinned base and take what is on disk now, abandoning the draft. The escape hatch from a
// conflict, and the only path that intentionally destroys typed text — so it is never automatic.
export async function reloadFromDisk(): Promise<void> {
    const project = globalStore.get(codeProjectAtom);
    const file = globalStore.get(codeFileAtom);
    if (project == null || file.kind !== "text") {
        return;
    }
    globalStore.set(codeDraftsAtom, (d) => withoutDraft(d, draftKey(project, file.path)));
    globalStore.set(codeSaveAtom, { kind: "idle" });
    await openPath(file.path, { pushHistory: false });
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

// The one way into this surface from anywhere else: a content-search hit, a diff row, a Radar
// finding, a finder query with a line. Takes the view model because surfaceAtom lives on the
// AgentsViewModel instance rather than in a module — the same type-only seam bindings.ts uses.
export async function openInCode(
    model: AgentsViewModel,
    target: { projectPath: string; rel: string; line?: number }
): Promise<void> {
    const project = resolveJumpProject(target.projectPath);
    const cur = globalStore.get(codeProjectAtom);
    // switching resets expand state, history and the file; a jump within the repository you are
    // already reading must not throw that away
    if (cur == null || !sameRepoPath(cur.path, project.path)) {
        await selectProject(project);
    }
    revealPath(target.rel);
    globalStore.set(codeCursorAtom, target.rel);
    // set before the read: the viewer honors this the moment the text lands
    globalStore.set(codePendingLineAtom, target.line ?? null);
    globalStore.set(model.surfaceAtom, "code");
    await openPath(target.rel);
}

function resolveJumpProject(projectPath: string): CodeProject {
    const registry = globalStore.get(projectsAtom) ?? {};
    for (const [name, v] of Object.entries(registry)) {
        if (v?.path && sameRepoPath(v.path, projectPath)) {
            return { name, path: v.path };
        }
    }
    // launchAgent creates worktrees, so a diff's cwd is frequently a repository the registry does
    // not know. git ls-files needs only a path, so browse it under its directory name rather than
    // refusing the jump — the header shows the full path, so nothing is hidden.
    return { name: repoBasename(projectPath), path: projectPath };
}
