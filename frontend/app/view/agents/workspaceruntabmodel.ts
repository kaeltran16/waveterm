// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: what the workspace pane's Run tab says about a run: its head (state, progress line, Needs you), the counts on
// its sub-tabs, a row per task, and the questions already answered. Read from the dag, the digest, the open asks and
// the run's event rows, with the rail's helpers, so the tab and the rail cannot disagree about a run.

import { formatElapsed } from "@/app/view/orchestrate/dagdigest";
import { shortRunId } from "./brainstormrunmodel";
import { ASK_OWNER_USER } from "./childaskmodel";
import { runFinished, runProgress, taskStateLabel, workerAsk, type RunInfo } from "./runlineage";
import { runStatusView } from "./runmodel";
import { runElapsedMs, runSegments, thenTask, type LaneState } from "./runrail";
import { detailOf } from "./runtimeline";

export type RunHeadTone = "live" | "done" | "muted";

export interface RunHeadView {
    title: string;
    state: { text: string; tone: RunHeadTone };
    // "done/total tasks · elapsed · run id · plan <file>"
    line: string;
    // while a question waits on you: what the run moves on to once it is answered
    needsYou: { then?: string } | null;
}

const NO_TIME = "—";
const NOT_STARTED = new Set(["pending", "ready"]);

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

export function runHead(run: RunInfo, asks: DagAskItem[], now: number): RunHeadView {
    const dag = run.dag;
    const id = shortRunId(run.runId);
    const yours = asks.some((a) => a.owner === ASK_OWNER_USER);
    let line: string;
    if (dag == null) {
        line = `${id} · no plan submitted`;
    } else {
        const { done, total } = runProgress(dag);
        const elapsed = runElapsedMs(dag, run.digest, now);
        const plan = dag.planpath?.split(/[\\/]/).pop();
        line = [`${done}/${total} tasks`, elapsed > 0 ? formatElapsed(elapsed) : "", id, plan ? `plan ${plan}` : ""]
            .filter(Boolean)
            .join(" · ");
    }
    return {
        title: run.title,
        state: headState(run),
        line,
        needsYou: yours ? { then: thenTask(dag) } : null,
    };
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
    asks: number;
    activity: number;
}

// the sub-tabs' counts: Asks holds the open questions and the answered ones, Activity every event row
export function runTabCounts(run: RunInfo, asks: DagAskItem[], events: RunEvent[]): RunTabCounts {
    return {
        tasks: run.dag?.tasks?.length ?? 0,
        asks: asks.length + answeredAsks(events).length,
        activity: events.length,
    };
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
