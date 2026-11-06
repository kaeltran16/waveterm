// frontend/app/view/agents/cardgitstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Per-card git diff stats (files/adds/dels) for the cockpit grid. Mirrors railstore.ts (which loads
// the same for the single focused agent) but keyed by agent id for every rendered card. The card
// grid effect drives this: refreshCardGit on enter, scheduleCardGit (debounced) on transcript
// activity, dropCardGit on leave. cwd resolution + the pure GitChanges parse are shared with the
// Files surface / rail.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import type { DiffStats } from "./agentsviewmodel";
import { resolveCwd } from "./agentcwdresolve";
import { ensureSessionStart } from "./agentsessionstore";
import { parseGitChanges, type GitChanges } from "./gitstatus";

export const diffStatsByIdAtom = atom<Record<string, DiffStats>>({}) as PrimitiveAtom<Record<string, DiffStats>>;
// each card's resolved cwd, so a chip can tell when its checkout's changes are shared with other cards
export const cardCwdByIdAtom = atom<Record<string, string>>({}) as PrimitiveAtom<Record<string, string>>;

function checkoutKey(cwd: string): string {
    return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Pure: how many cards, this one included, resolve to its checkout (0 when its cwd is unknown). Paths compare
 *  case-insensitively and slash-agnostic, as Windows treats them; a worktree is its own checkout. */
export function sharedCheckoutCount(id: string, cwdById: Record<string, string>): number {
    const own = cwdById[id];
    if (!own) {
        return 0;
    }
    const key = checkoutKey(own);
    return Object.values(cwdById).filter((c) => checkoutKey(c) === key).length;
}

/** Pure: collapse a GitChanges into the card's headline stats. */
export function diffStatsFromChanges(changes: GitChanges): DiffStats {
    return { files: changes.files.length, adds: changes.adds, dels: changes.dels };
}

// debounce after transcript activity — git runs while an agent works, idles when quiet
const DEBOUNCE_MS = 4000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
// monotonically-increasing load token per id: a newer load supersedes an in-flight older one
const loadSeq = new Map<string, number>();

function setCwd(id: string, cwd: string | null): void {
    const cur = globalStore.get(cardCwdByIdAtom);
    if (cwd == null) {
        if (!(id in cur)) {
            return;
        }
        const { [id]: _, ...rest } = cur;
        globalStore.set(cardCwdByIdAtom, rest);
        return;
    }
    if (cur[id] !== cwd) {
        globalStore.set(cardCwdByIdAtom, { ...cur, [id]: cwd });
    }
}

function setStats(id: string, stats: DiffStats | null): void {
    const cur = globalStore.get(diffStatsByIdAtom);
    if (stats == null) {
        if (!(id in cur)) {
            return;
        }
        const { [id]: _, ...rest } = cur;
        globalStore.set(diffStatsByIdAtom, rest);
        return;
    }
    globalStore.set(diffStatsByIdAtom, { ...cur, [id]: stats });
}

/** Resolve the agent's cwd and load git changes for it, updating diffStatsByIdAtom. A clean repo,
 *  non-repo, or unresolvable cwd drops the id from the map (the card's diff button hides). Guarded
 *  so a superseding load (or a drop) discards a slower older result. */
export async function refreshCardGit(id: string, transcriptPath: string | undefined, blockId?: string): Promise<void> {
    const seq = (loadSeq.get(id) ?? 0) + 1;
    loadSeq.set(id, seq);
    const [cwd, startTs] = await Promise.all([resolveCwd(transcriptPath, blockId), ensureSessionStart(transcriptPath)]);
    if (loadSeq.get(id) !== seq) {
        return;
    }
    setCwd(id, cwd || null);
    if (!cwd) {
        setStats(id, null);
        return;
    }
    try {
        // sessionstartts: anchor on the commit that was HEAD when this agent's session began, so the
        // pill counts only this session's work (commits since start + uncommitted). Null ts (no
        // transcript yet) degrades to the live working-tree-vs-HEAD diff.
        const ch = await RpcApi.GitChangesCommand(TabRpcClient, { cwd, sessionstartts: startTs ?? undefined });
        if (loadSeq.get(id) !== seq) {
            return;
        }
        if (!ch.isrepo) {
            setStats(id, null);
            return;
        }
        if (ch.numstaterror) {
            // the file list is there but its line counts are not: a +0 −0 chip would claim no edits
            console.warn(`cardgit: line counts failed for agent ${id}`, ch.numstaterror);
            setStats(id, null);
            return;
        }
        const stats = diffStatsFromChanges(parseGitChanges(ch.statusz, ch.numstat));
        setStats(id, stats.files > 0 ? stats : null);
    } catch (err) {
        if (loadSeq.get(id) === seq) {
            // no stats rather than fake zeros, but not silently: a failed read looks like a clean card
            console.warn(`cardgit: git changes failed for agent ${id}`, err);
            setStats(id, null);
        }
    }
}

/** Debounced refresh, coalescing a burst of transcript activity into one git load. */
export function scheduleCardGit(id: string, transcriptPath: string | undefined, blockId?: string): void {
    const existing = timers.get(id);
    if (existing) {
        clearTimeout(existing);
    }
    timers.set(
        id,
        setTimeout(() => {
            timers.delete(id);
            void refreshCardGit(id, transcriptPath, blockId);
        }, DEBOUNCE_MS)
    );
}

/** Stop tracking an agent that left the rendered set: cancel its pending refresh, invalidate any
 *  in-flight load, and drop its stats and cwd. */
export function dropCardGit(id: string): void {
    const existing = timers.get(id);
    if (existing) {
        clearTimeout(existing);
        timers.delete(id);
    }
    loadSeq.set(id, (loadSeq.get(id) ?? 0) + 1);
    setStats(id, null);
    setCwd(id, null);
}
