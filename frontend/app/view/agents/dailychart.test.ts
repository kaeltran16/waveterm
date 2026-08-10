// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { toRows } from "./dailychart";
import type { DailyUsage } from "./usagestats";

const daily: DailyUsage[] = [
    {
        day: "2026-08-10",
        byHarness: {
            claude: { tokens: 10, spendUsd: 1 },
            codex: { tokens: 20, spendUsd: 2 },
            opencode: { tokens: 30, spendUsd: 3 },
        },
    },
];

describe("toRows", () => {
    it("keys rows by harness in the given order and totals them", () => {
        expect(toRows(daily, "tokens", ["claude", "codex", "opencode"])).toEqual([
            {
                day: "08-10",
                values: { claude: 10, codex: 20, opencode: 30 },
                total: 60,
            },
        ]);
    });

    it("selects the spend metric", () => {
        expect(toRows(daily, "spend", ["claude", "codex", "opencode"])).toEqual([
            {
                day: "08-10",
                values: { claude: 1, codex: 2, opencode: 3 },
                total: 6,
            },
        ]);
    });

    it("defaults absent harnesses to zero", () => {
        expect(toRows(daily, "tokens", ["claude", "opencode", "jarvis"])).toEqual([
            {
                day: "08-10",
                values: { claude: 10, opencode: 30, jarvis: 0 },
                total: 40,
            },
        ]);
    });

    it("shortens the day key to MM-DD for the axis", () => {
        expect(toRows(daily, "tokens", ["claude"])[0].day).toBe("08-10");
    });
});
