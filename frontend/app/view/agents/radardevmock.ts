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
    "security",
    "lens-failed",
    "no-findings",
    "model-failed",
    "cancelled",
] as const;

const DAY = 86_400_000;

const signal = (id: string, collector: string, opts: { day?: number; summary?: string; ref?: string; snippet?: string } = {}): RadarSignal => ({
    id,
    collector,
    sourceref: opts.ref ?? `ref-${id}`,
    observedts: 1_720_000_000_000 + (opts.day ?? 0) * DAY,
    paths: ["src/coupons/validate.ts"],
    subsystem: "src/coupons",
    summary: opts.summary ?? `${collector} signal ${id}`,
    contenthash: `h-${id}`,
    snippet: opts.snippet,
});

// A rich set of signals across collectors and dates so chips, sources count, and the timeline populate.
const SIGNALS: RadarSignal[] = [
    signal("s1", "git", {
        day: 0,
        ref: "a3f9c1",
        summary: "validate.ts rewritten with no matching test diff",
        snippet: "@@ -12,3 +12,6 @@\n-  return code.length > 0;\n+  const c = normalize(code);\n+  if (isExpired(c)) return false;\n+  if (!withinUsageLimit(c)) return false;",
    }),
    signal("s2", "runs", { day: 4, ref: "run-2f9c", summary: "Harden coupon validation — corrected 2×" }),
    signal("s3", "transcript", { day: 8, ref: "agent-77", summary: "3 agents needed correction around this boundary" }),
    signal("s4", "memory", { day: 9, ref: "mem-12", summary: "project memory: “retries are idempotent” (now stale)" }),
];

const finding = (id: string, group: string, extra: Partial<RadarFinding> = {}): RadarFinding => ({
    id,
    fingerprint: `RAD-${id}`,
    group,
    riskkind: "test-coverage-gap",
    subsystem: "checkout · coupons",
    risk: `Coupon validation ${id} gained branches with no covering tests`,
    why: "validate.ts sits on the checkout write path and changed 7 times in two weeks. The new expiry and usage-limit branches shipped with no test deltas, and three agents needed correction around this exact boundary.",
    severity: "high",
    strength: "strong",
    signalids: ["s1", "s2", "s3", "s4"],
    files: ["src/coupons/validate.ts", "src/checkout/cart.ts", "tests/coupons.test.ts"],
    mission: "Add expiry and usage-limit coverage to tests/coupons.test.ts, then verify cart.ts integrates against the real validateCoupon rather than the current mock.",
    ...extra,
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
        completedts: 1_720_000_000_000 + 10 * DAY,
        signals: SIGNALS,
        ...extra,
    }) as RadarReport;

export function buildScenario(name: string): RadarReport {
    switch (name) {
        case "collecting":
            // mid-collection: earlier collectors done, one running, the rest still queued (absent).
            return base({ status: "collecting", phase: "collecting", signals: [], coverage: { structure: "ok", git: "ok", runs: "running" } });
        case "clustering":
            return base({ status: "clustering", phase: "clustering", payloadtokens: 12_400, coverage: { git: "ok", runs: "ok" } });
        case "partial":
            return base({
                status: "partial",
                coverage: { git: "ok", runs: "ok", transcript: "failed", memory: "ok" },
                partialsources: ["transcript"],
                findings: [finding("a", "new"), finding("b", "recurring", { severity: "medium", strength: "moderate" })],
            });
        case "no-findings":
            return base({ status: "completed", coverage: { git: "ok", runs: "ok", memory: "ok" }, findings: [] });
        case "model-failed":
            return base({ status: "failed", clustererror: "model returned invalid output", candidates: SIGNALS });
        case "cancelled":
            return base({ status: "cancelled" });
        case "security":
            return base({
                status: "completed",
                coverage: { structure: "ok", git: "ok", runs: "ok", config: "ok", dependency: "ok" },
                moderuns: [
                    { mode: "correctness", status: "completed", findingcount: 1 },
                    { mode: "security", status: "completed", findingcount: 2 },
                ],
                findings: [
                    finding("a", "new"),
                    finding("s1", "new", {
                        mode: "security",
                        riskkind: "auth-boundary-fragility",
                        subsystem: "src/auth",
                        severity: "high",
                        risk: "Auth session boundary churns without test adjacency",
                        why: "session.ts changed 4 times in the window with no covering test change; two agents needed correction here.",
                    }),
                    finding("s2", "recurring", {
                        mode: "security",
                        riskkind: "dependency-exposure",
                        subsystem: "package.json",
                        severity: "medium",
                        strength: "limited",
                        risk: "jsonwebtoken pinned to a floating ^ range",
                        why: "a floating range on an auth-critical dependency can pull an unreviewed version on install.",
                    }),
                ],
            });
        case "lens-failed":
            return base({
                status: "partial",
                coverage: { structure: "ok", git: "ok", runs: "ok", config: "ok", dependency: "ok" },
                moderuns: [
                    { mode: "correctness", status: "completed", findingcount: 1 },
                    { mode: "security", status: "clustering-failed", clustererror: "model returned invalid output" },
                ],
                findings: [finding("a", "new")],
            });
        case "results":
        default:
            return base({
                status: "completed",
                coverage: { git: "ok", runs: "ok", transcript: "ok", memory: "ok" },
                findings: [
                    finding("a", "new"),
                    finding("b", "recurring", { severity: "medium", strength: "moderate", subsystem: "session · cache" }),
                    finding("c", "nolonger", { severity: "high", strength: "limited", subsystem: "checkout · limiter" }),
                    finding("d", "dismissed", {
                        severity: "low",
                        strength: "limited",
                        disposition: { action: "dismiss", reason: "False positive", ts: 1_720_000_000_000 },
                    }),
                    finding("e", "suppressed", {
                        severity: "low",
                        strength: "limited",
                        subsystem: "legacy · v1 api",
                        disposition: { action: "suppress", ts: 1_720_000_000_000 },
                    }),
                ],
            });
    }
}

// setRadarScenario drives the surface. "never-scanned" clears the mock (null current report).
export function setRadarScenario(name: string): void {
    globalStore.set(radarDevMockAtom, name === "never-scanned" ? null : buildScenario(name));
}
