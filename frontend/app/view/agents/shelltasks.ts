// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure projection of a claude transcript into its background shell tasks and Monitor tasks still running,
// and the derived "standing by" state (idle with a task still running). No React and no Wave runtime
// imports, so the transcript shapes are unit-testable on their own.

import { formatAgeShort, formatAgo } from "./agentsviewmodel";

export interface MonitorEvent {
    ts?: number;
    lines: string[];
}

export interface ShellTask {
    id: string;
    kind: "shell" | "monitor";
    description: string;
    command?: string; // verbatim, which the kill matches the task's process by
    startedTs?: number;
    outputPath?: string;
    // monitor only
    timeoutMs?: number;
    persistent?: boolean;
    events?: MonitorEvent[];
}

// a cap, not a guarantee: a task started before the last 2000 transcript records is not listed.
export const SHELL_TAIL_LINES = 2000;

// the cut detailForTool applies to a Bash command in cmd/wsh/cmd/wshcmd-agenthook.go.
const COMMAND_DESCRIPTION_MAX = 60;

export const OUTPUT_MAX_CHARS = 64 * 1024;

function tag(content: string, name: string): string | undefined {
    const m = new RegExp(`<${name}>([^]*?)</${name}>`).exec(content);
    return m ? m[1].trim() : undefined;
}

// the ids a finish notification ends, whatever its status: a failed task goes as a completed one does,
// since the agent is told, and a command it killed itself (a hung one) also reports as failed.
// A session that died with tasks running reports them all in one notification with no <task-id>,
// naming them in the summary instead.
function finishedIds(content: string): string[] {
    // a Monitor event carries no status: not a finish
    if (!content.includes("<task-notification>") || tag(content, "status") == null) {
        return [];
    }
    const id = tag(content, "task-id");
    if (id != null) {
        return [id];
    }
    const listed = /Task ids: ([^]*)$/.exec(tag(content, "summary") ?? "")?.[1];
    return (
        listed
            ?.split(/[,\s]+/)
            .map((s) => s.replace(/\.$/, ""))
            .filter(Boolean) ?? []
    );
}

function toolResultText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("\n");
}

function startedTask(rec: any, toolUses: Map<string, any>, transcriptPath: string | undefined): ShellTask | null {
    const r = rec?.toolUseResult;
    const content = rec?.message?.content;
    const shellId = typeof r?.backgroundTaskId === "string" ? r.backgroundTaskId : "";
    // another tool's result can carry a taskId too; only a Monitor's has a timeout
    const monitorId = typeof r?.taskId === "string" && typeof r.timeoutMs === "number" ? r.taskId : "";
    const id = shellId || monitorId;
    if (id === "" || !Array.isArray(content)) {
        return null;
    }
    const result = content.find((b: any) => b?.type === "tool_result");
    const input = toolUses.get(result?.tool_use_id)?.input ?? {};
    const command = typeof input.command === "string" ? input.command : "";
    const description =
        typeof input.description === "string" && input.description.trim() !== ""
            ? input.description.trim()
            : command.slice(0, COMMAND_DESCRIPTION_MAX);
    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    const common = {
        id,
        description,
        ...(command !== "" ? { command } : {}),
        ...(Number.isFinite(ts) ? { startedTs: ts } : {}),
    };
    if (shellId === "") {
        const outputPath = transcriptPath ? monitorOutputPath(transcriptPath, id) : undefined;
        return {
            ...common,
            kind: "monitor",
            timeoutMs: r.timeoutMs,
            persistent: r.persistent === true,
            events: [],
            ...(outputPath ? { outputPath } : {}),
        };
    }
    const outputPath =
        redirectTarget(command, typeof rec.cwd === "string" ? rec.cwd : undefined) ??
        /Output is being written to: (.+?)\.(?:\s|$)/.exec(toolResultText(result?.content))?.[1];
    return { ...common, kind: "shell", ...(outputPath ? { outputPath } : {}) };
}

// the transcript's project dir and session, which claude names a monitor's output dir after
const TRANSCRIPT_PATH = /([^\\/]+)[\\/]([^\\/]+)\.jsonl$/;

/** Pure: where claude writes a monitor's output, from its transcript path, with the temp dir left as
 *  $TEMP for wavesrv to resolve. Undefined for a path that is not a .jsonl in a directory. */
export function monitorOutputPath(transcriptPath: string, taskId: string): string | undefined {
    const m = TRANSCRIPT_PATH.exec(transcriptPath);
    return m ? `$TEMP/claude/${m[1]}/${m[2]}/tasks/${taskId}.output` : undefined;
}

// a stdout redirect outside quotes: `>`, `>>`, `1>` or `&>`, then a quoted or bare target. `2>` and `>&2`
// never match, so a stderr-only redirect leaves the output in claude's own file
const STDOUT_REDIRECT = /(?:^|[\s;|&(])(?:1|&)?>>?\s*("[^"]*"|'[^']*'|[^\s;|&<>()]+)/g;
// a `cd` that starts a command, so a relative redirect after it lands in its directory
const CD = /(?:^|[;|&(])\s*cd\s+("[^"]*"|'[^']*'|[^\s;|&<>()]+)/g;
const QUOTED = /"[^"]*"|'[^']*'/g;
const DISCARD_TARGET = /^(?:\/dev\/|nul$)/i;
const ABSOLUTE_TARGET = /^(?:[/~]|[A-Za-z]:[\\/])/;
// agents log to the temp dir by variable ("$TEMP/dev.log"), which wavesrv resolves to its own temp dir
const TEMP_VAR_TARGET = /^\$\{?(?:TEMP|TMP|TMPDIR)\}?(?=[/\\]|$)/;

/** Pure: the file a shell command's stdout ends up in, when it redirects it away from claude's output file.
 *  The last redirect wins. Git Bash forms (/tmp, /c/, ~) and a leading temp-dir variable are left for wavesrv
 *  to resolve; a relative target is joined to cwd as moved by any `cd` before the redirect, and one with any
 *  other variable in it is not readable. */
export function redirectTarget(command: string, cwd: string | undefined): string | undefined {
    // quoted text is masked so a `>` inside a quoted script is not a redirect; targets are cut from the original
    const masked = command.replace(QUOTED, (q) => q[0] + "_".repeat(q.length - 2) + q[0]);
    let target: string | undefined;
    let at = 0;
    for (const m of masked.matchAll(STDOUT_REDIRECT)) {
        target = matchedWord(command, m);
        at = m.index;
    }
    if (target == null || target === "" || DISCARD_TARGET.test(target)) {
        return undefined;
    }
    let dir = cwd;
    for (const m of masked.matchAll(CD)) {
        if (m.index >= at) {
            break;
        }
        const to = matchedWord(command, m);
        dir = to === "-" ? undefined : resolvePath(to, dir);
    }
    return resolvePath(target, dir);
}

// the match's captured word, cut from the unmasked command and unquoted
function matchedWord(command: string, m: RegExpMatchArray): string {
    const start = m.index + m[0].length - m[1].length;
    return command.slice(start, start + m[1].length).replace(/^(["'])(.*)\1$/, "$2");
}

function resolvePath(path: string, base: string | undefined): string | undefined {
    if (/[$`]/.test(path.replace(TEMP_VAR_TARGET, ""))) {
        return undefined;
    }
    if (TEMP_VAR_TARGET.test(path) || ABSOLUTE_TARGET.test(path)) {
        return path;
    }
    return base ? `${base.replace(/[\\/]$/, "")}/${path}` : undefined;
}

function notificationContent(rec: any): string | null {
    if (rec.type === "queue-operation" && rec.operation === "enqueue" && typeof rec.content === "string") {
        return rec.content;
    }
    if (rec.type === "user" && typeof rec?.message?.content === "string") {
        return rec.message.content;
    }
    return null;
}

// a monitor event: a notification for a task id with an <event> body and no status
function eventOf(content: string): { id: string; body: string } | null {
    if (!content.includes("<task-notification>") || tag(content, "status") != null) {
        return null;
    }
    const id = tag(content, "task-id");
    const body = tag(content, "event");
    return id != null && body != null ? { id, body } : null;
}

/** Pure: the running background shell tasks and monitors in transcript JSONL lines, in start order. A
 *  shell task starts on a user record carrying toolUseResult.backgroundTaskId, a monitor on one carrying
 *  toolUseResult.taskId and timeoutMs; a <task-notification> with a status for that id (queue-operation
 *  enqueue or user-role string) or a successful TaskStop result for it drops it, and a monitor that is not
 *  persistent also drops at its timeout, which writes no record. A monitor's events are its status-less
 *  notifications: each is written as an enqueue, then a user record or a queued_command attachment, so a
 *  user record counts only when no enqueue of the same body preceded it. A notification for an id with
 *  no start in the lines is ignored. Unparseable lines are skipped. */
export function extractShellTasks(lines: string[], opts: { now?: number; transcriptPath?: string } = {}): ShellTask[] {
    const now = opts.now ?? Date.now();
    const toolUses = new Map<string, any>();
    const tasks = new Map<string, ShellTask>();
    // a task that finishes at once can have its enqueue written before its start record
    const finishedEarly = new Set<string>();
    // per monitor id, the enqueued event bodies whose user-record copy is still to come
    const pendingEvents = new Map<string, string[]>();
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        if (rec == null || typeof rec !== "object") {
            continue;
        }
        if (rec.type === "assistant" && Array.isArray(rec?.message?.content)) {
            for (const block of rec.message.content) {
                if (block?.type === "tool_use" && typeof block.id === "string") {
                    toolUses.set(block.id, block);
                }
            }
            continue;
        }
        // a TaskStop usually writes no killed notification; its success result is the only record.
        // a failed stop's toolUseResult is an error string, so it never matches.
        const stoppedId = rec.type === "user" ? rec?.toolUseResult?.task_id : undefined;
        if (typeof stoppedId === "string" && tasks.has(stoppedId)) {
            tasks.delete(stoppedId);
            continue;
        }
        const started = rec.type === "user" ? startedTask(rec, toolUses, opts.transcriptPath) : null;
        if (started != null) {
            if (!finishedEarly.has(started.id)) {
                tasks.set(started.id, started);
            }
            continue;
        }
        const content = notificationContent(rec);
        if (content == null) {
            continue;
        }
        const event = eventOf(content);
        if (event != null) {
            addEvent(rec, event, tasks.get(event.id), pendingEvents);
            continue;
        }
        for (const id of finishedIds(content)) {
            if (!tasks.delete(id)) {
                finishedEarly.add(id);
            }
        }
    }
    return [...tasks.values()].filter((t) => {
        const expires = monitorExpiresAt(t);
        return expires == null || now < expires;
    });
}

function addEvent(
    rec: any,
    event: { id: string; body: string },
    task: ShellTask | undefined,
    pendingEvents: Map<string, string[]>
): void {
    if (task?.kind !== "monitor") {
        return;
    }
    const pending = pendingEvents.get(event.id) ?? [];
    if (rec.type === "queue-operation") {
        pendingEvents.set(event.id, [...pending, event.body]);
    } else {
        const copyOf = pending.indexOf(event.body);
        if (copyOf >= 0) {
            pending.splice(copyOf, 1);
            return;
        }
    }
    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    task.events.push({ ...(Number.isFinite(ts) ? { ts } : {}), lines: event.body.split(/\r?\n/) });
}

export function isStandingBy(state: string, tasks: ShellTask[]): boolean {
    return state === "idle" && tasks.length > 0;
}

/** Pure: what to tell the user after a kill, or null when the row leaving says it. */
export function shellKillNote(r: ResMonKillRtnData, task: Pick<ShellTask, "kind" | "description">): string | null {
    const d = task.description;
    switch (r.outcome) {
        case "killed":
            return null;
        case "gone":
            return `"${d}" had already ended.`;
        case "failed": {
            // the OS text ends in its own period
            const why = r.error ? `: ${r.error.replace(/\.$/, "")}` : "";
            return `Could not ${task.kind === "monitor" ? "stop" : "kill"} "${d}"${why}.`;
        }
        default:
            return `${task.kind === "monitor" ? "Not stopped" : "Not killed"}: "${d}" is not a process of this agent's tab.`;
    }
}

export function shellTasksNoun(tasks: ShellTask[]): "shell tasks" | "monitors" | "tasks" {
    const monitors = tasks.filter((t) => t.kind === "monitor").length;
    if (monitors === 0) {
        return "shell tasks";
    }
    return monitors === tasks.length ? "monitors" : "tasks";
}

export function shellTasksLabel(tasks: ShellTask[]): string {
    const n = tasks.length;
    const noun = shellTasksNoun(tasks);
    if (n !== 1) {
        return `${n} ${noun}`;
    }
    return noun === "monitors" ? "1 monitor" : "1 shell task";
}

/** Pure: when a monitor times out, or null when it never does or its start is unknown. */
export function monitorExpiresAt(t: ShellTask): number | null {
    if (t.persistent || t.startedTs == null || t.timeoutMs == null) {
        return null;
    }
    return t.startedTs + t.timeoutMs;
}

/** Pure: "N events · 3m ago", or null when the monitor has reported nothing. */
export function monitorEventsSummary(t: ShellTask, now: number): string | null {
    const events = t.events ?? [];
    if (events.length === 0) {
        return null;
    }
    const lastTs = events[events.length - 1].ts;
    const count = events.length === 1 ? "1 event" : `${events.length} events`;
    return `${count} · ${formatAgo(lastTs != null ? now - lastTs : undefined)}`;
}

/** Pure: a monitor row's second line. */
export function monitorSubline(t: ShellTask, now: number): string {
    const body =
        monitorEventsSummary(t, now) ??
        `no events yet · ${formatAgeShort(t.startedTs != null ? now - t.startedTs : undefined)}`;
    return t.persistent ? `persistent · ${body}` : body;
}

/** Pure: "18m left" for a monitor row, null when persistent or its start/timeout is unknown. */
export function monitorTimeLeft(t: ShellTask, now: number): string | null {
    const expires = monitorExpiresAt(t);
    if (expires == null) {
        return null;
    }
    const left = expires - now;
    return left < 60_000 ? "<1m left" : `${Math.ceil(left / 60_000)}m left`;
}

/** The output lines trimmed so their joined text is at most the last maxChars characters; a line
 *  the cut lands inside is dropped rather than shown as a fragment. */
export function outputTail(lines: string[], maxChars = OUTPUT_MAX_CHARS): string[] {
    const text = lines.join("\n");
    if (text.length <= maxChars) {
        return lines;
    }
    const cutAt = text.length - maxChars;
    let tail = text.slice(cutAt);
    const newline = tail.indexOf("\n");
    // a single line longer than the cap keeps its tail; showing nothing would read as no output
    if (text[cutAt - 1] !== "\n" && newline >= 0) {
        tail = tail.slice(newline + 1);
    }
    return tail.split("\n");
}
