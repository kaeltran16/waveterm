// frontend/app/view/agents/comparestore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Branch-comparison state for the Diff surface. Separate from githistorystore.ts on purpose: that
// file is the single-ref history spine, this is a two-ref read with its own selection. Same idioms —
// module-level atoms written by async loaders through globalStore, with a guard token so a stale load
// cannot clobber a newer one. Module scope is load-bearing: the surface unmounts on nav switch, so
// the refs, the selection and the open file would be lost in component state.
//
// One selection model, two data sources: the aggregate row reads the two-ref commands, a commit row
// reads the same commit-scoped commands the history spine uses — a commit's contents mean the same
// thing however you reached it.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { AGGREGATE } from "./comparerows";
import { parseUnifiedDiff, type FileView } from "./gitdiff";
import { parseGitChanges, type GitChanges } from "./gitstatus";

export interface CompareRefs {
    base: string;
    head: string;
}

export interface CompareSides {
    ahead: HistoryCommit[];
    behind: HistoryCommit[];
    mergeBase: string;
}

export const compareOnAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
export const compareRefsAtom = atom<CompareRefs | null>(null) as PrimitiveAtom<CompareRefs | null>;
export const compareSidesAtom = atom<CompareSides | null>(null) as PrimitiveAtom<CompareSides | null>;
export const compareAggregateAtom = atom<GitChanges | null>(null) as PrimitiveAtom<GitChanges | null>;
// AGGREGATE, or a commit hash from either side
export const compareSelectionAtom = atom<string>(AGGREGATE) as PrimitiveAtom<string>;
export const compareSelectedFileAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
// A failed compare read, phrased with the refs in it so the column can name what did not resolve.
export const compareErrorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const compareBranchesAtom = atom<BranchInfo[]>([]) as PrimitiveAtom<BranchInfo[]>;
// The open file's diff. One atom for both selection states — the aggregate and a commit each write it
// from their own command, so there is nothing for a derived atom to choose between.
export const compareDiffAtom = atom<FileView | null>(null) as PrimitiveAtom<FileView | null>;
// The surface scope compare was entered from, as an opaque token the surface composes (cwd + run).
// Module-level rather than a component ref because the surface unmounts on nav switch: an effect
// keyed on cwd alone would fire on every remount and tear down a compare the user is still using.
// null = compare is not anchored to anything, i.e. it is off.
export const compareAnchorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

const commitChangesAtom = atom<GitChanges | null>(null) as PrimitiveAtom<GitChanges | null>;

// Pane 2 reads one source regardless of which row is selected.
export const compareActiveChangesAtom = atom<GitChanges | null>((get) =>
    get(compareSelectionAtom) === AGGREGATE ? get(compareAggregateAtom) : get(commitChangesAtom)
);

const current = { token: "" };

export function exitCompare(): void {
    current.token = "";
    globalStore.set(compareOnAtom, false);
    globalStore.set(compareAnchorAtom, null);
    globalStore.set(compareSidesAtom, null);
    globalStore.set(compareAggregateAtom, null);
    globalStore.set(compareSelectionAtom, AGGREGATE);
    globalStore.set(compareSelectedFileAtom, null);
    globalStore.set(commitChangesAtom, null);
    globalStore.set(compareDiffAtom, null);
    globalStore.set(compareErrorAtom, null);
    // compareRefsAtom survives on purpose: re-entering compare should offer the pair you last used.
}

// The picker's suggestions and the default base. Failure degrades to free text rather than an error:
// you can still type a ref by hand, which is the whole reason the fields accept free text.
export async function loadCompareRefsMeta(cwd: string): Promise<string> {
    try {
        const rtn = await RpcApi.ListBranchesCommand(TabRpcClient, { projectpath: cwd });
        globalStore.set(compareBranchesAtom, rtn.branches ?? []);
        return rtn.default ?? "";
    } catch {
        globalStore.set(compareBranchesAtom, []);
        return "";
    }
}

// Enter compare on the checked-out branch against the repo's default branch — the review question,
// and the pair that needs no typing. currentBranch comes from filesStateAtom.branch, which the
// change-list read already resolved, so learning where you are costs no extra git call. `anchor`
// identifies the surface scope this compare belongs to; the surface exits compare when it changes.
export async function enterCompare(cwd: string, currentBranch: string, anchor: string): Promise<void> {
    globalStore.set(compareOnAtom, true);
    globalStore.set(compareAnchorAtom, anchor);
    globalStore.set(compareErrorAtom, null);
    globalStore.set(compareSidesAtom, null);
    globalStore.set(compareAggregateAtom, null);
    const def = await loadCompareRefsMeta(cwd);
    const prev = globalStore.get(compareRefsAtom);
    const base = prev?.base || def;
    const head = prev?.head || currentBranch;
    await setCompareRefs(cwd, base, head);
}

export async function setCompareRefs(cwd: string, base: string, head: string): Promise<void> {
    globalStore.set(compareRefsAtom, { base, head });
    const token = `${cwd}|${base}|${head}`;
    current.token = token;
    globalStore.set(compareSidesAtom, null);
    globalStore.set(compareAggregateAtom, null);
    globalStore.set(compareSelectionAtom, AGGREGATE);
    globalStore.set(compareSelectedFileAtom, null);
    globalStore.set(commitChangesAtom, null);
    globalStore.set(compareDiffAtom, null);
    globalStore.set(compareErrorAtom, null);
    if (!base || !head) {
        globalStore.set(compareErrorAtom, "Pick two refs to compare.");
        return;
    }
    try {
        const [div, agg] = await Promise.all([
            RpcApi.GitDivergenceCommand(TabRpcClient, { cwd, base, head }),
            RpcApi.GitCompareChangesCommand(TabRpcClient, { cwd, base, head }),
        ]);
        if (current.token !== token) {
            return;
        }
        if (!div.isrepo || !agg.isrepo) {
            globalStore.set(compareErrorAtom, "Not a git repository.");
            return;
        }
        globalStore.set(compareSidesAtom, {
            ahead: div.ahead ?? [],
            behind: div.behind ?? [],
            mergeBase: div.mergebase ?? "",
        });
        const changes = parseGitChanges(agg.statusz, agg.numstat);
        globalStore.set(compareAggregateAtom, changes);
        const first = changes.files[0]?.path;
        if (first) {
            void selectCompareFile(cwd, first);
        }
    } catch {
        if (current.token === token) {
            // Name the pair: an unresolvable ref is the common cause, and a blank column would
            // otherwise read as "these refs do not differ".
            globalStore.set(compareErrorAtom, `Couldn’t compare ${base} with ${head}.`);
        }
    }
}

export async function selectCompareRow(cwd: string, rowId: string): Promise<void> {
    globalStore.set(compareSelectionAtom, rowId);
    globalStore.set(compareSelectedFileAtom, null);
    globalStore.set(compareDiffAtom, null);
    if (rowId === AGGREGATE) {
        const first = globalStore.get(compareAggregateAtom)?.files[0]?.path;
        if (first) {
            void selectCompareFile(cwd, first);
        }
        return;
    }
    globalStore.set(commitChangesAtom, null);
    try {
        const ch = await RpcApi.GitCommitChangesCommand(TabRpcClient, { cwd, hash: rowId });
        if (globalStore.get(compareSelectionAtom) !== rowId) {
            return; // selection moved on
        }
        const changes = ch.isrepo ? parseGitChanges(ch.statusz, ch.numstat) : null;
        globalStore.set(commitChangesAtom, changes);
        const first = changes?.files[0]?.path;
        if (first) {
            void selectCompareFile(cwd, first);
        }
    } catch {
        if (globalStore.get(compareSelectionAtom) === rowId) {
            globalStore.set(commitChangesAtom, null);
        }
    }
}

export async function selectCompareFile(cwd: string, path: string): Promise<void> {
    globalStore.set(compareSelectedFileAtom, path);
    globalStore.set(compareDiffAtom, null);
    const selection = globalStore.get(compareSelectionAtom);
    const refs = globalStore.get(compareRefsAtom);
    const moved = () =>
        globalStore.get(compareSelectedFileAtom) !== path || globalStore.get(compareSelectionAtom) !== selection;
    try {
        if (selection === AGGREGATE) {
            if (refs == null) {
                return;
            }
            const d = await RpcApi.GitCompareDiffCommand(TabRpcClient, {
                cwd,
                base: refs.base,
                head: refs.head,
                path,
            });
            if (moved()) {
                return;
            }
            globalStore.set(compareDiffAtom, parseUnifiedDiff(d.diff));
            return;
        }
        const d = await RpcApi.GitCommitDiffCommand(TabRpcClient, { cwd, hash: selection, path });
        if (moved()) {
            return;
        }
        globalStore.set(compareDiffAtom, parseUnifiedDiff(d.diff));
    } catch {
        if (!moved()) {
            globalStore.set(compareDiffAtom, null);
        }
    }
}
