// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure model for the Repo Radar surface: finding grouping, canonical counts, scan-state
// classification, selection fallback, and Run-draft construction. No jotai / RPC / React here.

export type RadarGroup = "new" | "recurring" | "nolonger" | "dismissed" | "suppressed";

export const GROUP_ORDER: RadarGroup[] = ["new", "recurring", "nolonger", "dismissed", "suppressed"];

// New + Recurring are actionable-now, so they start open; the rest are history and start collapsed.
export const DEFAULT_OPEN_GROUPS: Set<RadarGroup> = new Set<RadarGroup>(["new", "recurring"]);

const KNOWN_GROUPS = new Set<string>(GROUP_ORDER);

export function groupFindings(findings: RadarFinding[]): Record<RadarGroup, RadarFinding[]> {
    const out: Record<RadarGroup, RadarFinding[]> = {
        new: [],
        recurring: [],
        nolonger: [],
        dismissed: [],
        suppressed: [],
    };
    for (const f of findings ?? []) {
        const g = (KNOWN_GROUPS.has(f.group) ? f.group : "new") as RadarGroup;
        out[g].push(f);
    }
    return out;
}

export function findingSignalCount(f: RadarFinding): number {
    return new Set(f.signalids ?? []).size;
}

export function reportSignalCount(report: RadarReport): number {
    const ids = new Set<string>();
    for (const f of report.findings ?? []) {
        for (const id of f.signalids ?? []) {
            ids.add(id);
        }
    }
    return ids.size;
}

export function reportSourceCount(report: RadarReport): number {
    const referenced = new Set<string>();
    for (const f of report.findings ?? []) {
        for (const id of f.signalids ?? []) {
            referenced.add(id);
        }
    }
    const collectors = new Set<string>();
    for (const s of report.signals ?? []) {
        if (referenced.has(s.id)) {
            collectors.add(s.collector);
        }
    }
    return collectors.size;
}

// referencedSignals resolves a finding's signal ids to the report's signal objects, in id order,
// dropping ids with no matching signal. This is the single source for the detail pane's evidence.
export function referencedSignals(finding: RadarFinding, report: RadarReport): RadarSignal[] {
    const byId = new Map((report.signals ?? []).map((s) => [s.id, s]));
    const out: RadarSignal[] = [];
    for (const id of finding.signalids ?? []) {
        const s = byId.get(id);
        if (s) {
            out.push(s);
        }
    }
    return out;
}

// findingSourceCount counts distinct collectors among a finding's referenced signals.
export function findingSourceCount(finding: RadarFinding, report: RadarReport): number {
    return new Set(referencedSignals(finding, report).map((s) => s.collector)).size;
}

// timelineEntries derives the signals timeline from referenced signals, oldest first.
export interface TimelineEntry {
    ts: number;
    collector: string;
    summary: string;
    sourceref: string;
}

export function timelineEntries(finding: RadarFinding, report: RadarReport): TimelineEntry[] {
    return referencedSignals(finding, report)
        .map((s) => ({ ts: s.observedts, collector: s.collector, summary: s.summary, sourceref: s.sourceref }))
        .sort((a, b) => a.ts - b.ts);
}

// STRENGTH_PIPS maps the qualitative strength to filled pip count (of 3).
const STRENGTH_PIPS: Record<string, number> = { strong: 3, moderate: 2, limited: 1 };

export function strengthPips(strength: string): number {
    return STRENGTH_PIPS[strength] ?? 0;
}

// Group presentation metadata (label + lifecycle hint + delta indicator), shared by the master list
// and the detail pane so the two never drift. Tone drives color choice in the components.
export type RadarTone = "new" | "recurring" | "nolonger" | "muted";

export interface GroupMeta {
    label: string;
    hint: string;
    delta: string;
    tone: RadarTone;
}

export const GROUP_META: Record<RadarGroup, GroupMeta> = {
    new: { label: "New", hint: "since last scan", delta: "new", tone: "new" },
    recurring: { label: "Recurring", hint: "evidence strengthened", delta: "↑ strengthened", tone: "recurring" },
    nolonger: { label: "No longer detected", hint: "evidence disappeared", delta: "no longer detected", tone: "nolonger" },
    dismissed: { label: "Dismissed", hint: "closed with a reason", delta: "dismissed", tone: "muted" },
    suppressed: { label: "Suppressed", hint: "marked intentional", delta: "muted", tone: "muted" },
};

export function groupMeta(group: string): GroupMeta {
    return GROUP_META[(KNOWN_GROUPS.has(group) ? group : "new") as RadarGroup];
}

// Findings in the muted (history) lifecycle groups render dimmed and closed by default.
export function isMutedGroup(group: string): boolean {
    return group === "nolonger" || group === "dismissed" || group === "suppressed";
}

// groupSummary returns per-group counts in canonical order (all groups, including empty ones) for the
// results-header summary chips.
export function groupSummary(findings: RadarFinding[]): { group: RadarGroup; label: string; count: number }[] {
    const grouped = groupFindings(findings);
    return GROUP_ORDER.map((g) => ({ group: g, label: GROUP_META[g].label, count: grouped[g].length }));
}

export type RadarScanState =
    | "never-scanned"
    | "collecting"
    | "clustering"
    | "results"
    | "partial"
    | "no-findings"
    | "model-failed"
    | "cancelled";

export function classifyScanState(report: RadarReport | null): RadarScanState {
    if (!report) {
        return "never-scanned";
    }
    switch (report.status) {
        case "collecting":
            return "collecting";
        case "clustering":
            return "clustering";
        case "cancelled":
            return "cancelled";
        case "failed":
            return "model-failed";
        case "partial":
            return "partial";
        case "completed":
            return (report.findings?.length ?? 0) > 0 ? "results" : "no-findings";
        default:
            return "never-scanned";
    }
}

export function coverageEntries(report: RadarReport): { collector: string; status: string }[] {
    return Object.entries(report.coverage ?? {}).map(([collector, status]) => ({ collector, status }));
}

export function hasCoverageFailure(report: RadarReport): boolean {
    return coverageEntries(report).some((e) => e.status !== "ok");
}

// findings ordered by group, used for selection fallback (first actionable finding wins).
function orderedFindings(findings: RadarFinding[]): RadarFinding[] {
    const grouped = groupFindings(findings);
    return GROUP_ORDER.flatMap((g) => grouped[g]);
}

export function resolveSelection(findings: RadarFinding[], currentId: string | undefined): string | undefined {
    if (currentId && findings.some((f) => f.id === currentId)) {
        return currentId;
    }
    return orderedFindings(findings)[0]?.id;
}

// The finding->Run handoff payload. Consumed by the (deferred) Channels pending-Run composer.
export interface RadarRunDraft {
    reportId: string;
    findingId: string;
    fingerprint: string;
    mission: string;
    files: string[];
    evidenceRefs: string[];
    origin: "radar";
}

export function buildRunDraft(report: RadarReport, finding: RadarFinding): RadarRunDraft {
    return {
        reportId: report.oid,
        findingId: finding.id,
        fingerprint: finding.fingerprint,
        mission: finding.mission,
        files: [...(finding.files ?? [])],
        evidenceRefs: [...(finding.signalids ?? [])],
        origin: "radar",
    };
}

// The composer draft handed from a Radar finding to the Channels Run composer. Origin-agnostic on
// purpose: the composer never imports Radar concepts, it just renders goal + optional context + origin.
export interface PendingRunDraft {
    goal: string; // prefilled, editable
    files: string[]; // context, read-only in the composer
    evidenceRefs: string[]; // context, read-only in the composer
    radarOrigin?: { reportid: string; findingid: string; fingerprint: string };
    projectPath?: string; // resolves the target channel on landing
    landed?: boolean; // one-shot guard: set once Channels has navigated to this draft (survives surface remount)
}

// composeRunGoal turns a finding into an editable goal: the suggested mission, then (when present) the
// affected files and the evidence signal ids, so the user reviews the full context in one text field.
export function composeRunGoal(finding: RadarFinding): string {
    const parts = [finding.mission];
    const files = finding.files ?? [];
    if (files.length > 0) {
        parts.push(`\nAffected files:\n${files.map((f) => `- ${f}`).join("\n")}`);
    }
    const refs = finding.signalids ?? [];
    if (refs.length > 0) {
        parts.push(`\nEvidence: ${refs.join(", ")}`);
    }
    return parts.join("\n");
}

export function toPendingRunDraft(report: RadarReport, finding: RadarFinding): PendingRunDraft {
    const d = buildRunDraft(report, finding);
    return {
        goal: composeRunGoal(finding),
        files: d.files,
        evidenceRefs: d.evidenceRefs,
        radarOrigin: { reportid: d.reportId, findingid: d.findingId, fingerprint: d.fingerprint },
        projectPath: report.projectpath,
    };
}

export type InvestigationBadge = "investigating" | "investigated" | "still-detected" | null;

// The loop badge for a finding: an active investigation, a completed one, or a completed one contradicted by
// the finding still being detected (group still new/recurring — "the fix did not take"). cancelled/failed
// carry no list badge (surfaced only in the detail pane). Pure — no jotai/RPC.
export function investigationBadge(f: RadarFinding): InvestigationBadge {
    const inv = f.investigation;
    if (!inv) {
        return null;
    }
    if (inv.status === "executing") {
        return "investigating";
    }
    if (inv.status === "done") {
        return f.group === "new" || f.group === "recurring" ? "still-detected" : "investigated";
    }
    return null;
}
