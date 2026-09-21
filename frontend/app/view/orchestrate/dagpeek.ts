// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The DAG graph's hover peek as data: what a node's card has no room for — the full title, the plan's
// description, and why the task is where it is. The worker's live activity line is not here; it needs the
// roster and renders beside these rows.

import { firstLine, formatElapsed, waitingText, type TaskBrief } from "./dagdigest";

export type PeekRow = { text: string; tone: "muted" | "warning" };
// what a task's Verify has to show: a heading, and the output tail the plan's command left behind
export type VerifySection = { heading: string; tail: string; tone: "muted" | "warning" };
export type TaskPeek = { title: string; description: string; rows: PeekRow[]; verify: VerifySection | null };

export function taskPeek(
    task: TaskNode,
    td: DagTaskDigest | undefined,
    briefs: Map<string, TaskBrief>,
    nowMs: number
): TaskPeek {
    const rows: PeekRow[] = [];
    if (td?.waitreason === "ask" || td?.waitreason === "lead-ask") {
        const who = td.waitreason === "ask" ? "you" : "the lead";
        rows.push({ text: `asked ${who}: ${td.asksummary || "a question"}`, tone: "warning" });
    }
    if (task.state === "pending" || task.state === "ready") {
        rows.push({ text: waitingText(td, briefs), tone: "muted" });
    }
    const activity = activityText(task, nowMs);
    if (activity) {
        rows.push({ text: activity, tone: "muted" });
    }
    if (task.lastfailurekind) {
        const attempt = (task.attempts ?? 0) > 1 ? ` · attempt ${task.attempts}` : "";
        rows.push({ text: `last failure: ${task.lastfailurekind}${attempt}`, tone: "warning" });
    }
    for (const err of [task.verifyerror, task.mergeerror, task.cleanuperror]) {
        const line = firstLine(err);
        if (line) {
            rows.push({ text: line, tone: "warning" });
        }
    }
    return {
        title: task.label || task.id,
        description: (task.description ?? "").trim(),
        rows,
        verify: verifySection(task, nowMs),
    };
}

// verifySection decides what the peek's Verify block shows. A failed Verify's reason is already a row, so
// its section is the output alone; a task that never verified, or passed before output was kept, has none.
export function verifySection(task: TaskNode, nowMs: number): VerifySection | null {
    const tail = (task.verifyoutput ?? "").trim();
    switch (task.state) {
        case "verifying": {
            const elapsed = task.verifystartedts ? ` · ${ago(nowMs, task.verifystartedts)}` : "";
            return { heading: `Verify running${elapsed}`, tail, tone: "muted" };
        }
        case "verify-failed":
            return tail ? { heading: "Verify output", tail, tone: "warning" } : null;
        case "done":
            return tail || task.verifystartedts ? { heading: "Verify passed", tail, tone: "muted" } : null;
        default:
            return null;
    }
}

// the stamps are sampled transcript writes; a running task with neither has written nothing the watchdog
// can read (or its runtime has no readable transcript), which is not the same as idle
function activityText(task: TaskNode, nowMs: number): string | null {
    const parts: string[] = [];
    if (task.firstactivity) {
        parts.push(`first activity ${ago(nowMs, task.firstactivity)} ago`);
    }
    if (task.lastactivity) {
        parts.push(`last ${ago(nowMs, task.lastactivity)} ago`);
    }
    if (parts.length > 0) {
        return parts.join(" · ");
    }
    return task.state === "running" || task.state === "stalled" ? "no activity observed" : null;
}

function ago(nowMs: number, ts: number): string {
    return formatElapsed(Math.max(0, nowMs - ts));
}
