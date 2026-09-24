// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure model for the app-bar focus switcher: the filtered sections and the keyboard cursor. No React,
// no jotai, so the filter and the cursor walk unit-test without a render harness.

import { projectOf, type AgentState, type AgentVM } from "./agentsviewmodel";
import type { FocusKind } from "./focusstore";

export interface FocusRowVM {
    key: string; // `${kind}:${id}`, also the row's data-focus-row
    kind: FocusKind;
    id: string;
    label: string;
    detail: string; // second line: an agent's task, a run's worker count
    meta: string; // right-aligned mono: a project or a ticket; "" for none
    project: string; // what focusing this row sets the project filter to; "" leaves it alone
    status?: AgentState;
    paused?: boolean;
}

export interface FocusSection {
    kind: FocusKind;
    title: string;
    rows: FocusRowVM[];
}

function matches(query: string, ...fields: string[]): boolean {
    const q = query.trim().toLowerCase();
    return q === "" || fields.some((f) => f.toLowerCase().includes(q));
}

// Runs come off the live roster (an agent carries the run it works for) rather than a new RPC: the runs
// worth focusing are the ones with a worker on screen, which is exactly this set.
function runRows(agents: AgentVM[]): FocusRowVM[] {
    const byId = new Map<string, FocusRowVM & { count: number }>();
    for (const a of agents) {
        if (!a.runId) {
            continue;
        }
        const prev = byId.get(a.runId);
        if (prev) {
            prev.count++;
            continue;
        }
        const project = projectOf(a);
        byId.set(a.runId, {
            key: `run:${a.runId}`,
            kind: "run",
            id: a.runId,
            label: a.task || a.name,
            detail: "",
            meta: project,
            project,
            count: 1,
        });
    }
    return [...byId.values()].map(({ count, ...r }) => ({ ...r, detail: count === 1 ? "1 agent" : `${count} agents` }));
}

// currentProject hides an agent's project when it matches the filter already on, so the column only
// speaks up for a row that would switch projects.
export function buildFocusSections(
    agents: AgentVM[],
    spaces: SpaceSummary[],
    query: string,
    currentProject: string
): FocusSection[] {
    const agentRows: FocusRowVM[] = agents.map((a) => {
        const project = projectOf(a);
        return {
            key: `agent:${a.id}`,
            kind: "agent",
            id: a.id,
            label: a.name,
            detail: a.task ?? "",
            meta: project === currentProject ? "" : project,
            project,
            status: a.state,
        };
    });
    // a task summary carries no project, so focusing one leaves the project filter alone
    const taskRows: FocusRowVM[] = spaces.map((s) => ({
        key: `task:${s.id}`,
        kind: "task",
        id: s.id,
        label: s.objective,
        detail: "",
        meta: s.ticket ?? "",
        project: "",
        paused: s.status === "paused",
    }));
    const sections: FocusSection[] = [
        { kind: "agent", title: "Agents", rows: agentRows },
        { kind: "run", title: "Runs", rows: runRows(agents) },
        { kind: "task", title: "Tasks", rows: taskRows },
    ];
    return sections
        .map((s) => ({ ...s, rows: s.rows.filter((r) => matches(query, r.label, r.detail, r.meta)) }))
        .filter((s) => s.rows.length > 0);
}

// Clamps rather than wraps: a list that jumps from its last row to its first reads as a missed key.
// An unknown or null cursor starts from the top.
export function moveFocusCursor(keys: string[], cursor: string | null, delta: 1 | -1): string | null {
    if (keys.length === 0) {
        return null;
    }
    const at = cursor == null ? -1 : keys.indexOf(cursor);
    if (at < 0) {
        return keys[0];
    }
    return keys[Math.min(keys.length - 1, Math.max(0, at + delta))];
}
