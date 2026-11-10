// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What the permission band shows for a pending request: its title, a preview of what the tool would do, and the text
// of the "allowed" timeline row once answered. Pure; the choice labels come from the server (agentask.PermissionChoices).

import type { EditFile, TimelineItem } from "./agentsviewmodel";
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

function editPath(input: Record<string, any> | null): string | null {
    return str(input?.file_path) ?? str(input?.notebook_path);
}

export function permissionTitle(p: AgentPermissionData): string {
    if (EDIT_TOOLS.has(p.toolname)) {
        return `Allow an edit to ${editPath(parseInput(p)) ?? "a file"}?`;
    }
    if (p.toolname === "Bash") {
        return "Allow this command?";
    }
    if (p.toolname === PLAN_TOOL) {
        return "Approve this plan?";
    }
    return `Allow ${p.toolname}?`;
}

function editFiles(tool: string, input: Record<string, any>): EditFile[] | null {
    const path = editPath(input);
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

export function permissionPreview(p: AgentPermissionData): PermissionPreview {
    const input = parseInput(p);
    if (input == null) {
        return { kind: "json", text: p.toolinput };
    }
    if (EDIT_TOOLS.has(p.toolname)) {
        const files = editFiles(p.toolname, input);
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

function subject(p: AgentPermissionData): string {
    const input = parseInput(p);
    if (EDIT_TOOLS.has(p.toolname)) {
        return editPath(input) ?? p.toolname;
    }
    if (p.toolname === "Bash") {
        return str(input?.command) ?? p.toolname;
    }
    return p.toolname === PLAN_TOOL ? PLAN_SUBJECT : p.toolname;
}

export function permissionLogText(p: AgentPermissionData, choice: number): string {
    return `${p.choices[choice] ?? `choice ${choice + 1}`}: ${subject(p)}`;
}

// an "allowed" row the rendered view records after the band answers: drawn after the timeline item holding entry
// afterEntry - 1
export type TimelineMark = { afterEntry: number; text: string };

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
