// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What the plan gate shows, as data. The gate is the one moment the whole decomposition is on screen
// at once and still costs nothing to change, so it reads as a plan — numbered, in dependency order,
// each row naming what it waits for — rather than as the graph, which answers "what is happening now"
// and is the wrong question before anything has started.

import { MAX_DAG_TASKS, MAX_PARALLELISM } from "../agents/runconfig";

export interface PlanGateRow {
    n: number;
    id: string;
    label: string;
    deps: string;
}

export interface PlanGateView {
    rows: PlanGateRow[];
    shape: string; // "9 tasks · 4 layers"
    width: string; // "parallelism 3 · 16 max"
}

// taskDepths gives each task its longest distance from a root, which is what makes a "layer".
// Longest-path over a topological order rather than a recursive walk: a recursive walk has to be
// memoised to stay cheap, and a memo written from inside a cycle caches a depth measured from a
// truncated path. Anything the sweep never reaches — a task in a cycle — keeps depth 0 and the
// function still returns. A dependency naming a task outside this plan is not a dependency here, so
// it does not hold its dependant down a layer.
function taskDepths(tasks: TaskNode[]): Map<string, number> {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const depth = new Map(tasks.map((t) => [t.id, 0]));
    const remaining = new Map<string, number>();
    const dependants = new Map<string, string[]>();
    for (const t of tasks) {
        const deps = (t.deps ?? []).filter((d) => byId.has(d));
        remaining.set(t.id, deps.length);
        for (const d of deps) {
            dependants.set(d, [...(dependants.get(d) ?? []), t.id]);
        }
    }
    const queue = tasks.filter((t) => remaining.get(t.id) === 0).map((t) => t.id);
    for (let i = 0; i < queue.length; i++) {
        const id = queue[i];
        for (const next of dependants.get(id) ?? []) {
            depth.set(next, Math.max(depth.get(next)!, depth.get(id)! + 1));
            const left = remaining.get(next)! - 1;
            remaining.set(next, left);
            if (left === 0) {
                queue.push(next);
            }
        }
    }
    return depth;
}

// planLayers counts the waves the engine will run the plan in — the number a reader uses to judge
// whether a plan is a fan-out or a queue. Distinct from parallelism, which is how many of one layer
// run at a time.
export function planLayers(tasks: TaskNode[]): number {
    if (tasks.length === 0) {
        return 0;
    }
    return Math.max(...taskDepths(tasks).values()) + 1;
}

// depText names what a row waits for. Dependencies are shown by id rather than label because the ids
// are what the rows above are keyed by — a reader scanning "after retry-budget" finds that row.
export function depText(task: TaskNode): string {
    const deps = task.deps ?? [];
    return deps.length === 0 ? "no deps" : `after ${deps.join(", ")}`;
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function pinText(runtime: string | undefined, tier: string | undefined, model: string | undefined): string {
    const where = runtime || "unavailable";
    // an exact model wins over the tier, exactly as the router resolves it
    const what = model || tier;
    return what ? `${where} · ${what}` : where;
}

// leadRouteText says who wrote this plan, because the answer changes how much of it a reader checks.
export function leadRouteText(run: Run): string {
    return `lead ${pinText(run.runtime, run.tier, run.model)}`;
}

// workerRouteText says who will execute it and where. "managed worktrees" is claimed only when the
// group actually has them — a non-git project runs children in the project directory itself, and
// promising isolation that is not there is the one wrong thing to say at an approval gate.
export function workerRouteText(run: Run, group: TaskGroup): string {
    const route = group.workerroute ?? run.workerroute;
    const who = route == null ? "same as lead" : pinText(route.runtime, route.tier, route.model);
    return group.mergerequired ? `workers ${who} · managed worktrees` : `workers ${who} · in the project directory`;
}

// planGateView orders rows by dependency depth, then by the lead's own submission order within a
// layer. The submitted order is not necessarily topological, and a plan whose row 2 depends on row 7
// cannot be read top to bottom.
export function planGateView(group: TaskGroup): PlanGateView {
    const tasks = group.tasks ?? [];
    const depths = taskDepths(tasks);
    const rows = tasks
        .map((t, i) => ({ t, i, depth: depths.get(t.id) ?? 0 }))
        .sort((a, b) => (a.depth !== b.depth ? a.depth - b.depth : a.i - b.i))
        .map(({ t }, idx) => ({ n: idx + 1, id: t.id, label: t.label || t.id, deps: depText(t) }));
    const width = Math.min(group.parallelism || 1, MAX_PARALLELISM);
    return {
        rows,
        shape: `${plural(tasks.length, "task")} · ${plural(planLayers(tasks), "layer")}`,
        width: `parallelism ${width} · ${MAX_DAG_TASKS} max`,
    };
}
