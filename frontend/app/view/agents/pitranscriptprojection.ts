// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure projection of a Pi v3 native session transcript (JSONL lines) into AgentEntry[].
// No React, no Wave runtime imports. Deterministic; no LLM. Sibling of transcriptprojection.ts
// (Claude Code) and codextranscriptprojection.ts (Codex); both produce the shared AgentEntry[]
// contract, selected via the projection registry.
//
// Pi records are parent-linked ({id, parentId}): abandoned sibling branches stay on disk but are
// never rendered. The active branch is the parent chain of the final record, projected root-first.
// Malformed lines are skipped; a broken/missing/cyclic parent chain terminates at the reachable
// suffix instead of erroring — strict file diagnostics are backend-owned (pkg/pisession), the
// frontend projection must survive any file shape.

import type { AgentEntry } from "./agentsviewmodel";

interface PiBlock {
    type?: string;
    text?: string;
    toolCallId?: string;
    name?: string;
    args?: unknown;
    isError?: boolean;
    is_error?: boolean;
}

interface PiMessage {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    isError?: boolean;
    is_error?: boolean;
}

interface PiRecord {
    type?: string;
    id?: string;
    parentId?: string | null;
    message?: PiMessage;
    name?: string;
    summary?: string;
}

const VERB_BY_TOOL: Record<string, string> = {
    Bash: "bash",
    Read: "read",
    Write: "write",
    Edit: "edit",
    Grep: "grep",
    Glob: "glob",
    TodoWrite: "updated",
};

// Pi tool names are capitalized like Claude's; a bare lowercased name is the fallback (matches
// the opencode projector's fallback so unknown tools still read as themselves).
function verbFor(name: string): string {
    return VERB_BY_TOOL[name] ?? name.toLowerCase();
}

// the target line for a tool call: the bash command, else a file/pattern when the args carry one,
// else nothing (bare verb line).
function targetFor(name: string, args: unknown): string {
    if (typeof args === "string") {
        return args.trim();
    }
    if (args != null && typeof args === "object") {
        const a = args as Record<string, unknown>;
        if (typeof a.command === "string" && a.command.trim() !== "") {
            return a.command.trim();
        }
        if (typeof a.filePath === "string" && a.filePath !== "") {
            return a.filePath.split(/[/\\]/).pop() || a.filePath;
        }
        if (typeof a.pattern === "string" && a.pattern !== "") {
            return a.pattern;
        }
    }
    return name;
}

function textBlocks(content: unknown): string[] {
    if (typeof content === "string") {
        return content.trim() === "" ? [] : [content.trim()];
    }
    if (!Array.isArray(content)) {
        return [];
    }
    const out: string[] = [];
    for (const b of content as PiBlock[]) {
        if (b != null && b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") {
            out.push(b.text);
        }
    }
    return out;
}

type ActionEntry = AgentEntry & { kind: "action" };

function mapAssistantContent(content: unknown, entries: AgentEntry[], actionById: Map<string, ActionEntry>): void {
    for (const text of textBlocks(content)) {
        entries.push({ kind: "message", text });
    }
    if (!Array.isArray(content)) {
        return;
    }
    for (const b of content as PiBlock[]) {
        if (b == null || b.type !== "tool_use" || typeof b.name !== "string" || b.name === "") {
            continue;
        }
        const action: ActionEntry = { kind: "action", verb: verbFor(b.name), target: targetFor(b.name, b.args) };
        entries.push(action);
        if (typeof b.toolCallId === "string" && b.toolCallId !== "") {
            actionById.set(b.toolCallId, action);
        }
    }
}

// Pi tool results are their own message record (role "toolResult"); the call id lives on the
// message and the failure flag may be message-level or on a content block. Never rendered as a
// user entry — it only settles the matching action's outcome.
function applyToolResult(rec: PiRecord, actionById: Map<string, ActionEntry>): void {
    const msg = rec.message;
    if (msg == null) {
        return;
    }
    let toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
    if (toolCallId === "" && Array.isArray(msg.content)) {
        for (const b of msg.content as PiBlock[]) {
            if (b?.type === "tool_result" && typeof b.toolCallId === "string") {
                toolCallId = b.toolCallId;
                break;
            }
        }
    }
    if (toolCallId === "") {
        return;
    }
    const action = actionById.get(toolCallId);
    if (action == null) {
        return;
    }
    action.outcome = toolResultFailed(msg) ? "fail" : "ok";
}

function toolResultFailed(msg: PiMessage): boolean {
    if (msg.isError === true || msg.is_error === true) {
        return true;
    }
    if (Array.isArray(msg.content)) {
        for (const b of msg.content as PiBlock[]) {
            if (b?.type === "tool_result" && (b.isError === true || b.is_error === true)) {
                return true;
            }
        }
    }
    return false;
}

function mapRecord(rec: PiRecord, entries: AgentEntry[], actionById: Map<string, ActionEntry>): void {
    if (rec == null || rec.type !== "message" || rec.message == null) {
        return;
    }
    const msg = rec.message;
    if (msg.role === "user") {
        for (const text of textBlocks(msg.content)) {
            entries.push({ kind: "user", text });
        }
        return;
    }
    if (msg.role === "assistant") {
        mapAssistantContent(msg.content, entries, actionById);
        return;
    }
    if (msg.role === "toolResult") {
        applyToolResult(rec, actionById);
    }
}

// Parse valid records, tolerating malformed lines (skipped). A v3 session starts with a header and
// every later record carries id + parentId; the header itself and non-message entries (model_change,
// compaction, branch_summary, session_info) simply produce no entry.
function parseRecords(lines: string[]): PiRecord[] {
    const records: PiRecord[] = [];
    for (const line of lines) {
        try {
            const rec = JSON.parse(line) as PiRecord;
            if (rec != null) {
                records.push(rec);
            }
        } catch {
            // malformed line: skip
        }
    }
    return records;
}

// activeBranch follows parentId from the final record to a root, returning indices root-first.
// A missing parent or a cycle terminates at the reachable suffix (frontend safety; the backend
// parser reports these as errors instead).
function activeBranch(records: PiRecord[]): number[] {
    if (records.length === 0) {
        return [];
    }
    const idxById = new Map<string, number>();
    records.forEach((rec, i) => {
        if (rec != null && typeof rec.id === "string" && rec.id !== "") {
            idxById.set(rec.id, i);
        }
    });
    const chain: number[] = [];
    const onChain = new Set<number>();
    let cur = records.length - 1;
    for (;;) {
        if (cur < 0 || onChain.has(cur)) {
            break;
        }
        onChain.add(cur);
        chain.push(cur);
        const rec = records[cur];
        const parentId = rec?.parentId;
        if (parentId == null || parentId === "") {
            break;
        }
        const parent = idxById.get(parentId);
        if (parent == null) {
            break;
        }
        cur = parent;
    }
    return chain.reverse();
}

/** Pure: project Pi v3 JSONL lines into ordered entries, following only the active parent branch.
 *  user -> asked, assistant text -> message, tool_use -> action (joined to its toolResult by
 *  toolCallId), compaction -> compaction. branch_summary / model_change / session_info never render. */
export function projectPiTranscript(lines: string[]): AgentEntry[] {
    const records = parseRecords(lines);
    const branch = activeBranch(records);
    const entries: AgentEntry[] = [];
    const actionById = new Map<string, ActionEntry>();
    for (const idx of branch) {
        const rec = records[idx];
        if (rec?.type === "compaction") {
            const entry: AgentEntry = { kind: "compaction" };
            if (typeof rec.summary === "string" && rec.summary.trim() !== "") {
                entry.summary = rec.summary;
            }
            entries.push(entry);
            continue;
        }
        mapRecord(rec, entries, actionById);
    }
    return entries;
}

/** Pure: the session's display title — the latest session_info.name on the active branch, else the
 *  first active user text. Mirrors the backend's piBranchMeta so the Sessions surface and history
 *  scan agree on what a Pi session is called. */
export function extractPiTitle(lines: string[]): string | undefined {
    const records = parseRecords(lines);
    let title: string | undefined;
    for (const idx of activeBranch(records)) {
        const rec = records[idx];
        if (rec?.type === "session_info" && typeof rec.name === "string" && rec.name.trim() !== "") {
            title = rec.name.trim();
        }
    }
    if (title) {
        return title;
    }
    for (const idx of activeBranch(records)) {
        const rec = records[idx];
        if (rec?.type === "message" && rec.message?.role === "user") {
            const text = textBlocks(rec.message.content)[0];
            if (text) {
                return text;
            }
        }
    }
    return undefined;
}
