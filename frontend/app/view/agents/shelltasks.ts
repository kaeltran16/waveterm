// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure projection of a claude transcript into its background shell tasks still running, and the derived
// "standing by" state (idle with a task still running). No React and no Wave runtime imports, so the
// transcript shapes are unit-testable on their own.

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

function startedTask(rec: any, toolUses: Map<string, any>): ShellTask | null {
    const id = rec?.toolUseResult?.backgroundTaskId;
    const content = rec?.message?.content;
    if (typeof id !== "string" || id === "" || !Array.isArray(content)) {
        return null;
    }
    const result = content.find((b: any) => b?.type === "tool_result");
    const input = toolUses.get(result?.tool_use_id)?.input ?? {};
    const command = typeof input.command === "string" ? input.command : "";
    const description =
        typeof input.description === "string" && input.description.trim() !== ""
            ? input.description.trim()
            : command.slice(0, COMMAND_DESCRIPTION_MAX);
    const outputPath =
        redirectTarget(command, typeof rec.cwd === "string" ? rec.cwd : undefined) ??
        /Output is being written to: (.+?)\.(?:\s|$)/.exec(toolResultText(result?.content))?.[1];
    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    return {
        id,
        kind: "shell",
        description,
        ...(command !== "" ? { command } : {}),
        ...(Number.isFinite(ts) ? { startedTs: ts } : {}),
        ...(outputPath ? { outputPath } : {}),
    };
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

/** Pure: the running background shell tasks in transcript JSONL lines, in start order. A start is a
 *  user record carrying toolUseResult.backgroundTaskId; a <task-notification> with a status for that id
 *  (queue-operation enqueue or user-role string) or a successful TaskStop result for it drops it. A
 *  notification for an id with no start in the lines is ignored. Unparseable lines are skipped. */
export function extractShellTasks(lines: string[]): ShellTask[] {
    const toolUses = new Map<string, any>();
    const tasks = new Map<string, ShellTask>();
    // a task that finishes at once can have its enqueue written before its start record
    const finishedEarly = new Set<string>();
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
        const started = rec.type === "user" ? startedTask(rec, toolUses) : null;
        if (started != null) {
            if (!finishedEarly.has(started.id)) {
                tasks.set(started.id, started);
            }
            continue;
        }
        const content = notificationContent(rec);
        for (const id of content != null ? finishedIds(content) : []) {
            if (!tasks.delete(id)) {
                finishedEarly.add(id);
            }
        }
    }
    return [...tasks.values()];
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
