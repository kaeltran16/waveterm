// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: what each lead action call (wsh jarvis dag answer, tell, amend, retry, forward, escalate, merge, skip,
// sendback) shows as a card, from its argv and the run's events. No React, no Wave runtime.

import type { AgentActionEntry } from "./agentsviewmodel";
import { detailOf } from "./runtimeline";
import type { TranscriptContext } from "./transcriptcontext";
import type { WshCall, WshCardKey } from "./wshcall";

export type DagActionIcon = "tell" | "amend" | "retry" | "escalate" | "merge" | "skip" | "sendback";

// a one-line action: icon, verb, task id, then its text
export interface DagActionRow {
    kind: "row";
    icon: DagActionIcon;
    taskId: string;
    text?: string;
    // the text is what the lead typed, so the row quotes it
    quoted?: boolean;
    // a merge run again after the human's conflict fix
    continued?: boolean;
    model?: string;
    runtime?: string;
}

export interface DagForwardCard {
    kind: "forward";
    taskId: string;
    note?: string;
}

export interface DagAnswerOption {
    label: string;
    description?: string;
    picked: boolean;
}

// an answer the options cannot show: indexes that name no known option, or free text
export type DagExtraAnswer = { picked: number[] } | { text: string };

export interface DagAnswerCard {
    kind: "answer";
    taskId: string;
    label?: string;
    header?: string;
    question?: string;
    options: DagAnswerOption[];
    extra: DagExtraAnswer[];
}

export type DagActionModel = DagActionRow | DagForwardCard | DagAnswerCard;

interface AskDetail {
    taskid?: string;
    label?: string;
    header?: string;
    question?: string;
    options?: { label?: string; description?: string }[];
}

interface EscalatedDetail {
    taskid?: string;
    model?: string;
    runtime?: string;
}

const ASK_EVENT = "child-ask";
const ESCALATED_EVENT = "task-escalated";

const ROW_ICONS: Partial<Record<WshCardKey, DagActionIcon>> = {
    "dag-tell": "tell",
    "dag-amend": "amend",
    "dag-retry": "retry",
    "dag-escalate": "escalate",
    "dag-merge": "merge",
    "dag-skip": "skip",
    "dag-sendback": "sendback",
};

function flagText(call: WshCall, name: string): string | undefined {
    const v = call.flags[name];
    return typeof v === "string" && v !== "" ? v : undefined;
}

// the channel and run a dag call acted on: its own flags, else the host's lead run (a worker's host knows its lead)
export function dagRunIds(call: WshCall, ctx: TranscriptContext): { channelId?: string; runId?: string } {
    const channelId = flagText(call, "channel") ?? ctx.channelId;
    const runId =
        flagText(call, "runid") ??
        (ctx.role?.kind === "lead" ? ctx.role.runId : ctx.role != null ? ctx.role.leadRunId : undefined);
    const ids: { channelId?: string; runId?: string } = {};
    if (channelId) {
        ids.channelId = channelId;
    }
    if (runId) {
        ids.runId = runId;
    }
    return ids;
}

// picks the ask's options cannot name: 0-based, as the answer's json and `dag asks` number them
export function pickedLabel(picked: number[]): string {
    return `Picked ${picked.length === 1 ? "option" : "options"} ${picked.join(", ")}`;
}

function rowsOfKind<T extends { taskid?: string }>(events: RunEvent[], kind: string, taskId: string) {
    return events
        .filter((e) => e.kind === kind)
        .map((e) => ({ ts: e.ts, detail: detailOf<T>(e) }))
        .filter((r) => r.detail?.taskid === taskId);
}

// the engine's row for an escalation: the one nearest the call in time (the newest when the call has no time)
function escalatedRow(events: RunEvent[], taskId: string, ts: number | undefined): EscalatedDetail | undefined {
    const rows = rowsOfKind<EscalatedDetail>(events, ESCALATED_EVENT, taskId);
    const distance = (r: { ts: number }) => (ts == null ? -r.ts : Math.abs(r.ts - ts));
    return rows.sort((a, b) => distance(a) - distance(b))[0]?.detail;
}

// the question a lead answered: the task's latest child-ask at or before the call (the newest when it has no time)
function askRow(events: RunEvent[], taskId: string, ts: number | undefined): AskDetail | undefined {
    const rows = rowsOfKind<AskDetail>(events, ASK_EVENT, taskId).filter((r) => ts == null || r.ts <= ts);
    return rows.sort((a, b) => b.ts - a.ts)[0]?.detail;
}

function parseAnswers(raw: string | undefined): AgentAnswerItem[] {
    try {
        const parsed = JSON.parse(raw ?? "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function answerCardOf(taskId: string, answersJson: string | undefined, ask: AskDetail | undefined): DagAnswerCard {
    const answers = parseAnswers(answersJson);
    const known = (ask?.options ?? []).filter((o) => typeof o.label === "string");
    const first = new Set(answers[0]?.selectedindexes ?? []);
    const options = known.map((o, i) => ({
        label: o.label as string,
        ...(o.description ? { description: o.description } : {}),
        picked: first.has(i),
    }));
    const extra: DagExtraAnswer[] = [];
    answers.forEach((a, i) => {
        const unmatched = (a.selectedindexes ?? []).filter((n) => i > 0 || n >= known.length || n < 0);
        if (unmatched.length > 0) {
            extra.push({ picked: unmatched });
        }
        if (a.text) {
            extra.push({ text: a.text });
        }
    });
    const card: DagAnswerCard = { kind: "answer", taskId, options, extra };
    for (const field of ["label", "header", "question"] as const) {
        if (ask?.[field]) {
            card[field] = ask[field];
        }
    }
    return card;
}

// events: the run's events, newest first or not (the picks sort them)
export function dagActionOf(
    key: WshCardKey,
    call: WshCall,
    action: AgentActionEntry,
    events: RunEvent[]
): DagActionModel {
    const [taskId = "", text] = call.args;
    if (key === "dag-answer") {
        return answerCardOf(taskId, text, askRow(events, taskId, action.ts));
    }
    if (key === "dag-forward") {
        return { kind: "forward", taskId, ...(text ? { note: text } : {}) };
    }
    const row: DagActionRow = { kind: "row", icon: ROW_ICONS[key] ?? "tell", taskId };
    if (key === "dag-tell") {
        row.quoted = true;
    }
    if ((key === "dag-tell" || key === "dag-amend" || key === "dag-sendback") && text) {
        row.text = text;
    }
    if (key === "dag-merge" && call.flags.continue === true) {
        row.continued = true;
    }
    if (key === "dag-escalate") {
        const engine = escalatedRow(events, taskId, action.ts);
        const model = engine?.model ?? flagText(call, "model");
        const runtime = engine?.model ? engine.runtime : flagText(call, "runtime");
        if (model) {
            row.model = model;
        }
        if (runtime) {
            row.runtime = runtime;
        }
    }
    return row;
}
