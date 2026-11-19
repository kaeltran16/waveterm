// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// What a board says about its talk, on the Boards surface and in its agent's workspace tab: the talk column's items,
// the narrow tab's one-line turns, the ask box, the header's facts and the drawer at work, the agent chip and its
// picker, and the switcher's rows. Pure: no React, no RPC.

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { liveAgentsForProject } from "@/app/view/code/codehandoff";

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

// only these runtimes' replies can be copied back, so only they are tied to a board (decision 7)
const BOARD_AGENT_RUNTIMES = new Set(["claude", "pi"]);
// the roster and the server both read an agent with no runtime as claude
const DEFAULT_RUNTIME = "claude";

// where the talk renders: beside the agent's transcript (the narrow workspace tab), the workspace tab expanded over
// the center, or the Boards surface
export type Placement = "beside" | "expanded" | "surface";

// a forwarded turn's forward; "sending" is the moment between the drawer's flag and the forwarder's first state
export type ForwardState = "held" | "sent" | "replied" | "needsagent" | "sending";

// send the other way (decision 3): a drawn turn can go to the agent, a forwarded one can be drawn
export type Reroute = "agent" | "draw";

export type TalkItem =
    | { kind: "question"; turnId: string; text: string; on?: string; rerouted?: string }
    // asked: in the agent's workspace, "the agent asked" with its request line alone (its words are the agent's own)
    | { kind: "briefing"; turnId: string; from: string; time: string; text: string; ask?: string; asked?: boolean }
    | {
          kind: "reply";
          turnId: string;
          text: string;
          card?: { title: string; summary: string; shapeIds: string[] };
          reroute?: Reroute;
      }
    | {
          kind: "forward";
          turnId: string;
          state: ForwardState;
          line: string;
          reply?: string; // the copied reply, where the transcript is not in view
          reason?: string; // needsagent: why
          agentTabId?: string; // replied: the agent that answered
          way?: "open" | "back"; // replied: Open agent on the surface, Back to the transcript expanded
          reroute: Reroute;
      }
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

function headItem(t: BoardTurn, now: number, placement: Placement): TalkItem | null {
    if (t.briefing != null) {
        const item: TalkItem = {
            kind: "briefing",
            turnId: t.id,
            from: t.briefing.from,
            time: talkTime(t.ts, now),
            text: t.briefing.text,
            ask: t.briefing.ask || undefined,
        };
        if (placement !== "surface") {
            item.text = "";
            item.asked = true;
        }
        return item;
    }
    if (t.kept || !t.question) {
        return null;
    }
    const item: TalkItem = { kind: "question", turnId: t.id, text: t.question, on: t.on || undefined };
    if (t.from) {
        item.rerouted =
            t.state === "forwarded" ? "sent to the agent instead of drawn" : "drawn instead of sent to the agent";
    }
    return item;
}

// a line you asked, as opposed to an agent's request (a briefing, or its ask kept on this board)
function yours(t: BoardTurn): boolean {
    return t.briefing == null && !t.kept && !!t.question;
}

function forwardState(f: BoardForward | undefined): ForwardState {
    switch (f?.state) {
        case "held":
        case "sent":
        case "replied":
        case "needsagent":
            return f.state;
        default:
            return "sending";
    }
}

function forwardItem(t: BoardTurn, agent: BoardAgent | undefined, placement: Placement, now: number): TalkItem {
    const f = t.forward;
    const state = forwardState(f);
    const who = f?.title || agent?.title || "the agent";
    const item: Extract<TalkItem, { kind: "forward" }> = {
        kind: "forward",
        turnId: t.id,
        state,
        line: "",
        reroute: "draw",
    };
    switch (state) {
        case "held":
            item.line = `waiting for ${who}`;
            break;
        case "sent":
            item.line = placement === "beside" ? "sent to the agent · answered in the transcript" : "sent to the agent";
            break;
        case "replied":
            item.line = `${who} answered · ${talkTime(f.replyts || f.sentts || t.ts, now)}`;
            if (placement !== "beside") {
                item.reply = f.reply ?? "";
                item.agentTabId = f.tabid;
                item.way = placement === "surface" ? "open" : "back";
            }
            break;
        case "needsagent":
            item.line = "needs an agent";
            if (f.reason) {
                item.reason = capitalize(f.reason.trim());
            }
            break;
        default:
            item.line = "sending to the agent";
    }
    return item;
}

function stateItem(
    t: BoardTurn,
    first: boolean,
    now: number,
    agent: BoardAgent | undefined,
    placement: Placement
): TalkItem | null {
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
            if (yours(t)) {
                item.reroute = "agent";
            }
            return item;
        }
        case "forwarded":
            return forwardItem(t, agent, placement, now);
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

export function talkItems(talk: BoardTalk, now: number, placement: Placement): TalkItem[] {
    const items: TalkItem[] = [];
    let seenAnswered = false;
    for (const t of talk.turns ?? []) {
        const head = headItem(t, now, placement);
        if (head != null) {
            items.push(head);
        }
        const state = stateItem(t, !seenAnswered, now, talk.agent, placement);
        if (state != null) {
            items.push(state);
        }
        if (t.state === "answered") {
            seenAnswered = true;
        }
    }
    return items;
}

// the narrow tab's turns (decision 9); the one being drawn shows in its header instead
const BESIDE_TURNS = 2;
const CHOSEN_LINE: Record<"keep" | "new", string> = { keep: "kept here", new: "moved to a new board" };

// one line per turn in the narrow tab: what was asked, what came of it, and its one action
export interface BesideLine {
    turnId: string;
    text: string; // your line, or the agent's request
    agent: boolean; // the agent's request
    detail: string;
    forward?: ForwardState;
    shapeIds?: string[]; // Show
    reroute?: Reroute;
    failed?: boolean; // Retry
    asks?: boolean; // the request's open choice: New board from this, Keep it here
}

function besideLine(group: TalkItem[]): BesideLine | null {
    const head = group.find((i) => i.kind === "question" || i.kind === "briefing");
    const state = group.find((i) => i !== head);
    if (state == null || state.kind === "working") {
        return null;
    }
    const line: BesideLine = { turnId: state.turnId, text: "", agent: false, detail: "" };
    let on: string | undefined;
    if (head?.kind === "question") {
        line.text = head.text;
        on = head.on;
    } else if (head?.kind === "briefing") {
        line.text = head.ask || head.text;
        line.agent = true;
    }
    switch (state.kind) {
        case "reply":
            if (state.card != null) {
                line.detail = [on && `on ${on}`, state.card.title, state.card.summary].filter(Boolean).join(" · ");
                line.shapeIds = state.card.shapeIds;
            } else {
                line.detail = state.text;
            }
            if (state.reroute != null) {
                line.reroute = state.reroute;
            }
            break;
        case "forward":
            line.detail = state.line;
            line.forward = state.state;
            line.reroute = state.reroute;
            break;
        case "failed":
            line.detail = "couldn't answer";
            line.failed = true;
            break;
        case "stopped":
            line.detail = "stopped";
            break;
        case "asks":
            if (state.choice != null) {
                line.detail = CHOSEN_LINE[state.choice];
            } else {
                line.detail = state.text;
                line.asks = true;
            }
            break;
    }
    return line;
}

// the last turns as one line each, from talkItems(..., "beside")
export function besideLines(items: TalkItem[]): BesideLine[] {
    const groups = new Map<string, TalkItem[]>();
    for (const item of items) {
        groups.set(item.turnId, [...(groups.get(item.turnId) ?? []), item]);
    }
    const lines = [...groups.values()].map(besideLine).filter((l): l is BesideLine => l != null);
    return lines.slice(-BESIDE_TURNS);
}

// the drawer at work, for a header: the answering turn's time so far
export function drawerWorking(
    talk: BoardTalk | null,
    now: number
): { turnId: string; elapsed: string; slow: boolean } | null {
    const t = (talk?.turns ?? []).find((t) => t.state === "answering");
    if (t == null) {
        return null;
    }
    const ms = now - t.ts;
    return { turnId: t.id, elapsed: elapsedText(ms), slow: ms >= SLOW_AFTER_MS };
}

function turnInFlight(talk: BoardTalk | null): boolean {
    return (talk?.turns ?? []).some((t) => t.state === "waiting" || t.state === "answering");
}

// one box, one Ask: the drawer draws the line or flags it for the agent
export function askBox(
    talk: BoardTalk | null,
    selection: string | null,
    busy: boolean,
    wontOpen: boolean
): { disabled: boolean; hint: string; placeholder: string; stoppable: boolean } {
    const placeholder = "Ask the board";
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

// "3 drawings · 14 shapes · drawn 15:20" (decision 13)
export function boardFacts(info: BoardInfo, shapes: number, now: number): string {
    const drawings = info.drawings ?? 0;
    if ((info.questions ?? 0) === 0 && drawings === 0 && shapes === 0) {
        return `empty · created ${talkTime(info.createdts, now)}`;
    }
    const facts = [plural(drawings, "drawing"), plural(shapes, "shape")];
    if (info.drawnts) {
        facts.push(`drawn ${talkTime(info.drawnts, now)}`);
    }
    return facts.join(" · ");
}

export interface AgentChoice {
    tabId: string;
    name: string;
    runtime: string;
    current: boolean; // the board's agent now
}

// the picker's agents: the project's live claude and pi agents, the ones a forward can be typed into
export function agentChoices(
    agents: readonly AgentVM[],
    project: string,
    currentTabId: string | undefined
): AgentChoice[] {
    return liveAgentsForProject(agents, project)
        .filter((a) => !a.booting && BOARD_AGENT_RUNTIMES.has(a.agent || DEFAULT_RUNTIME))
        .map((a) => ({
            tabId: a.id,
            name: a.name,
            runtime: a.agent || DEFAULT_RUNTIME,
            current: a.id === currentTabId,
        }));
}

// the header's agent chip (decision 10)
export function agentChip(agent: BoardAgent | undefined): { label: string; runtime?: string } {
    return agent != null ? { label: agent.title, runtime: agent.runtime } : { label: "No agent" };
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

export interface SwitcherList {
    channelId: string;
    project: string;
    boards: BoardInfo[];
}

export interface SwitcherGroup {
    channelId: string;
    heading: string;
    rows: SwitcherRow[];
}

function lastActive(boards: BoardInfo[]): number {
    return Math.max(0, ...boards.map((b) => b.activets || b.createdts));
}

// one group per project: the open board's project first, then the others with boards, most recently active first
export function switcherGroups(lists: SwitcherList[], currentId: string, now: number): SwitcherGroup[] {
    const isCurrent = (l: SwitcherList) => Number(l.channelId === currentId);
    return lists
        .filter((l) => isCurrent(l) || l.boards.length > 0)
        .sort((a, b) => isCurrent(b) - isCurrent(a) || lastActive(b.boards) - lastActive(a.boards))
        .map((l) => ({ channelId: l.channelId, ...switcherRows(l.boards, l.project, now) }));
}
