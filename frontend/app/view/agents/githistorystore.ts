// frontend/app/view/agents/githistorystore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Commit-history state for the Diff surface. Mirrors filesstore.ts: module-level atoms written by
// async loaders via globalStore, with a guard token so a stale load cannot clobber a newer one.
// Module scope is deliberate — the surface unmounts on nav switch, so anything held in component
// state would be lost; the selected commit, the open file, the filters and the scroll offset all
// survive here. Derivation is pure and lives elsewhere: rows in historyrows.ts, the query and its
// labels in historyquery.ts.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { historyKey, type LoadHistoryOpts } from "./diffscope";
import { consumeFileLink, filesDiffAtom, filesStateAtom, selectFile } from "./filesstore";
import { parseUnifiedDiff, type FileView } from "./gitdiff";
import { parseGitChanges, type GitChanges } from "./gitstatus";
import {
    FILTER_DEBOUNCE_MS,
    HISTORY_PAGE_SIZE,
    NO_FILTERS,
    anyFilterActive,
    hasMorePages,
    restoreNotice,
    toHistoryQuery,
    type HistoryFilters,
} from "./historyquery";
import { WORKING_TREE, buildRows, keepSelection, type HistoryRow } from "./historyrows";

// Raw commits, accumulated across loaded pages. null = nothing read yet (the pane shows a skeleton).
export const historyCommitsAtom = atom<HistoryCommit[] | null>(null) as PrimitiveAtom<HistoryCommit[] | null>;
export const historyHeadAtom = atom<string>("") as PrimitiveAtom<string>;
// A described git failure, deliberately distinct from "this is not a repository" (isrepo:false).
export const historyFailureAtom = atom<GitFailure | null>(null) as PrimitiveAtom<GitFailure | null>;
export const historyFiltersAtom = atom<HistoryFilters>(NO_FILTERS) as PrimitiveAtom<HistoryFilters>;
export const historyHasMoreAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
export const historyAppendAtom = atom<"idle" | "loading" | "failed">("idle") as PrimitiveAtom<
    "idle" | "loading" | "failed"
>;
export const historyScrollAtom = atom<number>(0) as PrimitiveAtom<number>;
export const restoreNoticeAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
// null = nothing selected yet; WORKING_TREE ("") = the uncommitted row; otherwise a commit hash
export const selectedCommitAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const selectedFileAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const graphOnAtom = atom<boolean>(true) as PrimitiveAtom<boolean>;

const commitChangesAtom = atom<GitChanges | null>(null) as PrimitiveAtom<GitChanges | null>;
const commitDiffAtom = atom<FileView | null>(null) as PrimitiveAtom<FileView | null>;
// The scope's anchor/labels, held so the debounced filter reload can reissue the same scoped read.
const historyOptsAtom = atom<LoadHistoryOpts>({}) as PrimitiveAtom<LoadHistoryOpts>;
// When the current page was read. Relative ages are computed against this rather than a live clock,
// so the derived rows below are stable between reads instead of changing on every unrelated render.
const historyNowAtom = atom<number>(0) as PrimitiveAtom<number>;
// Stamped when the surface unmounts; read once by the next load to decide whether to announce a
// restore. null = we are not returning from anywhere.
const historyLeftAtAtom = atom<number | null>(null) as PrimitiveAtom<number | null>;

export const historyFilteredAtom = atom((get) => anyFilterActive(get(historyFiltersAtom)));

// Derived, not stored: appending a page must not duplicate the divider / uncommitted-row logic that
// buildRows already owns, so every page lands in historyCommitsAtom and the rows fall out of it.
export const historyRowsAtom = atom<HistoryRow[] | null>((get) => {
    const commits = get(historyCommitsAtom);
    if (commits == null) {
        return null;
    }
    const opts = get(historyOptsAtom);
    return buildRows(commits, {
        head: get(historyHeadAtom),
        // A filter suppresses the synthetic uncommitted row: it is not a commit, so it cannot satisfy
        // an author, path or text filter, and pinning it atop a filtered list would misreport the
        // result. buildRows already omits the row when the count is 0, so nothing else changes.
        dirtyFileCount: get(historyFilteredAtom) ? 0 : (get(filesStateAtom)?.changes?.files.length ?? 0),
        rowLabel: opts.rowLabel,
        anchor: opts.anchor,
        anchorLabel: opts.anchorLabel,
        now: get(historyNowAtom),
    });
});

// Panes 2 and 3 read one source regardless of what is selected: the working-tree row reuses the
// scope's already-loaded change set from filesstore, a commit uses its own.
export const activeChangesAtom = atom<GitChanges | null>((get) =>
    get(selectedCommitAtom) === WORKING_TREE ? (get(filesStateAtom)?.changes ?? null) : get(commitChangesAtom)
);
export const activeDiffAtom = atom<FileView | null>((get) =>
    get(selectedCommitAtom) === WORKING_TREE ? get(filesDiffAtom) : get(commitDiffAtom)
);

const current = { token: "" };
let filterTimer: ReturnType<typeof setTimeout> | null = null;

// Owned by diffscope.ts, where it is derived from the range; re-exported for the pane's convenience.
export type { LoadHistoryOpts };

// Relabels the divider and the synthetic top row without touching git. The rows are derived from this
// atom (historyRowsAtom), so a range change costs one change-list read and zero history reads.
export function setHistoryOpts(opts: LoadHistoryOpts): void {
    globalStore.set(historyOptsAtom, opts);
}

// A different repository (or run) is a different subject: filters and scroll offset from the old one
// are meaningless here and a stale path filter would silently produce an empty history that looks
// broken. Surviving a *nav switch* is a different thing: callers must not reach this on remount, and
// the one that did — the surface reading a still-loading change list as "no repository" — is why
// every return to the Diff surface used to land back at the top of an unfiltered list.
export function resetHistory(): void {
    current.token = "";
    if (filterTimer != null) {
        clearTimeout(filterTimer);
        filterTimer = null;
    }
    globalStore.set(historyCommitsAtom, null);
    globalStore.set(historyHeadAtom, "");
    globalStore.set(historyFailureAtom, null);
    globalStore.set(historyFiltersAtom, NO_FILTERS);
    globalStore.set(historyHasMoreAtom, false);
    globalStore.set(historyAppendAtom, "idle");
    globalStore.set(historyScrollAtom, 0);
    globalStore.set(restoreNoticeAtom, null);
    globalStore.set(selectedCommitAtom, null);
    globalStore.set(selectedFileAtom, null);
    globalStore.set(commitChangesAtom, null);
    globalStore.set(commitDiffAtom, null);
}

// Deliberately excludes the anchor: GitHistoryCommand takes cwd, limit and filters, so two loads that
// differ only in their divider label are the same read and must not blank the list between them.
function loadToken(cwd: string, filters: HistoryFilters): string {
    return historyKey(cwd, filters);
}

function synthFailure(command: string, e: unknown): GitFailure {
    // Not an exit status at all (websocket down, timeout, handler panic). -1 renders as "no exit
    // code" rather than a fabricated number the panel would then display as fact.
    return { command, exitcode: -1, stderr: String((e as Error)?.message ?? e) };
}

// scope: which subject this load is for, as scopeKey(scope) from diffscope.ts. Used only to claim a
// pending file deep link — from a sealed run's evidence card, or from an agent's changed-file rail.
// Deliberately not part of opts: opts is stored for the filter reload to reissue, and a one-shot link
// must not be.
export async function loadHistory(cwd: string | null, opts: LoadHistoryOpts = {}, scope?: string): Promise<void> {
    if (!cwd) {
        resetHistory();
        return;
    }
    const filters = globalStore.get(historyFiltersAtom);
    const token = loadToken(cwd, filters);
    // Blanking the list to signal "loading" unmounts every row, which collapses the scroll container:
    // the browser then clamps the restored offset to zero, and the pane's one-shot restore is already
    // spent by the time the rows come back. A remount re-runs this load with an identical token, so
    // that path is exactly the return-to-the-surface case. Same subject: leave the rows on screen until
    // their replacement arrives. Different subject: clear them, and start at the top.
    const sameSubject = current.token === token;
    current.token = token;
    globalStore.set(historyOptsAtom, opts);
    if (!sameSubject) {
        globalStore.set(historyCommitsAtom, null);
        globalStore.set(historyScrollAtom, 0);
    }
    globalStore.set(historyFailureAtom, null);
    globalStore.set(historyAppendAtom, "idle");
    try {
        const h = await RpcApi.GitHistoryCommand(TabRpcClient, {
            cwd,
            limit: HISTORY_PAGE_SIZE,
            ...toHistoryQuery(filters),
        });
        if (current.token !== token) {
            return;
        }
        if (!h.isrepo) {
            globalStore.set(historyCommitsAtom, []);
            globalStore.set(historyHasMoreAtom, false);
            return;
        }
        if (h.failure) {
            globalStore.set(historyFailureAtom, h.failure);
            globalStore.set(historyCommitsAtom, []);
            globalStore.set(historyHasMoreAtom, false);
            return;
        }
        const page = h.commits ?? [];
        globalStore.set(historyNowAtom, Date.now());
        globalStore.set(historyHeadAtom, h.head);
        globalStore.set(historyCommitsAtom, page);
        globalStore.set(historyHasMoreAtom, hasMorePages(page.length));
        settleSelection(cwd, scope);
        announceRestore();
    } catch (e) {
        if (current.token === token) {
            globalStore.set(historyFailureAtom, synthFailure("githistory", e));
            globalStore.set(historyCommitsAtom, []);
            globalStore.set(historyHasMoreAtom, false);
        }
    }
}

// Keep the user's place. The surface's load effect re-runs on every mount, so the unconditional
// re-select this replaced is what threw the selection back to row zero (and reopened its first file)
// every time you came back to the Diff surface.
function settleSelection(cwd: string, scope?: string): void {
    const rows = globalStore.get(historyRowsAtom) ?? [];
    // A deep link names one change, so it outranks both the default pick and the remembered row. It
    // resolves against the scope's own change set — the synthetic top row, whose file list is the run
    // diff under run scope and the since-session-start diff under agent scope — and consumeFileLink
    // only hands the path over once that set really holds it.
    const files = globalStore.get(filesStateAtom)?.changes?.files ?? [];
    const linked = scope ? consumeFileLink(scope, files.map((f) => f.path)) : undefined;
    if (linked) {
        globalStore.set(selectedCommitAtom, WORKING_TREE);
        void selectCommitFile(cwd, WORKING_TREE, linked);
        return;
    }
    const prev = globalStore.get(selectedCommitAtom);
    const pick = keepSelection(rows, prev);
    if (pick == null) {
        return;
    }
    // Re-read only when the selection actually moved, or when there is nothing loaded to show for it
    // (first load, or a scope whose panes were cleared).
    if (pick !== prev || globalStore.get(selectedFileAtom) == null) {
        void selectCommit(cwd, pick);
    }
}

function announceRestore(): void {
    const leftAt = globalStore.get(historyLeftAtAtom);
    globalStore.set(historyLeftAtAtom, null);
    if (leftAt == null) {
        return;
    }
    const rows = globalStore.get(historyRowsAtom) ?? [];
    globalStore.set(
        restoreNoticeAtom,
        restoreNotice({
            awayMs: Date.now() - leftAt,
            commit: globalStore.get(selectedCommitAtom),
            scroll: globalStore.get(historyScrollAtom),
            filters: globalStore.get(historyFiltersAtom),
            topRowHash: rows[0]?.hash ?? null,
        })
    );
}

// Called from the surface's unmount cleanup. Stamping the time is all the surface has to do; the
// next load decides whether anything is worth announcing.
export function noteSurfaceLeft(): void {
    globalStore.set(historyLeftAtAtom, Date.now());
}

export function dismissRestoreNotice(): void {
    globalStore.set(restoreNoticeAtom, null);
}

// Appends the next page. Reads cwd from the store rather than taking it as an argument, so the pane
// can call it from a scroll handler without threading scope through the component tree.
export async function loadMoreHistory(): Promise<void> {
    const cwd = globalStore.get(filesStateAtom)?.cwd;
    const commits = globalStore.get(historyCommitsAtom);
    if (
        !cwd ||
        commits == null ||
        !globalStore.get(historyHasMoreAtom) ||
        globalStore.get(historyAppendAtom) === "loading"
    ) {
        return;
    }
    const token = current.token;
    globalStore.set(historyAppendAtom, "loading");
    try {
        const h = await RpcApi.GitHistoryCommand(TabRpcClient, {
            cwd,
            limit: HISTORY_PAGE_SIZE,
            skip: commits.length,
            ...toHistoryQuery(globalStore.get(historyFiltersAtom)),
        });
        if (current.token !== token) {
            return; // scope or filters moved on: this page belongs to a list that no longer exists
        }
        if (h.failure) {
            globalStore.set(historyAppendAtom, "failed");
            return;
        }
        const page = h.commits ?? [];
        // A failed append must never destroy the page being read, which is why this is the one
        // failure that does not take over the surface — it only marks the footer.
        globalStore.set(historyCommitsAtom, [...commits, ...page]);
        globalStore.set(historyHasMoreAtom, hasMorePages(page.length));
        globalStore.set(historyAppendAtom, "idle");
    } catch {
        if (current.token === token) {
            globalStore.set(historyAppendAtom, "failed");
        }
    }
}

function reloadFirstPage(): void {
    const cwd = globalStore.get(filesStateAtom)?.cwd ?? null;
    globalStore.set(historyScrollAtom, 0);
    void loadHistory(cwd, globalStore.get(historyOptsAtom));
}

// Debounced: one git invocation per settled keystroke, not per keystroke.
export function setHistoryFilter(patch: Partial<HistoryFilters>): void {
    globalStore.set(historyFiltersAtom, { ...globalStore.get(historyFiltersAtom), ...patch });
    if (filterTimer != null) {
        clearTimeout(filterTimer);
    }
    filterTimer = setTimeout(() => {
        filterTimer = null;
        reloadFirstPage();
    }, FILTER_DEBOUNCE_MS);
}

export function clearHistoryFilters(): void {
    if (filterTimer != null) {
        clearTimeout(filterTimer);
        filterTimer = null;
    }
    globalStore.set(historyFiltersAtom, NO_FILTERS);
    reloadFirstPage(); // immediate: clearing is a decision, not typing
}

export function retryHistory(): void {
    globalStore.set(historyFailureAtom, null); // show the skeleton, not stale evidence, while retrying
    reloadFirstPage();
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
