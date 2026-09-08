// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The overview's attention queue, as data. Membership is unchanged — actionable exceptions plus
// merge-ready work — but every entry now carries what a reader needs to act on it: the task's own
// identity, the condition, the digest's authoritative action set, and where the action actually
// happens. Nothing here reconstructs scheduler policy or invents an action the digest did not offer.

export type QueueTarget = "worker" | "task";

export type QueueEntry = {
    taskId: string;
    label: string;
    detail: string;
    // the digest's HumanActions verbatim; empty means nobody has an action to take here yet
    actions: string[];
    target: QueueTarget;
    runId?: string;
};

export function attentionQueue(digest: DagStatusDigest, group: TaskGroup | undefined): QueueEntry[] {
    const rowById = new Map<string, DagTaskDigest>();
    for (const row of digest.tasks ?? []) {
        rowById.set(row.taskid, row);
    }
    const entries: QueueEntry[] = [];
    for (const task of group?.tasks ?? []) {
        const row = rowById.get(task.id);
        if (row == null || !needsAttention(task, row)) {
            continue;
        }
        entries.push({
            taskId: task.id,
            label: task.label || task.id,
            detail: conditionText(task, row),
            actions: row.humanactions ?? [],
            target: targetFor(task, row),
            runId: task.runid || undefined,
        });
    }
    return entries;
}

function needsAttention(task: TaskNode, row: DagTaskDigest): boolean {
    if (row.waitreason === "ask" || row.waitreason === "failure") {
        return true;
    }
    if (row.cleanupstate === "failed") {
        return true;
    }
    if (task.state === "failed" || task.state === "stalled" || task.state === "blocked-merge") {
        return true;
    }
    return row.mergestate === "ready";
}

// conditionText is the entry's second line: what is wrong, never who the task is. The label carries
// identity, so a pending ask no longer costs the reader the name of the task asking it.
function conditionText(task: TaskNode, row: DagTaskDigest): string {
    if (row.waitreason === "ask") {
        return row.asksummary || "waiting for an answer";
    }
    if (row.mergestate === "ready") {
        return "merge ready";
    }
    if (row.cleanupstate === "failed") {
        return "cleanup failed";
    }
    return task.state;
}

// targetFor routes the entry. An ask is answered, and a failure understood, in the worker's own
// transcript; merge and cleanup exceptions are resolved against the task in the graph rail. A task
// with no child run has no worker to open, whatever its condition.
function targetFor(task: TaskNode, row: DagTaskDigest): QueueTarget {
    if (!task.runid) {
        return "task";
    }
    const inWorker =
        row.waitreason === "ask" || row.waitreason === "failure" || task.state === "failed" || task.state === "stalled";
    return inWorker ? "worker" : "task";
}
