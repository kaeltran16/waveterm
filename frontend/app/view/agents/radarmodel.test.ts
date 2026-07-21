// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, test } from "vitest";
import {
    buildRunDraft,
    classifyCoverage,
    classifyScanState,
    composeRunGoal,
    coverageEntries,
    DEFAULT_OPEN_GROUPS,
    failedLenses,
    filterByMode,
    findingMode,
    findingSignalCount,
    findingSourceCount,
    groupMeta,
    modeFilterOptions,
    groupSummary,
    GROUP_ORDER,
    groupFindings,
    hasCoverageFailure,
    investigationBadge,
    isMutedGroup,
    isResultsState,
    projectsWithPath,
    referencedSignals,
    reportSignalCount,
    reportSourceCount,
    rescanLabel,
    resolveSelection,
    scanScopeLabel,
    strengthPips,
    timelineEntries,
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

    it("builds a timeline sorted oldest-first from referenced signals", () => {
        const r = report({
            signals: [
                { ...signal("s1", "git"), observedts: 300 },
                { ...signal("s2", "runs"), observedts: 100 },
            ],
        });
        const tl = timelineEntries(finding("a", "new", { signalids: ["s1", "s2"] }), r);
        expect(tl.map((t) => t.ts)).toEqual([100, 300]);
        expect(tl.map((t) => t.collector)).toEqual(["runs", "git"]);
    });
});

describe("presentation helpers", () => {
    it("maps strength to filled pip counts", () => {
        expect(strengthPips("strong")).toBe(3);
        expect(strengthPips("moderate")).toBe(2);
        expect(strengthPips("limited")).toBe(1);
        expect(strengthPips("bogus")).toBe(0);
    });

    it("exposes group label/hint/delta, defaulting unknown groups to new", () => {
        expect(groupMeta("recurring").delta).toBe("↑ strengthened");
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

    it("summarizes counts for every group in canonical order", () => {
        const s = groupSummary([finding("a", "new"), finding("b", "new"), finding("c", "recurring")]);
        expect(s.map((x) => x.group)).toEqual(GROUP_ORDER);
        expect(s.find((x) => x.group === "new")?.count).toBe(2);
        expect(s.find((x) => x.group === "recurring")?.count).toBe(1);
        expect(s.find((x) => x.group === "suppressed")?.count).toBe(0);
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
        expect(draft.evidenceRefs).toEqual(["s1"]);
        expect(draft.origin).toBe("radar");
    });
});

describe("composeRunGoal", () => {
    it("includes the mission, affected files, and evidence refs", () => {
        const f = finding("finding-1", "new", {
            mission: "add tests for the coupon boundary",
            files: ["src/coupon.ts", "src/coupon.test.ts"],
            signalids: ["s1", "s2"],
        });
        const goal = composeRunGoal(f);
        expect(goal).toContain("add tests for the coupon boundary");
        expect(goal).toContain("src/coupon.ts");
        expect(goal).toContain("src/coupon.test.ts");
        expect(goal).toContain("s1");
        expect(goal).toContain("s2");
    });

    it("omits the files and evidence sections when empty", () => {
        const f = finding("finding-2", "new", { mission: "look into X", files: [], signalids: [] });
        expect(composeRunGoal(f)).toBe("look into X");
    });
});

describe("toPendingRunDraft", () => {
    it("maps origin ids distinctly and carries the project path", () => {
        const r = report({ oid: "report-1", projectpath: "/repo/demo" });
        const f = finding("finding-1", "new", {
            fingerprint: "fp-9",
            mission: "add tests",
            files: ["a.ts"],
            signalids: ["s1"],
        });
        const draft = toPendingRunDraft(r, f);
        expect(draft.radarOrigin).toEqual({ reportid: "report-1", findingid: "finding-1", fingerprint: "fp-9" });
        expect(draft.files).toEqual(["a.ts"]);
        expect(draft.evidenceRefs).toEqual(["s1"]);
        expect(draft.projectPath).toBe("/repo/demo");
        expect(draft.goal).toContain("add tests");
    });
});

describe("investigationBadge", () => {
    const f = (group: string, status?: string): RadarFinding =>
        ({ id: "f", group, investigation: status ? { runid: "r", channelid: "c", status, startedts: 0 } : undefined }) as unknown as RadarFinding;

    it("is null with no investigation", () => {
        expect(investigationBadge(f("new"))).toBeNull();
    });
    it("is investigating while executing", () => {
        expect(investigationBadge(f("new", "executing"))).toBe("investigating");
    });
    it("is still-detected when done but the finding still recurs", () => {
        expect(investigationBadge(f("recurring", "done"))).toBe("still-detected");
        expect(investigationBadge(f("new", "done"))).toBe("still-detected");
    });
    it("is investigated when done and the finding is no longer open", () => {
        expect(investigationBadge(f("nolonger", "done"))).toBe("investigated");
        expect(investigationBadge(f("dismissed", "done"))).toBe("investigated");
    });
    it("shows no list badge for a cancelled/failed investigation", () => {
        expect(investigationBadge(f("new", "cancelled"))).toBeNull();
        expect(investigationBadge(f("new", "failed"))).toBeNull();
    });
});

describe("radar surface glue", () => {
    it("projectsWithPath keeps only registered projects that have a path", () => {
        const projects = { a: { path: "/a" }, b: { path: "" }, c: {}, d: { path: "/d" } };
        expect(projectsWithPath(projects)).toEqual([
            ["a", { path: "/a" }],
            ["d", { path: "/d" }],
        ]);
    });
    it("projectsWithPath returns [] for null/undefined", () => {
        expect(projectsWithPath(null)).toEqual([]);
        expect(projectsWithPath(undefined)).toEqual([]);
    });
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
    it("scanScopeLabel names the scoped project or prompts to select one", () => {
        expect(scanScopeLabel({ name: "payments-api" })).toBe("Scanning payments-api");
        expect(scanScopeLabel(null)).toBe("Select a registered project to scan");
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

    test("modeFilterOptions returns present modes in canonical order", () => {
        const fs = [{ mode: "debt" }, { mode: "correctness" }] as RadarFinding[];
        expect(modeFilterOptions(fs)).toEqual(["correctness", "debt"]);
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
