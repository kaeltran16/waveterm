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
import {
    endedWorkerId,
    formatLeft,
    laneLabel,
    leadStandingBy,
    runFinished,
    runProgress,
    taskAgentOf,
    unmetDeps,
    workerAsk,
    type Lineage,
    type RunInfo,
} from "./runlineage";
import { detailOf } from "./runtimeline";
import { modelLabel } from "./session-models/sessionviewmodel";

export type RowTone = "run" | "ask" | "soft" | "warn" | "err" | "ok" | "muted" | "wait";
export type RowAction = "retry" | "skip" | "takeover" | "tell" | "resolve";

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
    label: string;
    sub: string;
    tone: RowTone;
    tag?: string;
    kind: "live" | "wait" | "done";
    inline?: "ask" | "review";
    waitOn?: "deps" | "slot";
    needsYou: boolean;
    worker?: AgentVM;
    openId?: string;
    actions: RowAction[];
}

export interface LeadCardVM {
    rows: TaskRowVM[];
    waiting: TaskRowVM[];
    done: TaskRowVM[];
    segs: RowTone[];
    askCount: number;
    needsYou: boolean;
    planning: boolean;
    finished: boolean;
    progress: { done: number; total: number };
    // what the lead is doing, and what the run has cost so far
    activity: string;
    cost: string;
    settings: string;
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
    // the workers' transcripts summed (runtokenstore); absent until loaded
    tokens?: number;
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
    const judge = input.lead != null && !input.leadDown;
    const lane = laneLabel(run.digest, task.id);
    const laneText = lane ? `lane ${lane}` : "";
    const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" · ");
    const worker = taskAgentOf(lineage, roster, run.runId, task.id);
    const base: TaskRowVM = {
        key: rowKey(input.cardId, task.id),
        taskId: task.id,
        label: task.label || task.id,
        sub: join(task.id, laneText),
        tone: "run",
        kind: "live",
        needsYou: false,
        worker,
        openId: worker?.id,
        actions: [],
    };
    switch (task.state) {
        case "done":
            return {
                ...base,
                kind: "done",
                tone: "ok",
                sub: join(task.id, laneText, "landed"),
                openId: endedWorkerId(run.runId, task.id),
            };
        case "skipped":
        case "cancelled":
            return {
                ...base,
                kind: "done",
                tone: "muted",
                sub: join(task.id, laneText, task.state),
                openId: undefined,
            };
        case "review-failed":
            return {
                ...base,
                tone: "err",
                inline: "review",
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
                tone: task.state === "stalled" ? "warn" : "err",
                sub: join(
                    task.id,
                    laneText,
                    task.state === "stalled" ? "no output · process alive" : task.lastfailurekind || "failed"
                ),
                tag: judge ? "lead judging" : undefined,
                actions: judge ? [] : ["retry", "skip"],
            };
        case "blocked-merge":
        case "verify-failed":
            return {
                ...base,
                tone: "err",
                sub: join(task.id, laneText, task.state === "verify-failed" ? "Verify failed" : "merge conflict"),
                tag: judge ? "lead fixing" : "needs you",
                needsYou: !judge,
                // fixed in the project tree first; Continue then lands it or re-runs Verify
                actions: judge ? [] : ["resolve"],
            };
        case "verifying":
            return { ...base, sub: join(task.id, laneText, "verifying") };
        case "pending":
        case "ready": {
            // not running, even when a tab from an earlier attempt (a send-back) is still open on it
            const waits = unmetDeps(run.dag, task) ?? [];
            const slot = run.digest?.tasks?.find((t) => t.taskid === task.id)?.waitreason === "parallelism";
            return {
                ...base,
                kind: "wait",
                tone: "wait",
                waitOn: waits.length > 0 ? "deps" : slot ? "slot" : undefined,
                sub: join(
                    task.id,
                    waits.length > 0 ? `waits on ${waits.join(", ")}` : slot ? "waiting for a slot" : "queued"
                ),
            };
        }
    }
    if (worker == null) {
        return { ...base, sub: join(task.id, laneText, "running") };
    }
    const ask = workerAsk(run.digest, task.id);
    if (ask?.owner === "lead") {
        const left = ask.deadline ? formatLeft(ask.deadline - now) : "";
        return { ...base, sub: join(task.id, "asked the lead"), tag: join("→ lead", left), actions: ["takeover"] };
    }
    if (workerNeedsYou(run, task.id, worker) && worker.ask != null) {
        return { ...base, tone: "ask", tag: "asking", inline: "ask", needsYou: true, sub: join(task.id, "asks you") };
    }
    return { ...base, sub: join(task.id, laneText, worker.activity), actions: ["tell"] };
}

/** Pure: the waiting fold's label, counting what its rows wait on. */
export function waitLabel(waiting: Pick<TaskRowVM, "waitOn">[]): string {
    const deps = waiting.filter((r) => r.waitOn === "deps").length;
    const slot = waiting.filter((r) => r.waitOn === "slot").length;
    return [`${waiting.length} waiting`, deps ? `${deps} on dependencies` : "", slot ? `${slot} for a slot` : ""]
        .filter(Boolean)
        .join(" · ");
}

/** Pure: a run's lead card. Rows keep plan order; live rows list first, then what waits, then what is done. */
export function buildLeadCard(input: LeadCardInput): LeadCardVM {
    const { run, lead } = input;
    const dag = run.dag;
    const all = (dag?.tasks ?? []).map((t) => taskRow(input, t));
    const askCount = all.filter((r) => r.needsYou).length;
    const workers = dag?.workerroute;
    const workerModel = modelLabel(workers?.model) || workers?.runtime || "default";
    const leadModel = lead ? `lead ${lead.model || lead.agent || ""}`.trim() : "no lead";
    return {
        rows: all.filter((r) => r.kind === "live"),
        waiting: all.filter((r) => r.kind === "wait"),
        done: all.filter((r) => r.kind === "done"),
        segs: all.map((r) => r.tone),
        askCount,
        needsYou: askCount > 0 || lead?.state === "asking",
        planning: dag == null,
        finished: dag != null && runFinished(run),
        progress: runProgress(dag),
        activity: leadActivity(run, lead, input.leadDown),
        cost: runCost(run.digest?.report?.workerms, input.tokens),
        settings: [
            `${leadModel} · workers ${workerModel} · ×${dag?.parallelism ?? "?"}`,
            run.landPath ? `lands on wave/${run.runId.slice(0, 8)}` : "",
        ]
            .filter(Boolean)
            .join(" · "),
    };
}

/** Pure: the lead's line on its card. A lead at its prompt while the engine runs stands by; its own activity
 *  would read as the last thing it did. */
export function leadActivity(run: RunInfo, lead: AgentVM | undefined, leadDown: boolean): string {
    if (runFinished(run)) {
        return `run ${run.dag?.status ?? run.status}`;
    }
    if (leadDown) {
        return "lead down · its events come to you";
    }
    if (lead == null) {
        return "engine running · a lead starts at the first judgment event";
    }
    if (leadStandingBy(lead, run)) {
        const running =
            run.digest?.counts?.running ?? (run.dag?.tasks ?? []).filter((t) => t.state === "running").length;
        return running > 0 ? `standing by · engine running ${running} lane${running === 1 ? "" : "s"}` : "standing by";
    }
    return lead.activity || lead.state;
}

/** Pure: what a run has cost so far, leaving out what is not known. */
export function runCost(workerMs: number | undefined, tokens: number | undefined): string {
    return [workerMs ? `${formatElapsed(workerMs)} worker` : "", tokens ? `${formatTokens(tokens)} tokens` : ""]
        .filter(Boolean)
        .join(" · ");
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
