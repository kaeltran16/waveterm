// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: what the workspace pane's Run tab says about a run: its head (state, facts line, spend line, strip), the
// counts on its views, each task's dot, a row per task with its opened body, the Plan review and Final verification
// stage rows, and the questions already answered. Read from the dag, the
// digest and the run's event rows, with the rail's helpers where the two must agree about a run.

import { reportHeadline } from "@/app/view/jarvis/recordrunrow";
import { formatElapsed } from "@/app/view/orchestrate/dagdigest";
import { formatTokens, type AgentEntry } from "./agentsviewmodel";
import { shortRunId } from "./brainstormrunmodel";
import { finalStageView, type FinalStageView } from "./finalstage";
import { fmtClock } from "./runcompletion";
import { formatLeft, runFinished, taskStateLabel, workerAsk, type RunInfo } from "./runlineage";
import { runStatusView } from "./runmodel";
import { runElapsedMs } from "./runrail";
import { STRIP_MAX } from "./runstrip";
import { detailOf } from "./runtimeline";
import { summarizeUsage } from "./runusage";
import { layoutTranscript, type LayoutItem, type Step } from "./transcriptlayout";
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

export type AskAnswerer = "you" | "the lead";

export interface AnsweredAsk {
    // the question's event row
    key: string;
    question: string;
    answeredTs: number;
    by: AskAnswerer;
}

// answeredAsks pairs each worker question with the answer that followed it on the same task, by task, oldest first.
// child-answered does not record who answered: a task-forwarded between the two (a lead forward or a take-over) put
// the question with you, else the lead answered it. A question with no answer yet is still open, and not listed.
export function answeredAsks(events: RunEvent[]): Record<string, AnsweredAsk[]> {
    const sorted = [...events].sort((a, b) => a.ts - b.ts);
    const open = new Map<string, { key: string; question: string; forwarded: boolean }>();
    const out: Record<string, AnsweredAsk[]> = {};
    for (const e of sorted) {
        const d = detailOf<{ taskid?: string; question?: string }>(e);
        const taskId = d?.taskid;
        if (!taskId) {
            continue;
        }
        const asked = open.get(taskId);
        if (e.kind === "child-ask") {
            open.set(taskId, { key: e.id, question: d.question ?? "", forwarded: false });
        } else if (e.kind === "task-forwarded" && asked) {
            asked.forwarded = true;
        } else if (e.kind === "child-answered" && asked) {
            open.delete(taskId);
            const by: AskAnswerer = asked.forwarded ? "you" : "the lead";
            (out[taskId] ??= []).push({ key: asked.key, question: asked.question, answeredTs: e.ts, by });
        }
    }
    return out;
}

export interface LeadAskView {
    // "t-3 asked the lead"
    who: string;
    // "lead is answering · 2m left", without the countdown when the ask has no deadline
    when: string;
    // the options read-only, joined
    questions: { header: string; question: string; options: string }[];
    // "the lead answers in 2m unless you take over"
    until: string;
}

// leadAskView is a question the lead holds, as its task's row draws it
export function leadAskView(ask: DagAskItem, now: number): LeadAskView {
    const left = ask.deadline ? formatLeft(Math.max(0, ask.deadline - now)) : "";
    return {
        who: `${ask.taskid} asked the lead`,
        when: ["lead is answering", left].filter(Boolean).join(" · "),
        questions: (ask.questions ?? []).map((q) => ({
            header: q.header ?? "",
            question: q.question,
            options: (q.options ?? []).map((o) => o.label).join(" · "),
        })),
        until: left
            ? `the lead answers in ${left.replace(/ left$/, "")} unless you take over`
            : "the lead answers unless you take over",
    };
}

// latestSteps is the last n steps of a worker's transcript, oldest first, as the transcript's step rows lay them out
export function latestSteps(entries: AgentEntry[], n: number): Step[] {
    const stepsOf = (items: LayoutItem[]): Step[] =>
        items.flatMap((i) =>
            i.kind === "steps" ? i.steps : i.kind === "card" ? [i.step] : i.kind === "turn" ? stepsOf(i.items) : []
        );
    return stepsOf(layoutTranscript(entries, { active: true })).slice(-n);
}

export interface RunTabCounts {
    tasks: number;
    activity: number;
}

// the views' counts: Tasks the dag's tasks, Activity every event row
export function runTabCounts(run: RunInfo, events: RunEvent[]): RunTabCounts {
    return { tasks: run.dag?.tasks?.length ?? 0, activity: events.length };
}

// a task's worker run's sealed evidence, by task id; a task still working has none yet
export type TaskEvidence = Record<string, RunEvidence | undefined>;

export interface TaskRowView {
    id: string;
    name: string;
    // the task's id beside its label; empty when the label is the id
    sub: string;
    dot: RowDot;
    // the engine's word; "" on a merged or plainly running row, whose dot says it
    state: string;
    time: string;
    // the worker run's diff, when it changed anything
    adds?: number;
    dels?: number;
}

function taskState(task: TaskNode, byId: Map<string, TaskNode>, digest: DagStatusDigest | undefined, now: number) {
    if (task.merged && task.state !== "verifying") {
        return "";
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
    // the canvas times a Verify in seconds, which taskStateLabel's minutes would read as <1m
    if (task.state === "verifying" && task.verifystartedts) {
        return `verifying ${formatElapsed(Math.max(0, now - task.verifystartedts))}`;
    }
    return taskStateLabel(task, now) ?? (task.state === "running" ? "" : task.state);
}

// how long the task ran: the digest's figure once it has one, else the clock since its worker spawned; a task not
// started has no time
function taskTime(task: TaskNode, digest: DagStatusDigest | undefined, now: number): string {
    if (NOT_STARTED.has(task.state)) {
        return "";
    }
    const runMs = digest?.durations?.tasks?.find((d) => d.taskid === task.id)?.runms;
    if (runMs) {
        return formatElapsed(runMs);
    }
    if (task.spawnedts) {
        return formatElapsed(Math.max(0, now - task.spawnedts));
    }
    return NO_TIME;
}

// taskRows is the Tasks view: one row per task in plan order, with the tab's own dots
export function taskRows(
    dag: TaskGroup | undefined,
    digest: DagStatusDigest | undefined,
    now: number,
    evidence: TaskEvidence = {}
): TaskRowView[] {
    const tasks = dag?.tasks ?? [];
    const dots = taskDots(dag, digest);
    const byId = new Map(tasks.map((t) => [t.id, t] as const));
    return tasks.map((t) => {
        const ev = evidence[t.id];
        const diff = ev && (ev.addtotal > 0 || ev.deltotal > 0) ? { adds: ev.addtotal, dels: ev.deltotal } : {};
        return {
            id: t.id,
            name: t.label || t.id,
            sub: t.label ? t.id : "",
            dot: dots[t.id],
            state: taskState(t, byId, digest, now),
            time: taskTime(t, digest, now),
            ...diff,
        };
    });
}

export interface StageRowView {
    label: string;
    dot: RowDot;
    word: string;
    time: string;
}

const PLAN_REVIEW_DOT: Record<string, RowDot> = {
    passed: "merged",
    accepted: "merged",
    reviewing: "working",
    failed: "failed",
};

// planReviewRow is the stage row above the tasks; a dag with no plan review has none
export function planReviewRow(dag: TaskGroup | undefined): StageRowView | null {
    const review = dag?.planreview;
    if (review == null) {
        return null;
    }
    return { label: "Plan review", dot: PLAN_REVIEW_DOT[review.state] ?? "waits", word: review.state, time: "" };
}

const FINAL_RUNNING = new Set(["checking", "final", "verifying"]);
const FINAL_WAITS = "waits for every task";

function finalWord(stage: FinalStage | undefined, view: FinalStageView): string {
    const state = stage?.state ?? "";
    if (state === "") {
        return FINAL_WAITS;
    }
    if (state === "passed") {
        const n = stage.shots?.length ?? 0;
        return n > 0 ? `passed · ${n} scenarios` : "passed";
    }
    if (FINAL_RUNNING.has(state)) {
        return view.steps.find((s) => s.key === view.running)?.label ?? state;
    }
    return state;
}

function finalDot(state: string): RowDot {
    if (state === "passed") {
        return "merged";
    }
    if (FINAL_RUNNING.has(state)) {
        return "working";
    }
    return state === "" ? "waits" : "failed";
}

// finalRow is the stage row under the tasks, in the tab's own words (finalStageView's stay for its other callers)
export function finalRow(dag: TaskGroup | undefined, events: RunEvent[], now: number): StageRowView | null {
    if (!dag?.tasks?.length) {
        return null;
    }
    const view = finalStageView(dag, events, now);
    const state = dag.final?.state ?? "";
    return {
        label: "Final verification",
        dot: finalDot(state),
        word: finalWord(dag.final, view),
        time: state !== "" && view.stageMs ? formatElapsed(view.stageMs) : "",
    };
}

export interface TaskBodyView {
    // the body's first line: the report's headline, the state's sentence, or a waiting task's description
    lead: string;
    // a merged task's running Verify
    ran?: { command: string; time: string; lastLine?: string };
    files: EvidenceFile[];
    // its answered questions, oldest first: "asked · answered by the lead 16:19" and the question
    asked: { key: string; line: string; question: string }[];
    // "reviewer started 30s ago" while a reviewer judges it
    reviewer: string;
    // "review passed · merged 16:20" once merged
    merged: string;
    // a failed task's output
    failure: string;
    // a failed task in a live run waits on the lead
    deciding: boolean;
    // "depends on t-3, t-4", "· waits for a free worker" when the cap holds it
    depends: string;
    // the first evidence file, for Open changes; null with none
    changes: string | null;
}

export interface TaskBodyContext {
    dag: TaskGroup | undefined;
    digest: DagStatusDigest | undefined;
    evidence: TaskEvidence;
    events: RunEvent[];
    now: number;
    live: boolean;
}

const VERIFYING_LEAD = "Merged. The plan's Verify is running in the project checkout.";
const REVIEWING_LEAD = "Finished with a commit. A reviewer is judging it against the task and the spec.";
const MERGED_LEAD = "Merged.";
const FREE_WORKER = "waits for a free worker";

function taskEvents(events: RunEvent[], taskId: string, kind: string): RunEvent[] {
    return events.filter((e) => e.kind === kind && detailOf<{ taskid?: string }>(e)?.taskid === taskId);
}

// "review passed · merged HH:MM" from the task's last merge, "" with none
function mergedLine(events: RunEvent[], taskId: string): string {
    const merges = taskEvents(events, taskId, "task-merged");
    if (merges.length === 0) {
        return "";
    }
    const at = Math.max(...merges.map((e) => e.ts));
    const reviewed = taskEvents(events, taskId, "task-review-passed").some((e) => e.ts <= at);
    return [reviewed ? "review passed" : "", `merged ${fmtClock(at)}`].filter(Boolean).join(" · ");
}

function dependsLine(task: TaskNode, td: DagTaskDigest | undefined): string {
    const deps = task.deps ?? [];
    return [deps.length > 0 ? `depends on ${deps.join(", ")}` : "", td?.waitreason === "parallelism" ? FREE_WORKER : ""]
        .filter(Boolean)
        .join(" · ");
}

function bodyLead(task: TaskNode, ev: RunEvidence | undefined): string {
    if (task.state === "verifying") {
        return VERIFYING_LEAD;
    }
    if (task.state === "reviewing") {
        return REVIEWING_LEAD;
    }
    if (NOT_STARTED.has(task.state)) {
        return task.description?.split("\n")[0].trim() ?? "";
    }
    const headline = ev?.summary ? reportHeadline(ev.summary) : null;
    if (task.merged) {
        return headline ?? MERGED_LEAD;
    }
    return task.state === "done" ? (headline ?? "") : "";
}

// taskBody is what a task's opened row says, by its state
export function taskBody(task: TaskNode, ctx: TaskBodyContext): TaskBodyView {
    const ev = ctx.evidence[task.id];
    const td = ctx.digest?.tasks?.find((t) => t.taskid === task.id);
    const verifying = task.state === "verifying";
    const verifySince = task.verifystartedts ?? td?.verifystartedts;
    const failed = FAILED_STATES.has(task.state);
    const files = ev?.files ?? [];
    return {
        lead: bodyLead(task, ev),
        ran: verifying
            ? {
                  command: ctx.dag?.verify ?? "",
                  time: verifySince ? formatElapsed(Math.max(0, ctx.now - verifySince)) : "",
                  ...(td?.verifylastline ? { lastLine: td.verifylastline } : {}),
              }
            : undefined,
        files,
        asked: (answeredAsks(ctx.events)[task.id] ?? []).map((a) => ({
            key: a.key,
            line: `asked · answered by ${a.by} ${fmtClock(a.answeredTs)}`,
            question: a.question,
        })),
        reviewer:
            task.state === "reviewing" && task.reviewspawnedts
                ? `reviewer started ${formatElapsed(Math.max(0, ctx.now - task.reviewspawnedts))} ago`
                : "",
        merged: task.merged && !verifying ? mergedLine(ctx.events, task.id) : "",
        failure: failed ? task.verifyoutput || task.verifyerror || task.mergeerror || "" : "",
        deciding: failed && ctx.live,
        depends: NOT_STARTED.has(task.state) ? dependsLine(task, td) : "",
        changes: files[0]?.path ?? null,
    };
}
