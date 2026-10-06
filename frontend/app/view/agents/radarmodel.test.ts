// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, test } from "vitest";
import {
    auditDuration,
    auditRows,
    auditSummary,
    auditTally,
    auditTallyText,
    buildRunDraft,
    classifyCoverage,
    classifyScanState,
    COLLECTORS,
    composeRunGoal,
    coverageEntries,
    coverageRows,
    DEFAULT_OPEN_GROUPS,
    DEFAULT_OPEN_LIST_GROUPS,
    dismissReasons,
    dispositionLabel,
    evidenceRows,
    failedAuditShas,
    failedLenses,
    filterByMode,
    findingDelta,
    findingMode,
    findingSignalCount,
    findingSite,
    findingSourceCount,
    GROUP_ORDER,
    groupFindings,
    groupForList,
    groupMeta,
    hasCoverageFailure,
    investigationView,
    isDetectedNow,
    isMutedGroup,
    isNewFinding,
    isOldFormatReport,
    isResultsState,
    lensHealthText,
    lensRows,
    lensTabs,
    LIST_GROUP_ORDER,
    listGroupMeta,
    listGroupOf,
    missedLatestScan,
    partialCollectors,
    primaryAction,
    radarLoadPhase,
    radarView,
    referencedSignals,
    reportMetaAge,
    reportSignalCount,
    reportSourceCount,
    repositoryChangedDuringScan,
    rescanLabel,
    resolveLens,
    resolveSelection,
    scanHealth,
    scanMetaLine,
    shortSha,
    sourceFix,
    strengthPips,
    subsystemLabel,
    toPendingRunDraft,
} from "./radarmodel";

const finding = (id: string, group: string, extra: Partial<RadarFinding> = {}): RadarFinding => ({
    id,
    fingerprint: `fp-${id}`,
    group,
    riskkind: "test-coverage-gap",
    subsystem: "src/x",
    risk: `risk ${id}`,
    why: "why",
    severity: "medium",
    strength: "moderate",
    signalids: [],
    files: [],
    mission: "mission",
    ...extra,
});

describe("groupFindings", () => {
    it("buckets by lifecycle group in canonical order", () => {
        const grouped = groupFindings([
            finding("a", "recurring"),
            finding("b", "new"),
            finding("c", "dismissed"),
            finding("d", "new"),
        ]);
        expect(GROUP_ORDER).toEqual(["new", "recurring", "nolonger", "dismissed", "suppressed"]);
        expect(grouped.new.map((f) => f.id)).toEqual(["b", "d"]);
        expect(grouped.recurring.map((f) => f.id)).toEqual(["a"]);
        expect(grouped.dismissed.map((f) => f.id)).toEqual(["c"]);
        expect(grouped.nolonger).toEqual([]);
    });

    it("opens only new and recurring by default", () => {
        expect(DEFAULT_OPEN_GROUPS.has("new")).toBe(true);
        expect(DEFAULT_OPEN_GROUPS.has("recurring")).toBe(true);
        expect(DEFAULT_OPEN_GROUPS.has("nolonger")).toBe(false);
        expect(DEFAULT_OPEN_GROUPS.has("dismissed")).toBe(false);
        expect(DEFAULT_OPEN_GROUPS.has("suppressed")).toBe(false);
    });
});

const signal = (id: string, collector: string): RadarSignal => ({
    id,
    collector,
    sourceref: `ref-${id}`,
    observedts: 0,
    summary: "s",
    contenthash: `h-${id}`,
});

const report = (extra: Partial<RadarReport> = {}): RadarReport =>
    ({
        oid: "r1",
        version: 1,
        meta: {},
        projectname: "demo",
        projectpath: "/demo",
        status: "completed",
        startedts: 0,
        ...extra,
    }) as RadarReport;

describe("canonical counts", () => {
    it("counts unique signal ids per finding", () => {
        expect(findingSignalCount(finding("a", "new", { signalids: ["s1", "s2", "s1"] }))).toBe(2);
    });

    it("counts unique referenced signal ids across the report", () => {
        const r = report({
            findings: [finding("a", "new", { signalids: ["s1", "s2"] }), finding("b", "new", { signalids: ["s2", "s3"] })],
        });
        expect(reportSignalCount(r)).toBe(3);
    });

    it("counts distinct collectors among referenced signals", () => {
        const r = report({
            signals: [signal("s1", "git"), signal("s2", "git"), signal("s3", "runs")],
            findings: [finding("a", "new", { signalids: ["s1", "s2", "s3"] })],
        });
        expect(reportSourceCount(r)).toBe(2);
    });
});

describe("evidence resolution", () => {
    it("resolves referenced signals in id order, dropping unknown ids", () => {
        const r = report({ signals: [signal("s1", "git"), signal("s3", "runs")] });
        const f = finding("a", "new", { signalids: ["s3", "s2", "s1"] });
        expect(referencedSignals(f, r).map((s) => s.id)).toEqual(["s3", "s1"]);
    });

    it("counts distinct collectors for a single finding", () => {
        const r = report({ signals: [signal("s1", "git"), signal("s2", "git"), signal("s3", "runs")] });
        expect(findingSourceCount(finding("a", "new", { signalids: ["s1", "s2", "s3"] }), r)).toBe(2);
    });

    it("lists evidence oldest-first, keeping each signal's snippet", () => {
        const r = report({
            signals: [
                { ...signal("s1", "git"), observedts: 300, snippet: "@@ -1 +1 @@" },
                { ...signal("s2", "runs"), observedts: 100 },
            ],
        });
        const rows = evidenceRows(finding("a", "new", { signalids: ["s1", "s2", "missing"] }), r);
        expect(rows.map((s) => s.id)).toEqual(["s2", "s1"]);
        expect(rows[1].snippet).toBe("@@ -1 +1 @@");
    });
});

describe("presentation helpers", () => {
    it("maps strength to filled pip counts", () => {
        expect(strengthPips("strong")).toBe(3);
        expect(strengthPips("moderate")).toBe(2);
        expect(strengthPips("limited")).toBe(1);
        expect(strengthPips("bogus")).toBe(0);
    });

    it("hides a subsystem that names no directory", () => {
        expect(subsystemLabel(".")).toBe("");
        expect(subsystemLabel("unknown")).toBe("");
        expect(subsystemLabel("pkg/reporadar")).toBe("pkg/reporadar");
    });

    it("exposes group label/hint/delta, defaulting unknown groups to new", () => {
        expect(groupMeta("recurring").delta).toBe("recurring");
        expect(groupMeta("nolonger").tone).toBe("nolonger");
        expect(groupMeta("bogus").label).toBe(groupMeta("new").label);
    });

    it("marks history groups as muted", () => {
        expect(isMutedGroup("new")).toBe(false);
        expect(isMutedGroup("recurring")).toBe(false);
        expect(isMutedGroup("nolonger")).toBe(true);
        expect(isMutedGroup("dismissed")).toBe(true);
        expect(isMutedGroup("suppressed")).toBe(true);
    });
});

describe("classifyScanState", () => {
    it("returns never-scanned for null", () => {
        expect(classifyScanState(null)).toBe("never-scanned");
    });
    it("maps in-flight statuses", () => {
        expect(classifyScanState(report({ status: "collecting" }))).toBe("collecting");
        expect(classifyScanState(report({ status: "clustering" }))).toBe("clustering");
        expect(classifyScanState(report({ status: "cancelled" }))).toBe("cancelled");
    });
    it("distinguishes results from no-findings on completed", () => {
        expect(classifyScanState(report({ status: "completed", findings: [] }))).toBe("no-findings");
        expect(classifyScanState(report({ status: "completed", findings: [finding("a", "new")] }))).toBe("results");
    });
    it("maps partial and failed", () => {
        expect(classifyScanState(report({ status: "partial", findings: [finding("a", "new")] }))).toBe("partial");
        expect(classifyScanState(report({ status: "failed" }))).toBe("model-failed");
    });
});

describe("coverage", () => {
    it("lists collector coverage entries", () => {
        const r = report({ coverage: { git: "ok", runs: "failed" } });
        expect(coverageEntries(r)).toEqual(
            expect.arrayContaining([
                { collector: "git", status: "ok" },
                { collector: "runs", status: "failed" },
            ])
        );
    });
    it("detects any non-ok coverage", () => {
        expect(hasCoverageFailure(report({ coverage: { git: "ok" } }))).toBe(false);
        expect(hasCoverageFailure(report({ coverage: { git: "ok", runs: "partial" } }))).toBe(true);
    });
});

describe("resolveSelection", () => {
    it("keeps the current selection when still present", () => {
        expect(resolveSelection([finding("a", "new"), finding("b", "recurring")], "b")).toBe("b");
    });
    it("falls back to the first finding in group order", () => {
        expect(resolveSelection([finding("b", "recurring"), finding("a", "new")], "gone")).toBe("a");
    });
    it("returns undefined when there are no findings", () => {
        expect(resolveSelection([], "x")).toBeUndefined();
    });
});

describe("buildRunDraft", () => {
    it("keeps report, finding, and fingerprint ids distinct", () => {
        const r = report({ oid: "report-1" });
        const f = finding("finding-1", "new", { fingerprint: "fp-9", mission: "add tests", files: ["a.ts"], signalids: ["s1"] });
        const draft = buildRunDraft(r, f);
        expect(draft.reportId).toBe("report-1");
        expect(draft.findingId).toBe("finding-1");
        expect(draft.fingerprint).toBe("fp-9");
        expect(draft.mission).toBe("add tests");
        expect(draft.files).toEqual(["a.ts"]);
        expect(draft.origin).toBe("radar");
    });
});

describe("composeRunGoal", () => {
    it("is the mission alone, which already names the fix and each site", () => {
        const f = finding("finding-1", "new", {
            mission: "add tests for the coupon boundary",
            files: ["src/coupon.ts", "src/coupon.test.ts"],
            signalids: ["s1", "s2"],
        });
        expect(composeRunGoal(f)).toBe("add tests for the coupon boundary");
    });
});

describe("toPendingRunDraft", () => {
    it("maps origin ids distinctly and carries the project", () => {
        const r = report({ oid: "report-1", projectpath: "/repo/demo", projectname: "demo" });
        const f = finding("finding-1", "new", {
            fingerprint: "fp-9",
            mission: "add tests",
            files: ["a.ts"],
            signalids: ["s1"],
        });
        const draft = toPendingRunDraft(r, f);
        expect(draft.radarOrigin).toEqual({ reportid: "report-1", findingid: "finding-1", fingerprint: "fp-9" });
        expect(draft.files).toEqual(["a.ts"]);
        expect(draft.projectPath).toBe("/repo/demo");
        expect(draft.projectName).toBe("demo");
        expect(draft.goal).toBe("add tests");
    });
});

const withInv = (group: string, status?: string, extra: Partial<RadarFinding> = {}): RadarFinding =>
    finding("f", group, {
        investigation: status ? { runid: "run-1", channelid: "c", status, startedts: 0 } : undefined,
        ...extra,
    });

describe("investigationView", () => {
    it("is null with no investigation", () => {
        expect(investigationView(withInv("new"))).toBeNull();
    });
    it("is live while executing, and offers no separate Open run (the primary button opens it)", () => {
        expect(investigationView(withInv("new", "executing"))).toMatchObject({
            label: "Investigating",
            rowLabel: "investigating",
            tone: "live",
            live: true,
            openable: false,
            done: false,
        });
    });
    it("says still detected when done but the finding still recurs", () => {
        const v = investigationView(withInv("recurring", "done"));
        expect(v).toMatchObject({
            label: "Investigated — still detected",
            rowLabel: "still detected",
            tone: "warning",
        });
        expect(v).toMatchObject({ done: true, openable: true, live: false });
    });
    it("says investigated when done and the finding is no longer open", () => {
        expect(investigationView(withInv("nolonger", "done"))).toMatchObject({
            label: "Investigated",
            tone: "success",
        });
        expect(investigationView(withInv("dismissed", "done"))).toMatchObject({ rowLabel: "investigated" });
    });
    it("does not call a missed finding still detected after its investigation", () => {
        expect(investigationView(withInv("recurring", "done", { misscount: 1 }))).toMatchObject({
            label: "Investigated",
        });
    });
    it("keeps Open run for a cancelled or failed run, which still exists", () => {
        expect(investigationView(withInv("new", "cancelled"))).toMatchObject({
            label: "Investigation cancelled",
            rowLabel: "cancelled",
            tone: "muted",
            openable: true,
            done: false,
        });
        expect(investigationView(withInv("new", "failed"))).toMatchObject({
            label: "Investigation failed",
            openable: true,
        });
    });
    it("drops Open run for an orphaned investigation, whose run is gone", () => {
        expect(investigationView(withInv("new", "orphaned"))).toMatchObject({
            label: "Run no longer exists",
            rowLabel: "run gone",
            openable: false,
        });
    });
    it("reads an unknown status as failed rather than hiding it", () => {
        expect(investigationView(withInv("new", "bogus"))).toMatchObject({ label: "Investigation failed" });
    });
});

describe("primaryAction", () => {
    it("starts an investigation when there is none", () => {
        expect(primaryAction(withInv("new"))).toEqual({ kind: "start", label: "Start investigation" });
    });
    it("opens the live run instead of starting a second one", () => {
        expect(primaryAction(withInv("new", "executing"))).toEqual({ kind: "open-run", label: "Open run run-1" });
    });
    it("investigates again after any ended investigation", () => {
        for (const status of ["done", "cancelled", "failed", "orphaned"]) {
            expect(primaryAction(withInv("new", status))).toEqual({ kind: "start", label: "Investigate again" });
        }
    });
});

describe("dismissReasons", () => {
    it("offers the generic reasons when no investigation finished", () => {
        expect(dismissReasons(withInv("new")).map((r) => r.reason)).toEqual([
            "False positive",
            "Low priority",
            "Resolved elsewhere",
            "Intentional",
        ]);
        expect(dismissReasons(withInv("new", "failed"))).toHaveLength(4);
    });
    it("leads with the finished run as the reason", () => {
        const [first, ...rest] = dismissReasons(withInv("recurring", "done"));
        expect(first).toEqual({
            label: "Addressed by",
            run: "run-1",
            action: "dismiss",
            reason: "Resolved by investigation",
            note: "addressed by run run-1",
        });
        expect(rest).toHaveLength(4);
    });
    it("suppresses only for Intentional, which comes last", () => {
        const reasons = dismissReasons(withInv("recurring", "done"));
        expect(reasons[reasons.length - 1]).toEqual({
            label: "Intentional",
            action: "suppress",
            reason: "Intentional",
        });
        expect(reasons.slice(0, -1).every((r) => r.action === "dismiss")).toBe(true);
    });
});

describe("dispositionLabel", () => {
    it("reads a suppress as intentional, and a dismiss by its reason", () => {
        expect(dispositionLabel({ action: "suppress", ts: 0 })).toBe("Dismissed: intentional");
        expect(dispositionLabel({ action: "dismiss", reason: "Low priority", ts: 0 })).toBe("Dismissed: low priority");
        expect(dispositionLabel({ action: "dismiss", reason: " ", ts: 0 })).toBe("Dismissed: no reason");
        expect(dispositionLabel({ action: "dismiss", ts: 0 })).toBe("Dismissed: no reason");
    });
});

describe("radar surface glue", () => {
    it("isResultsState is true only for results and partial", () => {
        expect(isResultsState("results")).toBe(true);
        expect(isResultsState("partial")).toBe(true);
        expect(isResultsState("no-findings")).toBe(false);
        expect(isResultsState("never-scanned")).toBe(false);
        expect(isResultsState("model-failed")).toBe(false);
    });
    it("rescanLabel says re-run full scan only for a partial scan", () => {
        expect(rescanLabel("partial")).toBe("Re-run full scan");
        expect(rescanLabel("results")).toBe("Re-scan");
    });
    it("classifyCoverage maps streamed per-collector status to a checklist cell", () => {
        expect(classifyCoverage("ok")).toBe("done");
        expect(classifyCoverage("running")).toBe("running");
        expect(classifyCoverage("failed")).toBe("failed");
        expect(classifyCoverage("partial")).toBe("failed");
        // a collector not yet reached (absent from the coverage map) is queued
        expect(classifyCoverage(undefined)).toBe("queued");
    });
});

describe("radar modes", () => {
    test("findingMode defaults empty/unknown to correctness", () => {
        expect(findingMode({ mode: "" } as RadarFinding)).toBe("correctness");
        expect(findingMode({ mode: "security" } as RadarFinding)).toBe("security");
        expect(findingMode({ mode: "bogus" } as RadarFinding)).toBe("correctness");
        expect(findingMode({} as RadarFinding)).toBe("correctness");
    });

    test("filterByMode passes all or filters to one mode", () => {
        const fs = [{ mode: "correctness" }, { mode: "security" }] as RadarFinding[];
        expect(filterByMode(fs, "all")).toHaveLength(2);
        expect(filterByMode(fs, "security")).toHaveLength(1);
    });

    test("failedLenses returns only clustering-failed mode runs", () => {
        const report = {
            moderuns: [
                { mode: "correctness", status: "completed" },
                { mode: "security", status: "clustering-failed", clustererror: "boom" },
            ],
        } as RadarReport;
        const failed = failedLenses(report);
        expect(failed).toHaveLength(1);
        expect(failed[0].mode).toBe("security");
        expect(failedLenses(null)).toHaveLength(0);
    });
});

describe("scan-miss hysteresis", () => {
    it("flags an open finding the latest scan missed", () => {
        expect(missedLatestScan(finding("a", "new", { misscount: 1 }))).toBe(true);
        expect(missedLatestScan(finding("a", "recurring"))).toBe(false);
        expect(missedLatestScan(finding("a", "dismissed", { misscount: 3 }))).toBe(false);
    });
    it("counts only a detected open finding as detected now", () => {
        expect(isDetectedNow(finding("a", "recurring"))).toBe(true);
        expect(isDetectedNow(finding("a", "recurring", { misscount: 1 }))).toBe(false);
        expect(isDetectedNow(finding("a", "nolonger"))).toBe(false);
    });
    it("replaces the group delta for a missed finding", () => {
        expect(findingDelta(finding("a", "recurring", { misscount: 1 }))).toBe("not detected this scan");
        expect(findingDelta(finding("a", "recurring"))).toBe("recurring");
    });
});

describe("partial scan reasons", () => {
    it("names failed collectors, not the legacy repository-changed marker", () => {
        expect(partialCollectors(report({ partialsources: ["git", "repository-changed"] }))).toEqual(["git"]);
        expect(partialCollectors(report())).toEqual([]);
    });
    it("detects a repository change from the recorded boundaries", () => {
        expect(repositoryChangedDuringScan(report({ windowendts: 1, starthead: "a", endhead: "b" }))).toBe(true);
        expect(
            repositoryChangedDuringScan(
                report({ windowendts: 1, starthead: "a", endhead: "a", startdirty: "x", enddirty: "y" })
            )
        ).toBe(true);
        expect(repositoryChangedDuringScan(report({ windowendts: 1, starthead: "a", endhead: "a" }))).toBe(false);
        // the end boundary is written at finalize; before that a start boundary alone is not a change
        expect(repositoryChangedDuringScan(report({ starthead: "a", startdirty: "x" }))).toBe(false);
        expect(repositoryChangedDuringScan(report({ partialsources: ["repository-changed"] }))).toBe(true);
    });
});

const modeRun = (mode: string, status: string): RadarModeRun => ({ mode, status });

describe("COLLECTORS and coverageRows", () => {
    it("names the six collectors the backend runs, each with what it examines", () => {
        expect(COLLECTORS.map((c) => c.name)).toEqual([
            "structure",
            "git",
            "runs",
            "transcript",
            "config",
            "dependency",
        ]);
        expect(COLLECTORS.every((c) => c.examines.length > 0)).toBe(true);
    });
    it("joins every collector with its streamed coverage cell, queued when absent", () => {
        const rows = coverageRows(report({ coverage: { structure: "ok", git: "running", transcript: "failed" } }));
        expect(rows.map((r) => [r.name, r.cell])).toEqual([
            ["structure", "done"],
            ["git", "running"],
            ["runs", "queued"],
            ["transcript", "failed"],
            ["config", "queued"],
            ["dependency", "queued"],
        ]);
    });
    it("keeps a collector the table does not know, so coverage never hides one", () => {
        const rows = coverageRows(report({ coverage: { novel: "ok" } }));
        expect(rows[rows.length - 1]).toEqual({ name: "novel", examines: "", cell: "done" });
    });
    it("lists the table alone before any scan", () => {
        expect(coverageRows(null).map((r) => r.cell)).toEqual(COLLECTORS.map(() => "queued"));
    });
});

describe("lensRows", () => {
    it("streams each lens in scan order, whatever order the map holds", () => {
        const rows = lensRows(report({ lensprogress: { security: "queued", correctness: "running" } }));
        expect(rows.map((r) => [r.name, r.cell])).toEqual([
            ["correctness", "running"],
            ["security", "queued"],
        ]);
    });
    it("lists only the lenses a retry reruns", () => {
        expect(lensRows(report({ lensprogress: { security: "failed" } })).map((r) => [r.name, r.cell])).toEqual([
            ["security", "failed"],
        ]);
    });
    it("is empty for a scan that streams no lens progress", () => {
        expect(lensRows(report())).toEqual([]);
        expect(lensRows(null)).toEqual([]);
    });
});

describe("lensTabs", () => {
    const sec = finding("s", "new", { mode: "security" });
    const corr = finding("c", "new", { mode: "correctness" });

    it("renders no tabs when the scan has a single lens", () => {
        expect(lensTabs(report({ findings: [corr] }))).toEqual([]);
    });
    it("counts All plus each lens in canonical order", () => {
        const tabs = lensTabs(report({ findings: [sec, corr, corr] }));
        expect(tabs.map((t) => [t.key, t.count])).toEqual([
            ["all", 3],
            ["correctness", 2],
            ["security", 1],
        ]);
        expect(tabs.every((t) => !t.failed && !t.disabled)).toBe(true);
    });
    it("shows a failed lens with no findings, disabled", () => {
        const r = report({
            findings: [corr],
            moderuns: [modeRun("correctness", "completed"), modeRun("security", "clustering-failed")],
        });
        expect(lensTabs(r).find((t) => t.key === "security")).toMatchObject({ count: 0, failed: true, disabled: true });
    });
    it("keeps a failed lens selectable when findings were carried from the previous scan", () => {
        const r = report({
            findings: [corr, sec],
            moderuns: [modeRun("correctness", "completed"), modeRun("security", "clustering-failed")],
        });
        expect(lensTabs(r).find((t) => t.key === "security")).toMatchObject({
            count: 1,
            failed: true,
            disabled: false,
        });
    });
    it("ignores a skipped lens", () => {
        const r = report({
            findings: [corr],
            moderuns: [modeRun("correctness", "completed"), modeRun("debt", "skipped")],
        });
        expect(lensTabs(r)).toEqual([]);
    });
});

describe("resolveLens", () => {
    const tabs = lensTabs(
        report({
            findings: [finding("c", "new")],
            moderuns: [modeRun("correctness", "completed"), modeRun("security", "clustering-failed")],
        })
    );
    it("keeps a selectable lens", () => {
        expect(resolveLens(tabs, "correctness")).toBe("correctness");
    });
    it("falls back to all for a disabled, vanished, or tab-less lens", () => {
        expect(resolveLens(tabs, "security")).toBe("all");
        expect(resolveLens(tabs, "debt")).toBe("all");
        expect(resolveLens([], "correctness")).toBe("all");
    });
});

describe("scanHealth", () => {
    it("is empty for a clean scan", () => {
        expect(scanHealth(report())).toEqual([]);
    });
    it("lists failed collectors, failed lenses, then a repository change", () => {
        const r = report({
            partialsources: ["transcript", "repository-changed"],
            moderuns: [modeRun("correctness", "completed"), modeRun("security", "clustering-failed")],
            findings: [finding("s", "new", { mode: "security" })],
        });
        expect(scanHealth(r)).toEqual([
            { kind: "collectors", collectors: ["transcript"] },
            { kind: "lens", modes: ["security"], carried: 1 },
            { kind: "repository-changed" },
        ]);
    });
});

describe("lensHealthText", () => {
    it("says the other lenses are shown when the failed lens has nothing carried", () => {
        expect(lensHealthText(["security"], 0)).toBe(
            "The Security lens did not cluster. The other lenses' findings are shown."
        );
    });
    it("says carried findings come from the previous scan", () => {
        expect(lensHealthText(["security"], 2)).toBe(
            "The Security lens did not cluster. Its findings are carried over from the previous scan."
        );
    });
    it("joins several lenses", () => {
        expect(lensHealthText(["security", "debt"], 0)).toBe(
            "The Security and Tech-debt lenses did not cluster. The other lenses' findings are shown."
        );
    });
});

describe("scanMetaLine", () => {
    const now = 10 * 3_600_000;
    const done = { status: "completed", completedts: now - 2 * 3_600_000 };

    it("states age, findings, lenses and payload for a clean scan", () => {
        const r = report({
            ...done,
            payloadtokens: 12_400,
            findings: [finding("a", "new"), finding("b", "new", { mode: "security" })],
        });
        expect(scanMetaLine(r, now)).toBe("last scan 2h ago · 2 findings across 2 lenses · 12k-token payload");
    });
    it("names what is incomplete instead of the payload for a degraded scan", () => {
        const r = report({
            ...done,
            status: "partial",
            partialsources: ["transcript"],
            moderuns: [modeRun("correctness", "completed"), modeRun("security", "clustering-failed")],
            findings: [finding("a", "new")],
        });
        expect(scanMetaLine(r, now)).toBe("last scan 2h ago · 1 finding · 1 collector and 1 lens incomplete");
    });
    it("falls back to the start time before completion is recorded", () => {
        expect(scanMetaLine(report({ startedts: now - 3 * 3_600_000 }), now)).toBe("last scan 3h ago · 0 findings");
    });
});

describe("radarLoadPhase", () => {
    const REPORT = report();
    const base = { reports: [], currentReportId: undefined, report: null, loadError: null, scopeBlocked: false };
    it("is loading while the report list has not been fetched, not never-scanned", () => {
        expect(radarLoadPhase({ ...base, reports: null })).toBe("loading");
    });
    it("is loading while the selected report's object has not arrived", () => {
        expect(radarLoadPhase({ ...base, reports: [REPORT], currentReportId: REPORT.oid, report: null })).toBe(
            "loading"
        );
    });
    it("is an error only when a failed load left nothing to show", () => {
        expect(radarLoadPhase({ ...base, reports: null, loadError: "boom" })).toBe("error");
        expect(
            radarLoadPhase({
                ...base,
                reports: [REPORT],
                currentReportId: REPORT.oid,
                report: REPORT,
                loadError: "boom",
            })
        ).toBe("ready");
    });
    it("never waits forever on a project the registry no longer has", () => {
        expect(radarLoadPhase({ ...base, reports: null, scopeBlocked: true })).toBe("ready");
    });
    it("is ready on a loaded empty list, which is what never-scanned means", () => {
        expect(radarLoadPhase(base)).toBe("ready");
    });
});

const SHA = "34f60b82c0ffee0000000000000000000000beef";

const sibling = (id: string, group: string, extra: Partial<RadarFinding> = {}): RadarFinding =>
    finding(id, group, { sourcecommit: SHA, sourcesubject: "fix(x): y", ...extra });

const siteAt = (line: number): RadarSite => ({ line, trigger: "t", actual: "a", expected: "e", whynotcovered: "w" });

const audit = (commit: string, status: string, extra: Partial<RadarAudit> = {}): RadarAudit => ({
    commit,
    subject: `fix ${commit}`,
    committs: 0,
    files: [],
    status,
    ...extra,
});

describe("list groups", () => {
    it("puts every wire group that is not closed in open, an unknown one included", () => {
        for (const group of ["new", "recurring", "nolonger", "bogus"]) {
            expect([group, listGroupOf(finding("a", group))]).toEqual([group, "open"]);
        }
        expect(listGroupOf(finding("a", "dismissed"))).toBe("dismissed");
        expect(listGroupOf(finding("a", "suppressed"))).toBe("dismissed");
    });
    it("buckets findings in list order", () => {
        const grouped = groupForList([
            finding("a", "suppressed"),
            finding("b", "new"),
            finding("c", "nolonger"),
            finding("d", "dismissed"),
        ]);
        expect(grouped.open.map((f) => f.id)).toEqual(["b", "c"]);
        expect(grouped.dismissed.map((f) => f.id)).toEqual(["a", "d"]);
        expect(groupForList([])).toEqual({ open: [], dismissed: [] });
    });
    it("calls only the wire group new a new finding", () => {
        expect(isNewFinding(finding("a", "new"))).toBe(true);
        for (const group of ["recurring", "nolonger", "dismissed", "suppressed", "bogus"]) {
            expect([group, isNewFinding(finding("a", group))]).toEqual([group, false]);
        }
    });
    it("draws both groups open by default, in order", () => {
        expect(LIST_GROUP_ORDER).toEqual(["open", "dismissed"]);
        expect([...DEFAULT_OPEN_LIST_GROUPS].sort()).toEqual(["dismissed", "open"]);
    });
    it("hints the open group with its new count, and nothing at zero", () => {
        const items = [finding("a", "new"), finding("b", "new"), finding("c", "recurring")];
        expect(listGroupMeta("open", items)).toEqual({ label: "Open", hint: "2 new in the latest scan", tone: "open" });
        expect(listGroupMeta("open", [finding("c", "recurring")]).hint).toBe("");
        expect(listGroupMeta("dismissed", [finding("d", "dismissed")])).toEqual({
            label: "Dismissed",
            hint: "closed with a reason",
            tone: "muted",
        });
    });
});

describe("findingSite", () => {
    it("splits the file into dir and name and counts the further sites", () => {
        const f = sibling("a", "new", { files: ["pkg/a/b.go"], sites: [siteAt(12), siteAt(40), siteAt(7)] });
        expect(findingSite(f)).toEqual({ dir: "pkg/a/", file: "b.go", line: 12, path: "pkg/a/b.go", more: 2 });
    });
    it("gives a root-level file an empty dir", () => {
        expect(findingSite(sibling("a", "new", { files: ["main.go"], sites: [siteAt(3)] }))).toEqual({
            dir: "",
            file: "main.go",
            line: 3,
            path: "main.go",
            more: 0,
        });
    });
    it("is null with no file or no site", () => {
        expect(findingSite(sibling("a", "new", { files: [], sites: [siteAt(3)] }))).toBeNull();
        expect(findingSite(sibling("a", "new", { files: ["main.go"], sites: [] }))).toBeNull();
        expect(findingSite(sibling("a", "new", { files: ["main.go"] }))).toBeNull();
    });
});

describe("sourceFix", () => {
    const cited = { ...signal("s1", "git"), observedts: 1234 };

    it("shortens the commit and dates it from the cited signal", () => {
        const r = report({ signals: [{ ...signal("s0", "git"), observedts: 99 }, cited] });
        expect(sourceFix(sibling("a", "new", { signalids: ["s1"] }), r)).toEqual({
            sha: "34f60b82",
            subject: "fix(x): y",
            ts: 1234,
        });
        expect(shortSha(SHA)).toHaveLength(8);
    });
    it("leaves the date out when the report has no such signal", () => {
        expect(
            sourceFix(sibling("a", "new", { signalids: ["gone"] }), report({ signals: [cited] }))?.ts
        ).toBeUndefined();
        expect(sourceFix(sibling("a", "new", { signalids: ["s1"] }), report())?.ts).toBeUndefined();
    });
    it("is null for a finding with no source commit", () => {
        expect(sourceFix(finding("a", "new", { signalids: ["s1"] }), report({ signals: [cited] }))).toBeNull();
    });
});

describe("auditRows", () => {
    it("reads each audit status, counting only kept hits", () => {
        const rows = auditRows(
            report({
                audits: [
                    audit(SHA, "ok", { keptcount: 0, rootcause: "cause" }),
                    audit("b", "ok", { hitcount: 3, keptcount: 2, rootcause: "cause b" }),
                    audit("c", "failed", { error: "timed out", rootcause: "ignored" }),
                    audit("d", "queued"),
                    audit("e", "running"),
                    audit("f", "bogus"),
                    audit("g", "ok", { hitcount: 4 }),
                ],
            })
        );
        expect(rows.map((r) => [r.state, r.hits, r.detail])).toEqual([
            ["clean", 0, "cause"],
            ["hits", 2, "cause b"],
            ["failed", 0, "timed out"],
            ["queued", 0, ""],
            ["running", 0, ""],
            ["queued", 0, ""],
            ["clean", 0, ""],
        ]);
        expect(rows[0]).toMatchObject({ commit: SHA, sha: "34f60b82", subject: `fix ${SHA}` });
    });
    it("is empty with no report or no audits", () => {
        expect(auditRows(null)).toEqual([]);
        expect(auditRows(report())).toEqual([]);
    });
});

describe("audit tally and its text", () => {
    const tallyOf = (...audits: RadarAudit[]) => auditTally(auditRows(report({ audits })));
    const clean = (n: number) => Array.from({ length: n }, (_, i) => audit(`c${i}`, "ok"));
    const hits = (n: number) => Array.from({ length: n }, (_, i) => audit(`h${i}`, "ok", { keptcount: i + 1 }));
    const failed = (n: number) => Array.from({ length: n }, (_, i) => audit(`f${i}`, "failed", { error: "boom" }));

    it("counts each state, and audited leaves out what has not finished", () => {
        expect(tallyOf(...clean(1), ...hits(2), ...failed(1), audit("q", "queued"), audit("r", "running"))).toEqual({
            total: 6,
            audited: 4,
            clean: 1,
            withHits: 2,
            failed: 1,
            hits: 3,
        });
    });
    it("summarises a scan with no failure", () => {
        const t = tallyOf(...clean(6), ...hits(2));
        expect(auditSummary(t)).toBe("8 fix commits audited, 6 clean");
        expect(auditTallyText(t)).toBe("6 clean · 2 with hits");
    });
    it("names the failures when there are some", () => {
        const t = tallyOf(...clean(4), ...hits(2), ...failed(2));
        expect(auditSummary(t)).toBe("8 fix commits audited, 4 clean, 2 failed");
        expect(auditTallyText(t)).toBe("4 clean · 2 with hits · 2 failed");
    });
    it("uses the singular for one commit", () => {
        expect(auditSummary(tallyOf(...clean(1)))).toBe("1 fix commit audited, 1 clean");
    });
    it("says there were no new fix commits at zero", () => {
        expect(auditSummary(tallyOf())).toBe("no new fix commits");
    });
    it("lists the failed audits by short sha, in audit order", () => {
        const r = report({
            audits: [audit("7927fb68aaaa", "failed"), audit("ok1", "ok"), audit("9caee0d3bbbb", "failed")],
        });
        expect(failedAuditShas(r)).toEqual(["7927fb68", "9caee0d3"]);
        expect(failedAuditShas(report())).toEqual([]);
    });
});

describe("radarView", () => {
    const found = [sibling("a", "new")];
    const old = [finding("a", "new")];
    const audits = [audit(SHA, "ok")];

    it("is never-scanned with no report", () => {
        expect(radarView(null)).toBe("never-scanned");
    });
    it("is scanning while commits are selected or audited", () => {
        expect(radarView(report({ status: "collecting" }))).toBe("scanning");
        expect(radarView(report({ status: "clustering", audits, findings: found }))).toBe("scanning");
    });
    it("is old-format when any finding has no source commit, whatever the status", () => {
        expect(radarView(report({ status: "completed", findings: [...found, ...old] }))).toBe("old-format");
        expect(radarView(report({ status: "cancelled", findings: old }))).toBe("old-format");
        expect(isOldFormatReport(report({ findings: found }))).toBe(false);
        expect(isOldFormatReport(report())).toBe(false);
    });
    it("is cancelled for a cancelled scan", () => {
        expect(radarView(report({ status: "cancelled" }))).toBe("cancelled");
    });
    it("is fatal only for a failure that audited nothing", () => {
        expect(radarView(report({ status: "failed", fatalerror: "not a git repository" }))).toBe("fatal");
        expect(radarView(report({ status: "failed", fatalerror: "late", audits }))).toBe("audits");
    });
    it("is the report whenever there are findings", () => {
        expect(radarView(report({ status: "completed", findings: found, audits }))).toBe("report");
        expect(radarView(report({ status: "partial", findings: found }))).toBe("report");
        expect(radarView(report({ status: "failed", findings: found, audits: [audit(SHA, "failed")] }))).toBe("report");
    });
    it("is the audit list otherwise", () => {
        expect(radarView(report({ status: "completed", audits }))).toBe("audits");
        expect(radarView(report({ status: "failed", audits: [audit(SHA, "failed")] }))).toBe("audits");
        expect(radarView(report({ status: "partial", audits }))).toBe("audits");
        expect(radarView(report({ status: "completed" }))).toBe("audits");
    });
});

describe("report meta", () => {
    const MIN = 60_000;
    const now = 100 * MIN;

    it("ages the scan from its completion, or its start before that", () => {
        expect(reportMetaAge(report({ startedts: now - 9 * MIN, completedts: now - 4 * MIN }), now)).toBe(
            "last scan 4m ago"
        );
        expect(reportMetaAge(report({ startedts: now - 9 * MIN }), now)).toBe("last scan 9m ago");
    });
    it("times the audits from their start to completion", () => {
        const completedts = now;
        expect(auditDuration(report({ clusterstartedts: completedts - (4 * MIN + 36_000), completedts }))).toBe(
            "4m 36s"
        );
        expect(auditDuration(report({ completedts }))).toBe("");
        expect(auditDuration(report({ clusterstartedts: 5 }))).toBe("");
    });
});
