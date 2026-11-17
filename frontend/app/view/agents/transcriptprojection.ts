// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure projection of a Claude Code transcript (JSONL lines) into AgentEntry[].
// No React, no Wave runtime imports. Deterministic; no LLM (spec §5.3).

import type { AgentEntry, CardTask } from "./agentsviewmodel";
import {
    answerAsk,
    askQuestions,
    buildEditDiff,
    editFromPatch,
    parseGrep,
    relativePath,
    sliceRead,
    toolResultImages,
    toolResultText,
    unwrapToolError,
} from "./tooldetail";
import { stripAnsi } from "./testoutput";
import { parseTranscriptLines, type TranscriptRecord } from "./transcriptrecords";

const READ_MODAL_MAX_LINES = 400; // bound stored Read body (modal view); inline uses the per-kind budget

const VERB_BY_TOOL: Record<string, string> = {
    Read: "read",
    Edit: "edited",
    Write: "wrote",
    Bash: "ran",
    Grep: "grep",
    Glob: "glob",
    Task: "spawned",
    Skill: "skill",
    AskUserQuestion: "asked",
};

function verbFor(name: string): string {
    return VERB_BY_TOOL[name] ?? name.toLowerCase();
}

function baseName(p: string): string {
    const parts = p.split(/[/\\]/);
    return parts[parts.length - 1] || p;
}

// the most salient input field, in priority order
function targetFor(input: any): string {
    if (input == null) {
        return "";
    }
    if (typeof input.file_path === "string") {
        return baseName(input.file_path);
    }
    if (typeof input.pattern === "string") {
        return input.pattern;
    }
    if (typeof input.description === "string") {
        return input.description;
    }
    if (typeof input.command === "string") {
        return input.command;
    }
    if (typeof input.skill === "string") {
        return input.skill;
    }
    if (typeof input.questions?.[0]?.question === "string") {
        return input.questions[0].question;
    }
    return "";
}

type ActionEntry = AgentEntry & { kind: "action" };

const HANDBACK_TOOL = "SubagentHandback";

function parseCommand(content: string): { name: string; args?: string } | null {
    const nameMatch = /<command-name>([^]*?)<\/command-name>/.exec(content);
    if (nameMatch == null) {
        return null;
    }
    const raw = nameMatch[1].trim();
    const name = raw.startsWith("/") ? raw : "/" + raw;
    const argsMatch = /<command-args>([^]*?)<\/command-args>/.exec(content);
    const args = argsMatch ? argsMatch[1].trim() : "";
    return args !== "" ? { name, args } : { name };
}

// An errored Bash result that never ran: one that ran and failed opens with its exit code, and one stopped mid-run says
// it was interrupted, so it may have run. Every other error is a refusal before it started (a hook's "Refused by Arc",
// a permission rule, the user declining, a malformed call). An empty body stays a failure.
export function bashNeverRan(body: string): boolean {
    const t = body.trimStart();
    return t !== "" && !/^Exit code \d+/.test(t) && !/^(Interrupted\b|\[Tool call interrupted)/.test(t);
}

// Claude interruption marker, both "[Request interrupted by user]" and the "...for tool use]" variant.
function isInterrupted(text: string): boolean {
    return text.trimStart().startsWith("[Request interrupted by user");
}

type NotificationEntry = Extract<AgentEntry, { kind: "notification" }>;

// claude code writes a notification's summary in a fixed shape whose leading words name what finished
const NOTIFICATION_SOURCES: [RegExp, NonNullable<NotificationEntry["source"]>][] = [
    [/^Background (command|shell)\b/, "command"],
    [/^Monitor\b/, "monitor"],
    [/^Agent\b/, "subagent"],
];

function notificationSource(summary: string): Pick<NotificationEntry, "source"> {
    const hit = NOTIFICATION_SOURCES.find(([re]) => re.test(summary));
    return hit ? { source: hit[1] } : {};
}

// a record is a notification or a command's output only when it opens with the tag: a prompt may quote one later
function opensWith(content: string, tag: string): boolean {
    return content.trimStart().startsWith(tag);
}

// A finished background Task/subagent arrives as a user-role record whose string content is a
// <task-notification> XML block. Parse the human-facing fields; the full <result> is the child's report.
function parseTaskNotification(content: string): NotificationEntry | null {
    if (!opensWith(content, "<task-notification>")) {
        return null;
    }
    const grab = (tag: string): string | undefined => {
        const m = new RegExp(`<${tag}>([^]*?)</${tag}>`).exec(content);
        return m ? m[1].trim() : undefined;
    };
    const result = grab("result");
    const summary = grab("summary") ?? "";
    return {
        kind: "notification",
        summary,
        status: grab("status"),
        ...(result ? { result } : {}),
        ...notificationSource(summary),
    };
}

// a `!` command's two user records in Claude Code's bash mode: the input, then its output
const BASH_INPUT_RE = /^<bash-input>([^]*)<\/bash-input>$/;
const BASH_OUTPUT_RE = /^<bash-stdout>([^]*?)<\/bash-stdout>\s*<bash-stderr>([^]*?)<\/bash-stderr>$/;

// true when content is a bash-mode record: an input pushes a shell entry, an output fills the newest one still running.
// An output with no running entry adds nothing.
function applyBashRecord(entries: AgentEntry[], content: string, rec: any): boolean {
    const text = content.trim();
    const input = BASH_INPUT_RE.exec(text);
    if (input != null) {
        entries.push({ kind: "shell", command: input[1].trim(), ...recTs(rec) });
        return true;
    }
    const output = BASH_OUTPUT_RE.exec(text);
    if (output == null) {
        return false;
    }
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.kind === "shell") {
            if (e.stdout === undefined) {
                e.stdout = stripAnsi(output[1]);
                e.stderr = stripAnsi(output[2]);
            }
            break;
        }
    }
    return true;
}

const COMMAND_OUTPUT_RE = /^<local-command-(?:stdout|stderr)>([^]*?)<\/local-command-(?:stdout|stderr)>$/;

// a slash command's printed output fills the command right before it when that one has none yet; /compact keeps its own
// divider. An output anywhere else adds nothing, and is never a user bubble.
function applyCommandOutput(entries: AgentEntry[], content: string): boolean {
    const m = COMMAND_OUTPUT_RE.exec(content.trim());
    if (m == null) {
        return false;
    }
    const last = entries[entries.length - 1];
    const text = stripAnsi(m[1]).trim();
    if (last?.kind === "command" && last.name !== "/compact" && last.output === undefined && text !== "") {
        last.output = text;
    }
    return true;
}

// A background-task notice delivered mid-turn. A structured prompt reads like a finished subagent's notification; a
// free-text one is just the text inside the tag.
function parseNotice(prompt: string): NotificationEntry | null {
    const structured = prompt.includes("<summary>") ? parseTaskNotification(prompt) : null;
    if (structured != null) {
        return { ...structured, notice: true };
    }
    const m = /<task-notification>([^]*?)<\/task-notification>/.exec(prompt);
    const summary = (m ? m[1] : prompt).trim();
    return summary !== "" ? { kind: "notification", summary, notice: true, ...notificationSource(summary) } : null;
}

// the tag claude code wraps a long typed or pasted message in; pastedContentRe in pkg/agentsessions/humanprompts.go
const PASTED_CONTENT_RE = /<pasted_content id="[^"]+">\n?([^]*?)\n?<\/pasted_content id="[^"]+">/g;

function unwrapPasted(text: string): string {
    return text.replace(PASTED_CONTENT_RE, "$1");
}

// the arc mod's plugin name, on its joined rows
const ARC_PLUGIN = "arc";

// the record's time as a spreadable `{ ts }`; empty when absent or unparseable so the key stays off the entry
function recTs(rec: any): { ts?: number } {
    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    return Number.isFinite(ts) ? { ts } : {};
}

// An attachment record of a message typed while the agent worked. claude code writes no user record for it, so this is
// its only trace. The attachment's own timestamp wins over the record's.
function queuedEntry(rec: any): AgentEntry | null {
    const att = rec.attachment;
    const prompt = typeof att.prompt === "string" ? att.prompt : "";
    if (att.commandMode === "task-notification") {
        return parseNotice(prompt);
    }
    if (att.commandMode !== "prompt" || prompt.trim() === "") {
        return null;
    }
    return { kind: "user", text: unwrapPasted(prompt), queued: true, ...recTs({ timestamp: att.timestamp ?? rec.timestamp }) };
}

// A text the arc mod held while the agent worked and joined to the turn at a tool result: a meta record of the arc
// plugin, read at the step where it was written. Who wrote it is not recorded, so it draws by its text.
function joinedEntries(rec: any): AgentEntry[] {
    if (rec.origin?.kind !== "plugin" || rec.origin?.name !== ARC_PLUGIN) {
        return [];
    }
    const content = rec.message?.content;
    const texts =
        typeof content === "string"
            ? [content]
            : Array.isArray(content)
              ? content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text)
              : [];
    return texts
        .filter((t: string) => t.trim() !== "")
        .map((t: string) => ({ kind: "user", text: unwrapPasted(t), queued: true, ...recTs(rec) }));
}

// The same join as Claude Code 2.1.326+ writes it: a plugin_note attachment, its content the note's lines. A note whose
// content is empty is one the engine holds and has not sent (heldContent only), so the agent has not read it.
function noteEntry(rec: any): AgentEntry | null {
    const att = rec.attachment;
    if (att.plugin !== ARC_PLUGIN || !Array.isArray(att.content)) {
        return null;
    }
    const text = att.content.filter((l: unknown) => typeof l === "string").join("\n");
    if (text.trim() === "") {
        return null;
    }
    return { kind: "user", text: unwrapPasted(text), queued: true, ...recTs(rec) };
}

function mergeCompaction(entries: AgentEntry[], patch: Partial<Extract<AgentEntry, { kind: "compaction" }>>): void {
    const last = entries[entries.length - 1];
    if (last != null && last.kind === "compaction") {
        Object.assign(last, patch);
        return;
    }
    entries.push({ kind: "compaction", ...patch });
}

function hasText(content: unknown): boolean {
    return Array.isArray(content) && content.some((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "");
}

// Claude Code writes each block of one API message as its own record, sharing message.id; a record with neither id is a
// message of its own
function messageKey(rec: any): string | undefined {
    const id = rec?.message?.id ?? rec?.uuid;
    return typeof id === "string" ? id : undefined;
}

// the messages that have reply text somewhere among their records: their thinking stays hidden
function repliedMessages(records: readonly TranscriptRecord[]): Set<string> {
    const replied = new Set<string>();
    for (const r of records) {
        const rec: any = r;
        const key = messageKey(rec);
        if (rec?.type === "assistant" && key != null && hasText(rec.message?.content)) {
            replied.add(key);
        }
    }
    return replied;
}

/** Pure: project transcript JSONL lines into ordered previous-info entries.
 *  assistant text -> message; thinking of a message with no text -> thought; tool_use -> action; tool_result -> outcome on the matching
 *  action (fail on error; ok only for "ran", to avoid a checkmark on every read/edit).
 *  Unparseable lines and unknown record types are skipped. */
export function projectTranscript(lines: string[]): AgentEntry[] {
    return projectTranscriptRecords(parseTranscriptLines(lines));
}

/** Pure: projectTranscript over records parsed once (transcriptrecords.ts); reads them, never mutates one. */
export function projectTranscriptRecords(records: readonly TranscriptRecord[]): AgentEntry[] {
    const entries: AgentEntry[] = [];
    const actionById = new Map<string, ActionEntry>();
    const replied = repliedMessages(records);
    // the message the last thought came from, so its next thinking block joins that thought
    let thoughtFrom: string | undefined;
    for (const r of records) {
        const rec: any = r;
        if (rec == null) {
            continue;
        }
        if (rec.type === "assistant") {
            const content = rec?.message?.content;
            if (!Array.isArray(content)) {
                continue;
            }
            const key = messageKey(rec);
            const silent = key != null ? !replied.has(key) : !hasText(content);
            for (const block of content) {
                if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
                    entries.push({ kind: "message", text: block.text, ...recTs(rec) });
                    continue;
                }
                if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim() !== "") {
                    if (!silent) {
                        continue;
                    }
                    const text = block.thinking.trim();
                    const last = entries[entries.length - 1];
                    if (last?.kind === "thought" && key != null && thoughtFrom === key) {
                        last.text += "\n\n" + text;
                    } else {
                        entries.push({ kind: "thought", text, ...recTs(rec) });
                        thoughtFrom = key;
                    }
                    continue;
                }
                if (block?.type === "tool_use" && typeof block.name === "string") {
                    // a subagent's internal report-back call: plumbing, not work it did (its result then matches no action)
                    if (block.name === HANDBACK_TOOL) {
                        continue;
                    }
                    // a Skill tool call is always the model's (caller.type "direct" is set on every model call); a typed
                    // /skill arrives as a <command-name> user record instead
                    const action: ActionEntry = {
                        kind: "action",
                        verb: verbFor(block.name),
                        target: targetFor(block.input),
                        ...recTs(rec),
                    };
                    if (block.name === "Bash" && typeof block.input?.command === "string") {
                        action.command = block.input.command;
                    }
                    const cwd = typeof rec.cwd === "string" ? rec.cwd : undefined;
                    const filePath = relativePath(String(block.input?.file_path ?? ""), cwd);
                    if (block.name === "Edit" && block.input && typeof block.input.old_string === "string") {
                        action.detail = {
                            kind: "edit",
                            files: [
                                buildEditDiff(filePath, block.input.old_string, String(block.input.new_string ?? "")),
                            ],
                        };
                    } else if (block.name === "Write" && block.input && typeof block.input.content === "string") {
                        action.detail = {
                            kind: "edit",
                            files: [buildEditDiff(filePath, "", block.input.content)],
                        };
                    } else if (block.name === "Skill" && block.input && typeof block.input.skill === "string") {
                        const args = typeof block.input.args === "string" ? block.input.args.trim() : "";
                        action.detail = { kind: "skill", name: block.input.skill, args: args !== "" ? args : undefined };
                    } else if (block.name === "AskUserQuestion" && Array.isArray(block.input?.questions)) {
                        action.detail = { kind: "ask", questions: askQuestions(block.input.questions) };
                    }
                    // scratch fields (stripped before return): tool_use timestamp for duration, tool name for result
                    // routing
                    (action as any)._useTs = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
                    (action as any)._tool = block.name;
                    // the call's input and cwd, for the panel data its result fills
                    (action as any)._input = block.input;
                    (action as any)._cwd = cwd;
                    entries.push(action);
                    if (typeof block.id === "string") {
                        // same object lives in entries and the map; a later tool_result mutates
                        // outcome/detail through the map reference and the entries copy updates with it
                        actionById.set(block.id, action);
                    }
                }
            }
            continue;
        }
        if (rec.type === "user") {
            if (rec.isMeta === true) {
                // every other meta record (a skill body, a caveat) is plumbing
                entries.push(...joinedEntries(rec));
                continue;
            }
            if (rec.isCompactSummary === true) {
                const raw = rec?.message?.content;
                const summary =
                    typeof raw === "string"
                        ? raw
                        : Array.isArray(raw)
                          ? raw
                                .filter((b: any) => b?.type === "text")
                                .map((b: any) => b.text)
                                .join("\n")
                          : "";
                mergeCompaction(entries, summary.trim() !== "" ? { summary } : {});
                continue;
            }
            const content = rec?.message?.content;
            if (typeof content === "string") {
                if (applyBashRecord(entries, content, rec)) {
                    continue;
                }
                const note = parseTaskNotification(content);
                if (note != null) {
                    // its own record starts a turn, so the turn's time starts at it
                    entries.push({ ...note, ...recTs(rec) });
                } else if (applyCommandOutput(entries, content)) {
                    // handled: the output sits under its command, or draws nothing. Never a user bubble.
                } else if (opensWith(content, "<local-command-stdout>")) {
                    // slash-command stdout mixed with other text: not shown
                } else if (isInterrupted(content)) {
                    entries.push({ kind: "interrupted" });
                } else {
                    const cmd = parseCommand(content);
                    if (cmd != null) {
                        entries.push({ kind: "command", ...cmd, ...recTs(rec) });
                    } else if (content.trim() !== "") {
                        entries.push({ kind: "user", text: unwrapPasted(content), ...recTs(rec) });
                    }
                }
                continue;
            }
            if (!Array.isArray(content)) {
                continue;
            }
            const firstEntry = entries.length;
            for (const block of content) {
                if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
                    entries.push(
                        isInterrupted(block.text)
                            ? { kind: "interrupted" }
                            : { kind: "user", text: unwrapPasted(block.text), ...recTs(rec) }
                    );
                    continue;
                }
                if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") {
                    continue;
                }
                const action = actionById.get(block.tool_use_id);
                if (action == null) {
                    continue;
                }
                (action as any)._done = true;
                const body = toolResultText(block.content);
                const images = toolResultImages(block.content);
                if (images.length > 0) {
                    action.images = images;
                }
                const tool = (action as any)._tool as string | undefined;
                const input = (action as any)._input;
                const cwd = (action as any)._cwd as string | undefined;
                const failed = block.is_error === true;
                const blocked = tool === "Bash" && failed && bashNeverRan(body);
                // a Bash call that ran and failed tells why in its output, so only one that never ran carries an error
                const error = failed && (tool !== "Bash" || blocked) ? unwrapToolError(body) : "";
                if (error !== "") {
                    action.error = error;
                }
                if (tool === "Grep" && body && !failed) {
                    const matches = parseGrep(body).map((m) => (m.loc ? { ...m, loc: relativePath(m.loc, cwd) } : m));
                    action.detail = {
                        kind: "grep",
                        matches,
                        ...(typeof input?.pattern === "string" ? { pattern: input.pattern } : {}),
                        ...(input?.["-i"] === true ? { ignoreCase: true } : {}),
                    };
                    action.summary = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
                } else if ((tool === "Read" || tool === "Glob") && body && !failed) {
                    const { snippet, truncated } = sliceRead(body, READ_MODAL_MAX_LINES);
                    action.detail = {
                        kind: "read",
                        snippet,
                        truncated,
                        ...(tool === "Read" && typeof input?.file_path === "string"
                            ? { path: relativePath(input.file_path, cwd) }
                            : {}),
                    };
                    action.summary = `${body.split("\n").length} lines`;
                } else if (tool === "Bash" && body) {
                    action.detail = {
                        kind: "bash",
                        command: action.command,
                        // a call that never ran has no output; its reason is the error
                        output: blocked ? "" : stripAnsi(body),
                        exit: blocked ? null : failed ? 1 : 0,
                    };
                } else if (action.detail?.kind === "edit") {
                    // the file's own hunks, numbered; the tool_use's old/new strings stay when the result has none
                    const numbered = editFromPatch(action.detail.files[0].path, rec.toolUseResult?.structuredPatch);
                    if (numbered != null) {
                        action.detail = { kind: "edit", files: [numbered] };
                    }
                } else if (action.detail?.kind === "ask" && typeof rec.toolUseResult?.answers === "object") {
                    // the answers ride on the record, keyed by question text; a rejected call carries a string there
                    action.summary = answerAsk(action.detail.questions, rec.toolUseResult.answers ?? {});
                }
                const resTs = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
                const useTs = (action as any)._useTs as number;
                if (Number.isFinite(resTs) && Number.isFinite(useTs) && resTs >= useTs) {
                    action.durationMs = resTs - useTs;
                }
                if (blocked) {
                    action.outcome = "blocked";
                } else if (block.is_error === true) {
                    action.outcome = "fail";
                } else if (action.verb === "ran") {
                    action.outcome = "ok";
                }
            }
            // pasted images ride on the record's user entry; a record of images alone gets an empty-text one, but one that
            // holds an interruption marker gets none
            const images = toolResultImages(content);
            if (images.length > 0) {
                const own = entries.slice(firstEntry);
                const user = own.find((e) => e.kind === "user");
                if (user != null && user.kind === "user") {
                    user.images = images;
                } else if (!own.some((e) => e.kind === "interrupted")) {
                    entries.push({ kind: "user", text: "", images, ...recTs(rec) });
                }
            }
            continue;
        }
        if (rec.type === "attachment" && rec.attachment?.type === "plugin_note") {
            const entry = noteEntry(rec);
            if (entry != null) {
                entries.push(entry);
            }
            continue;
        }
        if (rec.type === "attachment" && rec.attachment?.type === "queued_command") {
            const entry = queuedEntry(rec);
            if (entry != null) {
                entries.push(entry);
            }
            continue;
        }
        if (rec.type === "system" && rec.subtype === "compact_boundary") {
            const m = rec.compactMetadata ?? {};
            const patch: Partial<Extract<AgentEntry, { kind: "compaction" }>> = {};
            if (typeof m.trigger === "string") {
                patch.trigger = m.trigger;
            }
            if (typeof m.preTokens === "number") {
                patch.preTokens = m.preTokens;
            }
            if (typeof m.postTokens === "number") {
                patch.postTokens = m.postTokens;
            }
            mergeCompaction(entries, patch);
            continue;
        }
    }
    // strip private scratch fields so they never leak into the AgentEntry contract
    for (const e of entries) {
        if (e.kind === "action") {
            const useTs = (e as any)._useTs as number;
            if (!e.outcome && Number.isFinite(useTs)) {
                e.startedTs = useTs;
            }
            if (!(e as any)._done) {
                e.pending = true;
            }
            delete (e as any)._done;
            delete (e as any)._useTs;
            delete (e as any)._tool;
            delete (e as any)._input;
            delete (e as any)._cwd;
        }
    }
    return entries;
}

/** Pure: the task list from the LATEST TodoWrite tool_use in the transcript, or undefined if the
 *  agent never wrote a todo list. `completed` -> done; every other status is not-done. Malformed
 *  todo entries (missing/non-string content) are skipped; an empty todo list yields []. */
export function extractTasks(lines: string[]): CardTask[] | undefined {
    return extractTasksRecords(parseTranscriptLines(lines));
}

/** Pure: extractTasks over records parsed once (transcriptrecords.ts); reads them, never mutates one. */
export function extractTasksRecords(records: readonly TranscriptRecord[]): CardTask[] | undefined {
    let latest: unknown[] | undefined;
    for (const r of records) {
        const rec: any = r;
        if (rec == null) {
            continue;
        }
        if (rec?.type !== "assistant" || !Array.isArray(rec?.message?.content)) {
            continue;
        }
        for (const block of rec.message.content) {
            if (block?.type === "tool_use" && block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {
                latest = block.input.todos;
            }
        }
    }
    if (latest == null) {
        return undefined;
    }
    const tasks: CardTask[] = [];
    for (const todo of latest) {
        const t = todo as any;
        if (typeof t?.content !== "string") {
            continue;
        }
        tasks.push({ text: t.content, done: t.status === "completed" });
    }
    return tasks;
}

/** Pure: the most recent ai-title in the transcript, or undefined. Claude Code emits multiple
 *  `{type:"ai-title", aiTitle}` records as the title is refined; the last one is current. */
export function extractAiTitle(lines: string[]): string | undefined {
    let title: string | undefined;
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        if (rec?.type === "ai-title" && typeof rec.aiTitle === "string" && rec.aiTitle.trim() !== "") {
            title = rec.aiTitle;
        }
    }
    return title;
}

export interface SubagentSpawn {
    toolUseId: string;
    subagentType: string;
    prompt: string;
    done: boolean;
    failed: boolean;
    background: boolean; // its tool_result is only the launch ack; a <task-notification> ends it
}

const NOTIFICATION_COMPLETED = "completed";

// a background launch ack: the record's toolUseResult says the agent went async
function isAsyncLaunch(toolUseResult: any): boolean {
    return toolUseResult?.isAsync === true || toolUseResult?.status === "async_launched";
}

function notificationTag(text: string, tag: string): string | undefined {
    const m = new RegExp(`<${tag}>([^]*?)</${tag}>`).exec(text);
    return m ? m[1].trim() : undefined;
}

// ends the background spawn a <task-notification> names; a foreground spawn is ended by its tool_result alone
function applyTaskNotification(spawns: Map<string, SubagentSpawn>, text: string): void {
    if (!text.includes("<task-notification>")) {
        return;
    }
    const s = spawns.get(notificationTag(text, "tool-use-id") ?? "");
    if (s == null || !s.background) {
        return;
    }
    s.done = true;
    s.failed = notificationTag(text, "status") !== NOTIFICATION_COMPLETED;
}

/** Pure: Task/Agent tool_use blocks in a Claude transcript -> subagent spawns, each joined to its
 *  tool_result by tool_use_id (done + failed via is_error). A spawn with no matching result is still
 *  running (done=false). A result that is an async launch ack marks the spawn background and leaves it
 *  running until a <task-notification> names it. Spawns keep first-seen order; non-Task tools are ignored. */
export function extractSubagentSpawns(lines: string[]): SubagentSpawn[] {
    const spawns = new Map<string, SubagentSpawn>();
    const order: string[] = [];
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        const content = rec?.message?.content;
        if (typeof content === "string") {
            applyTaskNotification(spawns, content);
            continue;
        }
        if (!Array.isArray(content)) {
            continue;
        }
        for (const block of content) {
            if (
                block?.type === "tool_use" &&
                (block.name === "Task" || block.name === "Agent") &&
                typeof block.id === "string"
            ) {
                const input = block.input ?? {};
                spawns.set(block.id, {
                    toolUseId: block.id,
                    subagentType: typeof input.subagent_type === "string" ? input.subagent_type : "",
                    prompt: typeof input.prompt === "string" ? input.prompt : "",
                    done: false,
                    failed: false,
                    background: false,
                });
                order.push(block.id);
            } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
                const s = spawns.get(block.tool_use_id);
                if (s == null) {
                    continue;
                }
                if (block.is_error !== true && isAsyncLaunch(rec.toolUseResult)) {
                    s.background = true;
                    continue;
                }
                s.done = true;
                s.failed = block.is_error === true;
            } else if (block?.type === "text" && typeof block.text === "string") {
                applyTaskNotification(spawns, block.text);
            }
        }
    }
    return order.map((id) => spawns.get(id)!);
}
