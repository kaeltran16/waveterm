// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A run's lead card as rows: each task of its dag with what it is doing, whose turn it is, and what you can do
// from the row. A worker's question and a failed review are answered inside the row, so a run needs one card,
// not one per worker. Pure: no React, no Wave runtime.

import { formatElapsed } from "../orchestrate/dagdigest";
import { relaunchLeadAction } from "../orchestrate/relaunchlead";
import { formatTokens, type AgentVM } from "./agentsviewmodel";
import { workerNeedsYou } from "./agenttreemodel";
import { finalRowFocusId, finalStageActivity, finalStageView, type FinalTone } from "./finalstage";
import { leadLandFacts } from "./leadland";
import {
    endedPlanReviewers,
    endedReviewerId,
    endedWorkerId,
    failedWithTranscript,
    formatLeft,
    leadStandingBy,
    mergeGateLine,
    runEngineBusy,
    runFinished,
    runProgress,
    taskAgentOf,
    taskStateLabel,
    unmetDeps,
    verifyFailLine,
    workerAsk,
    type Lineage,
    type RunInfo,
} from "./runlineage";
import { finalFailedLine, finishedRunLabel, runComplete } from "./runmodel";
import { landingBranch } from "./runrail";
import { finalSlot, taskStrip, treeStripLabel, type TaskStrip } from "./runstrip";
import { detailOf, planReviewLensTitle } from "./runtimeline";
import { modelLabel } from "./session-models/sessionviewmodel";

export type RowTone = "run" | "ask" | "soft" | "warn" | "err" | "ok" | "muted" | "wait";
export type RowAction = "retry" | "skip" | "takeover" | "tell" | "resolve";

// the words of every action the card runs on a task: its buttons, and a refusal's line
export const ACTION_LABEL: Record<RowAction | "approve" | "sendback", string> = {
    retry: "Retry",
    skip: "Skip",
    takeover: "Take over",
    tell: "Tell",
    resolve: "Continue",
    approve: "Approve",
    sendback: "Send back",
};

// a failed review's choices, numbered 1–4 on the card and on the keyboard
export const REVIEW_ACTIONS = [
    ["approve", "Approve"],
    ["sendback", "Send back"],
    ["retry", "Retry"],
    ["skip", "Skip"],
] as const;

/** Pure: the actions a focused row's number keys run, in the order the card numbers them. */
export function rowKeyActions(row: Pick<TaskRowVM, "inline" | "actions">): string[] {
    return row.inline === "review" ? REVIEW_ACTIONS.map(([a]) => a) : row.actions;
}

export interface TaskRowVM {
    key: string;
    taskId: string;
    // the task's engine state; the Final row's is its stage's
    state: string;
    label: string;
    sub: string;
    tone: RowTone;
    tag?: string;
    // how long it has run, or ran; the row shows its tag instead when it has one
    age?: string;
    kind: "live" | "wait" | "done";
    // a worker's question the lead holds; the row draws "→ lead" before its tag
    toLead?: boolean;
    // a failed review's rounds: "review" with its choices, "findings" alone while the lead judges them
    inline?: "ask" | "review" | "findings";
    waitOn?: "deps" | "slot";
    needsYou: boolean;
    worker?: AgentVM;
    openId?: string;
    // what the Open button says; by default a live worker's or a done task's transcript
    openLabel?: string;
    // why the task is stuck, a line the focused row shows before its actions
    detail?: string;
    actions: RowAction[];
}

// the Final row's and the Plan review row's task ids: task ids are plan ids, never these
export const FINAL_ROW_ID = "@final";
export const PLAN_REVIEW_ROW_ID = "@planreview";
const STAGE_ROW_IDS = new Set([FINAL_ROW_ID, PLAN_REVIEW_ROW_ID]);

const FINAL_ROW_TONE: Record<FinalTone, RowTone> = { wait: "wait", run: "run", pass: "ok", fail: "err", warn: "warn" };
const FINAL_ROW_TAG: Record<FinalTone, string> = {
    wait: "waiting",
    run: "running",
    pass: "passed",
    fail: "failed",
    warn: "unverified",
};

// task states in which a cancel stops something at work: a worker, a reviewer or a merge's Verify
const CANCEL_STOPS = new Set(["running", "reviewing", "verifying"]);

export interface LeadCardVM {
    rows: TaskRowVM[];
    waiting: TaskRowVM[];
    done: TaskRowVM[];
    // rows that wait on you: a question you hold, or a judgment with no lead to make it
    askCount: number;
    // the header's words where a lead's name would be, for a run with no lead in the roster
    noLead: { text: string; title: string };
    needsYou: boolean;
    planning: boolean;
    finished: boolean;
    complete: boolean;
    // the run's task strip, the final stage's slot once the stage has a row, and their words for a screen
    // reader; none before a plan exists
    bar?: { strip: TaskStrip; final?: FinalTone; label: string };
    progress: { done: number; skipped: number; total: number };
    // what the lead is doing, and what the run has cost so far
    activity: string;
    cost: string;
    settings: string;
    // the landing branch's full name, which the settings line shortens
    settingsTitle?: string;
}

export interface LeadCardInput {
    cardId: string;
    run: RunInfo;
    lead?: AgentVM;
    roster: AgentVM[];
    lineage: Lineage;
    // the lead cannot take wakes (isLeadDown); its judgment falls to you
    leadDown: boolean;
    now: number;
    // every session of the run summed (runtokenstore); absent until loaded
    tokens?: number;
    // the run's events: the final stage's step times come from them
    events?: RunEvent[];
}

const ROW_KEY_PREFIX = "row:";

export function rowKey(cardId: string, taskId: string): string {
    return `${ROW_KEY_PREFIX}${cardId}:${taskId}`;
}

export function isRowKey(id: string | undefined): boolean {
    return id?.startsWith(ROW_KEY_PREFIX) ?? false;
}

// the card a row key belongs to; a card id is its own card. Task ids hold no ":", a leadless card's id does.
export function rowCardId(id: string): string {
    return isRowKey(id) ? id.slice(ROW_KEY_PREFIX.length, id.lastIndexOf(":")) : id;
}

// the element a cursor stop renders as: a task row by its key, a card by its id
export function stopSelector(id: string): string {
    return isRowKey(id) ? `[data-row-key="${id}"]` : `[data-agent-id="${id}"]`;
}

// the keyboard walks folded rows too, so a fold opens while the cursor is on one of its rows
export function foldOpen(open: boolean, rows: Pick<TaskRowVM, "key">[], cursorKey: string | undefined): boolean {
    return open || (cursorKey != null && rows.some((r) => r.key === cursorKey));
}

function taskRow(input: LeadCardInput, task: TaskNode): TaskRowVM {
    const { run, lineage, roster, now } = input;
    const td = run.digest?.tasks?.find((t) => t.taskid === task.id);
    // a failure the lead handed to you is yours whatever the lead's state
    const forwarded = (td?.forwardedts ?? 0) > 0;
    const judge = input.lead != null && !input.leadDown && !forwarded;
    const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" · ");
    const worker = taskAgentOf(lineage, roster, run.runId, task.id);
    // a failed task's worker tab is reaped with its tree; its session's transcript is still there to read
    const ended = worker == null && failedWithTranscript(task);
    const failedOpen = ended
        ? { openId: endedWorkerId(run.runId, task.id), openLabel: "Open transcript" }
        : { openId: worker?.id };
    const base: TaskRowVM = {
        key: rowKey(input.cardId, task.id),
        taskId: task.id,
        state: task.state,
        label: task.label || task.id,
        sub: task.id,
        tone: "run",
        kind: "live",
        age: task.firstactivity ? formatElapsed(now - task.firstactivity) : undefined,
        needsYou: false,
        worker,
        openId: worker?.id,
        actions: [],
    };
    switch (task.state) {
        case "done": {
            // the lane tip waiting to land is the merge gate: live, not landed, and the engine's to merge, whether
            // ready or held behind another task's Verify
            const gate = mergeGateLine(run, task.id);
            if (gate != null) {
                return {
                    ...base,
                    tone: "wait",
                    tag: mergeWaitTag(td?.mergegatets, now),
                    sub: join(task.id, gate),
                    openId: endedWorkerId(run.runId, task.id),
                    openLabel: "Open transcript",
                };
            }
            // done but behind its lane: it lands when the lane's tip does, so it has not landed yet
            if (td?.mergestate === "waiting") {
                const tip = laneTip(run.digest, task.id);
                return {
                    ...base,
                    kind: "wait",
                    tone: "muted",
                    age: undefined,
                    openId: undefined,
                    sub: join(task.id, "done", tip && tip !== task.id ? `lands with ${tip}` : "waiting to land"),
                };
            }
            const ranMs = run.digest?.durations?.tasks?.find((t) => t.taskid === task.id)?.runms;
            return {
                ...base,
                kind: "done",
                tone: "ok",
                age: ranMs ? formatElapsed(ranMs) : undefined,
                sub: join(task.id, "landed"),
                openId: endedWorkerId(run.runId, task.id),
            };
        }
        case "skipped":
        case "cancelled":
            return {
                ...base,
                kind: "done",
                tone: "muted",
                sub: join(task.id, task.state),
                age: undefined,
                openId: undefined,
            };
        case "review-failed":
            // the rounds show either way; the choices are yours only when no lead judges them, as a failed task's
            return {
                ...base,
                ...failedOpen,
                tone: "err",
                inline: judge ? "findings" : "review",
                needsYou: !judge,
                tag: judge ? "lead judging" : "needs you",
                sub: join(task.id, "failed review"),
            };
        case "reviewing":
            return {
                ...base,
                tone: "soft",
                tag: "reviewing",
                sub: join(task.id, `reviewer · round ${(task.reviewround ?? 0) + 1}`),
            };
        case "stalled":
        case "failed":
            return {
                ...base,
                ...failedOpen,
                tone: task.state === "stalled" ? "warn" : "err",
                sub: join(
                    task.id,
                    task.state === "stalled" ? "no output · process alive" : task.lastfailurekind || "failed"
                ),
                tag: forwarded ? "needs you" : judge ? "lead judging" : undefined,
                needsYou: forwarded,
                actions: judge ? [] : ["retry", "skip"],
            };
        case "blocked-merge":
        case "verify-failed":
            return {
                ...base,
                ...failedOpen,
                tone: "err",
                sub: join(task.id, task.state === "verify-failed" ? "Verify failed" : "merge conflict"),
                detail: verifyFailLine(task, td),
                tag: judge ? "lead fixing" : "needs you",
                needsYou: !judge,
                // fixed in the project tree first; Continue then lands it or re-runs Verify
                actions: judge ? [] : ["resolve"],
            };
        case "verifying":
            // the worker is done and its merge is under Verify: not a worker at work
            return {
                ...base,
                tone: "soft",
                tag: taskStateLabel(task, now),
                sub: join(task.id, "merged · Verify running"),
            };
        case "pending":
        case "ready": {
            // not running, even when a tab from an earlier attempt (a send-back) is still open on it, so there is
            // nothing to open: the keyboard's Enter went to that tab, which the mouse could not reach
            const waits = unmetDeps(run.dag, task) ?? [];
            const slot = td?.waitreason === "parallelism";
            return {
                ...base,
                openId: undefined,
                kind: "wait",
                tone: "wait",
                waitOn: waits.length > 0 ? "deps" : slot ? "slot" : undefined,
                tag: waitTag(waits, slot),
                sub: join(
                    task.id,
                    waits.length > 0 ? `waits on ${waits.join(", ")}` : slot ? "waiting for a slot" : "queued"
                ),
            };
        }
    }
    if (worker == null) {
        return { ...base, sub: join(task.id, "running") };
    }
    const ask = workerAsk(run.digest, task.id);
    if (ask?.owner === "lead") {
        const left = ask.deadline ? formatLeft(ask.deadline - now) : "";
        return {
            ...base,
            toLead: true,
            sub: join(task.id, "asked the lead"),
            tag: left || undefined,
            actions: ["takeover"],
        };
    }
    if (workerNeedsYou(run, task.id, worker) && worker.ask != null) {
        return { ...base, tone: "ask", tag: "asking", inline: "ask", needsYou: true, sub: join(task.id, "asks you") };
    }
    return { ...base, sub: join(task.id, worker.activity), actions: ["tell"] };
}

// the last task of a task's lane, which the lane lands with
function laneTip(digest: DagStatusDigest | undefined, taskId: string): string | undefined {
    return digest?.lanes?.find((lane) => lane.includes(taskId))?.at(-1);
}

/** Pure: what a waiting row waits for, short enough for the row's end. */
export function waitTag(deps: string[], slot: boolean): string {
    if (deps.length > 1) {
        return `after ${deps.length} tasks`;
    }
    if (deps.length === 1) {
        return `after ${deps[0]}`;
    }
    return slot ? "for a slot" : "queued";
}

/** Pure: how long a finished lane has waited to land. A gate with no clock (its done event was pruned), or one
 *  stamped ahead of this clock, shows no age rather than one from the epoch or a negative one; nor does one under a
 *  second old, which formatElapsed would floor to "0s". */
export function mergeWaitTag(mergeGateTs: number | undefined, now: number): string {
    const ms = mergeGateTs ? now - mergeGateTs : 0;
    return ms >= 1000 ? `merge waiting ${formatElapsed(ms)}` : "merge waiting";
}

/** Pure: how many tasks a cancel would stop: a worker, a reviewer or a merge's Verify at work. A failed or stalled
 *  task waits on a judgment, and the merge gate's worker has finished. */
export function runningCount(rows: Pick<TaskRowVM, "state" | "taskId">[]): number {
    return rows.filter((r) => !STAGE_ROW_IDS.has(r.taskId) && CANCEL_STOPS.has(r.state)).length;
}

/** Pure: the cancel panel's question. */
export function cancelPrompt(running: number): string {
    if (running === 0) {
        return "Cancel this run?";
    }
    return `Stop ${running} running task${running === 1 ? "" : "s"} and cancel this run?`;
}

/** Pure: the card's progress, counting a skipped task as finished but not as done. */
export function progressText(p: { done: number; skipped: number; total: number }): string {
    const done = `${p.done - p.skipped}/${p.total}`;
    return p.skipped > 0 ? `${done} · ${p.skipped} skipped` : done;
}

export interface CardError {
    msg: string;
    // a task action's refusal: the task, and its stamp when the action ran
    taskId?: string;
    stamp?: string;
}

/** Pure: a task's state and the ask it holds; a refusal about the task stands while both do. */
export function taskStamp(run: Pick<RunInfo, "dag" | "digest">, taskId: string): string {
    const state = run.dag?.tasks?.find((t) => t.id === taskId)?.state ?? "";
    const askId = run.digest?.tasks?.find((t) => t.taskid === taskId)?.askid ?? "";
    return `${state}|${askId}`;
}

/** Pure: whether the card still shows a refusal. One about a task goes once that task has moved on, since its
 *  cause has; one with no task stands until the next action. */
export function cardErrorShown(err: CardError | undefined, run: Pick<RunInfo, "dag" | "digest">): boolean {
    return err != null && (err.taskId == null || err.stamp === taskStamp(run, err.taskId));
}

/** Pure: the final stage's row on the card, from the moment the stage has one in the tree. It opens the stage
 *  pane, or the current round's verifier session once that is in the roster. A passed stage folds with the done
 *  tasks; a failed one stays out, since it is what the run waits on. */
function finalRow(input: LeadCardInput): TaskRowVM | undefined {
    const { run } = input;
    const view = finalStageView(run.dag, input.events ?? [], input.now);
    if (!view.visible) {
        return undefined;
    }
    return {
        key: rowKey(input.cardId, FINAL_ROW_ID),
        taskId: FINAL_ROW_ID,
        state: view.state,
        label: "Final verification",
        sub: view.subline,
        tone: FINAL_ROW_TONE[view.tone],
        tag: [FINAL_ROW_TAG[view.tone], view.round > 1 ? `round ${view.round}` : ""].filter(Boolean).join(" · "),
        kind: view.tone === "pass" ? "done" : "live",
        needsYou: false,
        openId: finalRowFocusId(run, input.roster),
        openLabel: "Open stage",
        actions: [],
    };
}

/** Pure: the plan review's row on the card, before the tasks it gates: what is at work while it reviews, the lead's
 *  decision once it failed, and folded with the done tasks once it passed or you accepted it. It opens the current
 *  round's newest reviewer, live in the roster or read back from its transcript. */
function planReviewRow(input: LeadCardInput): TaskRowVM | undefined {
    const { run } = input;
    const pr = run.dag?.planreview;
    if (pr == null) {
        return undefined;
    }
    const newest = (pr.reviewers ?? [])
        .filter((r) => r.runid)
        .sort((a, b) => (b.startedts ?? 0) - (a.startedts ?? 0))[0];
    const live = newest ? input.roster.find((a) => a.runId === newest.runid) : undefined;
    const ended = newest != null && endedPlanReviewers(run).includes(newest);
    const base: TaskRowVM = {
        key: rowKey(input.cardId, PLAN_REVIEW_ROW_ID),
        taskId: PLAN_REVIEW_ROW_ID,
        state: pr.state,
        label: "Plan review",
        sub: "",
        tone: "run",
        kind: "live",
        tag: pr.round > 1 ? `round ${pr.round}` : undefined,
        needsYou: false,
        openId: live?.id ?? (ended ? endedReviewerId(run.runId, newest.runid) : undefined),
        openLabel: live ? "Open reviewer" : "Open transcript",
        actions: [],
    };
    switch (pr.state) {
        case "failed":
            return { ...base, tone: "wait", sub: "failed · lead deciding" };
        case "passed":
            return { ...base, kind: "done", tone: "ok", sub: "passed" };
        case "accepted":
            return {
                ...base,
                kind: "done",
                tone: "muted",
                sub: pr.amended ? "amended by the lead" : "accepted by you",
            };
    }
    const atWork = (pr.reviewers ?? []).filter((r) => r.state === "reviewing").map((r) => planReviewLensTitle(r.lens));
    return { ...base, sub: atWork.join(", ") || "reviewing" };
}

/** Pure: a run's lead card. Rows keep plan order; live rows list first, then what waits, then what is done. The
 *  final stage's row closes the live rows, or the done ones once it passed. */
export function buildLeadCard(input: LeadCardInput): LeadCardVM {
    const { run, lead } = input;
    const dag = run.dag;
    const review = planReviewRow(input);
    const all = [...(review ? [review] : []), ...(dag?.tasks ?? []).map((t) => taskRow(input, t))];
    const final = finalRow(input);
    if (final) {
        all.push(final);
    }
    const askCount = all.filter((r) => r.needsYou).length;
    // no route means the workers inherit the lead's
    const workers = dag?.workerroute ?? run.workerRoute;
    const workerModel = modelLabel(workers?.model) || workers?.runtime || "as lead";
    const leadModel = lead ? `lead ${lead.model || lead.agent || ""}`.trim() : "no lead";
    const strip = taskStrip(dag, run.digest);
    // only a run's own tree is named: one landing straight on its base names nothing new
    const branch = run.landPath ? landingBranch(run) : undefined;
    // once landed, where it landed
    const where = leadLandFacts(run)?.branch ?? (branch ? `lands on ${branch}` : undefined);
    return {
        rows: all.filter((r) => r.kind === "live"),
        waiting: all.filter((r) => r.kind === "wait"),
        done: all.filter((r) => r.kind === "done"),
        askCount,
        noLead: run.leadStarted
            ? { text: "lead closed", title: "The run's lead has closed; its judgment events come to you" }
            : { text: "no lead", title: "A lead starts at the run's first judgment event" },
        needsYou: askCount > 0 || lead?.state === "asking",
        // no dag on a finished run means its lead did the goal itself, not that a plan is still coming
        planning: dag == null && !runFinished(run),
        finished: runFinished(run),
        complete: runComplete(run),
        bar: strip ? { strip, final: finalSlot(dag), label: treeStripLabel(dag, run.digest) } : undefined,
        progress: runProgress(dag),
        activity: leadActivity(run, lead, input.leadDown),
        cost: runCost(run.digest?.report?.workerms, input.tokens),
        settings: [`${leadModel} · workers ${workerModel}`, dag ? `${dag.parallelism} at a time` : "", where ?? ""]
            .filter(Boolean)
            .join(" · "),
        settingsTitle: where,
    };
}

export type LeadMarkTone = "success" | "accent" | "warning" | "muted" | "error";

export const LEAD_MARK_CLASS: Record<LeadMarkTone, string> = {
    success: "text-success",
    accent: "text-accent",
    warning: "text-warning",
    muted: "text-muted",
    error: "text-error",
};

/** Pure: a run's Workflow mark, on its lead card and its agent tree row: green only when the run is complete. The
 *  pulse is the lead's own work; a lead that is down or standing by while the engine works leaves the mark accent
 *  and still, so the run does not read as stopped. A lead that failed to start keeps the mark, in the error tone. */
export function leadMark(run: RunInfo, lead: AgentVM | undefined): { tone: LeadMarkTone; pulse: boolean } {
    if (runComplete(run)) {
        return { tone: "success", pulse: false };
    }
    if (lead?.startError != null) {
        return { tone: "error", pulse: false };
    }
    if (lead == null || leadStandingBy(lead, run)) {
        return { tone: runEngineBusy(run) ? "accent" : "muted", pulse: false };
    }
    if (lead.state === "working") {
        return { tone: "accent", pulse: true };
    }
    if (lead.state === "asking") {
        return { tone: "warning", pulse: true };
    }
    return { tone: "muted", pulse: false };
}

/** Pure: the flow bar under the lead card's header, a working agent card's sweep. It follows the run, not only
 *  the lead: the lead mostly stands by while the engine works, and the run is no less active for it. */
export function runFlowing(run: RunInfo, lead: AgentVM | undefined): boolean {
    if (runFinished(run)) {
        return false;
    }
    return runEngineBusy(run) || (lead?.state === "working" && !leadStandingBy(lead, run));
}

/** Pure: the lead's line on its card. A lead at its prompt while the engine runs stands by; its own activity
 *  would read as the last thing it did. */
export function leadActivity(run: RunInfo, lead: AgentVM | undefined, leadDown: boolean): string {
    if (runFinished(run)) {
        return finishedRunLabel(run);
    }
    if (lead?.startError != null) {
        return `lead failed to start · ${lead.startError}`;
    }
    if (lead?.state === "asking") {
        return "asking you";
    }
    // past its tasks, the final stage is what the run is doing
    const final = run.dag?.final;
    if (final?.state === "failed") {
        return finalFailedLine(lead != null && !leadDown);
    }
    const finalStep = finalStageActivity(final);
    if (finalStep != null) {
        return `final verification · ${finalStep}`;
    }
    const review = run.dag?.planreview;
    if (review?.state === "reviewing") {
        return `plan review · round ${review.round}`;
    }
    if (leadDown) {
        return "lead down · its events come to you";
    }
    if (lead == null) {
        return run.leadStarted ? "lead closed · its events come to you" : "engine running · no lead, none needed yet";
    }
    if (leadStandingBy(lead, run)) {
        const running =
            run.digest?.counts?.running ?? (run.dag?.tasks ?? []).filter((t) => t.state === "running").length;
        return running > 0 ? `standing by · engine running ${running} lane${running === 1 ? "" : "s"}` : "standing by";
    }
    return lead.activity || lead.state;
}

/** Pure: how long a run has gone, from its dag's creation; a finished run's from the digest, which knows when it ended. */
export function runElapsed(run: RunInfo, now: number): string {
    const ms = runFinished(run) ? run.digest?.durations?.elapsedms : run.dag?.createdts ? now - run.dag.createdts : 0;
    // a dag stamped ahead of this clock has not started by it
    return ms && ms > 0 ? formatElapsed(ms) : "";
}

/** Pure: what a run has cost so far, leaving out what is not known. */
export function runCost(workerMs: number | undefined, tokens: number | undefined): string {
    return [workerMs ? `${formatElapsed(workerMs)} worker` : "", tokens ? `${formatTokens(tokens)} tokens` : ""]
        .filter(Boolean)
        .join(" · ");
}

/** Pure: an engine run's dials (worker parallelism) can change until it finishes. */
export function runAdjustable(run: Pick<RunInfo, "dag" | "status">): boolean {
    return run.dag != null && !runFinished(run);
}

/** Pure: the lead cannot take wakes. The newest wake failure stands until a lead is launched after it. */
export function isLeadDown(events: RunEvent[]): boolean {
    const failed = events.filter((e) => e.kind === "lead-wake-failed").sort((a, b) => b.ts - a.ts)[0];
    return failed != null && relaunchLeadAction(failed, events, false) != null;
}

export interface ReviewFinding {
    round: number;
    note: string;
}

/** Pure: one task's review findings for its current attempt, oldest round first. A retry resets the round
 *  count without an event of its own, so the attempt is the newest run of strictly decreasing rounds. A reviewer
 *  that fails to finish (final, not counted) reports the round before its own, so it can repeat the round below. */
export function reviewFindings(events: RunEvent[], taskId: string): ReviewFinding[] {
    const mine = events
        .filter((e) => e.kind === "task-review-failed")
        .map((e) => ({ ts: e.ts, d: detailOf<{ taskid?: string; note?: string; round?: number; final?: boolean }>(e) }))
        .filter((x) => x.d?.taskid === taskId)
        .sort((a, b) => b.ts - a.ts);
    const out: ReviewFinding[] = [];
    for (const [i, { d }] of mine.entries()) {
        const round = d!.round ?? 0;
        const newer = out[out.length - 1];
        if (newer != null && round >= newer.round) {
            break;
        }
        // the newest event names the round it failed in, unless it is a reviewer failure repeating the last count
        const reused = i === 0 && d!.final && mine[1]?.d?.round === round;
        out.push({ round: Math.max(1, reused ? round + 1 : round), note: d!.note ?? "" });
    }
    return out.reverse();
}
