import { describe, expect, it } from "vitest";
import { aggregateBuckets } from "./usagestats";

function bkt(over: Partial<UsageBucket>): UsageBucket {
    return {
        provider: "claude",
        model: "claude-opus-4-8",
        day: "2026-06-26",
        input: 0,
        output: 0,
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

    it("splits today vs rolling week and excludes older buckets", () => {
        const stats = aggregateBuckets(
            [
                bkt({ day: today, input: 100 }), // today + week
                bkt({ day: "2026-06-22", input: 50 }), // week only (4 days ago)
                bkt({ day: "2026-06-01", input: 999 }), // older than 7d -> excluded
            ],
            now
        );
        expect(stats.totals.tokensToday).toBe(100);
        expect(stats.totals.tokensWeek).toBe(150);
    });

    it("computes per-model pct within a provider, desc by tokens", () => {
        const stats = aggregateBuckets(
            [bkt({ model: "claude-opus-4-8", input: 75 }), bkt({ model: "claude-sonnet-4-6", input: 25 })],
            now
        );
        const p = stats.providers[0];
        expect(p.models[0].model).toBe("claude-opus-4-8");
        expect(p.models[0].pct).toBeCloseTo(75, 5);
        expect(p.models[1].pct).toBeCloseTo(25, 5);
    });

    it("prices buckets via usagepricing (opus input $15/M)", () => {
        const stats = aggregateBuckets([bkt({ day: today, model: "claude-opus-4-8", input: 1_000_000 })], now);
        expect(stats.totals.spendTodayUsd).toBeCloseTo(15, 5);
    });

    it("returns zeros for no buckets", () => {
        expect(aggregateBuckets([], now)).toEqual({
            totals: { tokensToday: 0, tokensWeek: 0, spendTodayUsd: 0, spendWeekUsd: 0 },
            providers: [],
        });
    });
});
