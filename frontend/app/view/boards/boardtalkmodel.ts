// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// What the Boards surface says about a board's talk: the talk column's items, the ask box, the header's facts
// and the switcher's rows. Pure: no React, no RPC.

export const SLOW_AFTER_MS = 90_000; // the 11-11 live check drew 16 shapes in ~16 s; a code-reading follow-up takes longer

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PROJECT_KINDS = new Set(["", "project"]);
const ABOUT_NOUN: Record<string, string> = {
    agent: "agent's session",
    session: "session",
    run: "run",
    effort: "effort",
    record: "record",
    briefing: "briefing",
};

export type TalkItem =
    | { kind: "question"; turnId: string; text: string; on?: string }
    | { kind: "briefing"; turnId: string; from: string; time: string; text: string; ask?: string }
    | { kind: "reply"; turnId: string; text: string; card?: { title: string; summary: string; shapeIds: string[] } }
    | { kind: "working"; turnId: string; slow: boolean; elapsed: string; waiting: boolean }
    | { kind: "failed"; turnId: string; time: string; text: string }
    | { kind: "stopped"; turnId: string }
    | { kind: "asks"; turnId: string; text: string; choice?: "keep" | "new" };

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function elapsedText(ms: number): string {
    const total = Math.max(0, Math.floor(ms / MS_PER_SECOND));
    if (total < SECONDS_PER_MINUTE) {
        return `${total} s`;
    }
    return `${Math.floor(total / SECONDS_PER_MINUTE)} min ${pad2(total % SECONDS_PER_MINUTE)} s`;
}

export function talkTime(ts: number, now: number): string {
    const d = new Date(ts);
    const today = new Date(now);
    const sameDay =
        d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    return sameDay ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function aboutTitle(about: BoardSource | undefined, project: string): string {
    if (about == null || PROJECT_KINDS.has(about.kind) || !about.title) {
        return `the ${project} code`;
    }
    return about.title;
}

export function aboutLine(about: BoardSource | undefined): string {
    if (about == null || PROJECT_KINDS.has(about.kind)) {
        return "the drawer reads the project's code";
    }
    const noun = ABOUT_NOUN[about.kind] ?? about.kind;
    return `The drawer starts from this ${noun} and reads the project's code.`;
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function failedText(reason: string | undefined): string {
    const why = (reason ?? "").trim().replace(/[.\s]+$/, "");
    const lead = why ? `${capitalize(why)}. ` : "";
    return `${lead}Nothing on the board changed. Retry asks the same question again.`;
}

function drewOnly(t: BoardTurn): boolean {
    return (t.added ?? 0) > 0 && !t.changed && !t.removed;
}

// decision 8: "drew N shapes" for the first answered turn when it only added shapes
function cardSummary(t: BoardTurn, first: boolean, now: number): string {
    const added = t.added ?? 0;
    const parts: string[] = [];
    if (first && drewOnly(t)) {
        parts.push(`drew ${plural(added, "shape")}`);
    } else {
        if (added > 0) {
            parts.push(`added ${plural(added, "shape")}`);
        }
        if (t.changed) {
            parts.push(`changed ${t.changed}`);
        }
        if (t.removed) {
            parts.push(`removed ${t.removed}`);
        }
    }
    parts.push(talkTime(t.answeredts || t.ts, now));
    return parts.join(" · ");
}

function hasDrawing(t: BoardTurn): boolean {
    return (t.added ?? 0) + (t.changed ?? 0) + (t.removed ?? 0) > 0;
}

function headItem(t: BoardTurn, now: number): TalkItem | null {
    if (t.briefing != null) {
        return {
            kind: "briefing",
            turnId: t.id,
            from: t.briefing.from,
            time: talkTime(t.ts, now),
            text: t.briefing.text,
            ask: t.briefing.ask || undefined,
        };
    }
    if (t.kept || !t.question) {
        return null;
    }
    return { kind: "question", turnId: t.id, text: t.question, on: t.on || undefined };
}

function stateItem(t: BoardTurn, first: boolean, now: number): TalkItem | null {
    switch (t.state) {
        case "waiting":
            return { kind: "working", turnId: t.id, slow: false, elapsed: "", waiting: true };
        case "answering": {
            const ms = now - t.ts;
            return {
                kind: "working",
                turnId: t.id,
                slow: ms >= SLOW_AFTER_MS,
                elapsed: elapsedText(ms),
                waiting: false,
            };
        }
        case "answered": {
            const item: TalkItem = { kind: "reply", turnId: t.id, text: t.reply ?? "" };
            if (hasDrawing(t)) {
                item.card = { title: t.title ?? "", summary: cardSummary(t, first, now), shapeIds: t.shapeids ?? [] };
            }
            return item;
        }
        case "asks":
            return {
                kind: "asks",
                turnId: t.id,
                text: t.reply ?? "",
                choice: t.choice === "keep" || t.choice === "new" ? t.choice : undefined,
            };
        case "failed":
            return {
                kind: "failed",
                turnId: t.id,
                time: talkTime(t.answeredts || t.ts, now),
                text: failedText(t.reason),
            };
        case "stopped":
            return { kind: "stopped", turnId: t.id };
        default:
            return null;
    }
}

export function talkItems(talk: BoardTalk, now: number): TalkItem[] {
    const items: TalkItem[] = [];
    let seenAnswered = false;
    for (const t of talk.turns ?? []) {
        const head = headItem(t, now);
        if (head != null) {
            items.push(head);
        }
        const state = stateItem(t, !seenAnswered, now);
        if (state != null) {
            items.push(state);
        }
        if (t.state === "answered") {
            seenAnswered = true;
        }
    }
    return items;
}

function turnInFlight(talk: BoardTalk | null): boolean {
    return (talk?.turns ?? []).some((t) => t.state === "waiting" || t.state === "answering");
}

export function askBox(
    talk: BoardTalk | null,
    boardName: string,
    selection: string | null,
    busy: boolean,
    wontOpen: boolean
): { disabled: boolean; hint: string; placeholder: string; stoppable: boolean } {
    const placeholder = `Ask the drawer about ${boardName}`;
    if (wontOpen) {
        return {
            disabled: true,
            hint: "This board won't open, so the drawer can't answer on it",
            placeholder,
            stoppable: false,
        };
    }
    // a waiting turn is not running yet, and Stop only ends the running one
    const stoppable = (talk?.turns ?? []).some((t) => t.state === "answering");
    if (busy || turnInFlight(talk)) {
        return { disabled: true, hint: "You can ask once this answer lands", placeholder, stoppable };
    }
    const hint = selection ? `Selected ${selection}` : "Select shapes to ask about them";
    return { disabled: false, hint, placeholder, stoppable };
}

export function boardFacts(info: BoardInfo, shapes: number, now: number): string {
    const questions = info.questions ?? 0;
    if (questions === 0 && shapes === 0) {
        return `empty · created ${talkTime(info.createdts, now)}`;
    }
    const facts = [plural(questions, "question"), plural(shapes, "shape")];
    if (info.answeredts) {
        facts.push(`answered ${talkTime(info.answeredts, now)}`);
    }
    return facts.join(" · ");
}

export interface SwitcherRow {
    id: string;
    name: string;
    time: string;
    sub: string;
    mark: "answering" | "asks" | "failed" | "wontopen" | null;
}

function switcherMark(b: BoardInfo): SwitcherRow["mark"] {
    if (b.loaderror) {
        return "wontopen";
    }
    return b.state === "answering" || b.state === "asks" || b.state === "failed" ? b.state : null;
}

export function switcherRows(
    boards: BoardInfo[],
    project: string,
    now: number
): { heading: string; rows: SwitcherRow[] } {
    const rows = boards.map((b) => ({
        id: b.id,
        name: b.name,
        time: talkTime(b.activets || b.createdts, now),
        sub: `${plural(b.questions ?? 0, "question")} · ${b.about || `the ${project} code`}`,
        mark: switcherMark(b),
    }));
    return { heading: `${plural(boards.length, "board")} in ${project}`, rows };
}
