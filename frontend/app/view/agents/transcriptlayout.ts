// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: how a transcript lays out. Tool actions become steps; a maximal run of steps is a stretch, broken by prose,
// user entries, events and change cards; a wsh change call that succeeded leaves the stretch as a standalone card; Arc's
// own messages become arc items. A thought (a thinking-only message), when the host draws them, sits inside the stretch
// around it, or alone where no step is beside it; thoughts with nothing between them merge into one. A finished turn's work, everything between its prompt and its final
// reply, folds into one "Worked for N" turn item; a human-originated row or a turn-boundary event splits it.
// Consecutive finished edits to one file merge into one step. An Agent step whose subagent still runs stays running
// whatever its result, and a folded turn keeps it out, right after the fold. No React.

import type { AgentActionEntry, AgentEntry, ToolImage } from "./agentsviewmodel";
import { arcMessageOf, type ArcMessage } from "./arcmessage";
import { commandPreview, commandTitle } from "./commandtitle";
import { classifyKind, splitAttachments } from "./composerattachments";
import { placeMarks, type TimelineMark } from "./permissionmodel";
import type { SubagentVM } from "./session-models/sessionviewmodel";
import type { TranscriptContext } from "./transcriptcontext";
import { firstWshCall, isCardKey, parseWshCalls, type WshCall, type WshKey } from "./wshcall";

export interface Step {
    // the first entry's index; a merged step spans `edits` consecutive entries from it
    index: number;
    action: AgentActionEntry;
    wsh: { call: WshCall; key: WshKey } | null;
    status: "ok" | "fail" | "blocked" | "declined" | "running" | "stopped";
    // set when two or more consecutive edits to one file merged into this step: how many
    edits?: number;
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
    // images: pasted; imagePaths/filePaths: the trailing attachments block's paths, split by kind
    | { kind: "user"; text: string; index: number; images?: ToolImage[]; imagePaths?: string[]; filePaths?: string[] }
    | { kind: "command"; name: string; args?: string; isSkill?: boolean; output?: string; index: number }
    | { kind: "compaction"; trigger?: string; preTokens?: number; postTokens?: number; summary?: string; index: number }
    | {
          kind: "notification";
          summary: string;
          status?: string;
          result?: string;
          notice?: true;
          source?: "command" | "monitor" | "subagent";
          // a subagent finish's Agent call, which links it to that subagent
          toolUseId?: string;
          index: number;
      }
    | { kind: "interrupted"; index: number }
    | {
          kind: "shell";
          command: string;
          stdout?: string;
          stderr?: string;
          ts?: number;
          exit?: number | null;
          cancelled?: boolean;
          truncated?: boolean;
          excluded?: boolean;
          index: number;
      }
    // latest: the feed's last wake, the only one that draws its sections open
    | { kind: "arc"; index: number; message: ArcMessage; ts?: number; idleMs?: number; latest: boolean }
    // thoughts: the stretch's own, set only when it has some
    | { kind: "steps"; startIndex: number; steps: Step[]; thoughts?: Thought[] }
    | { kind: "card"; index: number; step: Step }
    // a turn's work, folded: its items in order. latest: part of the last finished turn while the agent is not
    // working, whose cards draw open. live: the working turn's work, or the last turn's when it was interrupted, laid
    // out the same way but drawn open, so finishing folds the rows already drawn instead of redrawing them inside a fold
    | { kind: "turn"; startIndex: number; items: LayoutItem[]; fold: FoldSummary; latest: boolean; live?: boolean };

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

// the calls that end the session that makes them: the engine closes the tab before Claude Code writes their result.
// By subcommand chain, not key: an unresolved argument (--report "$TMP/r.md") makes the key the generic change
const SESSION_CLOSING: ReadonlySet<string> = new Set(["jarvis complete", "jarvis dag planreview", "jarvis dag final"]);

function closesSession(a: AgentActionEntry): boolean {
    return parseWshCalls(actionCommand(a) ?? "").some((call) => SESSION_CLOSING.has(call.path.join(" ")));
}

// a step's place in the transcript. last: no action comes after it
interface StepAt {
    interruptedLater: boolean;
    last: boolean;
    active: boolean;
}

// where a pending call stands: running while the agent works (it may wait on a permission prompt) and nothing
// interrupted it; ok when it closed the session as its last call; else it never got its result
function pendingStatus(a: AgentActionEntry, at: StepAt): Step["status"] {
    if (at.interruptedLater) {
        return "stopped";
    }
    if (at.active) {
        return "running";
    }
    return at.last && closesSession(a) ? "ok" : "stopped";
}

function stepStatus(a: AgentActionEntry, at: StepAt, running?: ReadonlySet<string>): Step["status"] {
    // a background spawn's result is only its launch ack, so the subagent's own state says whether it runs
    if (a.toolUseId != null && running?.has(a.toolUseId)) {
        return "running";
    }
    return a.pending ? pendingStatus(a, at) : finishedStatus(a);
}

/** The status an Agent step draws with its subagent's facts: a subagent that finished ends a step still waiting on the
 *  parent's result, so no spinner outlives it. */
export function subagentStepStatus(status: Step["status"], sub: SubagentVM | undefined): Step["status"] {
    return status === "running" && sub != null && sub.state !== "working" ? "ok" : status;
}

// a finished call's status: "ok" is what lifts a wsh change call out of the fold as its card
export function finishedStatus(a: AgentActionEntry): "ok" | "fail" | "blocked" | "declined" {
    if (a.outcome === "blocked" || a.outcome === "declined") {
        return a.outcome;
    }
    if (a.outcome === "fail" || (a.detail?.kind === "bash" && a.detail.exit !== 0)) {
        return "fail";
    }
    return "ok";
}

// the last entry a step covers
function stepEnd(step: Step): number {
    return step.index + (step.edits ?? 1) - 1;
}

// the one path a finished edit touched, else undefined
function editPath(step: Step): string | undefined {
    const { detail, verb } = step.action;
    if (verb !== "edited" || step.status !== "ok" || detail?.kind !== "edit" || detail.files.length === 0) {
        return undefined;
    }
    const path = detail.files[0].path;
    return detail.files.every((f) => f.path === path) ? path : undefined;
}

function mergeableEdits(prev: Step, next: Step): boolean {
    const path = editPath(prev);
    return path != null && path === editPath(next);
}

// one step for consecutive edits to one file: each edit's file block in order, so the counts sum
function mergeEdits(prev: Step, next: Step): Step {
    const files = (s: Step) => (s.action.detail?.kind === "edit" ? s.action.detail.files : []);
    const durationMs =
        prev.action.durationMs == null && next.action.durationMs == null
            ? undefined
            : (prev.action.durationMs ?? 0) + (next.action.durationMs ?? 0);
    return {
        ...prev,
        action: { ...prev.action, detail: { kind: "edit", files: [...files(prev), ...files(next)] }, durationMs },
        edits: (prev.edits ?? 1) + 1,
    };
}

// article: one reads "a <one>" rather than "1 <one>"
const COUNTED: Record<string, { one: string; many: string; verb: string; article?: boolean }> = {
    ran: { verb: "ran", one: "command", many: "commands" },
    grep: { verb: "searched", one: "pattern", many: "patterns" },
    glob: { verb: "searched", one: "pattern", many: "patterns" },
    spawned: { verb: "spawned", one: "agent", many: "agents" },
    asked: { verb: "asked", one: "question", many: "questions" },
    skill: { verb: "used", one: "skill", many: "skills", article: true },
    // no action has this verb: a canvas reveal is a Bash step, counted apart from the commands
    "canvas-reveal": { verb: "revealed", one: "canvas", many: "canvases", article: true },
};
// the verbs whose phrase names the one file they touched
const FILE_VERBS = new Set(["read", "edited", "wrote"]);

function isCanvasRevealCall(wsh: { call: WshCall; key: WshKey } | null | undefined): boolean {
    return wsh?.key === "ui-reveal" && (wsh.call.args[0] ?? "").startsWith("canvas:");
}

function isCanvasReveal(step: Step): boolean {
    return isCanvasRevealCall(step.wsh);
}

// the transcript's last finished canvas reveal: its card stays out of its turn's fold, and the Rendered view draws the
// Mockup card on it, so the canvas sits where the agent opened it rather than pinned after the transcript
export function lastCanvasReveal(entries: AgentEntry[]): AgentActionEntry | null {
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.kind === "action" && !e.pending && finishedStatus(e) === "ok") {
            if (isCanvasRevealCall(firstWshCall(actionCommand(e)))) {
                return e;
            }
        }
    }
    return null;
}

// "ran 2 commands, read retry.js, edited retry.js": kinds in first-appearance order, one file named, more counted
function foldPhrase(steps: Step[]): string {
    const order: string[] = [];
    const counts = new Map<string, number>();
    const files = new Map<string, Set<string>>();
    for (const step of steps) {
        const { action } = step;
        const verb = isCanvasReveal(step) ? "canvas-reveal" : action.verb;
        const kind = COUNTED[verb]?.verb ?? (FILE_VERBS.has(verb) ? verb : "other");
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
    // the permission marks the host draws: each splits the finished turn it falls in
    marks?: TimelineMark[];
    // the toolUseIds of the subagents still working: their Agent steps run, and a folded turn keeps them out
    runningSubagents?: ReadonlySet<string>;
}

export function layoutTranscript(entries: AgentEntry[], opts: LayoutOpts): LayoutItem[] {
    return foldTurns(entries, layoutItems(entries, opts), opts);
}

// the items of a turn's work, a queued notice included; every other kind is a prompt or a turn-boundary event, which
// stays outside and splits it
const FOLDED_KINDS = new Set<LayoutItem["kind"]>(["message", "thought", "steps", "card"]);

function isFolded(item: LayoutItem): boolean {
    return FOLDED_KINDS.has(item.kind) || (item.kind === "notification" && !!item.notice);
}

function isWork(item: LayoutItem): boolean {
    return item.kind === "steps" || item.kind === "card";
}

// a typed prompt, an Arc message, a typed slash command or a notification of its own record starts a turn, unless it
// was queued while the agent worked; a model's own Skill call is an action
function startsTurn(entries: AgentEntry[], item: LayoutItem): boolean {
    if (item.kind === "command" || (item.kind === "notification" && !item.notice)) {
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
        return Math.max(stepEnd(item.steps[item.steps.length - 1]), lastThought);
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

function turnItem(entries: AgentEntry[], items: LayoutItem[], latest: boolean, live: boolean): LayoutItem {
    const steps = items.flatMap((i) => (i.kind === "steps" ? i.steps : i.kind === "card" ? [i.step] : []));
    const first = itemStart(items[0]);
    return {
        kind: "turn",
        startIndex: first,
        items,
        fold: foldSummary(entries, steps, first, itemEnd(items[items.length - 1])),
        latest,
        ...(live ? { live } : {}),
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
    keepOut: AgentActionEntry | null,
    running: ReadonlySet<string>,
    latest: boolean,
    live: boolean
): LayoutItem[] {
    const range = flat.slice(from, to);
    const lastWork = lastIndexOf(range, isWork);
    const reply = lastIndexOf(range, (i) => i.kind === "message");
    const stop = from + (reply > lastWork ? reply : range.length);
    const out: LayoutItem[] = [];
    let part: LayoutItem[] = [];
    const close = () => {
        // a live turn keeps its steps in place, so none reorders while the parent works
        const { kept, held } = live || running.size === 0 ? { kept: part, held: [] } : holdRunning(part, running);
        // a part of prose and thoughts only draws as it is
        if (kept.some(isWork)) {
            out.push(turnItem(entries, kept, latest, live));
        } else {
            out.push(...kept);
        }
        if (held.length > 0) {
            out.push({ kind: "steps", startIndex: held[0].index, steps: held });
        }
        part = [];
    };
    for (let p = from; p < stop; p++) {
        const item = flat[p];
        if (!isFolded(item) || (item.kind === "card" && item.step.action === keepOut)) {
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

const NONE_RUNNING: ReadonlySet<string> = new Set();

// a folded part's items without the Agent steps of its running subagents, and those steps; a stretch left with no step
// keeps its thoughts as standalone ones
function holdRunning(part: LayoutItem[], running: ReadonlySet<string>): { kept: LayoutItem[]; held: Step[] } {
    const isHeld = (step: Step) => step.action.toolUseId != null && running.has(step.action.toolUseId);
    const held: Step[] = [];
    const kept = part.flatMap((item): LayoutItem[] => {
        if (item.kind !== "steps" || !item.steps.some(isHeld)) {
            return [item];
        }
        held.push(...item.steps.filter(isHeld));
        const steps = item.steps.filter((s) => !isHeld(s));
        const thoughts = item.thoughts ?? [];
        if (steps.length === 0) {
            return thoughts.map((t) => ({ kind: "thought" as const, ...t }));
        }
        const startIndex = Math.min(steps[0].index, thoughts[0]?.index ?? Infinity);
        return [{ kind: "steps", startIndex, steps, ...(thoughts.length > 0 ? { thoughts } : {}) }];
    });
    return { kept, held };
}

// folds every finished turn; while active, the last turn is live: split the same way, its turn items marked live.
// Not active, the last turn is the latest, and stays live when the transcript ends on its interruption: the work the
// person just stopped stays in view until their next prompt
function foldTurns(entries: AgentEntry[], flat: LayoutItem[], opts: LayoutOpts): LayoutItem[] {
    const starts = flat.flatMap((item, p) => (startsTurn(entries, item) ? [p] : []));
    const interrupted = flat[flat.length - 1]?.kind === "interrupted";
    const liveFrom = opts.active || interrupted ? (starts[starts.length - 1] ?? 0) : flat.length;
    // a mark draws after the item holding the entry before it, so the turn splits there
    const splitAfter = new Set(placeMarks(flat, opts.marks ?? []).after.keys());
    const keepOut = lastCanvasReveal(entries);
    const out: LayoutItem[] = [];
    for (let from = 0; from < flat.length; ) {
        let to = from + 1;
        while (to < flat.length && !startsTurn(entries, flat[to])) {
            to++;
        }
        out.push(
            ...foldTurn(
                entries,
                flat,
                from,
                to,
                splitAfter,
                keepOut,
                opts.runningSubagents ?? NONE_RUNNING,
                !opts.active && to === flat.length,
                from >= liveFrom
            )
        );
        from = to;
    }
    return out;
}

// claude's stand-in for a pasted image in the prompt text; the thumbnail replaces it when the image came along. A
// placeholder alone on its line takes the line with it
const IMAGE_PLACEHOLDER = /^[ \t]*\[Image #\d+\][ \t]*(?:\r?\n|$)|[ \t]*\[Image #\d+\]/gm;

// a prompt as drawn: pasted images under the text, and Arc's attachments block as thumbnails and file chips
function userItem(e: Extract<AgentEntry, { kind: "user" }>, index: number): Extract<LayoutItem, { kind: "user" }> {
    const hasImages = (e.images?.length ?? 0) > 0;
    const { text, paths } = splitAttachments(hasImages ? e.text.replace(IMAGE_PLACEHOLDER, "") : e.text);
    const item: Extract<LayoutItem, { kind: "user" }> = { kind: "user", text: text.trim(), index };
    if (hasImages) item.images = e.images;
    if (paths.length > 0) {
        const isImage = (p: string) => classifyKind({ name: p, type: "" }) === "image";
        item.imagePaths = paths.filter(isImage);
        item.filePaths = paths.filter((p) => !isImage(p));
    }
    return item;
}

// Claude Code's summary of a Monitor event: `Monitor event: "<the Monitor call's description>"`
const MONITOR_EVENT = /^Monitor event: "([^]*)"$/;

// a Monitor event notice right after the stretch holding the Monitor call it names: a notice with no status or result
// carries only that description, so it would draw the step a second time
function echoesMonitor(e: Extract<AgentEntry, { kind: "notification" }>, prev: LayoutItem | undefined): boolean {
    const bare = e.source === "monitor" && e.notice && e.status == null && !e.result;
    const desc = bare ? MONITOR_EVENT.exec(e.summary)?.[1] : undefined;
    if (desc == null || prev?.kind !== "steps") {
        return false;
    }
    return prev.steps.some((s) => s.action.verb === "monitor" && s.action.target === desc);
}

// the items as they come, unfolded
function layoutItems(entries: AgentEntry[], opts: LayoutOpts): LayoutItem[] {
    let lastMessage = -1;
    let lastInterrupted = -1;
    let lastAction = -1;
    let firstUser = -1;
    entries.forEach((e, i) => {
        if (e.kind === "message") lastMessage = i;
        if (e.kind === "interrupted") lastInterrupted = i;
        if (e.kind === "action") lastAction = i;
        // a text joined mid-turn is never a run's brief
        if (e.kind === "user" && !e.queued && firstUser < 0) firstUser = i;
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
            const at = { interruptedLater: lastInterrupted > i, last: i === lastAction, active: opts.active };
            const step: Step = { index: i, action: e, wsh, status: stepStatus(e, at, opts.runningSubagents) };
            const prev = run[run.length - 1];
            if (wsh && isCardKey(wsh.key) && step.status === "ok") {
                flush();
                items.push({ kind: "card", index: i, step });
            } else if (prev && stepEnd(prev) === i - 1 && mergeableEdits(prev, step)) {
                run[run.length - 1] = mergeEdits(prev, step);
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
                    items.push(userItem(e, i));
                }
                return;
            }
            case "command":
                items.push({ kind: "command", name: e.name, args: e.args, isSkill: e.isSkill, output: e.output, index: i });
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
                if (echoesMonitor(e, items[items.length - 1])) {
                    return;
                }
                items.push({
                    kind: "notification",
                    summary: e.summary,
                    status: e.status,
                    result: e.result,
                    notice: e.notice,
                    source: e.source,
                    ...(e.toolUseId != null ? { toolUseId: e.toolUseId } : {}),
                    index: i,
                });
                return;
            case "interrupted":
                // a second interruption with nothing drawn since says nothing new
                if (items[items.length - 1]?.kind !== "interrupted") {
                    items.push({ kind: "interrupted", index: i });
                }
                return;
            case "shell":
                items.push({ ...e, index: i });
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
                ? { title: target, mono: commandPreview(command) }
                : { title: commandTitle(command) ?? "", mono: commandPreview(command) };
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
