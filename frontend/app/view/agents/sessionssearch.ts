// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure model for searching the Sessions list: which rows a query keeps, and the snippet rows each card lists
// under its usual lines. A run card gathers its lead's hits, and its members' when Run agents is on. No React.

import { filterByStatus, type LiveSession, type SessionStatusFilter } from "./sessionsarchivestore";
import {
    isSoloSession,
    LEAD_MEMBER,
    memberOfSession,
    runSelKey,
    sessionKey,
    taskNum,
    type RunSessions,
    type RunView,
} from "./sessionsruns";

// a query this short (non-space characters) does not search
const MIN_QUERY_CHARS = 2;

// one entry of the left list: an orchestrator run or a session on its own
export interface Row {
    key: string;
    live: boolean;
    lastactivets: number;
    run?: { group: RunSessions; view: RunView };
    session?: LiveSession;
}

export interface SnippetRow {
    key: string;
    who: string; // you | agent on a solo; lead, a task number or a stage role on a run card; the event type
    hit: SessionHit;
    result: SessionSearchResult;
}

export interface CardMatch {
    hits: SnippetRow[];
    total: number; // every hit on the card, returned or not
    results: SessionSearchResult[]; // the card's matched sessions, its lead first; the card opens the first
}

export function isSearchQuery(query: string): boolean {
    return query.replace(/\s/g, "").length >= MIN_QUERY_CHARS;
}

export function keepRow(r: Row, f: SessionStatusFilter): boolean {
    if (f === "all") {
        return true;
    }
    if (f === "live") {
        return r.live;
    }
    if (r.run) {
        return f === "needs" ? r.run.view.needs.length > 0 : !r.live;
    }
    return filterByStatus([r.session!], f).length > 0;
}

export function scopeRows(rows: Row[], project: string): Row[] {
    if (project === "all") {
        return rows;
    }
    return rows.filter((r) => (r.run ? r.run.view.project : r.session!.projectname) === project);
}

export function composeSearchRows(
    rows: Row[],
    matches: Map<string, CardMatch>,
    status: SessionStatusFilter,
    project: string
): Row[] {
    return scopeRows(
        rows.filter((r) => matches.has(r.key)),
        project
    ).filter((r) => keepRow(r, status));
}

// the list row a session sits on: its run's card, else its own
function rowKeyOf(s: SessionActivity): string {
    return isSoloSession(s) ? sessionKey(s) : runSelKey(s.runid!);
}

function whoOf(s: SessionActivity, hit: SessionHit): string {
    if (hit.kind === "event") {
        return hit.speaker;
    }
    if (isSoloSession(s)) {
        return hit.speaker === "user" ? "you" : "agent";
    }
    const member = memberOfSession(s);
    if (member === LEAD_MEMBER) {
        return "lead";
    }
    return s.taskid === member ? taskNum(member) : member;
}

const leadFirst = (a: SessionSearchResult, b: SessionSearchResult) =>
    Number(memberOfSession(b.session) === LEAD_MEMBER) - Number(memberOfSession(a.session) === LEAD_MEMBER);

export function foldHits(results: SessionSearchResult[]): Map<string, CardMatch> {
    const byRow = new Map<string, SessionSearchResult[]>();
    for (const r of results) {
        const key = rowKeyOf(r.session);
        byRow.set(key, [...(byRow.get(key) ?? []), r]);
    }
    const out = new Map<string, CardMatch>();
    for (const [key, list] of byRow) {
        const ordered = isSoloSession(list[0].session) ? list : [...list].sort(leadFirst);
        out.set(key, {
            results: ordered,
            total: ordered.reduce((n, r) => n + r.turnhits + r.eventhits, 0),
            hits: ordered.flatMap((r) =>
                (r.hits ?? []).map((hit) => ({
                    key: `${sessionKey(r.session)}:${hit.kind}:${hit.ord}`,
                    who: whoOf(r.session, hit),
                    hit,
                    result: r,
                }))
            ),
        });
    }
    return out;
}

// a hit the archive has not loaded still lists
export function mergeResultSessions(base: SessionActivity[], results: SessionSearchResult[]): SessionActivity[] {
    const have = new Set(base.map(sessionKey));
    const extra: SessionActivity[] = [];
    for (const r of results) {
        const key = sessionKey(r.session);
        if (!have.has(key)) {
            have.add(key);
            extra.push(r.session);
        }
    }
    return extra.length > 0 ? [...base, ...extra] : base;
}

const plural = (n: number, word: string, many: string) => `${n} ${n === 1 ? word : many}`;

export function searchSummary(matches: Map<string, CardMatch>): string {
    let hits = 0;
    for (const m of matches.values()) {
        hits += m.total;
    }
    return `${plural(matches.size, "session", "sessions")} · ${plural(hits, "match", "matches")}`;
}

// marks are sorted [start, end) UTF-16 offsets into text, as the RPC returns them
export function snippetParts(text: string, marks: number[][]): { text: string; mark: boolean }[] {
    const out: { text: string; mark: boolean }[] = [];
    let at = 0;
    for (const [start, end] of marks ?? []) {
        const from = Math.max(start, at);
        if (from > at) {
            out.push({ text: text.slice(at, from), mark: false });
        }
        if (end > from) {
            out.push({ text: text.slice(from, end), mark: true });
            at = end;
        }
    }
    if (at < text.length) {
        out.push({ text: text.slice(at), mark: false });
    }
    return out;
}
