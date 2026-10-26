// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Opening a session at a search hit: the list keeps the search it came from, and the session's detail pane
// draws a find bar over its transcript (a turn hit) or highlights the event (an event hit).

import { globalStore } from "@/app/store/jotaiStore";
import { landOn } from "@/app/view/jarvis/returnsurface";
import type { AgentsViewModel } from "./agents";
import { sessionKey, sessionSelection } from "./sessionsruns";

export interface SessionsFind {
    sessionKey: string; // `${runtime}:${id}`
    query: string; // as typed, shown in the bar
    terms: string[]; // CommandSearchSessionsRtnData.terms
    target: { kind: "turn" | "event"; ord: number };
    at: ReturnType<typeof sessionSelection>; // the selection that puts sessionKey in view
}

// hit omitted = the first hit, or a turn target at ord 0 when there is none
export function openSessionHit(
    model: AgentsViewModel,
    r: SessionSearchResult,
    query: string,
    terms: string[],
    hit?: SessionHit
): void {
    const h = hit ?? r.hits?.[0];
    const target: SessionsFind["target"] = h
        ? { kind: h.kind as "turn" | "event", ord: h.ord }
        : { kind: "turn", ord: 0 };
    const to = sessionSelection(r.session);
    globalStore.set(model.sessionsQueryAtom, query);
    globalStore.set(model.sessionsSelAtom, to.sel);
    if (to.member != null) {
        globalStore.set(model.sessionsMemberAtom, to.member);
    }
    globalStore.set(model.sessionsViewAtom, target.kind === "event" ? "activity" : "transcript");
    globalStore.set(model.sessionsFindAtom, { sessionKey: sessionKey(r.session), query, terms, target, at: to });
    landOn(model.surfaceAtom, "sessions");
}

// Selecting another session ends a find. Read from the selection, never from the session a detail pane
// renders: while the pane animates from one detail to another, the outgoing one still renders the old session.
// The merged feed ("all") selects no session, so it leaves the find set.
export function findEnded(find: SessionsFind | null, sel: string, member: string): boolean {
    if (find == null || sel === "all") {
        return false;
    }
    return sel !== find.at.sel || (find.at.member != null && member !== find.at.member);
}

// the find bar's next position, wrapping; 0 when there is nothing to step through
export function stepFind(pos: number, total: number, dir: 1 | -1): number {
    return total > 0 ? (pos + dir + total) % total : 0;
}

// Folds case one code point at a time, so a folding that changes a character's length (İ) cannot shift the
// offsets: at[i] is the original [start, end) of the character folded[i] came from.
function foldText(text: string): { folded: string; at: [number, number][] } {
    let folded = "";
    const at: [number, number][] = [];
    let i = 0;
    for (const ch of text) {
        const low = ch.toLowerCase();
        folded += low;
        for (let k = 0; k < low.length; k++) {
            at.push([i, i + ch.length]);
        }
        i += ch.length;
    }
    return { folded, at };
}

// Every occurrence of every term in text, as sorted UTF-16 [start, end) ranges, with overlapping ones merged:
// the same rule the Go matcher counts turn hits by, so a turn's ranges here are its hits there.
export function findRanges(text: string, terms: string[]): [number, number][] {
    const { folded, at } = foldText(text);
    const found: [number, number][] = [];
    for (const term of terms) {
        const t = term.toLowerCase();
        if (t === "") {
            continue;
        }
        // resumes past each occurrence, as the Go matcher does, so "aa" in "aaaa" is two touching ranges
        for (let i = folded.indexOf(t); i >= 0; i = folded.indexOf(t, i + t.length)) {
            found.push([at[i][0], at[i + t.length - 1][1]]);
        }
    }
    found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: [number, number][] = [];
    for (const r of found) {
        const last = merged[merged.length - 1];
        if (last != null && r[0] < last[1]) {
            last[1] = Math.max(last[1], r[1]);
        } else {
            merged.push([r[0], r[1]]);
        }
    }
    return merged;
}

// The terms of a query the user refines in the find bar, by the search's own rule (ParseQuery,
// pkg/agentsessions): lower-cased words, and double-quoted text as one term; an unclosed quote runs to the end.
export function findTerms(query: string): string[] {
    return query.split('"').flatMap((part, i) => {
        const words = part.toLowerCase().split(/\s+/).filter(Boolean);
        return i % 2 === 1 ? (words.length ? [words.join(" ")] : []) : words;
    });
}
