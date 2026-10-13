// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure projection of a claude transcript into its background shell tasks: which are still running,
// which failed, and the derived "standing by" state (idle with a task still running). No React and
// no Wave runtime imports, so the transcript shapes are unit-testable on their own.

export interface ShellTask {
    id: string;
    description: string;
    state: "running" | "failed";
    startedTs?: number;
    outputPath?: string;
    exitCode?: number;
}

// a cap, not a guarantee: a task started before the last 2000 transcript records is not listed.
export const SHELL_TAIL_LINES = 2000;

// the cut detailForTool applies to a Bash command in cmd/wsh/cmd/wshcmd-agenthook.go.
const COMMAND_DESCRIPTION_MAX = 60;

const OUTPUT_MAX_CHARS = 64 * 1024;
const EXITED_LINE = /^\[exited with code (-?\d+)\]$/;

type Settled = "running" | "failed" | "gone";

interface TrackedTask extends Omit<ShellTask, "state"> {
    state: Settled;
}

interface Notification {
    ids: string[];
    status: string;
    summary: string;
    outputFile?: string;
}

function tag(content: string, name: string): string | undefined {
    const m = new RegExp(`<${name}>([^]*?)</${name}>`).exec(content);
    return m ? m[1].trim() : undefined;
}

// a session that died with tasks running reports them all in one notification with no <task-id>,
// naming them in the summary instead.
function parseNotification(content: string): Notification | null {
    if (!content.includes("<task-notification>")) {
        return null;
    }
    const status = tag(content, "status");
    if (status == null) {
        // a Monitor event, not a finish
        return null;
    }
    const summary = tag(content, "summary") ?? "";
    const id = tag(content, "task-id");
    const listed = /Task ids: ([^]*)$/.exec(summary)?.[1];
    const ids =
        id != null
            ? [id]
            : (listed
                  ?.split(/[,\s]+/)
                  .map((s) => s.replace(/\.$/, ""))
                  .filter(Boolean) ?? []);
    return { ids, status, summary, outputFile: tag(content, "output-file") };
}

// completed means a clean finish even with a nonzero code (grep's "No matches found"); killed and
// stopped mean the task was ended from outside, which drops it as a clean finish does.
const DROPPING_STATUSES = new Set(["completed", "killed", "stopped"]);

function settle(task: TrackedTask, note: Notification): void {
    if (DROPPING_STATUSES.has(note.status)) {
        task.state = "gone";
        return;
    }
    if (note.status !== "failed") {
        return;
    }
    task.state = "failed";
    const code = /exit code (-?\d+)/.exec(note.summary)?.[1];
    if (code != null) {
        task.exitCode = Number(code);
    }
    task.outputPath ??= note.outputFile;
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

function startedTask(rec: any, toolUses: Map<string, any>): TrackedTask | null {
    const id = rec?.toolUseResult?.backgroundTaskId;
    const content = rec?.message?.content;
    if (typeof id !== "string" || id === "" || !Array.isArray(content)) {
        return null;
    }
    const result = content.find((b: any) => b?.type === "tool_result");
    const input = toolUses.get(result?.tool_use_id)?.input ?? {};
    const description =
        typeof input.description === "string" && input.description.trim() !== ""
            ? input.description.trim()
            : String(input.command ?? "").slice(0, COMMAND_DESCRIPTION_MAX);
    const outputPath =
        redirectTarget(String(input.command ?? ""), typeof rec.cwd === "string" ? rec.cwd : undefined) ??
        /Output is being written to: (.+?)\.(?:\s|$)/.exec(toolResultText(result?.content))?.[1];
    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    return {
        id,
        description,
        state: "running",
        ...(Number.isFinite(ts) ? { startedTs: ts } : {}),
        ...(outputPath ? { outputPath } : {}),
    };
}

// a stdout redirect outside quotes: `>`, `>>`, `1>` or `&>`, then a quoted or bare target. `2>` and `>&2`
// never match, so a stderr-only redirect leaves the output in claude's own file
const STDOUT_REDIRECT = /(?:^|[\s;|&(])(?:1|&)?>>?\s*("[^"]*"|'[^']*'|[^\s;|&<>()]+)/g;
const QUOTED = /"[^"]*"|'[^']*'/g;
const DISCARD_TARGET = /^(?:\/dev\/|nul$)/i;
const ABSOLUTE_TARGET = /^(?:[/~]|[A-Za-z]:[\\/])/;

/** Pure: the file a shell command's stdout ends up in, when it redirects it away from claude's output file.
 *  The last redirect wins. Git Bash forms (/tmp, /c/, ~) are left for wavesrv to resolve; a relative target
 *  is joined to cwd, and one with a variable in it is not readable. */
export function redirectTarget(command: string, cwd: string | undefined): string | undefined {
    // quoted text is masked so a `>` inside a quoted script is not a redirect; targets are cut from the original
    const masked = command.replace(QUOTED, (q) => q[0] + "_".repeat(q.length - 2) + q[0]);
    let target: string | undefined;
    for (const m of masked.matchAll(STDOUT_REDIRECT)) {
        const start = m.index + m[0].length - m[1].length;
        target = command.slice(start, start + m[1].length).replace(/^(["'])(.*)\1$/, "$2");
    }
    if (target == null || target === "" || DISCARD_TARGET.test(target) || /[$`]/.test(target)) {
        return undefined;
    }
    if (ABSOLUTE_TARGET.test(target)) {
        return target;
    }
    return cwd ? `${cwd.replace(/[\\/]$/, "")}/${target}` : undefined;
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

/** Pure: the running and failed background shell tasks in transcript JSONL lines, in start order.
 *  A start is a user record carrying toolUseResult.backgroundTaskId; a <task-notification> for that
 *  id (queue-operation enqueue or user-role string, the later one winning) settles it, and a
 *  successful TaskStop result for it drops it. A notification
 *  for an id with no start in the lines is ignored. Unparseable lines are skipped. */
export function extractShellTasks(lines: string[]): ShellTask[] {
    const toolUses = new Map<string, any>();
    const tasks = new Map<string, TrackedTask>();
    // a task that finishes at once can have its enqueue written before its start record
    const earlyNotes = new Map<string, Notification>();
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
            tasks.get(stoppedId).state = "gone";
            continue;
        }
        const started = rec.type === "user" ? startedTask(rec, toolUses) : null;
        if (started != null) {
            const early = earlyNotes.get(started.id);
            if (early != null) {
                settle(started, early);
            }
            tasks.set(started.id, started);
            continue;
        }
        const content = notificationContent(rec);
        const note = content != null ? parseNotification(content) : null;
        for (const id of note?.ids ?? []) {
            const task = tasks.get(id);
            if (task != null) {
                settle(task, note);
            } else {
                earlyNotes.set(id, note);
            }
        }
    }
    return [...tasks.values()].filter((t): t is ShellTask => t.state !== "gone");
}

export function visibleShellTasks(all: ShellTask[]): ShellTask[] {
    return all.filter((t) => t.state === "running" || t.state === "failed");
}

export function isStandingBy(state: string, tasks: ShellTask[]): boolean {
    return state === "idle" && tasks.some((t) => t.state === "running");
}

export function shellTasksLabel(n: number): string {
    return n === 1 ? "1 shell task" : `${n} shell tasks`;
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

export function failedLabel(task: ShellTask): string {
    return task.exitCode != null ? `failed · exit ${task.exitCode}` : "failed";
}

export interface ShellTaskStatus {
    label: string;
    tone: "accent" | "error" | "muted";
    // a running task's output is still growing, so it is re-read
    live: boolean;
}

/** The output pane's state for a task, or for its last known snapshot once it left the visible list:
 *  a task leaves it only by finishing cleanly or being ended from outside. */
export function shellTaskStatus(task: ShellTask, finished: boolean): ShellTaskStatus {
    if (finished) {
        return { label: "finished", tone: "muted", live: false };
    }
    if (task.state === "running") {
        return { label: "running", tone: "accent", live: true };
    }
    return { label: failedLabel(task), tone: "error", live: false };
}

/** Whether an output line is the trailing exit marker of a nonzero exit. Only the last line counts: the
 *  same text earlier is the command's own output. */
export function isFailedExitLine(line: string, last: boolean): boolean {
    const code = last ? EXITED_LINE.exec(line.trim())?.[1] : undefined;
    return code != null && Number(code) !== 0;
}
