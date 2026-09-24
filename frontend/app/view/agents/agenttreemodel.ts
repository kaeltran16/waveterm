// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure view-model logic for the Agent surface's left tree. No React, no Wave runtime imports.
// Produces group headers, agent rows, and each orchestrator run's workers nested under its lead; subagent
// children are read from per-block atoms in the component (they're ephemeral and keyed by block ORef), so
// they stay out of this pure helper.

import { projectOf, type AgentVM } from "./agentsviewmodel";
import { holdsTask, NO_LINEAGE, workerAsk, type Lineage, type RunInfo } from "./runlineage";

export const UNGROUPED_PROJECT = "ungrouped";

export type AgentTreeRow =
    | { kind: "group"; project: string; count: number; attn: number }
    | { kind: "parent"; agent: AgentVM; project: string }
    // an orchestrator lead; `live` counts its workers that are not done
    | { kind: "lead"; agent: AgentVM; project: string; run: RunInfo; open: boolean; live: number }
    // a run whose workers are in the roster but whose lead is not: a plan-path run before its first lead
    | { kind: "run"; project: string; run: RunInfo; open: boolean; live: number }
    // a task's worker; a done task whose session is gone has no agent. `extras` counts the task's other tabs (its
    // reviewer, an earlier attempt), listed as `nested` rows beneath it while `extrasOpen`
    | {
          kind: "worker";
          agent?: AgentVM;
          project: string;
          run: RunInfo;
          task: TaskNode;
          nested?: boolean;
          extras?: number;
          extrasOpen?: boolean;
      }
    | { kind: "done"; project: string; run: RunInfo; count: number; open: boolean }
    | { kind: "queued"; project: string; run: RunInfo; count: number; open: boolean };

// TreeFolds is what the human folded: runs whose workers are hidden, runs whose done or queued tasks are listed,
// and tasks (by taskFoldKey) whose other tabs are listed.
export interface TreeFolds {
    collapsed: ReadonlySet<string>;
    doneOpen: ReadonlySet<string>;
    queuedOpen: ReadonlySet<string>;
    extrasOpen: ReadonlySet<string>;
}

const NO_FOLDS: TreeFolds = { collapsed: new Set(), doneOpen: new Set(), queuedOpen: new Set(), extrasOpen: new Set() };

export function taskFoldKey(runId: string, taskId: string): string {
    return `${runId}:${taskId}`;
}

// splitTaskTabs picks the tab a task's row stands for, its worker, and leaves the rest to nest beneath it. With no
// worker tab left, a done task's row is its ended worker's transcript, so every tab nests; otherwise the first stands in.
function splitTaskTabs(task: TaskNode, agents: AgentVM[]): { primary?: AgentVM; extras: AgentVM[] } {
    const i = agents.findIndex((a) => a.runId != null && a.runId === task.runid);
    if (i >= 0) {
        return { primary: agents[i], extras: agents.filter((_, j) => j !== i) };
    }
    if (task.state === "done") {
        return { primary: undefined, extras: agents };
    }
    const [primary, ...extras] = agents;
    return { primary, extras };
}

type TopItem =
    | { kind: "parent"; agent: AgentVM; project: string }
    | { kind: "lead"; agent: AgentVM; project: string; run: RunInfo }
    | { kind: "run"; project: string; run: RunInfo };

// A worker waits on the human only when the human holds its question; one asking its lead does not. With
// no digest yet, asking is the only signal there is.
export function workerNeedsYou(run: RunInfo, taskId: string, agent: AgentVM): boolean {
    if (run.digest == null) {
        return agent.state === "asking";
    }
    return workerAsk(run.digest, taskId)?.owner === "you";
}

const QUEUED = new Set(["pending", "ready"]);

function runRows(
    item: Extract<TopItem, { kind: "lead" | "run" }>,
    workers: Map<string, AgentVM[]>,
    folds: TreeFolds
): { rows: AgentTreeRow[]; members: number; attn: number } {
    const { run, project } = item;
    const tasks = run.dag?.tasks ?? [];
    const live = tasks.filter((t) => t.state !== "done" && workers.has(t.id));
    const done = tasks.filter((t) => t.state === "done");
    // tasks not dispatched yet have no session to open, so they fold away until asked for
    const queued = tasks.filter((t) => QUEUED.has(t.state) && !workers.has(t.id));
    const open = !folds.collapsed.has(run.runId);
    const head: AgentTreeRow =
        item.kind === "lead"
            ? { kind: "lead", agent: item.agent, project, run, open, live: live.length }
            : { kind: "run", project, run, open, live: live.length };
    const rows: AgentTreeRow[] = [head];
    // a task's row is its worker's; its reviewer and any tab an earlier attempt left fold beneath it, opening on
    // their own when one of them asks
    const pushTask = (task: TaskNode) => {
        const { primary, extras } = splitTaskTabs(task, workers.get(task.id) ?? []);
        const extrasOpen =
            extras.length > 0 &&
            (folds.extrasOpen.has(taskFoldKey(run.runId, task.id)) || extras.some((a) => a.state === "asking"));
        rows.push({ kind: "worker", agent: primary, project, run, task, extras: extras.length, extrasOpen });
        if (extrasOpen) {
            for (const agent of extras) {
                rows.push({ kind: "worker", agent, project, run, task, nested: true });
            }
        }
    };
    if (open) {
        // oldest first: what landed, what is running, what is still to come
        if (done.length > 0) {
            const doneOpen = folds.doneOpen.has(run.runId);
            rows.push({ kind: "done", project, run, count: done.length, open: doneOpen });
            if (doneOpen) {
                done.forEach(pushTask);
            }
        }
        live.forEach(pushTask);
        if (queued.length > 0) {
            const queuedOpen = folds.queuedOpen.has(run.runId);
            rows.push({ kind: "queued", project, run, count: queued.length, open: queuedOpen });
            if (queuedOpen) {
                queued.forEach(pushTask);
            }
        }
    }
    const attn = live.filter((t) => workerNeedsYou(run, t.id, workers.get(t.id)![0])).length;
    return { rows, members: live.length, attn };
}

/** Pure: roster + anchored order -> [group, ...rows] per project. Projects appear in the first-seen order
 *  of `order`; top-level rows within a group follow `order` (ids absent from `order` sort last). A run's
 *  workers follow its lead in plan order, and a run with no lead in the roster takes the place of its first
 *  worker. `count` is the group's visible agents, done workers aside; `attn` is how many wait on the human. */
export function buildAgentTree(
    agents: AgentVM[],
    order: string[],
    lineage: Lineage = NO_LINEAGE,
    folds: TreeFolds = NO_FOLDS
): AgentTreeRow[] {
    const rank = new Map(order.map((id, i) => [id, i] as const));
    const sorted = [...agents].sort(
        (a, b) => (rank.get(a.id) ?? Number.POSITIVE_INFINITY) - (rank.get(b.id) ?? Number.POSITIVE_INFINITY)
    );
    const leads = new Map<string, AgentVM>();
    const workers = new Map<string, Map<string, AgentVM[]>>();
    for (const a of sorted) {
        const role = lineage.roles[a.id];
        if (role?.kind === "lead" && lineage.runs[role.runId] && !leads.has(role.runId)) {
            leads.set(role.runId, a);
        } else if (role?.kind === "worker" && lineage.runs[role.leadRunId]) {
            let byTask = workers.get(role.leadRunId);
            if (!byTask) {
                byTask = new Map();
                workers.set(role.leadRunId, byTask);
            }
            byTask.set(role.taskId, [...(byTask.get(role.taskId) ?? []), a]);
        }
    }
    // the task's current run leads its agents, so a tab left from an earlier attempt never takes its row
    for (const [runId, byTask] of workers) {
        const run = lineage.runs[runId];
        for (const [taskId, list] of byTask) {
            list.sort((a, b) => Number(holdsTask(run, taskId, b)) - Number(holdsTask(run, taskId, a)));
        }
    }

    const groups: { project: string; items: TopItem[] }[] = [];
    const byProject = new Map<string, TopItem[]>();
    const push = (item: TopItem) => {
        let items = byProject.get(item.project);
        if (!items) {
            items = [];
            byProject.set(item.project, items);
            groups.push({ project: item.project, items });
        }
        items.push(item);
    };
    const placedRuns = new Set<string>();
    for (const a of sorted) {
        const role = lineage.roles[a.id];
        if (role?.kind === "lead" && leads.get(role.runId) === a) {
            placedRuns.add(role.runId);
            push({ kind: "lead", agent: a, project: projectOf(a) || UNGROUPED_PROJECT, run: lineage.runs[role.runId] });
        } else if (role?.kind === "worker" && lineage.runs[role.leadRunId]) {
            if (leads.has(role.leadRunId) || placedRuns.has(role.leadRunId)) {
                continue;
            }
            placedRuns.add(role.leadRunId);
            const run = lineage.runs[role.leadRunId];
            push({ kind: "run", project: run.project || UNGROUPED_PROJECT, run });
        } else {
            push({ kind: "parent", agent: a, project: projectOf(a) || UNGROUPED_PROJECT });
        }
    }

    const rows: AgentTreeRow[] = [];
    for (const g of groups) {
        const body: AgentTreeRow[] = [];
        let count = 0;
        let attn = 0;
        for (const item of g.items) {
            if (item.kind === "parent") {
                body.push(item);
                count++;
                attn += item.agent.state === "asking" ? 1 : 0;
                continue;
            }
            const r = runRows(item, workers.get(item.run.runId) ?? new Map(), folds);
            body.push(...r.rows);
            count += r.members + (item.kind === "lead" ? 1 : 0);
            attn += r.attn + (item.kind === "lead" && item.agent.state === "asking" ? 1 : 0);
        }
        rows.push({ kind: "group", project: g.project, count, attn }, ...body);
    }
    return rows;
}

/** Pure: the tree's total for its header, the sum of its groups' counts. */
export function treeAgentCount(rows: AgentTreeRow[]): number {
    return rows.reduce((n, r) => n + (r.kind === "group" ? r.count : 0), 0);
}
