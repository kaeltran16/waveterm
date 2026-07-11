// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    buildRunDraft,
    classifyScanState,
    composeRunGoal,
    coverageEntries,
    DEFAULT_OPEN_GROUPS,
    findingSignalCount,
    GROUP_ORDER,
    groupFindings,
    hasCoverageFailure,
    reportSignalCount,
    reportSourceCount,
    resolveSelection,
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
