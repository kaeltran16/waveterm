// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Briefing's pure projection: WorkState + the live agent roster -> render-ready rows. All
// ordering, exact worker suppression, window filtering, wording and navigation normalization happens
// here; React components do not reinterpret wire kinds inline.

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface BriefingModelInput {
    state: WorkState;
    agents: AgentVM[];
    actualCursor: number;
    queryStartedAt: number;
    sevenDaysAgo: number;
}

export interface RunRow {
    oref: string;
    goal: string;
    project: string;
    status: string;
    workerOrefs: string[];
    ts: number;
}
export interface BlockerRow {
    oref: string;
    objective: string;
    blockers: string;
    project: string | null;
    ts: number;
}
export interface AgentRow {
    oref: string;
    id: string;
    name: string;
    task: string;
    runtime: string;
    project: string | null;
    state: "working" | "asking";
    startedTs: number;
}
export interface DeltaRow {
    key: string;
    ts: number;
    kind: string;
    title: string;
    wording: string;
    detail: string | null;
    oref: string | null;
}
export interface ShippedRow {
    oref: string;
    goal: string;
    project: string;
    summary: string;
    completedTs: number;
    fresh: boolean;
}
export interface AttentionSummary {
    count: number;
}
export interface SourceHealthSummary {
    complete: boolean;
    missingLegs: string[];
    attentionState: string;
}
export interface BriefingModel {
    attention: AttentionSummary | null;
    activeRuns: RunRow[];
    blockers: BlockerRow[];
    directAgents: AgentRow[];
    delta: DeltaRow[];
    shipped: ShippedRow[];
    health: SourceHealthSummary;
    counts: { runs: number; agents: number; delta: number; shipped: number };
}

// The ledger's dossier/blocker targets arrive as vault:<id> while the native record subject is
// task:<id>. Briefing normalizes that one alias; it does not make vault: a global alias.
export function normalizeBriefingNav(oref: string | undefined | null): string | null {
    if (oref == null || oref === "") {
        return null;
    }
    return oref.startsWith("vault:") ? "task:" + oref.slice("vault:".length) : oref;
}

// the ledger retains no dossier status-transition history; "Record updated · current status: X" is
// the honest shape of a dossier's UpdatedTs event (detail arrives as "status: X").
function dossierWording(detail: string | undefined): string {
    if (detail != null && detail.startsWith("status: ")) {
        return "Record updated · current status: " + detail.slice("status: ".length);
    }
    return "Record updated";
}

const DELTA_WORDING: Record<string, string> = {
    "run-created": "Run started",
    "run-done": "Run completed",
    decision: "Decision recorded",
};

// exact identity only: a delta attention event and the current attention item come from the same
// GatherAttention read, so the (ts, title, detail) triple is exact, never fuzzy.
function matchesAttention(ev: TimelineEvent, items: ActiveWorkItem[]): boolean {
    return items.some(
        (a) => a.kind === "attention" && a.ts === ev.ts && a.title === ev.title && a.detail === ev.detail
    );
}

function sortBy<T>(rows: T[], score: (r: T) => number, tsOf: (r: T) => number, idOf: (r: T) => string): T[] {
    return [...rows].sort((a, b) => {
        const s = score(a) - score(b);
        if (s !== 0) {
            return s;
        }
        const t = tsOf(b) - tsOf(a); // timestamp descending
        if (t !== 0) {
            return t;
        }
        return idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0; // stable identity
    });
}

export function projectBriefing(input: BriefingModelInput): BriefingModel {
    const { state, agents, actualCursor, queryStartedAt } = input;
    const projects = state.projects ?? [];

    const attentionItems = projects.flatMap((p) => p.active ?? []).filter((a) => a.kind === "attention");
    const attention = attentionItems.length > 0 ? { count: attentionItems.length } : null;

    // active runs + blocked records
    const runItems = projects.flatMap((p) => p.active ?? []).filter((a) => a.kind === "run");
    const activeRuns: RunRow[] = sortBy(
        runItems.map((a) => ({
            oref: a.navtarget ?? "run:",
            goal: a.title,
            project: a.project,
            status:
                a.detail != null && a.detail.startsWith("status: ")
                    ? a.detail.slice("status: ".length)
                    : (a.detail ?? ""),
            workerOrefs: a.workerorefs ?? [],
            ts: a.ts,
        })),
        (r) => (r.status === "blocked" ? 0 : 1),
        (r) => r.ts,
        (r) => r.oref
    );

    const blockerItems = projects.flatMap((p) => p.active ?? []).filter((a) => a.kind === "blocker");
    const blockers: BlockerRow[] = sortBy(
        blockerItems.map((a) => ({
            oref: normalizeBriefingNav(a.navtarget) ?? "",
            objective: a.title,
            blockers: a.detail ?? "",
            project: (a.project ?? "") === "" ? null : a.project,
            ts: a.ts,
        })),
        () => 0,
        (b) => b.ts,
        (b) => b.oref
    );

    // direct agents: only working/asking roster rows, never terminal/background/idle; a row whose
    // tab oref belongs to an active run is represented by the Run only — no fallback dedup.
    const runWorkerOrefs = new Set(activeRuns.flatMap((r) => r.workerOrefs));
    const directAgents: AgentRow[] = sortBy(
        agents
            .filter(
                (a) =>
                    (a.state === "working" || a.state === "asking") &&
                    a.kind !== "terminal" &&
                    a.kind !== "background" &&
                    !runWorkerOrefs.has("tab:" + a.id)
            )
            .map((a) => ({
                oref: "agent:" + a.id,
                id: a.id,
                name: a.name,
                task: a.task ?? a.name,
                runtime: a.agent ?? "",
                project: a.project ?? null,
                state: a.state as "working" | "asking",
                startedTs: queryStartedAt - (a.state === "asking" ? (a.blockedMs ?? 0) : (a.activeMs ?? 0)),
            })),
        (a) => (a.state === "asking" ? 0 : 1),
        (a) => a.startedTs,
        (a) => a.id
    );

    // shipped: only the rolling seven-day window (the server may return more when the cursor is
    // older than seven days); `fresh` when the matching run-done event is in the client-side delta.
    const shippedItems = projects.flatMap((p) => p.shipped ?? []);
    const windowedShipped = shippedItems.filter((s) => s.completedts >= input.sevenDaysAgo);

    // delta: client-side window back to actualCursor (the server fetched since min(cursor, 7d)),
    // minus current-attention duplicates, minus completions promoted into the shipped section.
    const rawDelta = projects
        .flatMap((p) => p.delta ?? [])
        .filter((ev) => ev.ts >= actualCursor && ev.kind !== "session" && !matchesAttention(ev, attentionItems));
    const promotedOrefs = new Set(windowedShipped.map((s) => "run:" + s.runoid));
    const delta: DeltaRow[] = rawDelta
        .filter((ev) => ev.kind !== "run-done" || !promotedOrefs.has(ev.navtarget ?? ""))
        .map((ev) => {
            const wording = ev.kind === "dossier" ? dossierWording(ev.detail) : (DELTA_WORDING[ev.kind] ?? ev.kind);
            return {
                key: ev.kind + ":" + ev.ts + ":" + ev.title,
                ts: ev.ts,
                kind: ev.kind,
                title: ev.title,
                wording,
                detail: ev.detail ?? null,
                oref: normalizeBriefingNav(ev.navtarget),
            };
        });

    const shipped: ShippedRow[] = windowedShipped.map((s) => ({
        oref: "run:" + s.runoid,
        goal: s.goal,
        project: s.project,
        summary: s.summary ?? "",
        completedTs: s.completedts,
        fresh: rawDelta.some((ev) => ev.kind === "run-done" && ev.navtarget === "run:" + s.runoid),
    }));

    const missingLegs: string[] = [];
    if (state.sources.runs !== true) {
        missingLegs.push("Runs");
    }
    if (state.sources.dossiers !== true) {
        missingLegs.push("Records");
    }

    return {
        attention,
        activeRuns,
        blockers,
        directAgents,
        delta,
        shipped,
        health: { complete: missingLegs.length === 0, missingLegs, attentionState: state.sources.attention },
        counts: { runs: activeRuns.length, agents: directAgents.length, delta: delta.length, shipped: shipped.length },
    };
}
