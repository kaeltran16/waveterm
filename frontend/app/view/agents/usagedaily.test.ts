// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { harnessChartColor, harnessChartLabel, legendSeries, modelLegend, modelRows, modelShade } from "./usagedaily";
import { modelKey, type DailyUsage, type ModelSeries } from "./usagestats";

function series(harness: string, provider: string, model: string, tokens: number, spendUsd = 0): ModelSeries {
    return { key: modelKey(harness, provider, model), harness, provider, model, tokens, spendUsd };
}

function opacity(fill: string): number {
    const m = /(\d+(?:\.\d+)?)%, transparent\)$/.exec(fill);
    return m ? Number(m[1]) : 100;
}

describe("harness chart metadata", () => {
    it("maps known harnesses to their tokens and labels, others to muted and the raw id", () => {
        expect(["claude", "codex", "opencode", "pi", "jarvis"].map(harnessChartColor)).toEqual([
            "var(--color-accent)",
            "var(--color-success)",
            "var(--color-rt-opencode)",
            "var(--color-rt-pi)",
            "var(--color-muted)",
        ]);
        expect(["claude", "codex", "opencode", "pi", "jarvis"].map(harnessChartLabel)).toEqual([
            "Claude",
            "Codex",
            "OpenCode",
            "Pi",
            "jarvis",
        ]);
    });
});

describe("modelShade", () => {
    const color = "var(--color-rt-pi)";

    it("uses the bare color for a lone model", () => {
        expect(modelShade(color, 0, 1)).toBe(color);
    });

    it("steps six models strictly down from 100% to 25%", () => {
        const fills = [0, 1, 2, 3, 4, 5].map((r) => modelShade(color, r, 6));
        expect(fills[0]).toBe(color);
        const pcts = fills.map(opacity);
        expect(pcts[0]).toBe(100);
        expect(pcts[5]).toBe(25);
        for (let i = 1; i < pcts.length; i++) {
            expect(pcts[i]).toBeLessThan(pcts[i - 1]);
            expect(pcts[i]).toBeGreaterThanOrEqual(25);
        }
        for (const f of fills.slice(1)) {
            expect(f).toContain(color);
            expect(f.startsWith("color-mix(in srgb, ")).toBe(true);
        }
    });
});

describe("modelLegend", () => {
    const pi = series("pi", "openai-codex", "gpt-5.5", 300, 3);
    const codex = series("codex", "openai", "gpt-5.5", 100, 1);

    it("keeps the same model id under two harnesses as two rows in two groups", () => {
        const groups = modelLegend([pi, codex], ["claude", "codex", "pi"], "tokens");
        expect(groups.map((g) => g.harness)).toEqual(["codex", "pi"]);
        expect(groups.map((g) => g.models.map((m) => m.model))).toEqual([["gpt-5.5"], ["gpt-5.5"]]);
        expect(groups[0].models[0].key).not.toBe(groups[1].models[0].key);
        expect(groups[1].models[0].title).toBe("openai-codex/gpt-5.5");
        expect(groups[0].label).toBe("Codex");
        expect(groups.map((g) => g.pct)).toEqual([25, 75]);
        expect(groups.every((g) => g.showHead)).toBe(true);
    });

    it("orders groups by harnessOrder with unlisted harnesses last, alphabetically", () => {
        const groups = modelLegend(
            [series("zeta", "x", "m", 9), series("alpha", "x", "m", 8), series("claude", "anthropic", "opus", 1), pi],
            ["pi", "claude"],
            "tokens"
        );
        expect(groups.map((g) => g.harness)).toEqual(["pi", "claude", "alpha", "zeta"]);
    });

    it("orders models by tokens for both metrics", () => {
        // the cheaper-per-token model has more tokens but less spend
        const models = [series("claude", "anthropic", "haiku", 900, 1), series("claude", "anthropic", "opus", 100, 50)];
        const byTokens = modelLegend(models, ["claude"], "tokens")[0].models.map((m) => m.model);
        const bySpend = modelLegend(models, ["claude"], "spend")[0].models.map((m) => m.model);
        expect(byTokens).toEqual(["haiku", "opus"]);
        expect(bySpend).toEqual(byTokens);
    });

    it("selects the metric's value and shares it across the whole legend", () => {
        const [codexG, piG] = modelLegend([pi, codex], ["codex", "pi"], "spend");
        expect(codexG.models[0]).toMatchObject({ value: 1, pct: 25, tokens: 100, spendUsd: 1 });
        expect(piG.value).toBe(3);
        expect(piG.pct).toBe(75);
    });

    it("reads 0, never NaN, for the spend metric over unpriced models only", () => {
        const groups = modelLegend(
            [series("pi", "x", "unpriced", 500), series("pi", "x", "other", 100)],
            ["pi"],
            "spend"
        );
        const rows = legendSeries(groups);
        expect(rows.map((m) => [m.value, m.pct])).toEqual([
            [0, 0],
            [0, 0],
        ]);
        expect([groups[0].value, groups[0].pct]).toEqual([0, 0]);
    });

    it("shows group heads only with more than one group", () => {
        expect(modelLegend([pi], ["pi"], "tokens")[0].showHead).toBe(false);
        expect(modelLegend([], ["pi"], "tokens")).toEqual([]);
    });

    it("shades models within a harness by rank", () => {
        const [g] = modelLegend([series("pi", "x", "b", 10), series("pi", "x", "a", 20)], ["pi"], "tokens");
        expect(g.models.map((m) => m.fill)).toEqual([
            "var(--color-rt-pi)",
            "color-mix(in srgb, var(--color-rt-pi) 25%, transparent)",
        ]);
    });
});

describe("legendSeries", () => {
    it("flattens groups in legend order", () => {
        const groups = modelLegend(
            [series("pi", "x", "p2", 5), series("claude", "anthropic", "c1", 9), series("pi", "x", "p1", 7)],
            ["claude", "pi"],
            "tokens"
        );
        expect(legendSeries(groups).map((m) => m.model)).toEqual(["c1", "p1", "p2"]);
    });
});

describe("modelRows", () => {
    const a = modelKey("claude", "anthropic", "opus");
    const b = modelKey("pi", "x", "m");
    const daily: DailyUsage[] = [
        {
            day: "2026-08-10",
            byHarness: {},
            byModel: { [a]: { tokens: 10, spendUsd: 1 }, [b]: { tokens: 20, spendUsd: 2 } },
        },
        { day: "2026-08-11", byHarness: {}, byModel: {} },
    ];

    it("keys rows by model with MM-DD days and totals the given keys", () => {
        expect(modelRows(daily, [a, b], "tokens")).toEqual([
            { day: "08-10", values: { [a]: 10, [b]: 20 }, total: 30 },
            { day: "08-11", values: { [a]: 0, [b]: 0 }, total: 0 },
        ]);
    });

    it("selects the spend metric and totals only the given keys", () => {
        expect(modelRows(daily, [b], "spend")[0]).toEqual({ day: "08-10", values: { [b]: 2 }, total: 2 });
    });

    it("zero-fills a key with no entry", () => {
        const c = modelKey("codex", "openai", "gpt-5.5");
        expect(modelRows(daily, [a, c], "tokens")[0]).toEqual({ day: "08-10", values: { [a]: 10, [c]: 0 }, total: 10 });
    });
});
