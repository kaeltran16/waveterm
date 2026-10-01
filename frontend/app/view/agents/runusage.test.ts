// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { modelsText, summarizeUsage, usageText } from "./runusage";

function row(over: Partial<UsageRow>): UsageRow {
    return { role: "worker", input: 0, output: 0, cacheread: 0, cachewrite: 0, cachewrite1h: 0, msgs: 1, ...over };
}

const ROWS: UsageRow[] = [
    row({
        role: "lead",
        model: "claude-opus-5-5",
        input: 100_000,
        output: 50_000,
        cacheread: 800_000,
        cachewrite: 50_000,
    }),
    row({ taskid: "t-1", model: "claude-sonnet-5-5", input: 200_000, cacheread: 300_000 }),
    row({ role: "reviewer", taskid: "t-1", model: "claude-opus-5-5", output: 100_000, cachewrite1h: 400_000 }),
    row({ taskid: "t-2", missing: true }),
];

describe("summarizeUsage", () => {
    it("counts every token class once and splits by model, largest first", () => {
        const s = summarizeUsage(ROWS)!;
        expect(s.total).toBe(2_000_000);
        expect(s.cachedPct).toBe(55);
        expect(s.byModel).toEqual([
            { model: "opus-5-5", tokens: 1_500_000 },
            { model: "sonnet-5-5", tokens: 500_000 },
        ]);
        expect(s.missing).toBe(1);
    });

    it("totals one task's worker and reviewer", () => {
        const s = summarizeUsage(ROWS, "t-1")!;
        expect(s.total).toBe(1_000_000);
        expect(s.byModel.map((m) => m.model)).toEqual(["sonnet-5-5", "opus-5-5"]);
    });

    it("is null when nothing was spent", () => {
        expect(summarizeUsage(undefined)).toBeNull();
        expect(summarizeUsage(ROWS, "t-2")).toBeNull();
        expect(summarizeUsage(ROWS, "t-9")).toBeNull();
    });
});

describe("usageText", () => {
    it("names unreadable sessions only once the total is sealed", () => {
        const s = summarizeUsage(ROWS)!;
        expect(usageText(s, false)).toBe("2.0M tok · 55% cached");
        expect(usageText(s, true)).toBe("2.0M tok · 55% cached · 1 unreadable");
    });

    it("lists the models with their tokens", () => {
        expect(modelsText(summarizeUsage(ROWS)!)).toBe("opus-5-5 1.5M · sonnet-5-5 500k");
    });
});
