// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure extraction of lifecycle ActivityEvents from raw transcript JSONL lines. Sibling of the
// AgentEntry[] projectors (transcriptprojection.ts / codextranscriptprojection.ts): those discard
// timestamps, session boundaries, and tool identity — exactly what the Activity taxonomy needs — so
// this parses raw lines itself. No React, no Wave runtime imports.

import { extractAiTitle } from "./transcriptprojection";

export type ActivityType = "started" | "asked" | "committed" | "errored" | "finished";

export interface ActivityEvent {
    id: string; // `${sessionPath}#${index}` — stable per extraction
    agent: string; // "claude" | "codex"
    agentName: string; // display name
    project: string; // group key
    type: ActivityType;
    ts: number; // epoch ms
    text: string; // one-line summary
    sessionPath: string;
    live: boolean; // session is in the current live roster (drives Jump)
    liveId?: string; // tabId when live (jump target)
}

export interface ExtractBase {
    agent: string;
    sessionPath: string;
    agentName: string; // fallback name (live roster name, or file-derived)
    project: string; // fallback project (claude: from path; codex: overridden by session_meta)
    live: boolean;
    liveId?: string;
}

interface RawEvent {
    type: ActivityType;
    ts: number;
    text: string;
}

const COMMIT_RE = /\bgit\s+commit\b/;
const MAX_TEXT = 100;

function clip(s: string): string {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT - 1) + "…" : t;
}

function commitSubject(command: string): string {
    const m = command.match(/-m\s+["']([^"']+)["']/);
    return m ? clip(m[1]) : "committed";
}

function askText(input: any): string {
    const q = input?.questions?.[0];
    const s = typeof q?.question === "string" ? q.question : typeof q?.header === "string" ? q.header : "asked a question";
    return clip(s);
}

function recTs(rec: any): number {
    const t = typeof rec?.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    return Number.isNaN(t) ? 0 : t;
}

function finalize(raw: RawEvent[], base: ExtractBase, name: string, project: string): ActivityEvent[] {
    return raw
        .filter((e) => e.ts > 0)
        .sort((a, b) => a.ts - b.ts)
        .map((e, i) => ({
            id: `${base.sessionPath}#${i}`,
            agent: base.agent,
            agentName: name,
            project,
            type: e.type,
            ts: e.ts,
            text: e.text,
            sessionPath: base.sessionPath,
            live: base.live,
            liveId: base.liveId,
        }));
}

export function extractClaudeEvents(lines: string[], base: ExtractBase): ActivityEvent[] {
    const raw: RawEvent[] = [];
    const cmdById = new Map<string, string>(); // tool_use id -> command (for error text)
    let firstTs = 0;
    let lastTs = 0;
    let firstUser = "";
    let lastAssistant = "";
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        const ts = recTs(rec);
        if (ts > 0) {
            if (firstTs === 0) {
                firstTs = ts;
            }
            lastTs = ts;
        }
        if (rec.type === "assistant" && Array.isArray(rec?.message?.content)) {
            for (const b of rec.message.content) {
                if (b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "") {
                    lastAssistant = b.text;
                } else if (b?.type === "tool_use" && typeof b.name === "string") {
                    const cmd = typeof b?.input?.command === "string" ? b.input.command : "";
                    if (typeof b.id === "string") {
                        cmdById.set(b.id, cmd || b.name);
                    }
                    if (b.name === "AskUserQuestion") {
                        raw.push({ type: "asked", ts, text: askText(b.input) });
                    } else if (b.name === "Bash" && COMMIT_RE.test(cmd)) {
                        raw.push({ type: "committed", ts, text: commitSubject(cmd) });
                    }
                }
            }
        } else if (rec.type === "user") {
            const content = rec?.message?.content;
            if (typeof content === "string") {
                if (firstUser === "" && content.trim() !== "") {
                    firstUser = content;
                }
            } else if (Array.isArray(content)) {
                for (const b of content) {
                    if (b?.type === "text" && firstUser === "" && typeof b.text === "string" && b.text.trim() !== "") {
                        firstUser = b.text;
                    }
                    if (b?.type === "tool_result" && b?.is_error === true && typeof b.tool_use_id === "string") {
                        raw.push({ type: "errored", ts, text: `failed: ${clip(cmdById.get(b.tool_use_id) ?? "a command")}` });
                    }
                }
            }
        }
    }
    if (firstTs > 0) {
        raw.push({ type: "started", ts: firstTs, text: firstUser ? clip(firstUser) : "started session" });
    }
    if (!base.live && lastTs > 0) {
        raw.push({ type: "finished", ts: lastTs, text: lastAssistant ? clip(lastAssistant) : "finished" });
    }
    const name = extractAiTitle(lines) ?? base.agentName;
    return finalize(raw, base, name, base.project);
}

// Codex rollout helpers — mirror the private logic in codextranscriptprojection.ts (not exported
// there). Small and stable; duplicated rather than widening that module's API.
function shellCommand(argsRaw: unknown): string {
    if (typeof argsRaw !== "string") {
        return "";
    }
    try {
        const a = JSON.parse(argsRaw);
        return typeof a?.command === "string" ? a.command : "";
    } catch {
        return "";
    }
}

function outputIsError(output: unknown): boolean {
    if (typeof output !== "string") {
        return false;
    }
    const m = output.match(/Exit code:\s*(\d+)/);
    if (m) {
        return m[1] !== "0";
    }
    try {
        const p = JSON.parse(output);
        return typeof p?.metadata?.exit_code === "number" ? p.metadata.exit_code !== 0 : false;
    } catch {
        return false;
    }
}

function projectFromCwd(cwd: string): string {
    const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
}

export function extractCodexEvents(lines: string[], base: ExtractBase): ActivityEvent[] {
    const raw: RawEvent[] = [];
    const cmdById = new Map<string, string>();
    let firstTs = 0;
    let lastTs = 0;
    let firstUser = "";
    let lastAssistant = "";
    let project = base.project;
    let isSubagent = false;
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        const ts = recTs(rec);
        if (ts > 0) {
            if (firstTs === 0) {
                firstTs = ts;
            }
            lastTs = ts;
        }
        if (rec.type === "session_meta") {
            const p = rec.payload ?? {};
            if (typeof p.cwd === "string" && p.cwd) {
                project = projectFromCwd(p.cwd);
            }
            if (p.thread_source === "subagent") {
                isSubagent = true;
            }
            continue;
        }
        if (rec.type !== "response_item" || rec.payload == null) {
            continue;
        }
        const p = rec.payload;
        if (p.type === "message" && Array.isArray(p.content)) {
            for (const b of p.content) {
                if (p.role === "assistant" && b?.type === "output_text" && typeof b.text === "string" && b.text.trim() !== "") {
                    lastAssistant = b.text;
                }
                if (
                    p.role === "user" &&
                    b?.type === "input_text" &&
                    firstUser === "" &&
                    typeof b.text === "string" &&
                    b.text.trim() !== "" &&
                    !b.text.startsWith("<environment_context") &&
                    !b.text.startsWith("<skill>")
                ) {
                    firstUser = b.text;
                }
            }
        } else if (p.type === "function_call") {
            const cmd = shellCommand(p.arguments);
            if (typeof p.call_id === "string") {
                cmdById.set(p.call_id, cmd || (typeof p.name === "string" ? p.name : ""));
            }
            if (p.name === "shell_command" && COMMIT_RE.test(cmd)) {
                raw.push({ type: "committed", ts, text: commitSubject(cmd) });
            }
        } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
            if (typeof p.call_id === "string" && outputIsError(p.output)) {
                raw.push({ type: "errored", ts, text: `failed: ${clip(cmdById.get(p.call_id) ?? "a command")}` });
            }
        }
    }
    if (isSubagent) {
        return []; // v1: exclude subagent rollouts (spec §3)
    }
    if (firstTs > 0) {
        raw.push({ type: "started", ts: firstTs, text: firstUser ? clip(firstUser) : "started session" });
    }
    if (!base.live && lastTs > 0) {
        raw.push({ type: "finished", ts: lastTs, text: lastAssistant ? clip(lastAssistant) : "finished" });
    }
    const name = project || base.agentName;
    return finalize(raw, base, name, project);
}

export function extractEvents(lines: string[], base: ExtractBase): ActivityEvent[] {
    return base.agent === "codex" ? extractCodexEvents(lines, base) : extractClaudeEvents(lines, base);
}
