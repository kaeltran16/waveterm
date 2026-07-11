// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { classifyScanState } from "./radarmodel";
import { buildScenario, RADAR_SCENARIOS } from "./radardevmock";

describe("radar dev scenarios", () => {
    it("covers all eight scan states", () => {
        const states = RADAR_SCENARIOS.map((s) => classifyScanState(buildScenario(s)));
        for (const want of ["collecting", "clustering", "results", "partial", "no-findings", "model-failed", "cancelled"]) {
            expect(states).toContain(want);
        }
    });
    it("results scenario has findings across new and recurring", () => {
        const r = buildScenario("results");
        const groups = new Set((r.findings ?? []).map((f) => f.group));
        expect(groups.has("new")).toBe(true);
        expect(groups.has("recurring")).toBe(true);
    });
});
