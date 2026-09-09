// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The command palette's extended entity sources: records, conversation threads and initiatives (efforts).
// These were the kinds ⌘K could not reach at all, archived ones most of all. They arrive as three more
// ranked groups inside the existing palette — no second overlay, no new shortcut.
//
// Records and threads reuse the jarvis stores that already own those lists (tasksstore, jarvisstore): one
// list, one truth, and the Subjects column already primes them exactly this way. Efforts have no list
// store of their own — effortslistview.tsx fetches into component state — so this module owns one.
//
// Nothing here runs at boot. loadPaletteEntities is called from the palette's open effect, beside
// loadSpaces/loadSessionsArchive.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { BriefKind } from "@/app/view/jarvis/briefpalette";
import { loadJarvisConversations } from "@/app/view/jarvis/jarvisstore";
import { loadTaskList } from "@/app/view/jarvis/tasksstore";
import { fireAndForget } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import { fuzzyScore } from "./palette-match";

// The BriefKinds the palette sources here. Sessions are deliberately absent: the palette already has a
// Sessions group whose Enter resumes the session rather than navigating to it.
export const BRIEF_GROUP_KINDS: BriefKind[] = ["record", "thread", "effort"];

// null until the first list lands. A failed load leaves the last good list in place rather than clobbering
// it with an empty one, and an unloaded source simply contributes no rows.
export const paletteEffortsAtom = atom<EffortSummary[] | null>(null) as PrimitiveAtom<EffortSummary[] | null>;

let effortsLoading = false;

// includearchived, because archived initiatives have to stay findable; briefpalette flags them and sinks
// them below live work.
async function loadPaletteEfforts(): Promise<void> {
    if (effortsLoading) {
        return;
    }
    effortsLoading = true;
    try {
        const rtn = await RpcApi.EffortListCommand(TabRpcClient, { includearchived: true });
        globalStore.set(paletteEffortsAtom, rtn?.efforts ?? []);
    } finally {
        effortsLoading = false;
    }
}

// Three independent reads. Each swallows its own failure (loadTaskList into tasksErrorAtom,
// loadJarvisConversations and this one through fireAndForget), so one list failing costs its own rows and
// nothing else — the palette still opens and the other two still rank.
export function loadPaletteEntities(): void {
    loadTaskList();
    loadJarvisConversations();
    fireAndForget(loadPaletteEfforts);
}

/**
 * Merges two already-ranked row lists into one without re-ranking either: a two-pointer merge on
 * fuzzyScore, so each input keeps its internal order exactly. That is the point — rankBriefRows has
 * already sunk archived rows below every live one, and a global re-sort would float a well-matching
 * archived row back above them. The head is still the better-scoring of the two heads, which is what
 * assembleDefaultGroups reads to pick the leading group and to judge the relevance floor.
 *
 * Ties go to `primary`; an empty query has no scores to compare, so `extra` simply follows.
 */
export function mergeRanked<T extends { search: string }>(query: string, primary: T[], extra: T[]): T[] {
    const q = query.trim();
    if (q === "") {
        return [...primary, ...extra];
    }
    const score = (it: T) => fuzzyScore(q, it.search) ?? -Infinity;
    const primaryScores = primary.map(score);
    const extraScores = extra.map(score);
    const out: T[] = [];
    let i = 0;
    let j = 0;
    while (i < primary.length && j < extra.length) {
        if (extraScores[j] > primaryScores[i]) {
            out.push(extra[j++]);
        } else {
            out.push(primary[i++]);
        }
    }
    return [...out, ...primary.slice(i), ...extra.slice(j)];
}
