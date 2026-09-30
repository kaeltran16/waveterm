// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure model for the palette's Needs you scope: attention items grouped by what they ask of the user, with
// an ask resolved to its roster agent so its options can be answered inline.

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { parseDocReview } from "@/app/view/agents/docreview";

export type NeedsGroup = "asks" | "reviews" | "blocked";

export const NEEDS_GROUP_LABELS: Record<NeedsGroup, string> = { asks: "Asks", reviews: "Reviews", blocked: "Blocked" };

const GROUP_ORDER: NeedsGroup[] = ["asks", "reviews", "blocked"];

// anything not named here lands in Blocked, so nothing the badge counts is missing from the scope
const KIND_GROUP: Record<string, NeedsGroup> = {
    ask: "asks",
    escalation: "asks",
    gate: "reviews",
    "dag-gate": "reviews",
};

// radar findings keep their own badge
const DROPPED_KIND = "radar-triage";

// pkg/jarvis/attention.go keys an ask as "ask:" + its block oref, standalone or in a channel
const ASK_BLOCK_PREFIX = "ask:block:";

export interface NeedsRow {
    item: AttentionItem;
    group: NeedsGroup;
    agent?: AgentVM; // an ask resolved to its roster agent
    review: boolean; // the agent's ask is a doc review (parseDocReview)
    options: string[]; // inline answer labels; [] = no inline answer, Enter opens the agent at its question
}

export function askAgent(item: AttentionItem, agents: AgentVM[]): AgentVM | undefined {
    if (item.kind !== "ask" || !item.key.startsWith(ASK_BLOCK_PREFIX)) {
        return undefined;
    }
    const blockId = item.key.slice(ASK_BLOCK_PREFIX.length);
    return agents.find((a) => a.blockId === blockId);
}

// a multi-question or multi-select ask can't be answered by one digit; it opens the agent instead
function inlineOptions(agent: AgentVM | undefined): string[] {
    const qs = agent?.ask?.questions ?? [];
    if (qs.length !== 1 || qs[0].multiSelect) {
        return [];
    }
    return (qs[0].options ?? []).map((o) => o.label);
}

export function needsRows(items: AttentionItem[], agents: AgentVM[]): NeedsRow[] {
    return items
        .filter((item) => item.kind !== DROPPED_KIND)
        .map((item) => {
            const agent = askAgent(item, agents);
            const review = agent != null && parseDocReview(agent.ask) != null;
            const group = review ? "reviews" : (KIND_GROUP[item.kind] ?? "blocked");
            return { item, group, agent, review, options: review ? [] : inlineOptions(agent) };
        });
}

export function needsGroups(rows: NeedsRow[]): { group: NeedsGroup; rows: NeedsRow[] }[] {
    return GROUP_ORDER.map((group) => ({ group, rows: rows.filter((r) => r.group === group) })).filter(
        (g) => g.rows.length > 0
    );
}

export function inlineSelections(row: NeedsRow, optionIndex: number): Record<number, Set<number>> | null {
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= row.options.length) {
        return null;
    }
    return { 0: new Set([optionIndex]) };
}
