// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: what the details rail's Run section (for a lead) and Task section (for a worker) say about an
// orchestrator run. Read from the dag, the engine's digest and the run's event rows; no React.

import { formatAgeShort } from "./agentsviewmodel";
import { ASK_OWNER_USER } from "./childaskmodel";
import { laneLabel, workerAsk } from "./runlineage";
import { detailOf, eventTitle } from "./runtimeline";

export type LaneDot = "done" | "working" | "asking" | "pending" | "failed" | "muted";

export interface LaneRow {
    key: string;
    dots: LaneDot[];
    name: string;
    meta: string;
    // the task a click on the row lands on
    taskId: string;
}

const FINISHED = new Set(["done", "skipped", "cancelled"]);
const NOT_STARTED = new Set(["pending", "ready"]);
const FAILING = new Set(["stalled", "failed", "verify-failed", "blocked-merge"]);

// COMMIT_CHARS is how much of a landed commit's hash a line shows, as git's short form does.
const COMMIT_CHARS = 7;

function laneDot(task: TaskNode, digest: DagStatusDigest | undefined): LaneDot {
    if (task.state === "done") {
        return "done";
    }
    if (FINISHED.has(task.state)) {
        return "muted";
    }
    if (NOT_STARTED.has(task.state)) {
        return "pending";
    }
    if (FAILING.has(task.state)) {
        return "failed";
    }
    return workerAsk(digest, task.id) ? "asking" : "working";
}

function landedCommit(digest: DagStatusDigest | undefined, taskId: string): string | undefined {
    return digest?.report?.commits?.find((c) => c.taskid === taskId)?.commit.slice(0, COMMIT_CHARS);
}

function taskName(task: TaskNode): string {
    return task.label ? `${task.id} ${task.label}` : task.id;
}

function runningFor(task: TaskNode, now: number): string {
    return task.firstactivity ? formatAgeShort(now - task.firstactivity) : task.state;
}

// laneRows is the Run section's lane list: one row per lane with a dot per task, the task in play and
// what it is doing, a lane that has not started saying which lanes it waits on.
export function laneRows(dag: TaskGroup | undefined, digest: DagStatusDigest | undefined, now: number): LaneRow[] {
    const byId = new Map((dag?.tasks ?? []).map((t) => [t.id, t] as const));
    return (digest?.lanes ?? []).flatMap((ids) => {
        const tasks = ids.map((id) => byId.get(id)).filter((t): t is TaskNode => t != null);
        if (tasks.length === 0) {
            return [];
        }
        const key = laneLabel(digest, ids[0])!;
        const dots = tasks.map((t) => laneDot(t, digest));
        if (tasks.every((t) => NOT_STARTED.has(t.state))) {
            const unmet = (tasks[0].deps ?? []).filter((d) => byId.get(d)?.state !== "done");
            const waits = [...new Set(unmet.map((d) => laneLabel(digest, d)).filter(Boolean))];
            const meta = waits.length > 0 ? `waits ${waits.join(", ")}` : "queued";
            return [{ key, dots, name: ids.join(", "), meta, taskId: ids[0] }];
        }
        const current = tasks.find((t) => !FINISHED.has(t.state));
        if (current == null) {
            const tip = tasks[tasks.length - 1];
            return [
                { key, dots, name: taskName(tip), meta: landedCommit(digest, tip.id) ?? tip.state, taskId: tip.id },
            ];
        }
        const ask = workerAsk(digest, current.id);
        const meta = ask
            ? ask.owner === "lead"
                ? "asks lead"
                : "asks you"
            : current.state === "running"
              ? runningFor(current, now)
              : current.state;
        return [{ key, dots, name: taskName(current), meta, taskId: current.id }];
    });
}

export interface TaskFacts {
    lane?: string;
    laneText?: string;
    depends: string;
    // "Attempt" while the task is in play, "Result" once it is finished
    resultLabel: "Attempt" | "Result";
    result: string;
    landed: boolean;
}

// taskFacts is the Task section's rows for one worker's task.
export function taskFacts(
    dag: TaskGroup | undefined,
    digest: DagStatusDigest | undefined,
    taskId: string,
    now: number
): TaskFacts | undefined {
    const task = dag?.tasks?.find((t) => t.id === taskId);
    if (task == null) {
        return undefined;
    }
    const byId = new Map((dag?.tasks ?? []).map((t) => [t.id, t] as const));
    const lane = laneLabel(digest, taskId);
    const laneIds = digest?.lanes?.find((l) => l.includes(taskId));
    const depends =
        (task.deps ?? [])
            .map((d) => {
                const dep = byId.get(d);
                return `${d} · ${dep?.merged ? "landed" : (dep?.state ?? "unknown")}`;
            })
            .join(", ") || "none";
    const facts: TaskFacts = {
        lane,
        laneText: lane && laneIds ? `${lane} · ${laneIds.join(" → ")}` : undefined,
        depends,
        resultLabel: "Attempt",
        result: "",
        landed: false,
    };
    if (FINISHED.has(task.state)) {
        const commit = landedCommit(digest, taskId);
        const landed = task.merged === true;
        return {
            ...facts,
            resultLabel: "Result",
            result: landed ? ["landed", commit].filter(Boolean).join(" ") : task.state,
            landed,
        };
    }
    // Attempts counts consecutive failures of one kind, so the attempt in play is one past it
    return { ...facts, result: `${(task.attempts ?? 0) + 1} · ${runningFor(task, now)}` };
}

// runLogText is one timeline row as the Run section's short log says it, naming the task it is about.
export function runLogText(event: RunEvent): string {
    const d = detailOf<{ taskid?: string; by?: string; note?: string; question?: string }>(event);
    const task = d?.taskid ?? "";
    switch (event.kind) {
        case "task-forwarded":
            return d?.by === "human"
                ? `you took ${task} over from the lead`
                : [`${task} handed to you`, d?.note].filter(Boolean).join(" · ");
        case "child-ask":
            return [`${task} asked`, d?.question].filter(Boolean).join(" · ");
        case "child-answered":
            return `${task} answered`;
        default:
            return task ? `${eventTitle(event)} · ${task}` : eventTitle(event);
    }
}

// runElapsedMs is how long the run has gone: the digest's settled figure once it has ended, else a clock
// read from the dag's start, so it keeps moving between digest loads.
export function runElapsedMs(dag: TaskGroup | undefined, digest: DagStatusDigest | undefined, now: number): number {
    if (digest?.next?.kind === "terminal") {
        return digest.durations?.elapsedms ?? 0;
    }
    return dag?.createdts ? Math.max(0, now - dag.createdts) : 0;
}

// questionOrder puts the questions waiting on the human first, then the lead's, each oldest first.
export function questionOrder(asks: DagAskItem[]): DagAskItem[] {
    const yours = (a: DagAskItem) => (a.owner === ASK_OWNER_USER ? 0 : 1);
    return [...asks].sort((a, b) => yours(a) - yours(b) || a.ts - b.ts);
}

export const RUN_LOG_LINES = 3;

// runLog is the newest few rows of the run's timeline, newest first.
export function runLog(events: RunEvent[], n = RUN_LOG_LINES): { id: string; ts: number; text: string }[] {
    return [...events]
        .sort((a, b) => b.ts - a.ts)
        .slice(0, n)
        .map((e) => ({ id: e.id, ts: e.ts, text: runLogText(e) }));
}
