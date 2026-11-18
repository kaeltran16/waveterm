// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: what the workspace pane's Run tab says about a run: its head (state, facts line, spend line, strip), the
// counts on its views, each task's dot, a row per task, and the questions already answered. Read from the dag, the
// digest and the run's event rows, with the rail's helpers where the two must agree about a run.

import { formatElapsed } from "@/app/view/orchestrate/dagdigest";
import { formatTokens } from "./agentsviewmodel";
import { shortRunId } from "./brainstormrunmodel";
import { runFinished, taskStateLabel, workerAsk, type RunInfo } from "./runlineage";
import { runStatusView } from "./runmodel";
import { runElapsedMs, runSegments, type LaneState } from "./runrail";
import { STRIP_MAX } from "./runstrip";
import { detailOf } from "./runtimeline";
import { summarizeUsage } from "./runusage";
import { usd } from "./usagestats";

export type RunHeadTone = "live" | "done" | "muted";

export interface RunHeadView {
    title: string;
    state: { text: string; tone: RunHeadTone };
    // "merged/total tasks · elapsed · run id · plan <file>", then "landed <commit>" once a finished run landed
    line: string;
}

const NO_TIME = "—";
const NOT_STARTED = new Set(["pending", "ready"]);
const SHORT_COMMIT = 7;

// a task's dot: merged, working (pulsing), asked (pulsing, with the lead or with you), failed, or waits
export type RowDot = "merged" | "working" | "asked" | "failed" | "waits";

// unpulsed fills, for the head strip; waits is the strip's empty track as the rail's strip draws it
export const STRIP_FILL: Record<RowDot, string> = {
    merged: "bg-success",
    working: "bg-accent",
    asked: "bg-warning",
    failed: "bg-error",
    waits: "bg-edge-strong",
};

export const ROW_DOT: Record<RowDot, string> = {
    merged: "bg-success",
    working: "bg-accent pulse-dot",
    asked: "bg-warning pulse-dot",
    failed: "bg-error",
    waits: "bg-ink-faint",
};

const FAILED_STATES = new Set(["failed", "verify-failed", "review-failed", "blocked-merge"]);
const WORKING_STATES = new Set(["running", "verifying", "reviewing", "done"]);

function taskDot(task: TaskNode, digest: DagStatusDigest | undefined): RowDot {
    if (FAILED_STATES.has(task.state)) {
        return "failed";
    }
    // a merged task re-verifying the checkout is still at work
    if (task.merged && task.state !== "verifying") {
        return "merged";
    }
    if (workerAsk(digest, task.id) != null) {
        return "asked";
    }
    // done here is done awaiting its merge
    return WORKING_STATES.has(task.state) ? "working" : "waits";
}

// taskDots is the tab's own dot per task, not runSegments', which reads a lead-held question as working and both
// merged and done-awaiting-merge as done
export function taskDots(dag: TaskGroup | undefined, digest: DagStatusDigest | undefined): Record<string, RowDot> {
    return Object.fromEntries((dag?.tasks ?? []).map((t) => [t.id, taskDot(t, digest)]));
}

export type HeadStrip = { kind: "segments"; dots: RowDot[] } | { kind: "bar"; done: number; total: number };

// headStrip is the head's task strip from the dots, so strip and rows agree; past STRIP_MAX one bar of merged tasks
export function headStrip(dag: TaskGroup | undefined, digest: DagStatusDigest | undefined): HeadStrip | undefined {
    const dots = Object.values(taskDots(dag, digest));
    if (dots.length === 0) {
        return undefined;
    }
    if (dots.length > STRIP_MAX) {
        return { kind: "bar", done: dots.filter((d) => d === "merged").length, total: dots.length };
    }
    return { kind: "segments", dots };
}

function sentence(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function headState(run: RunInfo): RunHeadView["state"] {
    if (runFinished(run)) {
        return (run.dag?.status ?? run.status) === "cancelled"
            ? { text: "Cancelled", tone: "muted" }
            : { text: "Done", tone: "done" };
    }
    if (run.dag == null) {
        // a bounded run never submits a dag, so with none the run's own status says where it is
        return { text: sentence(runStatusView(run.status ?? "planning").label), tone: "muted" };
    }
    return { text: "Live", tone: "live" };
}

// the facts line counts merged tasks, not runProgress' state-done ones: a merged task still verifying is landed work
export function runHead(run: RunInfo, now: number): RunHeadView {
    const dag = run.dag;
    const id = shortRunId(run.runId);
    let line: string;
    if (dag == null) {
        line = `${id} · no plan submitted`;
    } else {
        const merged = dag.tasks.filter((t) => t.merged).length;
        const elapsed = runElapsedMs(dag, run.digest, now);
        const plan = dag.planpath?.split(/[\\/]/).pop();
        const landed = runFinished(run) && run.land?.commit ? `landed ${run.land.commit.slice(0, SHORT_COMMIT)}` : "";
        line = [
            `${merged}/${dag.tasks.length} tasks`,
            elapsed > 0 ? formatElapsed(elapsed) : "",
            id,
            plan ? `plan ${plan}` : "",
            landed,
        ]
            .filter(Boolean)
            .join(" · ");
    }
    return { title: run.title, state: headState(run), line };
}

// spendLine is the head's second line, "Spent ~$2.10 · Tokens 1.2M · Worker time 14m", each fact only when known
export function spendLine(usage: UsageRow[] | undefined, workerMs: number | undefined): string | null {
    const spent = summarizeUsage(usage);
    const facts = [
        spent?.estimateUsd != null ? `Spent ~${usd(spent.estimateUsd)}` : "",
        spent ? `Tokens ${formatTokens(spent.total)}` : "",
        workerMs ? `Worker time ${formatElapsed(workerMs)}` : "",
    ].filter(Boolean);
    return facts.length > 0 ? facts.join(" · ") : null;
}

export interface AnsweredAsk {
    // the question's event row
    key: string;
    taskId: string;
    question: string;
    answeredTs: number;
}

// answeredAsks pairs each worker question with the answer that followed it on the same task, newest answer first.
// A question with no answer yet is still open, and the open list comes from the asks themselves.
export function answeredAsks(events: RunEvent[]): AnsweredAsk[] {
    const sorted = [...events].sort((a, b) => a.ts - b.ts);
    const open = new Map<string, { key: string; question: string }>();
    const out: AnsweredAsk[] = [];
    for (const e of sorted) {
        const d = detailOf<{ taskid?: string; question?: string }>(e);
        const taskId = d?.taskid;
        if (!taskId) {
            continue;
        }
        if (e.kind === "child-ask") {
            open.set(taskId, { key: e.id, question: d.question ?? "" });
        } else if (e.kind === "child-answered" && open.has(taskId)) {
            const asked = open.get(taskId);
            open.delete(taskId);
            out.push({ key: asked.key, taskId, question: asked.question, answeredTs: e.ts });
        }
    }
    return out.reverse();
}

export interface RunTabCounts {
    tasks: number;
    activity: number;
}

// the views' counts: Tasks the dag's tasks, Activity every event row
export function runTabCounts(run: RunInfo, events: RunEvent[]): RunTabCounts {
    return { tasks: run.dag?.tasks?.length ?? 0, activity: events.length };
}

export interface TaskRowView {
    id: string;
    name: string;
    // the task's id under its label; empty when the label is the id
    sub: string;
    state: string;
    tone: LaneState;
    time: string;
}

function taskState(task: TaskNode, byId: Map<string, TaskNode>, digest: DagStatusDigest | undefined, now: number) {
    if (task.merged) {
        return "merged";
    }
    if (NOT_STARTED.has(task.state)) {
        const waits = (task.deps ?? []).filter((d) => !byId.get(d)?.merged && byId.get(d)?.state !== "done");
        return waits.length > 0 ? `waits on ${waits.join(", ")}` : "queued";
    }
    const ask = workerAsk(digest, task.id);
    if (ask?.owner === "you") {
        return "asking you";
    }
    if (ask?.owner === "lead") {
        return "asked the lead";
    }
    return taskStateLabel(task, now) ?? (task.state === "running" ? "working" : task.state);
}

// how long the task ran: the digest's figure once it has one, else the clock since its worker spawned
function taskTime(task: TaskNode, digest: DagStatusDigest | undefined, now: number): string {
    const runMs = digest?.durations?.tasks?.find((d) => d.taskid === task.id)?.runms;
    if (runMs) {
        return formatElapsed(runMs);
    }
    if (task.spawnedts && !NOT_STARTED.has(task.state)) {
        return formatElapsed(Math.max(0, now - task.spawnedts));
    }
    return NO_TIME;
}

// taskRows is the Tasks view: one row per task in plan order, its dot and state tone the rail's progress bar's
export function taskRows(dag: TaskGroup | undefined, digest: DagStatusDigest | undefined, now: number): TaskRowView[] {
    const tasks = dag?.tasks ?? [];
    const tones = runSegments(dag, digest);
    const byId = new Map(tasks.map((t) => [t.id, t] as const));
    return tasks.map((t, i) => ({
        id: t.id,
        name: t.label || t.id,
        sub: t.label ? t.id : "",
        state: taskState(t, byId, digest, now),
        tone: tones[i],
        time: taskTime(t, digest, now),
    }));
}
