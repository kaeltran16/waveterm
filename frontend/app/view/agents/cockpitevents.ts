// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit's Events rail: what changed state, never what an agent said. A run's events are the engine's
// persisted ones; a plain agent has no history anywhere, so its transitions are observed here and are lost on
// reload (effort 9868f8d2, decided frontend-only). Pure.

import { isFinishTransition } from "./agentrowmodel";
import { matchesProjectFilter, type AgentState, type AgentVM } from "./agentsviewmodel";
import { leadlessCardId } from "./cardgridlayout";
import { rowKey } from "./leadcardmodel";
import type { Lineage, RunInfo } from "./runlineage";
import { detailOf, eventText, finalEndedWords } from "./runtimeline";

export type RailKind =
    | "asked"
    | "answered"
    | "finished"
    | "quiet"
    | "failed"
    | "told"
    | "acted"
    | "landed"
    | "sentback";

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
    landed: "landed",
};

const FINAL_COMMAND_STEP = "final";
const FINAL_FAILED = "failed";

/** Pure: the rail's kind and text for one engine event, or undefined when it stays off the rail. A failed review
 *  counts once as failed, when its rounds are spent. Of the final stage's steps only the Final command passing and
 *  any step failing show, since a command passing is not the stage passing; the stage's end (final-ended, recorded
 *  whatever decided the outcome: the steps, the verifier's verdict or a human) says how the stage itself ended. */
function runRailKind(e: RunEvent): { kind: RailKind; text: string } | undefined {
    const d = detailOf<{
        final?: boolean;
        taskid?: string;
        note?: string;
        state?: string;
        step?: string;
        ok?: boolean;
        reason?: string;
        by?: string;
        outcome?: string;
    }>(e);
    switch (e.kind) {
        case "task-review-failed":
            if (d?.final) {
                return { kind: "failed", text: eventText(e) };
            }
            // a run row shows its text in place of the verb, so the text says it
            return {
                kind: "sentback",
                text: ["review sent back", d?.taskid, d?.note?.replace(/\s+/g, " ")].filter(Boolean).join(" · "),
            };
        case "plan-reviewed":
            // accepted is a failed review the lead went on past: its failure is already on the rail
            if (d?.state === "passed") {
                return { kind: "finished", text: "plan review passed" };
            }
            return d?.state === "failed" ? { kind: "failed", text: "plan review failed" } : undefined;
        case "final-step":
            if (d?.ok === false) {
                return { kind: "failed", text: eventText(e) };
            }
            return d?.ok === true && d.step === FINAL_COMMAND_STEP
                ? { kind: "finished", text: eventText(e) }
                : undefined;
        case "final-ended": {
            const words = finalEndedWords(e);
            if (words == null) {
                return undefined;
            }
            return { kind: d?.outcome === FINAL_FAILED ? "failed" : "finished", text: words };
        }
        case "land-held":
            return { kind: "failed", text: ["land held", d?.reason].filter(Boolean).join(" · ") };
        case "task-forwarded":
            return { kind: d?.by === "human" ? "acted" : "asked", text: eventText(e) };
        case "task-retried":
        case "task-skipped":
        case "task-escalated":
            // the lead's own actions and the engine's retries are not the human's
            return d?.by === "human" ? { kind: "acted", text: eventText(e) } : undefined;
        case "final-rerun":
            return { kind: "acted", text: eventText(e) };
    }
    const kind = RUN_KIND[e.kind];
    return kind == null ? undefined : { kind, text: eventText(e) };
}

/** Pure: a run's engine events as rail events. A click lands on the task's row of the run's card when the event
 *  names a task, else on the card: the lead's, or the run's own with no lead. */
export function runRailEvents(run: RunInfo, events: RunEvent[], leadId?: string): RailEvent[] {
    const cardId = leadId ?? leadlessCardId(run.runId);
    const out: RailEvent[] = [];
    for (const e of events) {
        const mapped = runRailKind(e);
        if (mapped == null) {
            continue;
        }
        const taskId = detailOf<{ taskid?: string }>(e)?.taskid;
        out.push({
            key: `${run.runId}:${e.id}`,
            focusId: taskId ? rowKey(cardId, taskId) : cardId,
            who: run.title,
            ...mapped,
            ts: e.ts,
            group: run.runId,
        });
    }
    return out;
}

/** Pure: a run lead's own questions as rail events, and the leads' next states. Only a lead turning to asking
 *  records one, named by its run and focused on its card: its workers and reviewers are covered by the run's
 *  events. A first sighting records nothing, as for plain agents. */
export function leadAskEvents(
    prev: Record<string, AgentState>,
    leads: { agent: AgentVM; title: string }[],
    now: number
): { events: RailEvent[]; next: Record<string, AgentState> } {
    const events: RailEvent[] = [];
    const next: Record<string, AgentState> = {};
    for (const { agent: a, title } of leads) {
        const was = prev[a.id];
        next[a.id] = a.state;
        if (was == null || was === "asking" || a.state !== "asking") {
            continue;
        }
        const ts = now - (a.blockedMs ?? 0);
        events.push({
            key: `${a.id}:asked:${ts}`,
            focusId: a.id,
            who: title,
            kind: "asked",
            text: a.ask?.questions?.[0]?.question ?? "",
            ts,
        });
    }
    return { events, next };
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

/** Pure: an "asked" event recorded before its question arrived takes the question once it lands. Only the
 *  agent's newest event is filled, so an earlier ask never takes the text of a later one. Returns `events`
 *  itself when nothing changed. */
export function fillAskedText(events: RailEvent[], agents: AgentVM[]): RailEvent[] {
    const byId = new Map(agents.map((a) => [a.id, a]));
    const newest = new Map<string, RailEvent>();
    for (const e of events) {
        if (e.focusId != null && e.group == null && (newest.get(e.focusId)?.ts ?? -Infinity) < e.ts) {
            newest.set(e.focusId, e);
        }
    }
    let changed = false;
    const out = events.map((e) => {
        if (e.kind !== "asked" || e.text || e.group != null || newest.get(e.focusId) !== e) {
            return e;
        }
        const a = byId.get(e.focusId);
        const question = a?.state === "asking" ? a.ask?.questions?.[0]?.question : undefined;
        if (!question) {
            return e;
        }
        changed = true;
        return { ...e, text: question };
    });
    return changed ? out : events;
}

/** Pure: the rows a project scope keeps. An agent's row follows its agent's project, a run's row its lead's;
 *  a row whose agent or lead is gone from the roster drops out of any scope but "all". */
export function scopeRailRows<T extends RailEvent>(
    rows: T[],
    agents: AgentVM[],
    lineage: Lineage,
    projectFilter: string
): T[] {
    if (projectFilter === "all") {
        return rows;
    }
    const byId = new Map(agents.map((a) => [a.id, a]));
    const leadOf = (runId: string) =>
        Object.entries(lineage.roles).find(([, r]) => r.kind === "lead" && r.runId === runId)?.[0];
    return rows.filter((e) => {
        const id = e.group != null ? leadOf(e.group) : e.focusId;
        const a = id != null ? byId.get(id) : undefined;
        return a != null && matchesProjectFilter(a, projectFilter);
    });
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
            // the row above names the run, so the toggle need not
            out.push({ ...e, more: open[g] ? "show less" : `+${count[g] - 1} more` });
        } else if (open[g]) {
            out.push(e);
        }
    }
    return out;
}
