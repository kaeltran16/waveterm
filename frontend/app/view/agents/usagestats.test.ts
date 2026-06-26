import { describe, expect, it } from "vitest";
import { aggregateUsage, dedupeUsage, extractUsage, spendOf, tokensOf, type UsageRecord } from "./usagestats";

function rec(over: Partial<UsageRecord>): UsageRecord {
    return {
        ts: 0,
        provider: "claude",
        model: "claude-opus-4-20250514",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        ...over,
    };
}

describe("tokensOf", () => {
    it("sums all four token classes", () => {
        expect(
            tokensOf(rec({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheCreateTokens: 200 }))
        ).toBe(1350);
    });
});

describe("spendOf", () => {
    it("prices opus tokens by class", () => {
        const s = spendOf(rec({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheCreateTokens: 200 }));
        // 100*15 + 50*75 + 1000*1.5 + 200*18.75 = 10500 (per 1e6) = 0.0105
        expect(s).toBeCloseTo(0.0105, 6);
    });
    it("returns 0 for unknown models (tokens still counted elsewhere)", () => {
        expect(spendOf(rec({ model: "gpt-5", inputTokens: 1000 }))).toBe(0);
    });
});

const ASSISTANT_LINE = JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-26T10:00:00.000Z",
    message: {
        model: "claude-opus-4-20250514",
        usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 200,
        },
    },
});

describe("extractUsage", () => {
    it("parses an assistant line into a record", () => {
        const [r] = extractUsage([ASSISTANT_LINE], "claude");
        expect(r).toMatchObject({
            provider: "claude",
            model: "claude-opus-4-20250514",
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 1000,
            cacheCreateTokens: 200,
        });
        expect(r.ts).toBe(Date.parse("2026-06-26T10:00:00.000Z"));
    });
    it("skips non-assistant lines", () => {
        expect(extractUsage([JSON.stringify({ type: "user", message: {} })], "claude")).toEqual([]);
    });
    it("skips malformed JSON", () => {
        expect(extractUsage(["{not json"], "claude")).toEqual([]);
    });
    it("skips assistant lines missing usage/model/timestamp", () => {
        expect(
            extractUsage([JSON.stringify({ type: "assistant", message: { model: "claude-opus-4" } })], "claude")
        ).toEqual([]);
    });
});

const DAY = 24 * 60 * 60 * 1000;
function arec(ts: number, model: string, input: number): UsageRecord {
    return { ts, provider: "claude", model, inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
}

describe("aggregateUsage", () => {
    const now = Date.parse("2026-06-26T12:00:00.000Z");

    it("buckets today vs week and excludes older-than-week", () => {
        const stats = aggregateUsage(
            [
                arec(now, "claude-opus-4", 100), // today + week
                arec(now - 2 * DAY, "claude-opus-4", 50), // week only
                arec(now - 8 * DAY, "claude-opus-4", 999), // excluded
            ],
            now
        );
        expect(stats.totals.tokensToday).toBe(100);
        expect(stats.totals.tokensWeek).toBe(150);
    });

    it("computes per-model pct within a provider, desc by tokens", () => {
        const stats = aggregateUsage([arec(now, "claude-opus-4", 75), arec(now, "claude-sonnet-4", 25)], now);
        const p = stats.providers[0];
        expect(p.provider).toBe("claude");
        expect(p.models[0].model).toBe("claude-opus-4");
        expect(p.models[0].pct).toBeCloseTo(75, 5);
        expect(p.models[1].pct).toBeCloseTo(25, 5);
    });

    it("returns zeros for no records", () => {
        expect(aggregateUsage([], now)).toEqual({
            totals: { tokensToday: 0, tokensWeek: 0, spendTodayUsd: 0, spendWeekUsd: 0 },
            providers: [],
        });
    });

    it("deduplicates streamed/duplicated records before totaling", () => {
        // two JSONL snapshots of the SAME request (growing output_tokens) must count once, not twice
        const snap = (out: number): UsageRecord => ({
            id: "msg_1:req_1",
            ts: now,
            provider: "claude",
            model: "claude-opus-4",
            inputTokens: 100,
            outputTokens: out,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
        });
        const stats = aggregateUsage([snap(10), snap(50)], now);
        expect(stats.totals.tokensToday).toBe(150); // 100 input + 50 output (final), not 260
    });
});

describe("extractUsage dedup key", () => {
    it("captures message.id:requestId as the dedup key", () => {
        const line = JSON.stringify({
            type: "assistant",
            timestamp: "2026-06-26T10:00:00.000Z",
            requestId: "req_1",
            message: { id: "msg_1", model: "claude-opus-4", usage: { output_tokens: 5 } },
        });
        expect(extractUsage([line], "claude")[0].id).toBe("msg_1:req_1");
    });
    it("leaves id undefined when requestId or message.id is missing", () => {
        const line = JSON.stringify({
            type: "assistant",
            timestamp: "2026-06-26T10:00:00.000Z",
            message: { id: "msg_1", model: "claude-opus-4", usage: { output_tokens: 5 } },
        });
        expect(extractUsage([line], "claude")[0].id).toBeUndefined();
    });
});

describe("dedupeUsage", () => {
    const mk = (over: Partial<UsageRecord>): UsageRecord => ({
        ts: 0,
        provider: "claude",
        model: "claude-opus-4",
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        ...over,
    });
    it("collapses records sharing a key, keeping the largest output_tokens (final snapshot)", () => {
        const deduped = dedupeUsage([
            mk({ id: "k", outputTokens: 10 }),
            mk({ id: "k", outputTokens: 50 }),
            mk({ id: "k", outputTokens: 30 }),
        ]);
        expect(deduped).toHaveLength(1);
        expect(deduped[0].outputTokens).toBe(50);
    });
    it("keeps records without a key (cannot be deduped)", () => {
        expect(dedupeUsage([mk({ outputTokens: 1 }), mk({ outputTokens: 2 })])).toHaveLength(2);
    });
    it("keeps distinct keys separate", () => {
        expect(dedupeUsage([mk({ id: "a" }), mk({ id: "b" })])).toHaveLength(2);
    });
});
