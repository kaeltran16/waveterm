// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What the permission band shows for a pending request: its title, a preview of what the tool would do, and the text
// of the "allowed" timeline row once answered. Pure; the choice labels come from the server (agentask.PermissionChoices).

import type { AgentEntry, EditFile, TimelineItem } from "./agentsviewmodel";
import { buildEditDiff } from "./tooldetail";

export type PermissionPreview =
    | { kind: "diff"; files: EditFile[] }
    | { kind: "command"; text: string }
    | { kind: "markdown"; text: string }
    | { kind: "json"; text: string };

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PLAN_TOOL = "ExitPlanMode";
const PLAN_SUBJECT = "plan";

function parseInput(p: AgentPermissionData): Record<string, any> | null {
    try {
        const v = JSON.parse(p.toolinput);
        return v != null && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
}

function str(v: unknown): string | null {
    return typeof v === "string" ? v : null;
}

// Claude sends absolute paths; inside the agent's working dir the band reads them as the timeline does, relative.
// Windows paths compare case-insensitively and with either separator.
export function relativeToCwd(path: string, cwd?: string): string {
    if (!cwd) {
        return path;
    }
    const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
    const p = norm(path);
    const base = norm(cwd) + "/";
    const windows = /^[A-Za-z]:\//.test(base);
    const hit = windows ? p.toLowerCase().startsWith(base.toLowerCase()) : p.startsWith(base);
    return hit && p.length > base.length ? p.slice(base.length) : path;
}

function editPath(input: Record<string, any> | null, cwd?: string): string | null {
    const path = str(input?.file_path) ?? str(input?.notebook_path);
    return path == null ? null : relativeToCwd(path, cwd);
}

/** Claude Code also raises a permission request for its AskUserQuestion dialog (wavesrv keeps it to know when the
 *  question is over). While the ask dock shows that question's choices, an AskUserQuestion at the head is the dock's to
 *  answer, so the band draws nothing until it leaves the queue. */
export function bandRequests<T extends Pick<AgentPermissionData, "toolname">>(pending: T[], askShown: boolean): T[] {
    return askShown && pending[0]?.toolname === "AskUserQuestion" ? [] : pending;
}

export function permissionTitle(p: AgentPermissionData, cwd?: string): string {
    if (EDIT_TOOLS.has(p.toolname)) {
        return `Allow an edit to ${editPath(parseInput(p), cwd) ?? "a file"}?`;
    }
    if (p.toolname === "Bash") {
        return "Allow this command?";
    }
    if (p.toolname === PLAN_TOOL) {
        return "Approve this plan?";
    }
    return `Allow ${p.toolname}?`;
}

function editFiles(tool: string, input: Record<string, any>, cwd?: string): EditFile[] | null {
    const path = editPath(input, cwd);
    if (path == null) {
        return null;
    }
    if (tool === "Edit") {
        return [buildEditDiff(path, str(input.old_string) ?? "", str(input.new_string) ?? "")];
    }
    if (tool === "MultiEdit" && Array.isArray(input.edits)) {
        return input.edits.map((e: any) => buildEditDiff(path, str(e?.old_string) ?? "", str(e?.new_string) ?? ""));
    }
    if (tool === "Write") {
        return [buildEditDiff(path, "", str(input.content) ?? "")];
    }
    if (tool === "NotebookEdit") {
        return [buildEditDiff(path, "", str(input.new_source) ?? "")];
    }
    return null;
}

export function permissionPreview(p: AgentPermissionData, cwd?: string): PermissionPreview {
    const input = parseInput(p);
    if (input == null) {
        return { kind: "json", text: p.toolinput };
    }
    if (EDIT_TOOLS.has(p.toolname)) {
        const files = editFiles(p.toolname, input, cwd);
        if (files != null) {
            return { kind: "diff", files };
        }
    } else if (p.toolname === "Bash" && str(input.command) != null) {
        return { kind: "command", text: input.command };
    } else if (p.toolname === PLAN_TOOL && str(input.plan) != null) {
        return { kind: "markdown", text: input.plan };
    }
    return { kind: "json", text: JSON.stringify(input, null, 2) };
}

function subject(p: AgentPermissionData, cwd?: string): string {
    const input = parseInput(p);
    if (EDIT_TOOLS.has(p.toolname)) {
        return editPath(input, cwd) ?? p.toolname;
    }
    if (p.toolname === "Bash") {
        return str(input?.command) ?? p.toolname;
    }
    return p.toolname === PLAN_TOOL ? PLAN_SUBJECT : p.toolname;
}

export function permissionLogText(p: AgentPermissionData, choice: number, cwd?: string): string {
    return `${p.choices[choice] ?? `choice ${choice + 1}`}: ${subject(p, cwd)}`;
}

// an "allowed" row the rendered view records after the band answers: drawn after the timeline item holding entry
// afterEntry - 1
export type TimelineMark = { afterEntry: number; text: string };

// an answer the band gave, stamped with when it went. Not an entry index: the entries are re-based whenever the stream
// restarts or trims (a /clear, a reconnect, a refocus re-tail, the line cap), and an index would then point elsewhere
export type PermissionMark = { ts: number; text: string };

function entryTime(e: AgentEntry): number | undefined {
    return e.kind === "action" ? e.startedTs : "ts" in e ? e.ts : undefined;
}

// a mark goes before the first entry stamped after it. One older than every stamped entry belongs to entries this
// window no longer holds (a /clear's old conversation, a trimmed head), so it is dropped rather than drawn at the top
export function anchorMarks(entries: AgentEntry[], marks: PermissionMark[]): TimelineMark[] {
    const times = entries.map(entryTime);
    const first = times.find((t) => t != null);
    const out: TimelineMark[] = [];
    for (const m of marks) {
        if (first == null || first > m.ts) {
            continue;
        }
        const at = times.findIndex((t) => t != null && t > m.ts);
        out.push({ afterEntry: at < 0 ? entries.length : at, text: m.text });
    }
    return out;
}

// an item covers the entries from its own start up to the next item's, so a mark goes after the last item starting at
// or before afterEntry - 1 (keyed by the item's position in `items`); a mark before every item leads them
export function placeMarks(
    items: TimelineItem[],
    marks: TimelineMark[]
): { lead: TimelineMark[]; after: Map<number, TimelineMark[]> } {
    const lead: TimelineMark[] = [];
    const after = new Map<number, TimelineMark[]>();
    for (const m of marks) {
        let at = -1;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (("index" in item ? item.index : item.startIndex) > m.afterEntry - 1) {
                break;
            }
            at = i;
        }
        if (at < 0) {
            lead.push(m);
        } else {
            after.set(at, [...(after.get(at) ?? []), m]);
        }
    }
    return { lead, after };
}
