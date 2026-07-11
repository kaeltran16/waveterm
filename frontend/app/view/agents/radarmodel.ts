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
