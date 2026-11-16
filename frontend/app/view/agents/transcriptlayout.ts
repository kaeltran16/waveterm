// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: how a transcript lays out. Tool actions become steps; a maximal run of steps is a stretch, broken by prose,
// user entries, events and change cards; a wsh change call that succeeded leaves the stretch as a standalone card; Arc's
// own messages become arc items. A thought (a thinking-only message), when the host draws them, sits inside the stretch
// around it, or alone where no step is beside it; thoughts with nothing between them merge into one. A finished turn's work, everything between its prompt and its final
// reply, folds into one "Worked for N" turn item; a human-originated row or a turn-boundary event splits it. No React.

import type { AgentActionEntry, AgentEntry } from "./agentsviewmodel";
import { arcMessageOf, type ArcMessage } from "./arcmessage";
import { commandTitle } from "./commandtitle";
import { placeMarks, type TimelineMark } from "./permissionmodel";
import { toolRendererKey } from "./renderregistry";
import type { TranscriptContext } from "./transcriptcontext";
import { firstWshCall, isCardKey, type WshCall, type WshKey } from "./wshcall";

export interface Step {
    index: number;
    action: AgentActionEntry;
    wsh: { call: WshCall; key: WshKey } | null;
    status: "ok" | "fail" | "blocked" | "running" | "stopped";
}

export interface FoldSummary {
    durationMs?: number;
    phrase: string;
    adds: number;
    dels: number;
    failed: number;
}

// a thought drawn inside a stretch, between the steps around it
export interface Thought {
    index: number;
    text: string;
}

export type LayoutItem =
    | { kind: "message"; text: string; index: number; latest: boolean }
    | { kind: "thought"; text: string; index: number }
    | { kind: "user"; text: string; index: number }
    | { kind: "command"; name: string; args?: string; isSkill?: boolean; index: number }
    | { kind: "compaction"; trigger?: string; preTokens?: number; postTokens?: number; summary?: string; index: number }
    | { kind: "notification"; summary: string; status?: string; result?: string; notice?: true; index: number }
    | { kind: "interrupted"; index: number }
    // latest: the feed's last wake, the only one that draws its sections open
    | { kind: "arc"; index: number; message: ArcMessage; ts?: number; idleMs?: number; latest: boolean }
    // thoughts: the stretch's own, set only when it has some
    | { kind: "steps"; startIndex: number; steps: Step[]; thoughts?: Thought[] }
    | { kind: "card"; index: number; step: Step }
    // a finished turn's work, folded: its items in order. open: it starts open (a tool output card in the rendered view)
    | { kind: "turn"; startIndex: number; items: LayoutItem[]; fold: FoldSummary; open: boolean };

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
    if (a.outcome === "blocked") {
        return "blocked";
    }
    if (a.outcome === "fail" || (a.detail?.kind === "bash" && a.detail.exit !== 0)) {
        return "fail";
    }
    return "ok";
}

// article: one reads "a <one>" rather than "1 <one>"
const COUNTED: Record<string, { one: string; many: string; verb: string; article?: boolean }> = {
    ran: { verb: "ran", one: "command", many: "commands" },
    grep: { verb: "searched", one: "pattern", many: "patterns" },
    glob: { verb: "searched", one: "pattern", many: "patterns" },
    spawned: { verb: "spawned", one: "agent", many: "agents" },
    asked: { verb: "asked", one: "question", many: "questions" },
    skill: { verb: "used", one: "skill", many: "skills", article: true },
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
                return n === 1 && counted.article
                    ? `${kind} a ${counted.one}`
                    : `${kind} ${plural(n, counted.one, counted.many)}`;
            }
            return `used ${plural(n, "other tool", "other tools")}`;
        })
        .join(", ");
}

// the nearest entry from i on, stepping by dir, that is not a thought: a thought is part of the work, not its edge
function edgeEntry(entries: AgentEntry[], i: number, dir: 1 | -1): AgentEntry | undefined {
    while (entries[i]?.kind === "thought") {
        i += dir;
    }
    return entries[i];
}

// N runs from the entry before the fold (its prompt) to the entry after it (its final reply), else to the last step's
// end. first and last: the fold's entry range
function foldDuration(entries: AgentEntry[], steps: Step[], first: number, last: number): number | undefined {
    const lastStep = steps[steps.length - 1];
    const start = entryTime(edgeEntry(entries, first - 1, -1)) ?? entryTime(steps[0].action);
    const lastTs = entryTime(lastStep.action);
    const lastEnd = lastTs != null ? lastTs + (lastStep.action.durationMs ?? 0) : undefined;
    const end = entryTime(edgeEntry(entries, last + 1, 1)) ?? lastEnd;
    return start != null && end != null && end >= start ? end - start : undefined;
}

export function foldSummary(entries: AgentEntry[], steps: Step[], first: number, last: number): FoldSummary {
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
        durationMs: foldDuration(entries, steps, first, last),
        phrase: foldPhrase(steps),
        adds,
        dels,
        failed: steps.filter((s) => s.status === "fail").length,
    };
}

export interface LayoutOpts {
    // the agent is working, so its last turn is live and lays out unfolded
    active: boolean;
    ctx?: TranscriptContext;
    // draw thought entries (the rendered view); without it they are skipped and break nothing
    thoughts?: boolean;
    // the rendered view: a turn holding a tool output card starts open
    renderers?: boolean;
    // the permission marks the host draws: each splits the finished turn it falls in
    marks?: TimelineMark[];
}

export function layoutTranscript(entries: AgentEntry[], opts: LayoutOpts): LayoutItem[] {
    return foldTurns(entries, layoutItems(entries, opts), opts);
}

// the items of a turn's work; every other kind is a prompt or a turn-boundary event, which stays outside and splits it
const FOLDED_KINDS = new Set<LayoutItem["kind"]>(["message", "thought", "steps", "card", "notification"]);

function isWork(item: LayoutItem): boolean {
    return item.kind === "steps" || item.kind === "card";
}

// a typed prompt, an Arc message or a typed slash command starts a turn, unless it was queued while the agent worked; a
// model's own Skill call is an action
function startsTurn(entries: AgentEntry[], item: LayoutItem): boolean {
    if (item.kind === "command") {
        return true;
    }
    const e = item.kind === "user" || item.kind === "arc" ? entries[item.index] : undefined;
    return e?.kind === "user" && !e.queued;
}

function itemStart(item: LayoutItem): number {
    return "index" in item ? item.index : item.startIndex;
}

function itemEnd(item: LayoutItem): number {
    if (item.kind === "steps") {
        const lastThought = item.thoughts?.[item.thoughts.length - 1]?.index ?? -1;
        return Math.max(item.steps[item.steps.length - 1].index, lastThought);
    }
    return itemStart(item);
}

function lastIndexOf(items: LayoutItem[], pred: (item: LayoutItem) => boolean): number {
    for (let i = items.length - 1; i >= 0; i--) {
        if (pred(items[i])) {
            return i;
        }
    }
    return -1;
}

function turnItem(entries: AgentEntry[], items: LayoutItem[], opts: LayoutOpts): LayoutItem {
    const steps = items.flatMap((i) => (i.kind === "steps" ? i.steps : i.kind === "card" ? [i.step] : []));
    const first = itemStart(items[0]);
    const toolCard = items.some((i) => i.kind === "steps" && i.steps.some((s) => toolRendererKey(s.action) != null));
    return {
        kind: "turn",
        startIndex: first,
        items,
        fold: foldSummary(entries, steps, first, itemEnd(items[items.length - 1])),
        open: !!opts.renderers && toolCard,
    };
}

// a finished turn's items flat[from, to): its final reply, the last message with no step or card after it, stays out
// with whatever follows it; the work before it folds, one fold per side of each row that stays outside
function foldTurn(
    entries: AgentEntry[],
    flat: LayoutItem[],
    from: number,
    to: number,
    splitAfter: Set<number>,
    opts: LayoutOpts
): LayoutItem[] {
    const range = flat.slice(from, to);
    const lastWork = lastIndexOf(range, isWork);
    const reply = lastIndexOf(range, (i) => i.kind === "message");
    const stop = from + (reply > lastWork ? reply : range.length);
    const out: LayoutItem[] = [];
    let part: LayoutItem[] = [];
    const close = () => {
        // a part of prose and thoughts only draws as it is
        if (part.some(isWork)) {
            out.push(turnItem(entries, part, opts));
        } else {
            out.push(...part);
        }
        part = [];
    };
    for (let p = from; p < stop; p++) {
        if (!FOLDED_KINDS.has(flat[p].kind)) {
            close();
            out.push(flat[p]);
            continue;
        }
        part.push(flat[p]);
        if (splitAfter.has(p)) {
            close();
        }
    }
    close();
    out.push(...flat.slice(stop, to));
    return out;
}

// folds every finished turn; while active, the last turn is live and stays as it is
function foldTurns(entries: AgentEntry[], flat: LayoutItem[], opts: LayoutOpts): LayoutItem[] {
    const starts = flat.flatMap((item, p) => (startsTurn(entries, item) ? [p] : []));
    const liveFrom = opts.active ? (starts[starts.length - 1] ?? 0) : flat.length;
    // a mark draws after the item holding the entry before it, so the turn splits there
    const splitAfter = new Set(placeMarks(flat, opts.marks ?? []).after.keys());
    const out: LayoutItem[] = [];
    for (let from = 0; from < liveFrom; ) {
        let to = from + 1;
        while (to < liveFrom && !startsTurn(entries, flat[to])) {
            to++;
        }
        out.push(...foldTurn(entries, flat, from, to, splitAfter, opts));
        from = to;
    }
    out.push(...flat.slice(liveFrom));
    return out;
}

// the items as they come, unfolded
function layoutItems(entries: AgentEntry[], opts: LayoutOpts): LayoutItem[] {
    let lastMessage = -1;
    let lastInterrupted = -1;
    let firstUser = -1;
    entries.forEach((e, i) => {
        if (e.kind === "message") lastMessage = i;
        if (e.kind === "interrupted") lastInterrupted = i;
        if (e.kind === "user" && firstUser < 0) firstUser = i;
    });

    const items: LayoutItem[] = [];
    let run: Step[] = [];
    // thoughts since the last step: they join the stretch around them, else stand alone
    let thoughts: Thought[] = [];
    let runThoughts: Thought[] = [];
    const flush = () => {
        if (run.length === 0) {
            items.push(...thoughts.map((t) => ({ kind: "thought" as const, ...t })));
            thoughts = [];
            return;
        }
        const own = [...runThoughts, ...thoughts];
        const startIndex = Math.min(run[0].index, own[0]?.index ?? Infinity);
        items.push({ kind: "steps", startIndex, steps: run, ...(own.length > 0 ? { thoughts: own } : {}) });
        run = [];
        thoughts = [];
        runThoughts = [];
    };

    let prevTime: number | undefined;
    entries.forEach((e, i) => {
        if (e.kind === "thought") {
            if (!opts.thoughts) {
                return;
            }
            // every pending thought came after the last step with nothing else between, so this one joins the last
            const prev = thoughts[thoughts.length - 1];
            if (prev) {
                prev.text = `${prev.text}\n\n${e.text}`;
            } else {
                thoughts.push({ index: i, text: e.text });
            }
            return;
        }
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
                runThoughts.push(...thoughts);
                thoughts = [];
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
                    items.push({ kind: "arc", index: i, message, ts: e.ts, idleMs, latest: false });
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
                items.push({
                    kind: "notification",
                    summary: e.summary,
                    status: e.status,
                    result: e.result,
                    notice: e.notice,
                    index: i,
                });
                return;
            case "interrupted":
                items.push({ kind: "interrupted", index: i });
                return;
        }
    });
    flush();
    const lastWake = items[lastIndexOf(items, (it) => it.kind === "arc" && it.message.kind === "wake")];
    if (lastWake?.kind === "arc") {
        lastWake.latest = true;
    }
    return items;
}

// a stretch's rows: two or more consecutive finished image reads draw as one "Read N images" row; a thought sits between
// the steps around it
export type StepRowItem = { kind: "step"; step: Step } | { kind: "images"; steps: Step[] } | ({ kind: "thought" } & Thought);

function isImageRead(s: Step): boolean {
    return s.action.verb === "read" && s.status === "ok" && (s.action.images?.length ?? 0) > 0;
}

export function stepRows(steps: Step[], thoughts: Thought[] = []): StepRowItem[] {
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
    let next = 0;
    // the thoughts before entry index i, each closing the image group it interrupts
    const thoughtsBefore = (i: number) => {
        while (next < thoughts.length && thoughts[next].index < i) {
            flush();
            rows.push({ kind: "thought", ...thoughts[next++] });
        }
    };
    for (const step of steps) {
        thoughtsBefore(step.index);
        if (isImageRead(step)) {
            group.push(step);
            continue;
        }
        flush();
        rows.push({ kind: "step", step });
    }
    thoughtsBefore(Infinity);
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
            return target && target !== command
                ? { title: target, mono: command }
                : { title: commandTitle(command) ?? "", mono: command };
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
