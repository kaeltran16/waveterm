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
    globalStore.set(model.sessionsFindAtom, { sessionKey: sessionKey(r.session), query, terms, target });
    landOn(model.surfaceAtom, "sessions");
}
