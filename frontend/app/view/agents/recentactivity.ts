// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The right-rail "Recent activity" peek: newest narration entry per agent, newest-first.
// Pure derivation (buildRecentActivity) + a live-roster atom (recentActivityAtom).

import { atom, type Atom } from "jotai";
import type { AgentEntry, AgentState, AgentVM } from "./agentsviewmodel";
import { liveAgentsAtom } from "./liveagents";
import { lastActivityByIdAtom, liveEntriesByIdAtom } from "./livetranscript";

export const RECENT_ACTIVITY_LIMIT = 6;

export interface RecentActivityItem {
    id: string;
    agent: string;
    text: string;
    typeLabel: string;
    ts: number;
    state: AgentState;
}

function describe(entry: AgentEntry): { text: string; typeLabel: string } {
    if (entry.kind === "message") {
        return { text: entry.text, typeLabel: "said" };
    }
    if (entry.kind === "user") {
        return { text: entry.text, typeLabel: "you" };
    }
    return { text: `${entry.verb} ${entry.target}`.trim(), typeLabel: entry.verb };
}

/** Pure: one item per agent (its newest entry), newest-first by lastActivity, sliced to `max`.
 *  Live entries win; falls back to the agent's previousInfo (ts 0). Agents with no entries are skipped. */
export function buildRecentActivity(
    agents: AgentVM[],
    entriesById: Record<string, AgentEntry[]>,
    lastActivityById: Record<string, number>,
    max: number
): RecentActivityItem[] {
    const items: RecentActivityItem[] = [];
    for (const a of agents) {
        const entries = entriesById[a.id] ?? a.previousInfo ?? [];
        if (entries.length === 0) {
            continue;
        }
        const { text, typeLabel } = describe(entries[entries.length - 1]);
        items.push({ id: a.id, agent: a.name, text, typeLabel, ts: lastActivityById[a.id] ?? a.idleSince ?? 0, state: a.state });
    }
    return items.sort((x, y) => y.ts - x.ts).slice(0, max);
}

export const recentActivityAtom: Atom<RecentActivityItem[]> = atom((get) =>
    buildRecentActivity(get(liveAgentsAtom), get(liveEntriesByIdAtom), get(lastActivityByIdAtom), RECENT_ACTIVITY_LIMIT)
);
