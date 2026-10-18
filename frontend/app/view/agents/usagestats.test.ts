import { describe, expect, it } from "vitest";
import { aggregateBuckets, bucketSpend, bucketTokens, modelKey, pctStr, usd } from "./usagestats";

describe("usd", () => {
    it("prints thousands as K, whole dollars from 100, and cents below", () => {
        expect([usd(2500), usd(1000), usd(999.6), usd(100), usd(99.5), usd(0)]).toEqual([
            "$2.5K",
            "$1K",
            "$1000",
            "$100",
            "$99.50",
            "$0.00",
        ]);
    });
});

describe("bucket helpers", () => {
    it("counts every token class and prices a bucket the way the aggregate does", () => {
        const b = bkt({ input: 1_000_000, output: 1_000_000, reasoning: 10, cacheread: 20, cachecreate: 30 });
        expect(bucketTokens(b)).toBe(2_000_060);
        expect(bucketSpend(b)).toBeCloseTo(
            aggregateBuckets([b], Date.parse("2026-06-26T12:00:00.000Z")).totals.spendWindowUsd,
            9
        );
        expect(bucketSpend(bkt({ model: "no-such-model", input: 500 }))).toBe(0);
    });

    it("formats a share as the cards and legends print it", () => {
        expect([pctStr(0), pctStr(0.04), pctStr(1), pctStr(4.26), pctStr(41.6)]).toEqual([
            "0%",
            "<0.1%",
            "1%",
            "4.3%",
            "42%",
        ]);
    });
});

function bkt(over: Partial<UsageBucket>): UsageBucket {
    return {
        harness: "claude",
        provider: "anthropic",
        model: "claude-opus-4-8",
        day: "2026-06-26",
        input: 0,
        output: 0,
        reasoning: 0,
        cacheread: 0,
        cachecreate: 0,
        cachecreate1h: 0,
        msgs: 1,
        ...over,
    };
}

describe("aggregateBuckets", () => {
    const now = Date.parse("2026-06-26T12:00:00.000Z");
    const today = "2026-06-26";

    it("splits today vs rolling week (totals stay date-filtered even with older buckets)", () => {
        const stats = aggregateBuckets(
            [
                bkt({ day: today, input: 100 }),
                bkt({ day: "2026-06-22", input: 50 }), // within rolling 7
                bkt({ day: "2026-06-01", input: 999 }), // older — excluded from totals
            ],
            now
        );
        expect(stats.totals.tokensToday).toBe(100);
        expect(stats.totals.tokensWeek).toBe(150);
    });

    it("computes whole-window totals and active days across all loaded buckets", () => {
        const stats = aggregateBuckets(
            [
                bkt({ day: today, input: 100 }),
                bkt({ day: "2026-05-01", input: 300 }), // older than a week
                bkt({ harness: "codex", provider: "openai", model: "gpt-5.5", day: "2026-05-01", input: 50 }),
            ],
            now
        );
        expect(stats.totals.tokensWindow).toBe(450); // includes >7d buckets, unlike tokensWeek
        expect(stats.totals.tokensWindowByHarness.claude).toBe(400);
        expect(stats.totals.tokensWindowByHarness.codex).toBe(50);
        expect(stats.totals.activeDays).toBe(2);
        expect(stats.totals.spendWindowUsd).toBeGreaterThan(0);
    });

    it("builds an all-provider token-class split in fixed order with priced spend", () => {
        const stats = aggregateBuckets(
            [bkt({ model: "claude-opus-4-8", input: 1e6, output: 1e6, cacheread: 1e6, cachecreate: 1e6 })],
            now
        );
        expect(stats.split.map((s) => s.cls)).toEqual(["cacheRead", "reasoning", "output", "cacheWrite", "input"]);
        const byCls = Object.fromEntries(stats.split.map((s) => [s.cls, s]));
        expect(byCls.cacheRead.tokens).toBe(1e6);
        expect(byCls.output.spendUsd).toBeCloseTo(25, 5);
        expect(byCls.input.spendUsd).toBeCloseTo(5, 5);
        expect(byCls.reasoning.tokens).toBe(0);
    });

    it("daily zero-fills idle days in range and keys by harness", () => {
        const stats = aggregateBuckets(
            [
                bkt({ day: "2026-06-24", input: 10 }),
                bkt({ harness: "codex", provider: "openai", model: "gpt-5.5", day: "2026-06-26", input: 20 }),
            ],
            now
        );
        // range 06-24..06-26 inclusive -> 3 days, the middle one idle
        expect(stats.daily.map((d) => d.day)).toEqual(["2026-06-24", "2026-06-25", "2026-06-26"]);
        expect(stats.daily[0].byHarness.claude.tokens).toBe(10);
        expect(stats.daily[1].byHarness).toEqual({}); // idle day
        expect(stats.daily[2].byHarness.codex.tokens).toBe(20);
    });

    // The 30-day cap used to truncate the all-time series silently; the brush replaces it, so the
    // aggregation must now return every day in range.
    it("returns every day in range without a 30-day cap", () => {
        const day = (n: number) => {
            const d = new Date(2026, 0, 1);
            d.setDate(d.getDate() + n);
            const m = String(d.getMonth() + 1).padStart(2, "0");
            return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, "0")}`;
        };
        const buckets = [0, 44].map((n) => bkt({ day: day(n), input: 10, output: 5 }));
        const stats = aggregateBuckets(buckets, new Date(2026, 1, 14).getTime());
        expect(stats.daily.length).toBe(45);
        expect(stats.daily[0].day).toBe(day(0));
        expect(stats.daily[44].day).toBe(day(44));
        expect("dailyTruncated" in stats).toBe(false);
    });

    it("returns empty shapes for no buckets", () => {
        expect(aggregateBuckets([], now)).toEqual({
            availableHarnesses: [],
            totals: {
                tokensToday: 0,
                tokensWeek: 0,
                spendTodayUsd: 0,
                spendWeekUsd: 0,
                tokensWindow: 0,
                spendWindowUsd: 0,
                activeDays: 0,
                reportedCostWeekUsd: 0,
                reportedCostWeekPresent: false,
                reportedCostWeekHarnesses: [],
                reportedCostWindowUsd: 0,
                reportedCostWindowPresent: false,
                reportedCostWindowHarnesses: [],
                pricedTokensWeek: 0,
                pricedTokensWindow: 0,
                pricingCoverageWeekPct: null,
                pricingCoverageWindowPct: null,
                tokensTodayByHarness: {},
                tokensWindowByHarness: {},
            },
            split: [
                { cls: "cacheRead", label: "Cache read", tokens: 0, spendUsd: 0 },
                { cls: "reasoning", label: "Reasoning", tokens: 0, spendUsd: 0 },
                { cls: "output", label: "Output", tokens: 0, spendUsd: 0 },
                { cls: "cacheWrite", label: "Cache write", tokens: 0, spendUsd: 0 },
                { cls: "input", label: "Input", tokens: 0, spendUsd: 0 },
            ],
            daily: [],
            models: [],
        });
    });

    it("derives harnesses, reported cost and coverage", () => {
        const buckets = [
            bkt({ harness: "claude", provider: "anthropic", input: 100 }),
            bkt({
                harness: "opencode",
                provider: "openai",
                model: "gpt-5.5",
                input: 200,
                reasoning: 50,
                reportedcostusd: 0,
            }),
            bkt({
                harness: "opencode",
                provider: "opencode-go",
                model: "gemini-2.5-pro",
                input: 700,
                reportedcostusd: 1.25,
            }),
        ];

        const all = aggregateBuckets(buckets, now, "all");
        expect(all.availableHarnesses).toEqual(["claude", "opencode"]);
        expect(all.totals.tokensWindow).toBe(1050);
        expect(all.totals.reportedCostWindowUsd).toBe(1.25);
        expect(all.totals.reportedCostWindowPresent).toBe(true);
        expect(all.totals.reportedCostWindowHarnesses).toEqual(["opencode"]);
        expect(all.totals.pricingCoverageWindowPct).toBeCloseTo((350 / 1050) * 100);

        const openCode = aggregateBuckets(buckets, now, "opencode");
        expect(openCode.totals.tokensWindow).toBe(950);
        expect(openCode.split.find((s) => s.cls === "reasoning")?.tokens).toBe(50);
        expect(openCode.daily[0].byHarness.opencode.tokens).toBe(950);
    });

    it("reports no coverage for an empty scope and keeps a reported zero present", () => {
        const empty = aggregateBuckets([], now, "all");
        expect(empty.totals.pricingCoverageWindowPct).toBeNull();
        expect(empty.totals.reportedCostWindowPresent).toBe(false);
        expect(empty.totals.reportedCostWindowUsd).toBe(0);

        const zeroed = aggregateBuckets(
            [bkt({ harness: "opencode", provider: "openai", model: "gpt-5.5", reportedcostusd: 0 })],
            now,
            "all"
        );
        expect(zeroed.totals.reportedCostWindowPresent).toBe(true);
        expect(zeroed.totals.reportedCostWindowUsd).toBe(0);
        expect(zeroed.totals.reportedCostWindowHarnesses).toEqual(["opencode"]);
    });

    it("keeps Pi a separate harness from its provider/model dimensions", () => {
        const buckets = [
            bkt({ harness: "pi", provider: "openai-codex", model: "gpt-5.5", day: today, input: 300, output: 100 }),
            bkt({ harness: "claude", provider: "anthropic", model: "claude-opus-4-8", day: today, input: 200 }),
        ];
        const all = aggregateBuckets(buckets, now, "all");
        expect(all.availableHarnesses).toEqual(["pi", "claude"]);
        expect(all.totals.tokensWindowByHarness.pi).toBe(400);
        expect(all.totals.tokensWindowByHarness.claude).toBe(200);
        // the harness filter isolates pi buckets (chips still come from the unfiltered set)
        const piOnly = aggregateBuckets(buckets, now, "pi");
        expect(piOnly.totals.tokensWindow).toBe(400);
        expect(piOnly.availableHarnesses).toEqual(["pi", "claude"]);
        expect(piOnly.totals.tokensWindowByHarness.claude).toBeUndefined();
    });

    it("folds byModel per day per model, zero-fills idle days, and orders models by tokens", () => {
        const opus = modelKey("claude", "anthropic", "claude-opus-4-8");
        const sonnet = modelKey("claude", "anthropic", "claude-sonnet-4-5");
        const stats = aggregateBuckets(
            [
                bkt({ day: "2026-06-24", input: 100 }),
                bkt({ day: "2026-06-24", output: 50 }),
                bkt({ day: today, model: "claude-sonnet-4-5", input: 400 }),
            ],
            now
        );
        expect(stats.daily.map((d) => d.day)).toEqual(["2026-06-24", "2026-06-25", today]);
        expect(stats.daily[0].byModel[opus].tokens).toBe(150);
        expect(stats.daily[0].byModel[opus].spendUsd).toBeGreaterThan(0);
        expect(stats.daily[1].byModel).toEqual({});
        expect(Object.keys(stats.daily[2].byModel)).toEqual([sonnet]);
        expect(stats.models.map((m) => [m.key, m.tokens])).toEqual([
            [sonnet, 400],
            [opus, 150],
        ]);
        expect(stats.models[1]).toMatchObject({ harness: "claude", provider: "anthropic", model: "claude-opus-4-8" });
    });

    it("narrows byModel and models under a harness filter", () => {
        const buckets = [
            bkt({ harness: "pi", provider: "openai-codex", model: "gpt-5.5", day: today, input: 300 }),
            bkt({ day: today, input: 200 }),
        ];
        const piOnly = aggregateBuckets(buckets, now, "pi");
        const pi = modelKey("pi", "openai-codex", "gpt-5.5");
        expect(Object.keys(piOnly.daily[0].byModel)).toEqual([pi]);
        expect(piOnly.models.map((m) => m.key)).toEqual([pi]);
    });

    it("keeps the same model id under two harnesses as two series", () => {
        const stats = aggregateBuckets(
            [
                bkt({ harness: "pi", provider: "openai-codex", model: "gpt-5.5", day: today, input: 300 }),
                bkt({ harness: "codex", provider: "openai", model: "gpt-5.5", day: today, input: 200 }),
            ],
            now
        );
        const pi = modelKey("pi", "openai-codex", "gpt-5.5");
        const codex = modelKey("codex", "openai", "gpt-5.5");
        expect(pi).not.toBe(codex);
        expect(stats.models.map((m) => m.key)).toEqual([pi, codex]);
        expect(stats.daily[0].byModel[pi].tokens).toBe(300);
        expect(stats.daily[0].byModel[codex].tokens).toBe(200);
    });

    it("excludes a model whose only bucket billed no tokens", () => {
        const stats = aggregateBuckets(
            [bkt({ day: today, input: 100 }), bkt({ day: today, model: "claude-haiku-4-5" })],
            now
        );
        expect(stats.models.map((m) => m.model)).toEqual(["claude-opus-4-8"]);
    });
});

describe("aggregateBuckets sums", () => {
    const now = Date.parse("2026-06-26T12:00:00.000Z");
    const today = "2026-06-26";
    const M = 1_000_000;

    it("splits every token class with its own tokens and spend", () => {
        const stats = aggregateBuckets(
            [bkt({ input: 1 * M, output: 2 * M, reasoning: 3 * M, cacheread: 4 * M, cachecreate: 5 * M })],
            now
        );
        // opus: $5 in, $25 out, $0.5 cache read, $6.25 cache write per 1M; reasoning bills as output
        expect(stats.split.map((s) => [s.cls, s.tokens, s.spendUsd])).toEqual([
            ["cacheRead", 4 * M, 2],
            ["reasoning", 3 * M, 75],
            ["output", 2 * M, 50],
            ["cacheWrite", 5 * M, 31.25],
            ["input", 1 * M, 5],
        ]);
    });

    it("sums spend into today, the week, the window, the daily rows and the model series", () => {
        const stats = aggregateBuckets(
            [
                bkt({ day: today, output: 1 * M }), // $25
                bkt({ day: today, input: 1 * M }), // $5
                bkt({ harness: "codex", provider: "openai", model: "gpt-5.5", day: today, input: 1 * M }), // $5
                bkt({ day: "2026-06-20", output: 1 * M }), // first day of the rolling week, $25
                bkt({ day: "2026-06-19", output: 1 * M }), // a day before it, $25
            ],
            now
        );
        expect(stats.totals).toMatchObject({
            tokensToday: 3 * M,
            spendTodayUsd: 35,
            tokensWeek: 4 * M,
            spendWeekUsd: 60,
            tokensWindow: 5 * M,
            spendWindowUsd: 85,
            tokensTodayByHarness: { claude: 2 * M, codex: 1 * M },
        });
        const last = stats.daily[stats.daily.length - 1];
        expect(last.day).toBe(today);
        expect(last.byHarness).toEqual({
            claude: { tokens: 2 * M, spendUsd: 30 },
            codex: { tokens: 1 * M, spendUsd: 5 },
        });
        expect(stats.models.map((m) => [m.harness, m.tokens, m.spendUsd])).toEqual([
            ["claude", 4 * M, 80],
            ["codex", 1 * M, 5],
        ]);
    });

    it("covers the week by the share of its tokens that are priced", () => {
        const stats = aggregateBuckets(
            [
                bkt({ day: today, input: 100 }),
                bkt({ day: today, model: "no-such-model", input: 300 }),
                bkt({ day: "2026-06-01", input: 1000 }), // priced, but outside the week
            ],
            now
        );
        expect(stats.totals.pricedTokensWeek).toBe(100);
        expect(stats.totals.pricingCoverageWeekPct).toBe(25);
        expect(stats.totals.pricedTokensWindow).toBe(1100);
        expect(stats.totals.pricingCoverageWindowPct).toBeCloseTo((1100 / 1400) * 100, 9);
    });

    it("gives no week coverage when the week holds no tokens", () => {
        const stats = aggregateBuckets([bkt({ day: "2026-06-01", input: 100 })], now);
        expect(stats.totals.pricingCoverageWeekPct).toBeNull();
        expect(stats.totals.pricingCoverageWindowPct).toBe(100);
    });

    it("keeps the reported cost of the week apart from the whole window's", () => {
        const stats = aggregateBuckets(
            [
                bkt({
                    harness: "opencode",
                    provider: "openai",
                    model: "gpt-5.5",
                    day: today,
                    input: 10,
                    reportedcostusd: 1.5,
                }),
                bkt({ harness: "claude", day: today, input: 10 }), // reports nothing
                bkt({
                    harness: "pi",
                    provider: "openai-codex",
                    model: "gpt-5.5",
                    day: "2026-06-01",
                    input: 10,
                    reportedcostusd: 2,
                }),
            ],
            now
        );
        expect(stats.totals).toMatchObject({
            reportedCostWeekUsd: 1.5,
            reportedCostWeekPresent: true,
            reportedCostWeekHarnesses: ["opencode"],
            reportedCostWindowUsd: 3.5,
            reportedCostWindowPresent: true,
            reportedCostWindowHarnesses: ["opencode", "pi"],
        });
    });

    it("reports no week cost when only an older bucket reported one", () => {
        const stats = aggregateBuckets([bkt({ day: "2026-06-01", input: 10, reportedcostusd: 2 })], now);
        expect(stats.totals).toMatchObject({
            reportedCostWeekUsd: 0,
            reportedCostWeekPresent: false,
            reportedCostWeekHarnesses: [],
            reportedCostWindowUsd: 2,
            reportedCostWindowPresent: true,
        });
    });

    it("counts a day as active only when it billed tokens", () => {
        const stats = aggregateBuckets([bkt({ day: today, input: 100 }), bkt({ day: "2026-06-24" })], now);
        expect(stats.totals.activeDays).toBe(1);
        expect(stats.daily.map((d) => d.day)).toEqual(["2026-06-24", "2026-06-25", today]);
    });
});

describe("aggregateBuckets day range", () => {
    const now = Date.parse("2026-06-26T12:00:00.000Z");
    const dayKeys = (buckets: UsageBucket[]) => aggregateBuckets(buckets, now).daily.map((d) => d.day);

    it("starts at the earliest day and runs to the latest, whatever order the buckets arrive in", () => {
        const buckets = [
            bkt({ day: "2026-06-26", input: 10 }),
            bkt({ day: "2026-06-28", input: 10 }), // a day ahead of today
            bkt({ day: "2026-06-24", input: 10 }),
        ];
        expect(dayKeys(buckets)).toEqual(["2026-06-24", "2026-06-25", "2026-06-26", "2026-06-27", "2026-06-28"]);
        expect(dayKeys([...buckets].reverse())).toEqual(dayKeys(buckets));
    });

    it("runs on to today when every bucket is older", () => {
        expect(dayKeys([bkt({ day: "2026-06-23", input: 10 })])).toEqual([
            "2026-06-23",
            "2026-06-24",
            "2026-06-25",
            "2026-06-26",
        ]);
    });
});

describe("modelKey", () => {
    it("is stable and unique per triple", () => {
        expect(modelKey("pi", "a", "b")).toBe(modelKey("pi", "a", "b"));
        expect(modelKey("pi", "a/b", "c")).not.toBe(modelKey("pi", "a", "b/c"));
    });
});
