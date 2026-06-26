import { describe, expect, it } from "vitest";
import { aggregateUsage, dedupeUsage, extractCodexUsage, extractUsage, tokensOf, type UsageRecord } from "./usagestats";

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
    it("captures 1h extended-cache tokens from cache_creation", () => {
        const line = JSON.stringify({
            type: "assistant",
            timestamp: "2026-06-26T10:00:00.000Z",
            message: {
                model: "claude-opus-4-8",
                usage: {
                    input_tokens: 10,
                    cache_creation_input_tokens: 500,
                    cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 },
                },
            },
        });
        const [r] = extractUsage([line], "claude");
        expect(r.cacheCreateTokens).toBe(500);
        expect(r.cacheCreate1hTokens).toBe(500);
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

// Codex transcripts use a different shape than Claude: token usage lives in event_msg lines
// (payload.type "token_count") as a CUMULATIVE total_token_usage, and the model is carried by a
// preceding turn_context line. cached_input_tokens is a subset of input_tokens, so the record is
// normalized (input = input - cached) to keep tokensOf == Codex's own total.
const codexTurnContext = (model: string, ts = "2026-06-26T03:07:50.000Z") =>
    JSON.stringify({ timestamp: ts, type: "turn_context", payload: { model } });

const codexTokenCount = (totalUsage: object, ts = "2026-06-26T03:08:00.663Z") =>
    JSON.stringify({
        timestamp: ts,
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: totalUsage, last_token_usage: totalUsage } },
    });

const CODEX_USAGE = {
    input_tokens: 9458,
    cached_input_tokens: 7040,
    output_tokens: 89,
    reasoning_output_tokens: 71,
    total_tokens: 9547,
};

describe("extractCodexUsage", () => {
    it("normalizes a token_count event so tokensOf equals Codex's own total_tokens", () => {
        const [r] = extractCodexUsage([codexTurnContext("gpt-5.5"), codexTokenCount(CODEX_USAGE)]);
        expect(r.provider).toBe("codex");
        expect(r.model).toBe("gpt-5.5");
        expect(r.inputTokens).toBe(9458 - 7040); // non-cached portion only
        expect(r.cacheReadTokens).toBe(7040);
        expect(r.outputTokens).toBe(89); // reasoning already included
        expect(r.cacheCreateTokens).toBe(0);
        expect(tokensOf(r)).toBe(9547);
        expect(r.ts).toBe(Date.parse("2026-06-26T03:08:00.663Z"));
    });

    it("emits one record per session using the max cumulative total (not the sum of turns)", () => {
        const small = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 };
        const big = { input_tokens: 5000, cached_input_tokens: 1000, output_tokens: 500, total_tokens: 5500 };
        const recs = extractCodexUsage([
            codexTurnContext("gpt-5.5"),
            codexTokenCount(small, "2026-06-26T03:08:00.000Z"),
            codexTokenCount(big, "2026-06-26T03:20:00.000Z"),
        ]);
        expect(recs).toHaveLength(1);
        expect(tokensOf(recs[0])).toBe(5500);
        expect(recs[0].ts).toBe(Date.parse("2026-06-26T03:20:00.000Z"));
    });

    it("falls back to model 'codex' when no turn_context precedes the totals", () => {
        const [r] = extractCodexUsage([codexTokenCount(CODEX_USAGE)]);
        expect(r.model).toBe("codex");
    });

    it("ignores null-info token_count, non-token lines, and malformed JSON; returns [] with no usage", () => {
        expect(
            extractCodexUsage([
                "{not json",
                JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } }),
                JSON.stringify({ type: "response_item", payload: {} }),
            ])
        ).toEqual([]);
    });
});
