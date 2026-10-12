// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit's Events rail: what changed state, never what an agent said. A run's events are the engine's
// persisted ones; a plain agent has no history anywhere, so its transitions are observed here and are lost on
// reload (effort 9868f8d2, decided frontend-only). Pure.

import { isFinishTransition } from "./agentrowmodel";
import type { AgentState, AgentVM } from "./agentsviewmodel";
import type { RunInfo } from "./runlineage";
import { detailOf, eventText } from "./runtimeline";

export type RailKind = "asked" | "answered" | "finished" | "quiet" | "failed" | "told" | "landed";

export interface RailEvent {
    key: string;
    focusId?: string;
    who: string;
    kind: RailKind;
    text: string;
    ts: number;
    // the run an engine event belongs to; a run's events fold under its newest one
    group?: string;
}

export type RailRow = RailEvent & { more?: string };

export interface AgentSnap {
    state: AgentState;
    // idle with a shell task still running: its turn ended but its work did not
    standingBy: boolean;
    // turned idle from working before a shell-task read since then landed: its finish waits on that read
    held: boolean;
}

export const RAIL_MAX = 50;

/** Pure: an agent's next snapshot. A finish is held only when one is owed: the agent turned idle from
 *  working (or was already held) and its shell-task read since then is still pending. An agent first seen
 *  idle holds nothing, so a mount or reload never plays a finish when its first read lands. */
export function nextSnap(
    was: AgentSnap | undefined,
    state: AgentState,
    standingBy: boolean,
    readPending: boolean
): AgentSnap {
    const held = state === "idle" && readPending && was != null && (was.state === "working" || was.held);
    return { state, standingBy, held };
}

/** Pure: whether the step from `was` to `snap` finishes the agent, for the rail, the card and the header.
 *  Held and standing by both mean not finished yet; releasing either with nothing running finishes it. */
export function finishes(was: AgentSnap, snap: AgentSnap): boolean {
    return isFinishTransition(was.state, snap.state, was.standingBy || was.held, snap.standingBy || snap.held);
}

/** Pure: the rail events between the last snapshot and now, and the next snapshot. A first sighting records
 *  nothing, so a reload never floods the rail with every agent's current state. An agent standing by (ids in
 *  `standingBy`) finishes when its last shell task ends, not at the Stop that began it; one whose shell-task
 *  read since the Stop is pending (ids in `readPending`) finishes when that read lands with nothing running. */
export function agentTransitions(
    prev: Record<string, AgentSnap>,
    agents: AgentVM[],
    now: number,
    standingBy: ReadonlySet<string> = new Set(),
    readPending: ReadonlySet<string> = new Set()
): { events: RailEvent[]; next: Record<string, AgentSnap> } {
    const events: RailEvent[] = [];
    const next: Record<string, AgentSnap> = {};
    for (const a of agents) {
        const was = prev[a.id];
        const snap = nextSnap(was, a.state, standingBy.has(a.id), readPending.has(a.id));
        next[a.id] = snap;
        if (was == null || (was.state === snap.state && was.standingBy === snap.standingBy && was.held === snap.held)) {
            continue;
        }
        const push = (kind: RailKind, text: string, ts: number) =>
            events.push({ key: `${a.id}:${kind}:${ts}`, focusId: a.id, who: a.name, kind, text, ts });
        if (a.state === "asking") {
            push("asked", a.ask?.questions?.[0]?.question ?? "", now - (a.blockedMs ?? 0));
        } else if (was.state === "asking") {
            push("answered", "", now);
        } else if (finishes(was, snap)) {
            // idleSince is the Stop, which for an agent that stood by is long before its last task ended
            push("finished", a.activity || a.task, was.standingBy && !was.held ? now : (a.idleSince ?? now));
        }
    }
    return { events, next };
}

const RUN_KIND: Record<string, RailKind> = {
    "child-ask": "asked",
    "child-answered": "answered",
    // a finished task lands only at its merge, which a held merge can put off indefinitely
    "task-done": "finished",
    "task-merged": "landed",
    "task-failed": "failed",
    "task-verify-failed": "failed",
    "lead-wake-failed": "failed",
    "engine-stuck": "failed",
    "task-stalled": "quiet",
    "task-told": "told",
    "dag-done": "finished",
    "dag-cancelled": "finished",
};

/** Pure: a run's engine events as rail events. A failed review counts once, when its rounds are spent. */
export function runRailEvents(run: RunInfo, events: RunEvent[], leadId?: string): RailEvent[] {
    const out: RailEvent[] = [];
    for (const e of events) {
        let kind = RUN_KIND[e.kind];
        if (e.kind === "task-review-failed" && detailOf<{ final?: boolean }>(e)?.final) {
            kind = "failed";
        }
        if (kind == null) {
            continue;
        }
        out.push({
            key: `${run.runId}:${e.id}`,
            focusId: leadId,
            who: run.title,
            kind,
            text: eventText(e),
            ts: e.ts,
            group: run.runId,
        });
    }
    return out;
}

/** Pure: newest first, one per key, at most `max`. */
export function mergeRailEvents(lists: RailEvent[][], max = RAIL_MAX): RailEvent[] {
    const seen = new Set<string>();
    return lists
        .flat()
        .sort((x, y) => y.ts - x.ts)
        .filter((e) => (seen.has(e.key) ? false : (seen.add(e.key), true)))
        .slice(0, max);
}

/** Pure: events after the last "mark all read" are new. */
export function splitUnread(events: RailEvent[], seenTs: number): { fresh: RailEvent[]; old: RailEvent[] } {
    return { fresh: events.filter((e) => e.ts > seenTs), old: events.filter((e) => e.ts <= seenTs) };
}

/** Pure: the rows a list shows. A run with several events shows its newest, which counts the rest, until it is
 *  opened; plain agents' events always show. */
export function groupRailEvents(events: RailEvent[], open: Record<string, boolean>): RailRow[] {
    const count: Record<string, number> = {};
    for (const e of events) {
        if (e.group != null) {
            count[e.group] = (count[e.group] ?? 0) + 1;
        }
    }
    const seen = new Set<string>();
    const out: RailRow[] = [];
    for (const e of events) {
        const g = e.group;
        if (g == null || count[g] < 2) {
            out.push(e);
        } else if (!seen.has(g)) {
            seen.add(g);
            out.push({ ...e, more: open[g] ? `show less from ${e.who}` : `+${count[g] - 1} more from ${e.who}` });
        } else if (open[g]) {
            out.push(e);
        }
    }
    return out;
}
