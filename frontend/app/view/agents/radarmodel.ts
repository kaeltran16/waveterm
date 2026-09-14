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
    recurring: { label: "Recurring", hint: "seen in an earlier scan too", delta: "recurring", tone: "recurring" },
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

function isOpenGroup(group: string): boolean {
    return group === "new" || group === "recurring";
}

// An open finding the latest scan did not detect stays open for a scan before moving to No longer
// detected (one miss is usually model variance), so its group alone overstates what the scan saw.
export function missedLatestScan(f: RadarFinding): boolean {
    return isOpenGroup(f.group) && (f.misscount ?? 0) > 0;
}

export function isDetectedNow(f: RadarFinding): boolean {
    return isOpenGroup(f.group) && !missedLatestScan(f);
}

// findingDelta is a finding's lifecycle note in the list.
export function findingDelta(f: RadarFinding): string {
    return missedLatestScan(f) ? "not detected this scan" : groupMeta(f.group).delta;
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

// scan-scope selector entries: registered projects that actually have a path (radar surface).
export function projectsWithPath<T extends { path?: string }>(
    projects: Record<string, T> | null | undefined
): [string, T][] {
    return Object.entries(projects ?? {}).filter(([, v]) => v?.path) as [string, T][];
}

export function isResultsState(state: RadarScanState): boolean {
    return state === "results" || state === "partial";
}

export function rescanLabel(state: RadarScanState): string {
    return state === "partial" ? "Re-run full scan" : "Re-scan";
}

export function scanScopeLabel(scope: { name: string } | null): string {
    return scope ? `Scanning ${scope.name}` : "Select a registered project to scan";
}

export function coverageEntries(report: RadarReport): { collector: string; status: string }[] {
    return Object.entries(report.coverage ?? {}).map(([collector, status]) => ({ collector, status }));
}

// classifyCoverage maps a streamed per-collector coverage status to a checklist cell. During a scan each
// collector streams queued (absent) -> running -> ok/failed; "partial" counts as a failure (matches
// hasCoverageFailure). Shared by the scan checklist and the header coverage row so they never drift.
export type CoverageCell = "done" | "running" | "failed" | "queued";
export function classifyCoverage(status: string | undefined): CoverageCell {
    if (status === "ok") {
        return "done";
    }
    if (status === "running") {
        return "running";
    }
    if (status === "failed" || status === "partial") {
        return "failed";
    }
    return "queued";
}

export function hasCoverageFailure(report: RadarReport): boolean {
    return coverageEntries(report).some((e) => e.status !== "ok");
}

// reports written before a repository change stopped counting as a coverage gap carry this marker in
// partialsources
const REPOSITORY_CHANGED = "repository-changed";

// partialCollectors names the collectors that failed, which is what makes a scan partial.
export function partialCollectors(report: RadarReport): string[] {
    return (report.partialsources ?? []).filter((s) => s !== REPOSITORY_CHANGED);
}

// repositoryChangedDuringScan reports whether HEAD or the working tree moved while the scan ran. It is a
// note, not a coverage gap: every collector still ran. The end boundary exists only once the scan
// finalized.
export function repositoryChangedDuringScan(report: RadarReport): boolean {
    if ((report.partialsources ?? []).includes(REPOSITORY_CHANGED)) {
        return true;
    }
    if (!report.windowendts) {
        return false;
    }
    const headMoved = !!report.starthead && !!report.endhead && report.starthead !== report.endhead;
    return headMoved || (report.startdirty ?? "") !== (report.enddirty ?? "");
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
// the latest scan still detecting the finding ("the fix did not take"). cancelled/failed/orphaned carry no
// list badge (surfaced only in the detail pane). Pure — no jotai/RPC.
export function investigationBadge(f: RadarFinding): InvestigationBadge {
    const inv = f.investigation;
    if (!inv) {
        return null;
    }
    if (inv.status === "executing") {
        return "investigating";
    }
    if (inv.status === "done") {
        return isDetectedNow(f) ? "still-detected" : "investigated";
    }
    return null;
}

// investigationEndLabel labels an investigation that ended without completing.
export function investigationEndLabel(status: string): string {
    switch (status) {
        case "cancelled":
            return "Investigation cancelled";
        case "orphaned":
            return "Investigation run no longer exists";
        default:
            return "Investigation failed";
    }
}

export type RadarMode = "correctness" | "security" | "debt";

export const MODE_ORDER: RadarMode[] = ["correctness", "security", "debt"];

const KNOWN_MODES = new Set<string>(MODE_ORDER);

export interface ModeMeta {
    label: string;
    short: string;
}

export const MODE_META: Record<RadarMode, ModeMeta> = {
    correctness: { label: "Correctness", short: "Corr" },
    security: { label: "Security", short: "Sec" },
    debt: { label: "Tech-debt", short: "Debt" },
};

// findingMode reads a finding's mode, defaulting empty/unknown to correctness (reports written before
// the multi-mode change carry no mode).
export function findingMode(f: RadarFinding): RadarMode {
    const m = f.mode;
    return (m && KNOWN_MODES.has(m) ? m : "correctness") as RadarMode;
}

// modeFilterOptions returns the distinct modes present among findings, in canonical order — the set
// the surface's filter chips render.
export function modeFilterOptions(findings: RadarFinding[]): RadarMode[] {
    const present = new Set((findings ?? []).map(findingMode));
    return MODE_ORDER.filter((m) => present.has(m));
}

export function filterByMode(findings: RadarFinding[], mode: RadarMode | "all"): RadarFinding[] {
    return mode === "all" ? (findings ?? []) : (findings ?? []).filter((f) => findingMode(f) === mode);
}

// failedLenses returns the mode runs that failed to cluster — the per-lens error banner's source.
export function failedLenses(report: RadarReport | null): RadarModeRun[] {
    return (report?.moderuns ?? []).filter((r) => r.status === "clustering-failed");
}
