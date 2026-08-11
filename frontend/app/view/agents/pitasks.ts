// frontend/app/view/agents/pitasks.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure derive helpers for the rail's Tasks section. Rendering stays in agentdetailsrail.tsx;
// everything testable lives here (repo convention: testable logic extracted, not rendered).

export const TASK_STATUS_ORDER = ["in_progress", "pending", "completed"] as const;
export type TaskStatus = (typeof TASK_STATUS_ORDER)[number];

export interface TaskGroup {
    status: TaskStatus;
    tasks: PiTask[]; // sorted updatedAt desc
}

// groupTasks buckets by status in display order, discarding unknown statuses (the backend
// already filters; this is belt-and-braces for hand-edited files).
export function groupTasks(tasks: PiTask[]): TaskGroup[] {
    const byStatus = new Map<TaskStatus, PiTask[]>();
    for (const t of tasks) {
        if (!TASK_STATUS_ORDER.includes(t.status as TaskStatus)) {
            continue;
        }
        const s = t.status as TaskStatus;
        const group = byStatus.get(s) ?? [];
        group.push(t);
        byStatus.set(s, group);
    }
    return TASK_STATUS_ORDER.filter((s) => (byStatus.get(s)?.length ?? 0) > 0).map((s) => ({
        status: s,
        tasks: (byStatus.get(s) ?? []).sort((a, b) => b.updatedat - a.updatedat),
    }));
}

// capTasks flattens groups in order and keeps the first `cap` rows; the rest are reported as
// `more` so the rail can render a single "+N more" row (RailFilesCap-style). Completed rows
// sort last, so the cap naturally cuts them first.
export function capTasks(groups: TaskGroup[], cap: number): { groups: TaskGroup[]; more: number } {
    const kept: TaskGroup[] = [];
    let budget = cap;
    let more = 0;
    for (const g of groups) {
        if (budget <= 0) {
            more += g.tasks.length;
            continue;
        }
        const take = Math.min(g.tasks.length, budget);
        kept.push({ status: g.status, tasks: g.tasks.slice(0, take) });
        budget -= take;
        more += g.tasks.length - take;
    }
    return { groups: kept, more };
}

// edgeSummary renders dependency edges as one muted line ("blocks 2 · blocked by 1") or null
// when there are none — ids are internal, counts are all the rail needs.
export function edgeSummary(t: PiTask): string | null {
    const parts: string[] = [];
    if (t.blocks.length > 0) {
        parts.push(`blocks ${t.blocks.length}`);
    }
    if (t.blockedby.length > 0) {
        parts.push(`blocked by ${t.blockedby.length}`);
    }
    return parts.length > 0 ? parts.join(" · ") : null;
}
