// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure projection of a Claude Code transcript (JSONL lines) into AgentEntry[].
// No React, no Wave runtime imports. Deterministic; no LLM (spec §5.3).

import type { AgentActionEntry, AgentEntry, CardTask } from "./agentsviewmodel";
import {
    answerAsk,
    askQuestions,
    buildEditDiff,
    cleanToolText,
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

// the tools that run a shell command: each draws as a command with its output and exit
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

const VERB_BY_TOOL: Record<string, string> = {
    Read: "read",
    Edit: "edited",
    Write: "wrote",
    Bash: "ran",
    PowerShell: "ran",
    Grep: "grep",
    Glob: "glob",
    Task: "spawned",
    Skill: "skill",
    AskUserQuestion: "asked",
};

const MCP_PREFIX = "mcp__";

// an unmapped tool name as words: an MCP tool's own name ("mcp__server__update_plan"), camelCase and snake_case spaced
export function readableVerb(name: string): string {
    const own = name.startsWith(MCP_PREFIX) ? name.split("__").slice(2).join("_") || name : name;
    return own
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_\s]+/g, " ")
        .trim()
        .toLowerCase();
}

function verbFor(name: string): string {
    return VERB_BY_TOOL[name] ?? readableVerb(name);
}

function baseName(p: string): string {
    const parts = p.split(/[/\\]/);
    return parts[parts.length - 1] || p;
}

// the input fields that name what any other tool acts on (a search's query, a fetch's url, a stopped task, a wakeup's
// reason over its prompt), in priority order
const TARGET_FIELDS = ["title", "query", "url", "task_id", "shell_id", "reason", "prompt"];

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
    const field = TARGET_FIELDS.find((k) => typeof input[k] === "string" && input[k].trim() !== "");
    return field != null ? input[field] : "";
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

// a failed command's exit code from its result's opening "Exit code N"; one with none (stopped mid-run) reads 1, since
// every reader only compares the code to 0
function failedExit(body: string): number {
    const m = /^Exit code (\d+)/.exec(body.trimStart());
    return m ? Number(m[1]) : 1;
}

function plural(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// Glob's result lists one path per line, or says it found none; a capped list ends with a note that is no path
function globSummary(body: string): string {
    if (body.trim() === "No files found") {
        return "no files";
    }
    return plural(body.split("\n").filter((l) => l !== "" && !l.startsWith("(Results are truncated")).length, "file");
}

// Claude Code's words when the user rejects a call at its permission prompt. Each refusal opens the result, so a
// command that ran and printed one is no refusal
const USER_REJECTED_RE = /^(?:The user doesn't want to proceed with this tool use|The tool use was rejected)\b/;
// a permission rule or check denying a call; its own words name the rule
const PERMISSION_DENIED_RE =
    /^(?:Permission (?:to|for) [^\n]*?\b(?:has been|was) denied\b|[^\n]*\bdenied by your permission settings\b)/;
// the record's mark of a call refused at the permission prompt, whose text is the prompt's reason ("Command contains
// subexpressions $()")
const USER_REJECTED_KIND = "user-rejected";
const DECLINED_QUESTION = "You declined the question, so Claude stopped and waited for you.";
const DECLINED_CALL = "You declined this call, so Claude stopped and waited for you.";

function firstSentence(text: string): string {
    const line = text.trim().split("\n")[0];
    return /^[^]*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line;
}

// the reason line of a call the user declined or a permission denied, else null: the user's refusal boilerplate gives
// way to a line of ours, and a denial keeps its first sentence
function declinedReason(tool: string | undefined, error: string, rec: any): string | null {
    if (USER_REJECTED_RE.test(error)) {
        return tool === "AskUserQuestion" ? DECLINED_QUESTION : DECLINED_CALL;
    }
    if (PERMISSION_DENIED_RE.test(error) || rec?.toolDenialKind === USER_REJECTED_KIND) {
        return firstSentence(error);
    }
    return null;
}

// an InputValidationError is its message, then a paragraph of advice and the tool's whole JSON schema
function toolError(body: string): string {
    const error = unwrapToolError(body);
    return /^InputValidationError\b/.test(error) ? error.split(/\n\s*\n/)[0].trim() : error;
}

// lines the harness appends to a tool's result, about the session rather than the call
const HARNESS_LINES = [
    /^Shell cwd was reset to /,
    /^\[This command modified \d+ files? you've previously read\b/,
    /^Command running in background with ID: /,
];

// a tool result as the panel shows it: clean text with no harness lines
function cleanToolBody(body: string): string {
    return cleanToolText(body)
        .split("\n")
        .filter((line) => !HARNESS_LINES.some((re) => re.test(line)))
        .join("\n");
}

const XML_ENTITIES: Record<string, string> = {
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&#39;": "'",
    "&amp;": "&",
};

// one pass, so an escaped entity ("&amp;lt;") decodes to its text ("&lt;") and no further
function decodeXml(text: string): string {
    return text.replace(/&(?:lt|gt|quot|apos|#39|amp);/g, (m) => XML_ENTITIES[m]);
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
    // claude code escapes the fields' XML
    const grab = (tag: string): string | undefined => {
        const m = new RegExp(`<${tag}>([^]*?)</${tag}>`).exec(content);
        return m ? decodeXml(m[1].trim()) : undefined;
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

// the tools that spawn a subagent
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

// A background shell or Monitor finishing sends a <task-notification> too. It is a subagent's when it names a Task/Agent
// call, or, when that call is not in view, carries the child's <result>.
function isSubagentFinish(content: string, actionById: Map<string, ActionEntry>): boolean {
    const id = /<tool-use-id>([^<]*)<\/tool-use-id>/.exec(content)?.[1].trim();
    const tool = id != null ? ((actionById.get(id) as any)?._tool as string | undefined) : undefined;
    return tool != null ? SUBAGENT_TOOLS.has(tool) : content.includes("<result>");
}

// a subagent finish carries the id of the Agent call it ends, which links it to that call's subagent
function withFinishId(note: NotificationEntry, content: string): NotificationEntry {
    const id = note.source === "subagent" ? notificationTag(content, "tool-use-id") : undefined;
    return id ? { ...note, toolUseId: id } : note;
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
        return { ...withFinishId(structured, prompt), notice: true };
    }
    const m = /<task-notification>([^]*?)<\/task-notification>/.exec(prompt);
    const summary = (m ? m[1] : prompt).trim();
    return summary !== "" ? { kind: "notification", summary, notice: true, ...notificationSource(summary) } : null;
}

// A subagent's report as Claude Code 2.1.330+ hands it back, a message from a peer session: the frame's tag, one
// "[Subagent hand-back]" preamble line, then the report with each line indented two spaces
const HAND_BACK_RE = /^<agent-message from="[^"]*">\n\[Subagent hand-back\][^\n]*\n([^]*?)\n?<\/agent-message>$/;

// a hand-back as the subagent's notice, its report dedented; name is the subagent's type when the record carries it
function parseHandBack(text: string, name: unknown): NotificationEntry | null {
    const m = HAND_BACK_RE.exec(text.trim());
    if (m == null) {
        return null;
    }
    const result = m[1].replace(/^ {2}/gm, "");
    return {
        kind: "notification",
        summary: typeof name === "string" && name !== "" ? `Agent "${name}" reported` : "Agent reported",
        ...(result.trim() !== "" ? { result } : {}),
        notice: true,
        source: "subagent",
    };
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
    const ts = recTs({ timestamp: att.timestamp ?? rec.timestamp });
    const handBack = att.origin?.kind === "peer" ? parseHandBack(prompt, att.origin.name) : null;
    return handBack != null ? { ...handBack, ...ts } : { kind: "user", text: unwrapPasted(prompt), queued: true, ...ts };
}

// a slash command's user record; the meta record right after it is the command's expansion (a skill body)
function isCommandRecord(rec: any): boolean {
    const content = rec?.type === "user" ? rec.message?.content : undefined;
    return typeof content === "string" && parseCommand(content) != null;
}

// A text the arc mod held while the agent worked and joined to the turn at a tool result: a meta record of the arc
// plugin, read at the step where it was written. Who wrote it is not recorded, so it draws by its text. A slash command
// the mod delivered carries the same origin on its expansion, which is plumbing like any other skill body.
function joinedEntries(rec: any, prev: any): AgentEntry[] {
    if (rec.origin?.kind !== "plugin" || rec.origin?.name !== ARC_PLUGIN || isCommandRecord(prev)) {
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

// the harness note Claude Code writes into a compaction summary (the tools used before it); as raw HTML it swallows the
// markdown after it
const SYSTEM_REMINDER_RE = /<system-reminder>[^]*?<\/system-reminder>\n?/g;

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
    for (let i = 0; i < records.length; i++) {
        const rec: any = records[i];
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
                    if (SHELL_TOOLS.has(block.name) && typeof block.input?.command === "string") {
                        action.command = block.input.command;
                    }
                    if (SUBAGENT_TOOLS.has(block.name) && typeof block.id === "string") {
                        action.toolUseId = block.id;
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
                        // the row already names the skill, so without args there is no body and the row stays plain
                        const args = typeof block.input.args === "string" ? block.input.args.trim() : "";
                        if (args !== "") {
                            action.detail = { kind: "skill", name: block.input.skill, args };
                        }
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
                entries.push(...joinedEntries(rec, records[i - 1]));
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
                const shown = summary.replace(SYSTEM_REMINDER_RE, "");
                mergeCompaction(entries, shown.trim() !== "" ? { summary: shown } : {});
                continue;
            }
            const content = rec?.message?.content;
            if (typeof content === "string") {
                if (applyBashRecord(entries, content, rec)) {
                    continue;
                }
                const note = parseTaskNotification(content);
                if (note != null) {
                    // its own record starts a turn, so the turn's time starts at it. The call it names, when in view,
                    // says whether a subagent finished, which its summary alone may not
                    entries.push(
                        withFinishId(
                            {
                                ...note,
                                ...recTs(rec),
                                ...(isSubagentFinish(content, actionById) ? { source: "subagent" as const } : {}),
                            },
                            content
                        )
                    );
                } else if (applyCommandOutput(entries, content)) {
                    // handled: the output sits under its command, or draws nothing. Never a user bubble.
                } else if (opensWith(content, "<local-command-stdout>")) {
                    // slash-command stdout mixed with other text: not shown
                } else if (isInterrupted(content)) {
                    entries.push({ kind: "interrupted" });
                } else {
                    const cmd = parseCommand(content);
                    const handBack = cmd == null ? parseHandBack(content, rec.origin?.name) : null;
                    if (cmd != null) {
                        entries.push({ kind: "command", ...cmd, ...recTs(rec) });
                    } else if (handBack != null) {
                        entries.push({ ...handBack, ...recTs(rec) });
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
                const raw = toolResultText(block.content);
                const body = cleanToolBody(raw);
                const images = toolResultImages(block.content);
                if (images.length > 0) {
                    action.images = images;
                }
                const tool = (action as any)._tool as string | undefined;
                const input = (action as any)._input;
                const cwd = (action as any)._cwd as string | undefined;
                const failed = block.is_error === true;
                const shell = tool != null && SHELL_TOOLS.has(tool);
                const declined = failed ? declinedReason(tool, unwrapToolError(body), rec) : null;
                const blocked = declined == null && shell && failed && bashNeverRan(body);
                // a command that ran and failed tells why in its output, so only one that never ran carries an error
                const error = declined ?? (failed && (!shell || blocked) ? toolError(body) : "");
                if (error !== "") {
                    action.error = error;
                }
                // a failed edit changed nothing, so it shows no diff
                if (failed && action.detail?.kind === "edit") {
                    delete action.detail;
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
                    action.summary = tool === "Glob" ? globSummary(body) : plural(body.split("\n").length, "line");
                } else if (shell && raw) {
                    // a background launch's result is only a harness line: the call keeps its command panel
                    const ran = !blocked && declined == null;
                    action.detail = {
                        kind: "bash",
                        command: action.command,
                        // a call that never ran has no output; its reason is the error
                        output: ran ? body : "",
                        exit: !ran ? null : failed ? failedExit(body) : 0,
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
                if (declined != null) {
                    action.outcome = "declined";
                } else if (blocked) {
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

/** Pure: a subagent's running call (from its listing) as the pending action its step row would draw, so it is named
 *  by the same verb, target and title code. */
export function subagentCallEntry(call: SubagentCall): AgentActionEntry | undefined {
    const timestamp = call.startedatms ? new Date(call.startedatms).toISOString() : undefined;
    const rec = {
        type: "assistant",
        timestamp,
        message: { content: [{ type: "tool_use", id: "current", name: call.name, input: call.input ?? {} }] },
    };
    const [entry] = projectTranscriptRecords([rec]);
    return entry?.kind === "action" ? entry : undefined;
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
    description?: string;
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
        // an api-request-blob replays the request's messages: its copied launch ack has no toolUseResult, so it read as
        // the spawn finishing and the tree hid the still-running subagent
        if (rec?.type !== "user" && rec?.type !== "assistant") {
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
            if (block?.type === "tool_use" && SUBAGENT_TOOLS.has(block.name) && typeof block.id === "string") {
                const input = block.input ?? {};
                spawns.set(block.id, {
                    toolUseId: block.id,
                    subagentType: typeof input.subagent_type === "string" ? input.subagent_type : "",
                    prompt: typeof input.prompt === "string" ? input.prompt : "",
                    ...(typeof input.description === "string" ? { description: input.description } : {}),
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
