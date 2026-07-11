// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// DEV-ONLY radar fixtures for CDP visual verification. setRadarScenario(name) is exposed on window in
// dev (see radarsurface.tsx) so CDP can drive each scan state without a real backend scan.

import { globalStore } from "@/app/store/jotaiStore";
import { radarDevMockAtom } from "./radarstore";

export const RADAR_SCENARIOS = [
    "never-scanned",
    "collecting",
    "clustering",
    "results",
    "partial",
    "no-findings",
    "model-failed",
    "cancelled",
] as const;

const signal = (id: string, collector: string, snippet?: string): RadarSignal => ({
    id,
    collector,
    sourceref: `ref-${id}`,
    observedts: 1_720_000_000_000,
    paths: ["src/coupons/validate.ts"],
    subsystem: "src/coupons",
    summary: `${collector} signal ${id}`,
    contenthash: `h-${id}`,
    snippet,
});

const finding = (id: string, group: string): RadarFinding => ({
    id,
    fingerprint: `fp-${id}`,
    group,
    riskkind: "test-coverage-gap",
    subsystem: "src/coupons",
    risk: `Coupon validation ${id} has no test coverage on the expiry path`,
    why: "The expiry branch is exercised only in production; a regression would silently accept expired coupons.",
    severity: "high",
    strength: "moderate",
    signalids: ["s1", "s2"],
    files: ["src/coupons/validate.ts"],
    mission: "Add unit tests for the coupon expiry branch.",
});

const base = (extra: Partial<RadarReport>): RadarReport =>
    ({
        oid: "dev-report",
        version: 1,
        meta: {},
        projectname: "payments-api",
        projectpath: "/repos/payments-api",
        status: "completed",
        startedts: 1_720_000_000_000,
        signals: [signal("s1", "git", "@@ -1,3 +1,4 @@\n-  return true;\n+  return !isExpired(coupon);"), signal("s2", "runs")],
        ...extra,
    }) as RadarReport;

export function buildScenario(name: string): RadarReport {
    switch (name) {
        case "collecting":
            return base({ status: "collecting", phase: "collecting", signals: [], coverage: { git: "ok" } });
        case "clustering":
            return base({ status: "clustering", phase: "clustering", payloadtokens: 12_400, coverage: { git: "ok", runs: "ok" } });
        case "partial":
            return base({ status: "partial", coverage: { git: "ok", runs: "failed" }, partialsources: ["runs"], findings: [finding("a", "new"), finding("b", "recurring")] });
        case "no-findings":
            return base({ status: "completed", coverage: { git: "ok" }, findings: [] });
        case "model-failed":
            return base({ status: "failed", clustererror: "model returned invalid output", candidates: [signal("s1", "git")] });
        case "cancelled":
            return base({ status: "cancelled" });
        case "results":
        default:
            return base({
                status: "completed",
                coverage: { git: "ok", runs: "ok", memory: "ok" },
                findings: [finding("a", "new"), finding("b", "recurring"), finding("c", "nolonger")],
            });
    }
}

// setRadarScenario drives the surface. "never-scanned" clears the mock (null current report).
export function setRadarScenario(name: string): void {
    globalStore.set(radarDevMockAtom, name === "never-scanned" ? null : buildScenario(name));
}
