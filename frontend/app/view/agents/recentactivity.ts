// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The right-rail "Recent activity" peek: newest narration entry per agent, newest-first.
// Pure derivation (buildRecentActivity); the cockpit calls it with its `now` tick + live atoms.

import type { AgentEntry, AgentState, AgentVM } from "./agentsviewmodel";

export const RECENT_ACTIVITY_LIMIT = 6;

export interface RecentActivityItem {
    id: string;
    agent: string;
    text: string;
    typeLabel: string;
    ts: number;
    state: AgentState;
}

function commandText(entry: Extract<AgentEntry, { kind: "command" }>): string {
    const name = entry.isSkill && !entry.name.startsWith("/") ? `/${entry.name}` : entry.name;
    return `${name} ${entry.args ?? ""}`.trim();
}

function describe(entry: AgentEntry): { text: string; typeLabel: string } {
    if (entry.kind === "message") {
        return { text: entry.text, typeLabel: "said" };
    }
    if (entry.kind === "user") {
        return { text: entry.text, typeLabel: "you" };
    }
    if (entry.kind === "command") {
        return { text: commandText(entry), typeLabel: entry.isSkill ? "skill" : "command" };
    }
    if (entry.kind === "compaction") {
        return { text: "Conversation compacted", typeLabel: "compacted" };
    }
    if (entry.kind === "notification") {
        return { text: entry.summary || "Subagent finished", typeLabel: "task" };
    }
    if (entry.kind === "interrupted") {
        return { text: "Interrupted", typeLabel: "interrupted" };
    }
    return { text: `${entry.verb} ${entry.target}`.trim(), typeLabel: entry.verb };
}

/** Pure: one item per agent (its newest entry), newest-first by lastActivity, sliced to `max`.
 *  Live entries win; falls back to the agent's previousInfo. When no live timestamp exists (e.g. a
 *  fixture roster), ts is derived from the agent's age field (`now - blockedMs|activeMs`, or idleSince)
 *  so the "x ago" label is real instead of 1970. Agents with no entries are skipped. */
export function buildRecentActivity(
    agents: AgentVM[],
    entriesById: Record<string, AgentEntry[]>,
    lastActivityById: Record<string, number>,
    max: number,
    now: number
): RecentActivityItem[] {
    const items: RecentActivityItem[] = [];
    for (const a of agents) {
        const entries = entriesById[a.id] ?? a.previousInfo ?? [];
        if (entries.length === 0) {
            continue;
        }
        const { text, typeLabel } = describe(entries[entries.length - 1]);
        const ts = lastActivityById[a.id] ?? a.idleSince ?? now - (a.blockedMs ?? a.activeMs ?? 0);
        items.push({ id: a.id, agent: a.name, text, typeLabel, ts, state: a.state });
    }
    return items.sort((x, y) => y.ts - x.ts).slice(0, max);
}
