// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: what the note, Jira and brainstorm judge calls show, from their argv, their own --json output and the records
// Arc keeps (a note, the ticket, the brainstorm file). No React, no Wave runtime.

import type { AgentActionEntry } from "./agentsviewmodel";
import { judgeWait, type BrainstormFile } from "./brainstormmodel";
import { wshJsonOutput, type WshCall } from "./wshcall";

// a note's body shows this many of its first bullets
export const NOTE_BULLET_MAX = 4;
// a ticket's description and newest comment are cut to these, the description with a way to the rest
export const JIRA_DESCRIPTION_CLAMP = 320;
export const JIRA_COMMENT_CLAMP = 110;

const NOTE_BODY_STDIN = "-";
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;
const JIRA_KEY = /[A-Za-z][A-Za-z0-9]*-\d+/;

function bashOf(action: AgentActionEntry): { output?: string; exit?: number } {
    return action.detail?.kind === "bash" ? { output: action.detail.output, exit: action.detail.exit } : {};
}

// ---- notes ----

export interface NoteSpan {
    text: string;
    strong?: boolean;
}

export interface NoteCard {
    title: string;
    noteId?: string;
    bullets: NoteSpan[][];
}

// **bold** runs are the lead-in the board draws brighter
function spansOf(line: string): NoteSpan[] {
    return line
        .split(/\*\*(.+?)\*\*/)
        .map((text, i): NoteSpan => (i % 2 === 1 ? { text, strong: true } : { text }))
        .filter((s) => s.text !== "");
}

// the body's bullets; a body with none gives its first lines, headings stripped
export function noteBullets(body: string | undefined): NoteSpan[][] {
    const lines = (body ?? "").split(/\r?\n/).filter((l) => l.trim() !== "");
    const bullets = lines.map((l) => BULLET.exec(l)?.[1]).filter((t): t is string => t != null);
    const texts = bullets.length > 0 ? bullets : lines.map((l) => l.replace(/^\s*#+\s*/, "").trim());
    return texts.slice(0, NOTE_BULLET_MAX).map(spansOf);
}

// the id wsh printed: the note from --json, else the "added note <id>" line
export function noteIdOf(action: AgentActionEntry): string | undefined {
    const { output, exit } = bashOf(action);
    const json = wshJsonOutput<{ id?: string }>(action.command, output, exit);
    if (json?.id) {
        return json.id;
    }
    return /^added note (\S+)/m.exec(output ?? "")?.[1];
}

// the argv body, unless it was piped on stdin and so is not in the call
export function noteArgvBody(call: WshCall): string | undefined {
    const body = call.flags["body"];
    return typeof body === "string" && body !== NOTE_BODY_STDIN ? body : undefined;
}

// whether the card needs the note's record: the id for its link, or a body the call did not carry
export function noteNeedsRecord(call: WshCall, action: AgentActionEntry): boolean {
    return noteIdOf(action) == null || noteArgvBody(call) == null;
}

// the wshdata key of the note's record: one per note, so a transcript's cards for one note fetch it once
export function noteDataKey(call: WshCall, action: AgentActionEntry): string {
    return `note:${noteIdOf(action) ?? `title:${call.args[0] ?? ""}`}`;
}

// by id, else the newest with that title
export function findNote(notes: UserNote[] | undefined, id: string | undefined, title: string): UserNote | undefined {
    if (!notes) {
        return undefined;
    }
    return (id ? notes.find((n) => n.id === id) : undefined) ?? [...notes].reverse().find((n) => n.title === title);
}

export function noteCardOf(call: WshCall, action: AgentActionEntry, record?: UserNote): NoteCard {
    return {
        title: record?.title ?? call.args[0] ?? "",
        noteId: record?.id ?? noteIdOf(action),
        bullets: noteBullets(record?.body ?? noteArgvBody(call)),
    };
}

// ---- jira show ----

export interface JiraAttachmentTile {
    id: string;
    filename: string;
    image: boolean;
}

export interface JiraCommentLine {
    author?: string;
    createdTs?: number;
    text: string;
}

export interface JiraTicketCard {
    key: string;
    summary: string;
    typeStatus: string;
    url?: string;
    // text is what shows; full is the whole description when it was cut
    description: { text: string; full: string; clamped: boolean };
    attachments: JiraAttachmentTile[];
    comment?: JiraCommentLine;
    project?: string;
    projectSure: boolean;
}

export function jiraKeyOf(call: WshCall): string {
    return (JIRA_KEY.exec(call.args[0] ?? "")?.[0] ?? call.args[0] ?? "").toUpperCase();
}

const NO_ATTACHMENTS = "no attachments";
// the stderr line wsh jira attachments prints for a ticket with none
const NO_ATTACHMENTS_LINE = new RegExp(`^${JIRA_KEY.source} has no attachments$`);
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

// the collapsed step row's summary of `wsh jira attachments`, from its own output only: the saved paths it printed
// (plain) or the array it printed (--json); a ticket with none reads as such, never as a count
export function jiraAttachmentsStepSummary(call: WshCall, output: string | undefined): string | undefined {
    const lines = (output ?? "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== "");
    const json = call.flags["json"];
    if (json === true || json === "true") {
        const rest = lines.filter((l) => !NO_ATTACHMENTS_LINE.test(l)).join("\n");
        try {
            const v = JSON.parse(rest);
            return !Array.isArray(v) ? undefined : v.length === 0 ? NO_ATTACHMENTS : `${v.length} saved`;
        } catch {
            return undefined;
        }
    }
    if (lines.length === 1 && NO_ATTACHMENTS_LINE.test(lines[0])) {
        return NO_ATTACHMENTS;
    }
    return lines.length > 0 && lines.every((l) => ABSOLUTE_PATH.test(l)) ? `${lines.length} saved` : undefined;
}

// the ticket as `wsh jira show --json` prints it, or as JiraShowCommand returns it
export function jiraShowOf(action: AgentActionEntry): CommandJiraShowRtnData | null {
    const { output, exit } = bashOf(action);
    return wshJsonOutput<CommandJiraShowRtnData>(action.command, output, exit);
}

// "11-09", in the reader's time zone
export function jiraDateOf(ts: number | undefined): string | undefined {
    if (!ts) {
        return undefined;
    }
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function oneLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function clampAtWord(text: string, max: number): { text: string; clamped: boolean } {
    if (text.length <= max) {
        return { text, clamped: false };
    }
    const cut = text.slice(0, max);
    const space = cut.lastIndexOf(" ");
    return { text: `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`, clamped: true };
}

// the newest comment by its time, else the last listed
function newestComment(comments: JiraCommentLine[] | undefined): JiraCommentLine | undefined {
    if (!comments?.length) {
        return undefined;
    }
    return comments.reduce((best, c) => ((c.createdTs ?? 0) >= (best.createdTs ?? 0) ? c : best));
}

export function jiraTicketOf(data: CommandJiraShowRtnData): JiraTicketCard {
    const t = data.ticket;
    const full = (t.description ?? "").trim();
    const newest = newestComment(t.comments?.map((c) => ({ author: c.author, createdTs: c.createdts, text: c.body })));
    return {
        key: t.key,
        summary: t.summary,
        typeStatus: [t.type, t.status].filter(Boolean).join(" · "),
        url: t.url || undefined,
        description: { ...clampAtWord(full, JIRA_DESCRIPTION_CLAMP), full },
        attachments: (t.attachments ?? []).map((a) => ({
            id: a.id,
            filename: a.filename,
            image: (a.mimetype ?? "").startsWith("image/"),
        })),
        comment: newest && { ...newest, text: clampAtWord(oneLine(newest.text), JIRA_COMMENT_CLAMP).text },
        project: data.project || undefined,
        projectSure: data.sure,
    };
}

// ---- brainstorm judge ----

// weighing: the agent's question lists approaches and the file says the judge works. done and failed: Arc's record on
// the question, or on the history entry once the question moved on. unknown: no brainstorm file to read.
export interface JudgeCard {
    state: "weighing" | "done" | "failed" | "unknown";
    n?: number;
    approaches?: number;
    text?: string;
}

export function judgeCardOf(file: BrainstormFile | null | undefined): JudgeCard {
    if (file == null) {
        return { state: "unknown" };
    }
    const q = file.question;
    if (q != null && judgeWait(file, false)) {
        return { state: "weighing", n: q.n, approaches: q.approaches?.length, text: q.text };
    }
    if (q?.judge != null) {
        return {
            state: q.judge.kind === "failed" ? "failed" : "done",
            n: q.n,
            approaches: q.approaches?.length,
            text: q.text,
        };
    }
    const past = [...file.history].reverse().find((h) => h.kind === "question" && h.judge != null);
    if (past?.judge != null) {
        return { state: past.judge.kind === "failed" ? "failed" : "done", n: past.n, text: past.q };
    }
    return { state: "unknown" };
}
