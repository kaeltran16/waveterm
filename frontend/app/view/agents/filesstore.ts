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
import { ensureSessionStart } from "./agentsessionstore";
import { parseUnifiedDiff, plainFileView, type FileView } from "./gitdiff";
import { parseGitChanges, type GitChanges } from "./gitstatus";

export interface FilesState {
    cwd: string | null;
    branch: string;
    isRepo: boolean;
    changes: GitChanges | null;
    ref: string; // base commit to diff against; "" = live working-tree-vs-HEAD
}

// A registered project the Diff surface can scope to, resolved from the config registry (name -> path).
export interface FilesProject {
    name: string;
    path: string;
}

export const filesStateAtom = atom<FilesState | null>(null) as PrimitiveAtom<FilesState | null>;
// Which project the surface is scoped to; null = follow the focused agent instead. Module scope for the
// same reason as the rest of this file: the Diff surface unmounts on nav switch, so component state here
// meant leaving and returning silently dropped the repository and emptied all three panes.
export const filesProjectSelAtom = atom<FilesProject | null>(null) as PrimitiveAtom<FilesProject | null>;
export const filesSelectedPathAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const filesDiffAtom = atom<FileView | null>(null) as PrimitiveAtom<FileView | null>;
// true = the git load failed (distinct from "not a repo" — a failed RPC used to masquerade as isRepo:false).
export const filesErrorAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

// guards against a stale load overwriting a newer one; token distinguishes agent-/project-/run-scoped
// loads (`agent:<id>` / `project:<name>` / `run:<id>`) so switching source cancels the in-flight load.
const current = { token: "" };

// The scope vocabulary, exported so a caller that wants to deep-link into the surface names the same
// scope the load will run under. One format, one place — a link built from a different string than
// the load's would silently never be claimed.
export const agentScope = (id: string) => `agent:${id}`;
export const runScope = (runId: string) => `run:${runId}`;
export const projectScope = (name: string) => `project:${name}`;

const EMPTY: FilesState = { cwd: null, branch: "", isRepo: false, changes: null, ref: "" };

// How to anchor the diff: an explicit base commit (runs), or a session-start unix-seconds timestamp
// (interactive agents) that the backend resolves to the session-start commit and echoes back so
// committed work still shows. Neither set = live working-tree-vs-HEAD (project view). sessionStartTs
// wins if both are set.
interface LoadOpts {
    ref?: string;
    sessionStartTs?: number;
}

// Core: fetch branch + changes for a resolved cwd and select the first file. The caller owns the
// guard token (set before any await) so a newer load short-circuits this one's writes.
async function loadChangesForCwd(token: string, cwd: string | null, opts: LoadOpts): Promise<void> {
    if (!cwd) {
        if (current.token === token) {
            globalStore.set(filesStateAtom, EMPTY);
        }
        return;
    }
    try {
        const ch = await RpcApi.GitChangesCommand(TabRpcClient, {
            cwd,
            ...(opts.ref ? { ref: opts.ref } : {}),
            ...(opts.sessionStartTs ? { sessionstartts: opts.sessionStartTs } : {}),
        });
        if (current.token !== token) {
            return;
        }
        // sessionStartTs mode: the backend resolved + echoed the concrete base — thread it into per-file
        // diffs so they match the list. Otherwise use the ref we sent ("" = live).
        const ref = opts.sessionStartTs ? (ch.ref ?? "") : (opts.ref ?? "");
        const changes = ch.isrepo ? parseGitChanges(ch.statusz, ch.numstat) : null;
        globalStore.set(filesStateAtom, { cwd, branch: ch.branch, isRepo: ch.isrepo, changes, ref });
        globalStore.set(filesErrorAtom, false);
        // Deliberately always the first file: a deep link is claimed by the history store, which owns
        // the *visible* selection. Honouring it here as well would load one file's diff and then have
        // the history load pick another, so the pane showed whichever RPC landed last.
        const first = changes?.files[0]?.path;
        if (first) {
            void selectFile(cwd, first);
        }
    } catch {
        if (current.token === token) {
            // a failed git RPC is an error, not a clean "not a repo" — flag it so the surface says so.
            globalStore.set(filesErrorAtom, true);
            globalStore.set(filesStateAtom, { ...EMPTY, cwd });
        }
    }
}

// Re-fetch changes for the surface's active source, reusing the live guard token so the writes
// aren't short-circuited (used after a Review apply mutates the tree). No-op if nothing is loaded.
export async function reloadChanges(cwd: string | null): Promise<void> {
    if (!current.token) return;
    // reuse the already-resolved concrete base (a sha for worktree/run modes, "" for live) so the
    // reload stays anchored to the same point the initial load picked.
    const ref = globalStore.get(filesStateAtom)?.ref ?? "";
    await loadChangesForCwd(current.token, cwd, { ref });
}

function beginLoad(token: string): void {
    current.token = token;
    globalStore.set(filesStateAtom, null);
    globalStore.set(filesSelectedPathAtom, null);
    globalStore.set(filesDiffAtom, null);
    globalStore.set(filesErrorAtom, false);
}

export async function loadFilesForAgent(
    id: string,
    transcriptPath: string | undefined,
    blockId?: string
): Promise<void> {
    const token = agentScope(id);
    beginLoad(token);
    const [cwd, sessionStartTs] = await Promise.all([
        resolveCwd(transcriptPath, blockId),
        ensureSessionStart(transcriptPath),
    ]);
    if (current.token !== token) {
        return;
    }
    // anchor on the session-start commit so committed work stays visible (a plain vs-HEAD diff would
    // collapse to nothing after the agent commits). Null ts degrades to the live diff.
    await loadChangesForCwd(token, cwd, { sessionStartTs: sessionStartTs ?? undefined });
}

// Project-scoped load: the registry path IS the cwd, so no transcript / session exists to anchor to.
// Show the live working-tree-vs-HEAD diff (uncommitted changes) — the "open this repo in a git client"
// view.
export async function loadFilesForProject(name: string, path: string): Promise<void> {
    const token = projectScope(name);
    beginLoad(token);
    await loadChangesForCwd(token, path || null, {});
}

// Run-scoped load: base-anchored, read-only, against the run's captured base commit (an immutable
// historical record). baseCommit "" degrades to the live HEAD diff.
export async function loadFilesForRun(runId: string, cwd: string, baseCommit: string): Promise<void> {
    const token = runScope(runId);
    beginLoad(token);
    await loadChangesForCwd(token, cwd || null, { ref: baseCommit });
}

// A caller elsewhere in the app — a sealed run's evidence card, an agent's changed-file rail — names
// the file it wants before the Diff surface has mounted. Held here rather than in an atom, and read by
// the history store, which owns the *visible* selection: writing filesSelectedPathAtom would not move
// the pane, because since the git-review rewrite panes 2 and 3 render whatever the history pane's
// selected row is.
//
// Keyed by scope (see agentScope / runScope / projectScope) rather than by run id, so every source the
// surface can be scoped to links the same way. The agent rail used to have a separate mechanism that
// wrote an atom nothing renders, which is why clicking a file there landed on the scope's first file.
//
// One-shot on purpose. The history pane deliberately remembers where you were so a nav switch does not
// throw you back to row zero; a deep link has to beat that once, then stop, or every return to the
// surface would drag you back to the linked file.
const pendingFileLink = { scope: "", path: "" };

export function requestFileLink(scope: string, path: string): void {
    pendingFileLink.scope = scope;
    pendingFileLink.path = path;
}

// Consumed only when `available` (the scope's loaded change set) actually holds the path. The Diff
// surface fires one history read per mount against the state captured in that render, which on a
// remount is still the outgoing scope's — a request eaten by that read would never reach the load that
// can honour it, and selecting a file the pane does not list would leave it blank.
export function consumeFileLink(scope: string, available: string[]): string | undefined {
    if (!scope || pendingFileLink.scope !== scope || !pendingFileLink.path) {
        return undefined;
    }
    if (!available.includes(pendingFileLink.path)) {
        return undefined;
    }
    const path = pendingFileLink.path;
    pendingFileLink.scope = "";
    pendingFileLink.path = "";
    return path;
}

export async function selectFile(cwd: string, path: string): Promise<void> {
    globalStore.set(filesSelectedPathAtom, path);
    globalStore.set(filesDiffAtom, null);
    const ref = globalStore.get(filesStateAtom)?.ref ?? "";
    try {
        const d = await RpcApi.GitDiffCommand(TabRpcClient, { cwd, path, ref });
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
