// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: what the workspace pane's Task tab says about a finished task: its head, the plan's brief, what it asked the
// lead, its review rounds, the plan's Verify at its merge and its own sealed changes. Read from the lead's dag and
// digest, the task's worker run, the run's usage rows and its event rows.

import { formatTokens } from "./agentsviewmodel";
import { prettyModel } from "./modellabel";
import { fmtClock, fmtDuration } from "./runcompletion";
import { detailOf } from "./runtimeline";
import { summarizeUsage } from "./runusage";
import { formatDuration } from "./tooldetail";
import { usd } from "./usagestats";
import { taskDots, type RowDot } from "./workspaceruntabmodel";

const SHORT_COMMIT = 7;
// the key of the one review card the task's own verdict gives when no review event was recorded
const VERDICT_KEY = "verdict";

export interface TaskTabInput {
    task: TaskNode;
    dag: TaskGroup;
    digest?: DagStatusDigest;
    // the task's worker run
    child?: Run;
    usage?: UsageRow[];
    events: RunEvent[];
}

export interface TaskAskView {
    key: string;
    question: string;
    // null while unanswered
    answer: string | null;
    // "lead 14:47", who answered and when; "" while unanswered
    meta: string;
}

export interface TaskReviewView {
    key: string;
    round: number;
    passed: boolean;
    // the verdict's clock time; "" when only the task's own verdict is known
    time: string;
    note: string;
}

export interface TaskTabView {
    title: string;
    state: { word: string; dot: RowDot };
    // "t-4 · 2 attempts · 6m 12s · Opus 5.5 · 412k tokens · ~$0.74 · 9d2e4b1", each part only when known
    meta: string;
    // links: "waits on t-1 · then t-7", each half only when not empty
    brief: { text: string; links: string };
    asked: TaskAskView[];
    // newest first
    review: TaskReviewView[];
    // null with no Verify in the plan; result null when none ran at the task's merge
    verify: { command: string; result: { ok: boolean; text: string } | null } | null;
    changes: { files: string; adds: number; dels: number } | null;
}

type EventDetail = {
    taskid?: string;
    askid?: string;
    question?: string;
    answer?: string;
    note?: string;
    round?: number;
    batch?: string[];
    reason?: string;
    ms?: number;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function sentence(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function metaLine({ task, digest, child, usage }: TaskTabInput): string {
    const runMs = digest?.durations?.tasks?.find((d) => d.taskid === task.id)?.runms || child?.evidence?.runtimems || 0;
    const model = child?.model || task.runspec?.model;
    const spent = summarizeUsage(usage, task.id);
    return [
        task.id,
        task.attempts ? plural(task.attempts, "attempt") : "",
        runMs > 0 ? fmtDuration(runMs) : "",
        model ? prettyModel(model) : "",
        spent ? `${formatTokens(spent.total)} tokens` : "",
        spent?.estimateUsd != null ? `~${usd(spent.estimateUsd)}` : "",
        child?.endcommit ? child.endcommit.slice(0, SHORT_COMMIT) : "",
    ]
        .filter(Boolean)
        .join(" · ");
}

function briefLinks(task: TaskNode, dag: TaskGroup): string {
    const deps = task.deps ?? [];
    const then = dag.tasks.filter((t) => t.deps?.includes(task.id)).map((t) => t.id);
    return [deps.length > 0 ? `waits on ${deps.join(", ")}` : "", then.length > 0 ? `then ${then.join(", ")}` : ""]
        .filter(Boolean)
        .join(" · ");
}

function ownEvents(events: RunEvent[], taskId: string): { e: RunEvent; d: EventDetail }[] {
    return [...events]
        .sort((a, b) => a.ts - b.ts)
        .map((e) => ({ e, d: detailOf<EventDetail>(e) ?? {} }))
        .filter(({ d }) => d.taskid === taskId || d.batch?.includes(taskId));
}

// a task-forwarded between the question and its answer put it with you, else the lead answered it
function askedLead(own: { e: RunEvent; d: EventDetail }[]): TaskAskView[] {
    return own
        .filter(({ e, d }) => e.kind === "child-ask" && d.askid)
        .map(({ e: ask, d }) => {
            const answered = own.find(({ e, d: a }) => e.kind === "child-answered" && a.askid === d.askid);
            if (answered == null) {
                return { key: ask.id, question: d.question ?? "", answer: null, meta: "" };
            }
            const forwarded = own.some(
                ({ e }) => e.kind === "task-forwarded" && e.ts >= ask.ts && e.ts <= answered.e.ts
            );
            return {
                key: ask.id,
                question: d.question ?? "",
                answer: answered.d.answer ?? "",
                meta: `${forwarded ? "you" : "lead"} ${fmtClock(answered.e.ts)}`,
            };
        });
}

// only a failed review records its round, so a pass is one round past the failures before it
function reviewRounds(task: TaskNode, own: { e: RunEvent; d: EventDetail }[]): TaskReviewView[] {
    const cards: TaskReviewView[] = [];
    let failed = 0;
    for (const { e, d } of own) {
        if (e.kind !== "task-review-failed" && e.kind !== "task-review-passed") {
            continue;
        }
        const passed = e.kind === "task-review-passed";
        if (!passed) {
            failed++;
        }
        const round = passed ? failed + 1 : (d.round ?? failed);
        cards.push({ key: e.id, round, passed, time: fmtClock(e.ts), note: d.note ?? "" });
    }
    if (cards.length > 0) {
        return cards.reverse();
    }
    if (!task.reviewverdict) {
        return [];
    }
    // reviewround counts the failed reviews
    const passed = task.reviewverdict === "pass";
    const round = passed ? (task.reviewround ?? 0) + 1 : Math.max(1, task.reviewround ?? 0);
    return [{ key: VERDICT_KEY, round, passed, time: "", note: task.reviewnote ?? "" }];
}

function verifyAtMerge(dag: TaskGroup, own: { e: RunEvent; d: EventDetail }[]): TaskTabView["verify"] {
    if (!dag.verify) {
        return null;
    }
    const last = own.filter(({ e }) => e.kind === "task-verify-passed" || e.kind === "task-verify-failed").at(-1);
    if (last == null) {
        return { command: dag.verify, result: null };
    }
    if (last.e.kind === "task-verify-failed") {
        return { command: dag.verify, result: { ok: false, text: last.d.reason || "failed" } };
    }
    const text = last.d.ms != null ? `ok · ${formatDuration(last.d.ms)}` : "ok";
    return { command: dag.verify, result: { ok: true, text } };
}

export function taskTabView(input: TaskTabInput): TaskTabView {
    const { task, dag, digest, child, events } = input;
    const own = ownEvents(events, task.id);
    const ev = child?.evidence;
    return {
        title: task.label || task.id,
        state: {
            word: task.merged ? "Merged" : sentence(task.state),
            dot: taskDots(dag, digest)[task.id] ?? "waits",
        },
        meta: metaLine(input),
        brief: { text: task.description ?? "", links: briefLinks(task, dag) },
        asked: askedLead(own),
        review: reviewRounds(task, own),
        verify: verifyAtMerge(dag, own),
        changes: ev ? { files: plural(ev.files?.length ?? 0, "file"), adds: ev.addtotal, dels: ev.deltotal } : null,
    };
}
