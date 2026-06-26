// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure view-model logic for the Agent surface's left tree. No React, no Wave runtime imports.
// Produces group headers + parent rows; subagent children are read from per-block atoms in the
// component (they're ephemeral and keyed by block ORef), so they stay out of this pure helper.

import { projectOf, type AgentVM } from "./agentsviewmodel";

export const UNGROUPED_PROJECT = "ungrouped";

export type AgentTreeRow =
    | { kind: "group"; project: string; count: number; attn: number }
    | { kind: "parent"; agent: AgentVM; project: string };

/** Pure: roster + anchored order -> [group, ...parents] per project. Projects appear in the
 *  first-seen order of `order`; parents within a group follow `order` (ids absent from `order`
 *  sort last). `attn` is the count of asking agents in the group. */
export function buildAgentTree(agents: AgentVM[], order: string[]): AgentTreeRow[] {
    const rank = new Map(order.map((id, i) => [id, i] as const));
    const sorted = [...agents].sort(
        (a, b) => (rank.get(a.id) ?? Number.POSITIVE_INFINITY) - (rank.get(b.id) ?? Number.POSITIVE_INFINITY)
    );
    const groups: { project: string; agents: AgentVM[] }[] = [];
    const byProject = new Map<string, AgentVM[]>();
    for (const a of sorted) {
        const project = projectOf(a) || UNGROUPED_PROJECT;
        let bucket = byProject.get(project);
        if (!bucket) {
            bucket = [];
            byProject.set(project, bucket);
            groups.push({ project, agents: bucket });
        }
        bucket.push(a);
    }
    const rows: AgentTreeRow[] = [];
    for (const g of groups) {
        rows.push({
            kind: "group",
            project: g.project,
            count: g.agents.length,
            attn: g.agents.filter((a) => a.state === "asking").length,
        });
        for (const a of g.agents) {
            rows.push({ kind: "parent", agent: a, project: g.project });
        }
    }
    return rows;
}
