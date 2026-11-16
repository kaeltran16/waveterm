// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: how a transcript lays out. Tool actions become steps; a maximal run of steps is a stretch, broken by prose,
// user entries, events and change cards; a finished turn's long stretch folds into "Worked for N"; a wsh change call
// that succeeded leaves the stretch as a standalone card; Arc's own messages become arc items. No React.

import { CollapseRunThreshold, type AgentActionEntry, type AgentEntry } from "./agentsviewmodel";
import { arcMessageOf, type ArcMessage } from "./arcmessage";
import type { TranscriptContext } from "./transcriptcontext";
import { firstWshCall, isCardKey, type WshCall, type WshKey } from "./wshcall";

export interface Step {
    index: number;
    action: AgentActionEntry;
    wsh: { call: WshCall; key: WshKey } | null;
    status: "ok" | "fail" | "running" | "stopped";
}

export interface FoldSummary {
    durationMs?: number;
    phrase: string;
    adds: number;
    dels: number;
    failed: number;
}

export type LayoutItem =
    | { kind: "message"; text: string; index: number; latest: boolean }
    | { kind: "user"; text: string; index: number }
    | { kind: "command"; name: string; args?: string; isSkill?: boolean; index: number }
    | { kind: "compaction"; trigger?: string; preTokens?: number; postTokens?: number; summary?: string; index: number }
    | { kind: "notification"; summary: string; status?: string; result?: string; index: number }
    | { kind: "interrupted"; index: number }
    | { kind: "arc"; index: number; message: ArcMessage; ts?: number; idleMs?: number }
    | { kind: "steps"; startIndex: number; steps: Step[]; fold: FoldSummary | null }
    | { kind: "card"; index: number; step: Step };

// the entry's own time: a record's ts, or an action's tool_use time
function entryTime(e: AgentEntry | undefined): number | undefined {
    if (e == null) {
        return undefined;
    }
    if (e.kind === "action") {
        return e.ts ?? e.startedTs;
    }
    return "ts" in e ? e.ts : undefined;
}

// the raw Bash command: recorded at tool_use, else the one the result carried
export function actionCommand(a: AgentActionEntry): string | undefined {
    return a.command ?? (a.detail?.kind === "bash" ? a.detail.command : undefined);
}

function stepStatus(a: AgentActionEntry, interruptedLater: boolean): Step["status"] {
    if (a.pending) {
        return interruptedLater ? "stopped" : "running";
    }
    if (a.outcome === "fail" || (a.detail?.kind === "bash" && a.detail.exit !== 0)) {
        return "fail";
    }
    return "ok";
}

// a typed prompt, an Arc message or a typed slash command starts a turn; a model's own Skill call does not
function startsTurn(e: AgentEntry): boolean {
    return e.kind === "user" || (e.kind === "command" && !e.byModel);
}

const COUNTED: Record<string, { one: string; many: string; verb: string }> = {
    ran: { verb: "ran", one: "command", many: "commands" },
    grep: { verb: "searched", one: "pattern", many: "patterns" },
    glob: { verb: "searched", one: "pattern", many: "patterns" },
    spawned: { verb: "spawned", one: "agent", many: "agents" },
    asked: { verb: "asked", one: "question", many: "questions" },
};
// the verbs whose phrase names the one file they touched
const FILE_VERBS = new Set(["read", "edited", "wrote"]);

// "ran 2 commands, read retry.js, edited retry.js": kinds in first-appearance order, one file named, more counted
function foldPhrase(steps: Step[]): string {
    const order: string[] = [];
    const counts = new Map<string, number>();
    const files = new Map<string, Set<string>>();
    for (const { action } of steps) {
        const kind = COUNTED[action.verb]?.verb ?? (FILE_VERBS.has(action.verb) ? action.verb : "other");
        if (!counts.has(kind)) {
            order.push(kind);
            files.set(kind, new Set());
        }
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
        files.get(kind)!.add(action.target);
    }
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    return order
        .map((kind) => {
            const n = counts.get(kind)!;
            if (FILE_VERBS.has(kind)) {
                const touched = files.get(kind)!;
                return touched.size === 1
                    ? `${kind} ${[...touched][0]}`
                    : `${kind} ${plural(touched.size, "file", "files")}`;
            }
            const counted = Object.values(COUNTED).find((c) => c.verb === kind);
            if (counted) {
                return `${kind} ${plural(n, counted.one, counted.many)}`;
            }
            return `used ${plural(n, "other tool", "other tools")}`;
        })
        .join(", ");
}

// N runs from the entry before the stretch to the entry after it, else to the last step's end
function foldDuration(entries: AgentEntry[], steps: Step[]): number | undefined {
    const first = steps[0];
    const last = steps[steps.length - 1];
    const start = entryTime(entries[first.index - 1]) ?? entryTime(first.action);
    const lastTs = entryTime(last.action);
    const lastEnd = lastTs != null ? lastTs + (last.action.durationMs ?? 0) : undefined;
    const end = entryTime(entries[last.index + 1]) ?? lastEnd;
    return start != null && end != null && end >= start ? end - start : undefined;
}

export function foldSummary(entries: AgentEntry[], steps: Step[]): FoldSummary {
    let adds = 0;
    let dels = 0;
    for (const { action } of steps) {
        if (action.detail?.kind === "edit") {
            for (const f of action.detail.files) {
                adds += f.adds;
                dels += f.dels;
            }
        }
    }
    return {
        durationMs: foldDuration(entries, steps),
        phrase: foldPhrase(steps),
        adds,
        dels,
        failed: steps.filter((s) => s.status === "fail").length,
    };
}

export function layoutTranscript(
    entries: AgentEntry[],
    opts: { active: boolean; ctx?: TranscriptContext; threshold?: number }
): LayoutItem[] {
    const threshold = opts.threshold ?? CollapseRunThreshold;
    let turnStart = -1;
    let lastMessage = -1;
    let lastInterrupted = -1;
    let firstUser = -1;
    entries.forEach((e, i) => {
        if (startsTurn(e)) turnStart = i;
        if (e.kind === "message") lastMessage = i;
        if (e.kind === "interrupted") lastInterrupted = i;
        if (e.kind === "user" && firstUser < 0) firstUser = i;
    });

    const items: LayoutItem[] = [];
    let run: Step[] = [];
    const flush = () => {
        if (run.length === 0) {
            return;
        }
        const live = opts.active && run[0].index > turnStart;
        const fold = !live && run.length >= threshold ? foldSummary(entries, run) : null;
        items.push({ kind: "steps", startIndex: run[0].index, steps: run, fold });
        run = [];
    };

    let prevTime: number | undefined;
    entries.forEach((e, i) => {
        const time = entryTime(e);
        const before = prevTime;
        if (time != null) prevTime = time;
        if (e.kind === "action") {
            const wsh = firstWshCall(actionCommand(e));
            const step: Step = { index: i, action: e, wsh, status: stepStatus(e, lastInterrupted > i) };
            if (wsh && isCardKey(wsh.key) && step.status === "ok") {
                flush();
                items.push({ kind: "card", index: i, step });
            } else {
                run.push(step);
            }
            return;
        }
        flush();
        switch (e.kind) {
            case "message":
                items.push({ kind: "message", text: e.text, index: i, latest: i === lastMessage });
                return;
            case "user": {
                const message = arcMessageOf(e, i === firstUser, opts.ctx);
                if (message) {
                    const idleMs = e.ts != null && before != null ? e.ts - before : undefined;
                    items.push({ kind: "arc", index: i, message, ts: e.ts, idleMs });
                } else {
                    items.push({ kind: "user", text: e.text, index: i });
                }
                return;
            }
            case "command":
                items.push({ kind: "command", name: e.name, args: e.args, isSkill: e.isSkill, index: i });
                return;
            case "compaction":
                items.push({
                    kind: "compaction",
                    trigger: e.trigger,
                    preTokens: e.preTokens,
                    postTokens: e.postTokens,
                    summary: e.summary,
                    index: i,
                });
                return;
            case "notification":
                items.push({ kind: "notification", summary: e.summary, status: e.status, result: e.result, index: i });
                return;
            case "interrupted":
                items.push({ kind: "interrupted", index: i });
                return;
        }
    });
    flush();
    return items;
}

// a stretch's rows: two or more consecutive finished image reads draw as one "Read N images" row
export type StepRowItem = { kind: "step"; step: Step } | { kind: "images"; steps: Step[] };

function isImageRead(s: Step): boolean {
    return s.action.verb === "read" && s.status === "ok" && (s.action.images?.length ?? 0) > 0;
}

export function stepRows(steps: Step[]): StepRowItem[] {
    const rows: StepRowItem[] = [];
    let group: Step[] = [];
    const flush = () => {
        if (group.length >= 2) {
            rows.push({ kind: "images", steps: group });
        } else {
            rows.push(...group.map((step) => ({ kind: "step" as const, step })));
        }
        group = [];
    };
    for (const step of steps) {
        if (isImageRead(step)) {
            group.push(step);
            continue;
        }
        flush();
        rows.push({ kind: "step", step });
    }
    flush();
    return rows;
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// a step row's title and the mono text beside it. subject, when set, is the title's tail the row emphasises.
export function stepTitle(action: AgentActionEntry): { title: string; mono?: string; subject?: string } {
    const { verb, target } = action;
    switch (verb) {
        case "ran": {
            const command = actionCommand(action);
            if (command == null) {
                break;
            }
            // the projection puts the description in target when there is one, else the command
            return target && target !== command ? { title: target, mono: command } : { title: "", mono: command };
        }
        case "read":
        case "edited":
        case "wrote": {
            const word = verb === "read" ? "Read" : verb === "edited" ? "Edited" : "Wrote";
            return target ? { title: `${word} ${target}`, subject: target } : { title: word };
        }
        case "grep":
        case "glob":
            return { title: "Searched", mono: target || undefined };
        case "asked":
            return target ? { title: `Asked ${target}`, subject: target } : { title: "Asked" };
        case "spawned":
            return target ? { title: `Spawned ${target}`, subject: target } : { title: "Spawned" };
    }
    return { title: capitalize(verb), mono: target || undefined };
}
