// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Briefing's pure projection: WorkState + the live agent roster -> render-ready rows. All
// ordering, exact worker suppression, window filtering, wording and navigation normalization happens
// here; React components do not reinterpret wire kinds inline.

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { buildEffortCard, type EffortCardModel } from "./effortmodel";

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// the briefing shows capped windows, never longer pages; the header pills keep the true counts.
export const EFFORT_CAP = 6;
export const ACTIVE_CAP = 8;
export const DELTA_CAP = 10;
export const SHIPPED_CAP = 8;

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
// one recency-sorted list across runs, blockers and direct agents; the kind badge tells the
// story the old per-leg sub-headers told, so the section reads as one triage queue.
export type ActiveWorkKind = "run" | "blocker" | "agent";
export interface ActiveWorkRow {
    key: string;
    kind: ActiveWorkKind;
    oref: string;
    name: string;
    meta: string;
    chip: { label: string; tone: "blocked" | "asking" | "running" | "muted" } | null;
    ts: number;
}

// calendar-day buckets for the since-last-visit window; empty groups are dropped so a quiet
// day simply doesn't render.
export type DeltaGroupLabel = "Today" | "Yesterday" | "Earlier";
export interface DeltaGroup {
    label: DeltaGroupLabel;
    rows: DeltaRow[];
}
export function groupDelta(delta: DeltaRow[], nowTs: number): DeltaGroup[] {
    const startOfDay = (ts: number) => {
        const d = new Date(ts);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    };
    const today = startOfDay(nowTs);
    const yesterday = today - 24 * 60 * 60 * 1000;
    const groups: DeltaGroup[] = [
        { label: "Today", rows: [] },
        { label: "Yesterday", rows: [] },
        { label: "Earlier", rows: [] },
    ];
    for (const row of delta) {
        const label: DeltaGroupLabel = row.ts >= today ? "Today" : row.ts >= yesterday ? "Yesterday" : "Earlier";
        groups.find((g) => g.label === label)!.rows.push(row);
    }
    return groups.filter((g) => g.rows.length > 0);
}

// The needs-you queue: one actionable row per waiting thing, replacing the single count banner that
// only ever opened the rail. Rows come from the live attention poll (attentionstore), not the
// snapshot, so an ask raised after the snapshot still appears; the snapshot's own attention items
// stay the delta-dedup key and nothing else.
export type QueueTone = "asking" | "error";
export type QueueNav = { kind: "channel"; channelId: string; runId: string | null } | { kind: "effort"; oref: string };
export interface QueueRow {
    key: string;
    kind: string;
    title: string;
    detail: string;
    ts: number | null;
    action: string | null;
    nav: QueueNav | null;
    tone: QueueTone;
}

// dag-gate/dag-blocked are absent from the rail's map and fell through to the raw wire kind, which
// already reads as a label; spelled out here so every kind the server can emit has a written form.
const QUEUE_KIND_LABEL: Record<string, string> = {
    gate: "gate",
    escalation: "escalation",
    ask: "ask",
    "dag-gate": "dag gate",
    "dag-blocked": "dag blocked",
};

export function buildAttentionQueue(input: { attention: AttentionItem[]; efforts: EffortCardModel[] }): QueueRow[] {
    // wire order is the priority claim (gates, then escalations, then asks; oldest first inside a
    // kind — pkg/jarvis/attention.go), so this preserves it rather than re-sorting on age.
    const rows: QueueRow[] = (input.attention ?? []).map((a) => {
        const channelId = a.channelid ?? "";
        return {
            key: a.key,
            kind: QUEUE_KIND_LABEL[a.kind] ?? a.kind,
            title: a.text,
            detail: [a.source, channelId !== "" && a.channelname ? "#" + a.channelname : null]
                .filter((s) => s != null && s !== "")
                .join(" · "),
            ts: a.waitingsince > 0 ? a.waitingsince : null,
            // a standalone item names no channel, so there is no run body to land on; it renders as
            // static info rather than a button that would navigate nowhere (NeedsRow's rule, kept).
            action: channelId !== "" ? a.action : null,
            nav:
                channelId !== ""
                    ? { kind: "channel", channelId, runId: a.runid != null && a.runid !== "" ? a.runid : null }
                    : null,
            tone: a.kind === "dag-blocked" ? "error" : "asking",
        };
    });
    // a blocked chunk is attention the server's attention leg never sees; it has no waiting-since to
    // interleave on, so it follows the wire rows rather than competing with them for priority.
    for (const e of input.efforts) {
        for (const label of e.blockedChunks) {
            rows.push({
                key: "chunk:" + e.oref + ":" + label,
                kind: "chunk blocked",
                title: label,
                detail: e.title,
                ts: null,
                action: "Open",
                nav: { kind: "effort", oref: e.oref },
                tone: "asking",
            });
        }
    }
    return rows;
}

// needing-eyes first (blocked run / blocker / asking agent), recency within tier, identity last.
export function mergeActiveWork(input: {
    activeRuns: RunRow[];
    blockers: BlockerRow[];
    directAgents: AgentRow[];
}): ActiveWorkRow[] {
    const rows: ActiveWorkRow[] = [
        ...input.activeRuns.map((r) => ({
            key: "run:" + r.oref,
            kind: "run" as const,
            oref: r.oref,
            name: r.goal,
            meta: [r.project, r.status].filter(Boolean).join(" · "),
            chip:
                r.status === "blocked"
                    ? { label: "blocked", tone: "blocked" as const }
                    : { label: r.status || "running", tone: "running" as const },
            ts: r.ts,
        })),
        ...input.blockers.map((b) => ({
            key: "blocker:" + b.oref,
            kind: "blocker" as const,
            oref: b.oref,
            name: b.objective,
            meta: b.blockers,
            chip: b.project == null ? { label: "Unscoped record", tone: "muted" as const } : null,
            ts: b.ts,
        })),
        ...input.directAgents.map((a) => ({
            key: "agent:" + a.id,
            kind: "agent" as const,
            oref: a.oref,
            name: a.name + " · " + (a.task || a.name),
            meta: [a.runtime, a.project].filter(Boolean).join(" · "),
            chip: { label: a.state, tone: a.state === "asking" ? ("asking" as const) : ("running" as const) },
            ts: a.startedTs,
        })),
    ];
    return rows
        .sort((x, y) => {
            const s = (r: ActiveWorkRow) =>
                r.kind === "blocker" || (r.chip != null && (r.chip.tone === "blocked" || r.chip.tone === "asking"))
                    ? 0
                    : 1;
            const d = s(x) - s(y);
            if (d !== 0) {
                return d;
            }
            const t = y.ts - x.ts;
            if (t !== 0) {
                return t;
            }
            return x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
        })
        .map((r, i) => ({ ...r, key: r.key + ":" + i }));
}
export interface SourceHealthSummary {
    complete: boolean;
    missingLegs: string[];
    attentionState: string;
}
export interface BriefingModel {
    activeRuns: RunRow[];
    blockers: BlockerRow[];
    directAgents: AgentRow[];
    delta: DeltaRow[];
    shipped: ShippedRow[];
    efforts: EffortCardModel[];
    effortMore: number;
    activeMore: number;
    deltaMore: number;
    shippedMore: number;
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

    // the snapshot's attention items are the delta-dedup key and nothing else — the rendered queue
    // reads the live poll (buildAttentionQueue), so these are never projected into a row.
    const attentionItems = projects.flatMap((p) => p.active ?? []).filter((a) => a.kind === "attention");

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

    // efforts: non-archived only, newest-updated first (the wire already sorts; the defensive sort
    // keeps the projection total regardless of server ordering), then capped for display.
    const effortCards = (state.efforts ?? [])
        .filter((e) => e.status !== "archived")
        .sort((a, b) => b.updatedts - a.updatedts)
        .map(buildEffortCard);

    // display caps: rows show the window, the section pill keeps the true count, overflow is a link.
    const cappedRuns = activeRuns.slice(0, ACTIVE_CAP);
    const cappedBlockers = blockers.slice(0, ACTIVE_CAP);
    const cappedAgents = directAgents.slice(0, ACTIVE_CAP);
    const cappedDelta = delta.slice(0, DELTA_CAP);
    const cappedShipped = shipped.slice(0, SHIPPED_CAP);
    const over = (n: number, cap: number) => Math.max(0, n - cap);

    return {
        activeRuns: cappedRuns,
        blockers: cappedBlockers,
        directAgents: cappedAgents,
        delta: cappedDelta,
        shipped: cappedShipped,
        efforts: effortCards.slice(0, EFFORT_CAP),
        effortMore: over(effortCards.length, EFFORT_CAP),
        activeMore:
            over(activeRuns.length, ACTIVE_CAP) +
            over(blockers.length, ACTIVE_CAP) +
            over(directAgents.length, ACTIVE_CAP),
        deltaMore: over(delta.length, DELTA_CAP),
        shippedMore: over(shipped.length, SHIPPED_CAP),
        health: { complete: missingLegs.length === 0, missingLegs, attentionState: state.sources.attention },
        counts: { runs: activeRuns.length, agents: directAgents.length, delta: delta.length, shipped: shipped.length },
    };
}
