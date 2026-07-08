// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure projection of a Claude Code transcript (JSONL lines) into AgentEntry[].
// No React, no Wave runtime imports. Deterministic; no LLM (spec §5.3).

import type { AgentEntry, CardTask } from "./agentsviewmodel";
import { buildEditDiff, parseGrep, sliceRead, toolResultText } from "./tooldetail";

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
    return "";
}

type ActionEntry = AgentEntry & { kind: "action" };

/** Pure: project transcript JSONL lines into ordered previous-info entries.
 *  assistant text -> message; tool_use -> action; tool_result -> outcome on the matching
 *  action (fail on error; ok only for "ran", to avoid a checkmark on every read/edit).
 *  Unparseable lines and unknown record types are skipped. */
export function projectTranscript(lines: string[]): AgentEntry[] {
    const entries: AgentEntry[] = [];
    const actionById = new Map<string, ActionEntry>();
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        if (rec.type === "assistant") {
            const content = rec?.message?.content;
            if (!Array.isArray(content)) {
                continue;
            }
            for (const block of content) {
                if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
                    entries.push({ kind: "message", text: block.text });
                    continue;
                }
                if (block?.type === "tool_use" && typeof block.name === "string") {
                    const action: ActionEntry = { kind: "action", verb: verbFor(block.name), target: targetFor(block.input) };
                    if (block.name === "Edit" && block.input && typeof block.input.old_string === "string") {
                        action.detail = {
                            kind: "edit",
                            files: [buildEditDiff(String(block.input.file_path ?? ""), block.input.old_string, String(block.input.new_string ?? ""))],
                        };
                    } else if (block.name === "Write" && block.input && typeof block.input.content === "string") {
                        action.detail = {
                            kind: "edit",
                            files: [buildEditDiff(String(block.input.file_path ?? ""), "", block.input.content)],
                        };
                    } else if (block.name === "Skill" && block.input && typeof block.input.skill === "string") {
                        const args = typeof block.input.args === "string" ? block.input.args.trim() : "";
                        action.detail = { kind: "skill", name: block.input.skill, args: args !== "" ? args : undefined };
                    }
                    // scratch fields (stripped before return): tool_use timestamp for duration, tool name for result
                    // routing, and the raw Bash command (the target line shows the human description instead).
                    (action as any)._useTs = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
                    (action as any)._tool = block.name;
                    if (block.name === "Bash" && typeof block.input?.command === "string") {
                        (action as any)._command = block.input.command;
                    }
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
            const content = rec?.message?.content;
            if (typeof content === "string") {
                if (content.trim() !== "") {
                    entries.push({ kind: "user", text: content });
                }
                continue;
            }
            if (!Array.isArray(content)) {
                continue;
            }
            for (const block of content) {
                if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
                    entries.push({ kind: "user", text: block.text });
                    continue;
                }
                if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") {
                    continue;
                }
                const action = actionById.get(block.tool_use_id);
                if (action == null) {
                    continue;
                }
                const body = toolResultText(block.content);
                const tool = (action as any)._tool as string | undefined;
                if (tool === "Grep" && body) {
                    const matches = parseGrep(body);
                    action.detail = { kind: "grep", matches };
                    action.summary = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
                } else if ((tool === "Read" || tool === "Glob") && body) {
                    const { snippet, truncated } = sliceRead(body, READ_MODAL_MAX_LINES);
                    action.detail = { kind: "read", snippet, truncated };
                    action.summary = `${body.split("\n").length} lines`;
                } else if (tool === "Bash" && body) {
                    action.detail = {
                        kind: "bash",
                        command: (action as any)._command,
                        output: body,
                        exit: block.is_error === true ? 1 : 0,
                    };
                }
                const resTs = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
                const useTs = (action as any)._useTs as number;
                if (Number.isFinite(resTs) && Number.isFinite(useTs) && resTs >= useTs) {
                    action.durationMs = resTs - useTs;
                }
                if (block.is_error === true) {
                    action.outcome = "fail";
                } else if (action.verb === "ran") {
                    action.outcome = "ok";
                }
            }
        }
    }
    // strip private scratch fields so they never leak into the AgentEntry contract
    for (const e of entries) {
        if (e.kind === "action") {
            delete (e as any)._useTs;
            delete (e as any)._tool;
            delete (e as any)._command;
        }
    }
    return entries;
}

/** Pure: the task list from the LATEST TodoWrite tool_use in the transcript, or undefined if the
 *  agent never wrote a todo list. `completed` -> done; every other status is not-done. Malformed
 *  todo entries (missing/non-string content) are skipped; an empty todo list yields []. */
export function extractTasks(lines: string[]): CardTask[] | undefined {
    let latest: unknown[] | undefined;
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
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
