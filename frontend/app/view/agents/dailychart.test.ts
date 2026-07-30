// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { toRows } from "./dailychart";
import type { DailyUsage } from "./usagestats";

const d: DailyUsage = {
    day: "2026-07-15",
    claudeTokens: 100,
    codexTokens: 40,
    claudeSpendUsd: 1.5,
    codexSpendUsd: 0.5,
};

describe("toRows", () => {
    it("selects the token metric and totals the two providers", () => {
        expect(toRows([d], "tokens")).toEqual([{ day: "07-15", claude: 100, codex: 40, total: 140 }]);
    });

    it("selects the spend metric", () => {
        expect(toRows([d], "spend")).toEqual([{ day: "07-15", claude: 1.5, codex: 0.5, total: 2 }]);
    });

    it("shortens the day key to MM-DD for the axis", () => {
        expect(toRows([d], "tokens")[0].day).toBe("07-15");
    });
});
