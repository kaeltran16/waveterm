// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure model for the Repo Radar surface: finding grouping, canonical counts, scan-state
// classification, selection fallback, and Run-draft construction. No jotai / RPC / React here.

import { formatAgo, formatTokens } from "./agentsviewmodel";
import type { LoadPhase } from "./loadphase";
import { fmtDuration } from "./runcompletion";

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

// evidenceRows is the detail pane's one evidence list: referenced signals oldest-first, each keeping its
// snippet so the diff renders inline under the signal it belongs to.
export function evidenceRows(finding: RadarFinding, report: RadarReport): RadarSignal[] {
    return referencedSignals(finding, report).sort((a, b) => a.observedts - b.observedts);
}

// STRENGTH_PIPS maps the qualitative strength to filled pip count (of 3).
const STRENGTH_PIPS: Record<string, number> = { strong: 3, moderate: 2, limited: 1 };

export function strengthPips(strength: string): number {
    return STRENGTH_PIPS[strength] ?? 0;
}

// the backend names a finding whose files share no directory "." (and one with no paths "unknown");
// neither says where to look, and the affected-files list already does, so they render as nothing
export function subsystemLabel(subsystem: string): string {
    return subsystem === "." || subsystem === "unknown" ? "" : subsystem;
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

// Whether the scan-state machine above may speak yet. classifyScanState(null) is "never-scanned", which is
// only true once the list has actually been read; before that it is loading. "ready" hands over to
// classifyScanState — Radar's empty is its never-scanned panel, so there is no "empty" here.
export function radarLoadPhase(p: {
    reports: RadarReport[] | null;
    currentReportId: string | undefined;
    report: RadarReport | null;
    loadError: string | null;
    scopeBlocked: boolean;
}): LoadPhase {
    if (p.loadError != null && p.reports == null) {
        return "error";
    }
    // a persisted project the registry no longer has never resolves; waiting on it would be a skeleton forever
    if (p.scopeBlocked) {
        return "ready";
    }
    if (p.reports == null || (p.currentReportId != null && p.report == null)) {
        return "loading";
    }
    return "ready";
}

export function isResultsState(state: RadarScanState): boolean {
    return state === "results" || state === "partial";
}

export function rescanLabel(state: RadarScanState): string {
    return state === "partial" ? "Re-run full scan" : "Re-scan";
}

// The collectors a scan runs (pkg/reporadar/types.go) and what each examines. The one list behind the
// empty state, the live scan progress and the coverage popover, so they cannot disagree.
export interface CollectorInfo {
    name: string;
    examines: string;
}

export const COLLECTORS: CollectorInfo[] = [
    { name: "structure", examines: "Source and test layout" },
    { name: "git", examines: "Recent commits and changed files" },
    { name: "runs", examines: "Recent Runs and how they ended" },
    { name: "transcript", examines: "Agent failures, retries and corrections" },
    { name: "config", examines: "Config and migration boundaries" },
    { name: "dependency", examines: "Dependency manifest pins" },
];

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

export interface CoverageRow extends CollectorInfo {
    cell: CoverageCell;
}

// coverageRows joins every known collector with its streamed status. A collector the table does not
// know yet is appended rather than dropped, so a new backend collector still shows up.
export function coverageRows(report: RadarReport | null): CoverageRow[] {
    const coverage = report?.coverage ?? {};
    const known = new Set(COLLECTORS.map((c) => c.name));
    const extra = Object.keys(coverage)
        .filter((name) => !known.has(name))
        .map((name) => ({ name, examines: "" }));
    return [...COLLECTORS, ...extra].map((c) => ({ ...c, cell: classifyCoverage(coverage[c.name]) }));
}

// The lenses clustering runs, one model call each (V1Modes in pkg/reporadar/types.go).
export const LENSES: CollectorInfo[] = [
    { name: "correctness", examines: "Test gaps, contract drift and repeated failures" },
    { name: "security", examines: "Auth, secret and input boundaries" },
];

// lensRows lists the lenses this clustering pass runs, each with its streamed status. Only the lenses in
// lensprogress are listed, since a retry reruns just the ones that failed.
export function lensRows(report: RadarReport | null): CoverageRow[] {
    const progress = report?.lensprogress ?? {};
    const known = new Set(LENSES.map((l) => l.name));
    const extra = Object.keys(progress)
        .filter((name) => !known.has(name))
        .map((name) => ({ name, examines: "" }));
    return [...LENSES.filter((l) => l.name in progress), ...extra].map((l) => ({
        ...l,
        cell: classifyCoverage(progress[l.name]),
    }));
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
    origin: "radar";
}

export function buildRunDraft(report: RadarReport, finding: RadarFinding): RadarRunDraft {
    return {
        reportId: report.oid,
        findingId: finding.id,
        fingerprint: finding.fingerprint,
        mission: finding.mission,
        files: [...(finding.files ?? [])],
        origin: "radar",
    };
}

// The composer draft handed from a Radar finding to the Channels Run composer. Origin-agnostic on
// purpose: the composer never imports Radar concepts, it just renders goal + optional context + origin.
export interface PendingRunDraft {
    goal: string; // prefilled, editable
    files: string[]; // context, read-only in the composer
    radarOrigin?: { reportid: string; findingid: string; fingerprint: string };
    projectPath?: string; // resolves the target channel on landing
    projectName?: string; // names the channel when the project has none yet
    landed?: boolean; // one-shot guard: set once Channels has navigated to this draft (survives surface remount)
}

// the mission already names the source fix and each site with its trigger, actual and expected
// (pkg/reporadar/hits.go), so the goal adds nothing to it
export function composeRunGoal(finding: RadarFinding): string {
    return finding.mission;
}

export function toPendingRunDraft(report: RadarReport, finding: RadarFinding): PendingRunDraft {
    const d = buildRunDraft(report, finding);
    return {
        goal: composeRunGoal(finding),
        files: d.files,
        radarOrigin: { reportid: d.reportId, findingid: d.findingId, fingerprint: d.fingerprint },
        projectPath: report.projectpath,
        projectName: report.projectname,
    };
}

export type InvestigationTone = "live" | "success" | "warning" | "muted";

// InvestigationView is how a finding's latest investigation reads in the list and the detail. live: the
// run is still going, so the primary button opens it. openable: a run exists to look at separately.
export interface InvestigationView {
    label: string;
    rowLabel: string;
    tone: InvestigationTone;
    live: boolean;
    openable: boolean;
    done: boolean;
}

function invView(
    label: string,
    rowLabel: string,
    tone: InvestigationTone,
    flags: { live?: boolean; openable?: boolean; done?: boolean }
): InvestigationView {
    return { label, rowLabel, tone, live: !!flags.live, openable: !!flags.openable, done: !!flags.done };
}

export function investigationView(f: RadarFinding): InvestigationView | null {
    const inv = f.investigation;
    if (!inv) {
        return null;
    }
    switch (inv.status) {
        case "executing":
            return invView("Investigating", "investigating", "live", { live: true });
        case "done":
            // a missed finding is not "still detected": the latest scan did not see it
            return isDetectedNow(f)
                ? invView("Investigated — still detected", "still detected", "warning", { openable: true, done: true })
                : invView("Investigated", "investigated", "success", { openable: true, done: true });
        case "orphaned":
            return invView("Run no longer exists", "run gone", "muted", {});
        case "cancelled":
            return invView("Investigation cancelled", "cancelled", "muted", { openable: true });
        default:
            return invView("Investigation failed", "failed", "muted", { openable: true });
    }
}

// primaryAction is the finding's one accent button, and what list-nav Enter fires. While a run is live
// the useful next step is to watch it, not to start a second one.
export interface PrimaryAction {
    kind: "start" | "open-run";
    label: string;
}

export function primaryAction(f: RadarFinding): PrimaryAction {
    const inv = f.investigation;
    if (inv?.status === "executing") {
        return { kind: "open-run", label: `Open run ${inv.runid}` };
    }
    return { kind: "start", label: inv ? "Investigate again" : "Start investigation" };
}

// the one reason that suppresses: the finding stays closed as a decision, not as a triage call
const INTENTIONAL = "Intentional";

export const DISMISS_REASONS = ["False positive", "Low priority", "Resolved elsewhere", INTENTIONAL];

export interface DismissReason {
    label: string;
    run?: string;
    action: "dismiss" | "suppress";
    reason: string;
    note?: string;
}

// A finished investigation is the likeliest reason to close a finding, so it leads the list.
export function dismissReasons(f: RadarFinding): DismissReason[] {
    const generic = DISMISS_REASONS.map(
        (reason): DismissReason => ({ label: reason, action: reason === INTENTIONAL ? "suppress" : "dismiss", reason })
    );
    const inv = f.investigation;
    if (inv?.status !== "done") {
        return generic;
    }
    const byRun: DismissReason = {
        label: "Addressed by",
        run: inv.runid,
        action: "dismiss",
        reason: "Resolved by investigation",
        note: `addressed by run ${inv.runid}`,
    };
    return [byRun, ...generic];
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

export function filterByMode(findings: RadarFinding[], mode: RadarMode | "all"): RadarFinding[] {
    return mode === "all" ? (findings ?? []) : (findings ?? []).filter((f) => findingMode(f) === mode);
}

// failedLenses returns the mode runs that failed to cluster — the per-lens error banner's source.
export function failedLenses(report: RadarReport | null): RadarModeRun[] {
    return (report?.moderuns ?? []).filter((r) => r.status === "clustering-failed");
}

export type LensKey = RadarMode | "all";

export interface LensTab {
    key: LensKey;
    label: string;
    count: number;
    failed: boolean;
    disabled: boolean;
}

// lensTabs lists All plus every lens the scan ran or has findings for. A lens that failed to cluster still
// carries its findings from the previous scan (pkg/reporadar/lifecycle.go), so it is disabled only when it
// has none. A single-lens scan gets no tabs: All and that lens would show the same list.
export function lensTabs(report: RadarReport | null): LensTab[] {
    const findings = report?.findings ?? [];
    const failed = new Set(failedLenses(report).map((r) => r.mode));
    const ran = new Set((report?.moderuns ?? []).filter((r) => r.status !== "skipped").map((r) => r.mode));
    const present = new Set(findings.map(findingMode));
    const modes = MODE_ORDER.filter((m) => ran.has(m) || present.has(m));
    if (modes.length < 2) {
        return [];
    }
    const lenses = modes.map((m) => {
        const count = findings.filter((f) => findingMode(f) === m).length;
        const isFailed = failed.has(m);
        return { key: m, label: MODE_META[m].label, count, failed: isFailed, disabled: isFailed && count === 0 };
    });
    return [{ key: "all", label: "All", count: findings.length, failed: false, disabled: false }, ...lenses];
}

export function resolveLens(tabs: LensTab[], lens: LensKey): LensKey {
    const tab = tabs.find((t) => t.key === lens);
    return tab && !tab.disabled ? lens : "all";
}

export type HealthLine =
    | { kind: "collectors"; collectors: string[] }
    | { kind: "lens"; modes: RadarMode[]; carried: number }
    | { kind: "repository-changed" };

// scanHealth lists every way the scan is incomplete or inconsistent, one line each; empty when clean.
export function scanHealth(report: RadarReport): HealthLine[] {
    const lines: HealthLine[] = [];
    const collectors = partialCollectors(report);
    if (collectors.length > 0) {
        lines.push({ kind: "collectors", collectors });
    }
    const modes = failedLenses(report).map((r) => findingMode({ mode: r.mode } as RadarFinding));
    if (modes.length > 0) {
        const carried = (report.findings ?? []).filter((f) => modes.includes(findingMode(f))).length;
        lines.push({ kind: "lens", modes, carried });
    }
    if (repositoryChangedDuringScan(report)) {
        lines.push({ kind: "repository-changed" });
    }
    return lines;
}

export function joinAnd(items: string[]): string {
    return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function lensHealthText(modes: RadarMode[], carried: number): string {
    const names = joinAnd(modes.map((m) => MODE_META[m].label));
    const subject = modes.length === 1 ? `The ${names} lens did` : `The ${names} lenses did`;
    const rest =
        carried > 0 ? "Its findings are carried over from the previous scan." : "The other lenses' findings are shown.";
    return `${subject} not cluster. ${rest}`;
}

export function plural(n: number, word: string, many = `${word}s`): string {
    return `${n} ${n === 1 ? word : many}`;
}

// scanMetaLine is the line under the subject bar. A degraded scan names what is incomplete in place of the
// payload size, which matters less than knowing the result has gaps.
export function scanMetaLine(report: RadarReport, now: number): string {
    const findings = report.findings ?? [];
    const parts = [`last scan ${formatAgo(now - (report.completedts || report.startedts))}`];
    const collectors = partialCollectors(report).length;
    const lenses = failedLenses(report).length;
    if (collectors + lenses > 0) {
        const gaps = [
            collectors > 0 ? plural(collectors, "collector") : "",
            lenses > 0 ? plural(lenses, "lens", "lenses") : "",
        ].filter(Boolean);
        return [...parts, plural(findings.length, "finding"), `${gaps.join(" and ")} incomplete`].join(" · ");
    }
    const lensCount = lensTabs(report).length - 1;
    parts.push(plural(findings.length, "finding") + (lensCount > 1 ? ` across ${lensCount} lenses` : ""));
    if (report.payloadtokens) {
        parts.push(`${formatTokens(report.payloadtokens)}-token payload`);
    }
    return parts.join(" · ");
}

export type RadarListGroup = "open" | "dismissed";

export const LIST_GROUP_ORDER: RadarListGroup[] = ["open", "dismissed"];

export const DEFAULT_OPEN_LIST_GROUPS: Set<RadarListGroup> = new Set<RadarListGroup>(LIST_GROUP_ORDER);

// a suppressed finding is a dismissal with the reason Intentional, so the two share a list group
export function listGroupOf(f: RadarFinding): RadarListGroup {
    return f.group === "dismissed" || f.group === "suppressed" ? "dismissed" : "open";
}

export function groupForList(findings: RadarFinding[]): Record<RadarListGroup, RadarFinding[]> {
    const out: Record<RadarListGroup, RadarFinding[]> = { open: [], dismissed: [] };
    for (const f of findings ?? []) {
        out[listGroupOf(f)].push(f);
    }
    return out;
}

export function isNewFinding(f: RadarFinding): boolean {
    return f.group === "new";
}

export interface ListGroupMeta {
    label: string;
    hint: string;
    tone: "open" | "muted";
}

export function listGroupMeta(group: RadarListGroup, items: RadarFinding[]): ListGroupMeta {
    if (group === "dismissed") {
        return { label: "Dismissed", hint: "closed with a reason", tone: "muted" };
    }
    const fresh = items.filter(isNewFinding).length;
    return { label: "Open", hint: fresh > 0 ? `${fresh} new in the latest scan` : "", tone: "open" };
}

export interface FindingSite {
    dir: string;
    file: string;
    line: number;
    path: string;
    more: number;
}

// findingSite is the first site of the finding's one file, which is what the row and the site link name.
export function findingSite(f: RadarFinding): FindingSite | null {
    const path = f.files?.[0];
    const sites = f.sites ?? [];
    if (!path || sites.length === 0) {
        return null;
    }
    const cut = path.lastIndexOf("/") + 1;
    return { dir: path.slice(0, cut), file: path.slice(cut), line: sites[0].line, path, more: sites.length - 1 };
}

const SHORT_SHA_LEN = 8;

export function shortSha(commit: string): string {
    return (commit ?? "").slice(0, SHORT_SHA_LEN);
}

export interface SourceFix {
    sha: string;
    subject: string;
    ts?: number;
}

// sourceFix is the fix commit whose audit found this finding. The backend keeps one git signal per source
// commit, so the commit's date is that signal's observedts.
export function sourceFix(f: RadarFinding, report: RadarReport): SourceFix | null {
    if (!f.sourcecommit) {
        return null;
    }
    const ids = new Set(f.signalids ?? []);
    const cited = (report.signals ?? []).find((s) => ids.has(s.id));
    return { sha: shortSha(f.sourcecommit), subject: f.sourcesubject ?? "", ts: cited?.observedts };
}

export type AuditState = "queued" | "running" | "clean" | "hits" | "failed";

export interface AuditRow {
    commit: string;
    sha: string;
    subject: string;
    state: AuditState;
    hits: number;
    detail: string;
}

// only hits that passed the gate count (keptcount), so an audit whose every hit was dropped reads as clean
function auditState(a: RadarAudit): AuditState {
    switch (a.status) {
        case "ok":
            return (a.keptcount ?? 0) > 0 ? "hits" : "clean";
        case "failed":
            return "failed";
        case "running":
            return "running";
        default:
            return "queued";
    }
}

export function auditRows(report: RadarReport | null): AuditRow[] {
    return (report?.audits ?? []).map((a) => {
        const state = auditState(a);
        return {
            commit: a.commit,
            sha: shortSha(a.commit),
            subject: a.subject,
            state,
            hits: a.keptcount ?? 0,
            detail: (state === "failed" ? a.error : a.rootcause) ?? "",
        };
    });
}

export interface AuditTally {
    total: number;
    audited: number;
    clean: number;
    withHits: number;
    failed: number;
    hits: number;
}

export function auditTally(rows: AuditRow[]): AuditTally {
    const count = (state: AuditState) => rows.filter((r) => r.state === state).length;
    const clean = count("clean");
    const withHits = count("hits");
    const failed = count("failed");
    return {
        total: rows.length,
        audited: clean + withHits + failed,
        clean,
        withHits,
        failed,
        hits: rows.reduce((n, r) => n + r.hits, 0),
    };
}

export function auditSummary(t: AuditTally): string {
    if (t.total === 0) {
        return "no new fix commits";
    }
    const failed = t.failed > 0 ? `, ${t.failed} failed` : "";
    return `${plural(t.total, "fix commit")} audited, ${t.clean} clean${failed}`;
}

export function auditTallyText(t: AuditTally): string {
    const parts = [`${t.clean} clean`, `${t.withHits} with hits`];
    if (t.failed > 0) {
        parts.push(`${t.failed} failed`);
    }
    return parts.join(" · ");
}

export function failedAuditShas(report: RadarReport): string[] {
    return auditRows(report)
        .filter((r) => r.state === "failed")
        .map((r) => r.sha);
}

export function auditStateText(r: AuditRow): string {
    switch (r.state) {
        case "hits":
            return plural(r.hits, "hit");
        case "running":
            return "auditing";
        default:
            return r.state;
    }
}

export interface SentencePart {
    text: string;
    sha?: boolean;
}

// failedAuditsSentence is the warning strip's text, in parts so the component can set each sha in mono.
export function failedAuditsSentence(shas: string[]): SentencePart[] {
    const n = shas.length;
    const fixes = n === 1 ? "that fix" : n === 2 ? "those two fixes" : `those ${n} fixes`;
    const parts: SentencePart[] = [{ text: n === 1 ? "The audit of " : "The audits of " }];
    shas.forEach((sha, i) => {
        if (i > 0) {
            parts.push({ text: i === n - 1 ? " and " : ", " });
        }
        parts.push({ text: sha, sha: true });
    });
    parts.push({ text: ` failed. Sibling bugs of ${fixes} may be missing.` });
    return parts;
}

export interface AuditsPanel {
    kind: "empty" | "clean" | "failed";
    title: string;
    tally: string;
}

// auditsPanel is the finished scan with no findings: nothing new to audit, every audit clean, or some
// failed, in which case "no sibling bugs" holds only for the commits that were read.
export function auditsPanel(t: AuditTally, duration: string): AuditsPanel {
    if (t.total === 0) {
        return { kind: "empty", title: "No new fix commits to audit", tally: "" };
    }
    if (t.failed > 0) {
        return { kind: "failed", title: "No sibling bugs found", tally: auditTallyText(t) };
    }
    return {
        kind: "clean",
        title: `No sibling bugs in ${plural(t.total, "fix commit")}`,
        tally: [`${t.clean} of ${t.total} clean`, duration].filter(Boolean).join(" · "),
    };
}

export type RadarView = "never-scanned" | "scanning" | "old-format" | "cancelled" | "fatal" | "report" | "audits";

// a finding with no source commit was written by the lens pipeline, which nothing here can draw
export function isOldFormatReport(report: RadarReport): boolean {
    return (report.findings ?? []).some((f) => !f.sourcecommit);
}

// radarView picks the body for the scoped project's newest report. The order is the contract: an
// old-format report is never drawn as a report, whatever its status.
export function radarView(report: RadarReport | null): RadarView {
    if (!report) {
        return "never-scanned";
    }
    if (report.status === "collecting" || report.status === "clustering") {
        return "scanning";
    }
    if (isOldFormatReport(report)) {
        return "old-format";
    }
    if (report.status === "cancelled") {
        return "cancelled";
    }
    if (report.status === "failed" && report.fatalerror && (report.audits?.length ?? 0) === 0) {
        return "fatal";
    }
    return (report.findings?.length ?? 0) > 0 ? "report" : "audits";
}

export function reportMetaAge(report: RadarReport, now: number): string {
    return `last scan ${formatAgo(now - (report.completedts || report.startedts))}`;
}

export function auditDuration(report: RadarReport): string {
    if (!report.clusterstartedts || !report.completedts) {
        return "";
    }
    return fmtDuration(report.completedts - report.clusterstartedts);
}

export function dispositionLabel(d: RadarDisposition): string {
    if (d.action === "suppress") {
        return "Dismissed: intentional";
    }
    return `Dismissed: ${(d.reason ?? "").trim().toLowerCase() || "no reason"}`;
}
