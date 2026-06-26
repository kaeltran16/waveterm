import { describe, expect, it } from "vitest";
import { priceFor, spendOf } from "./usagepricing";
import type { UsageRecord } from "./usagestats";

function rec(over: Partial<UsageRecord>): UsageRecord {
    return {
        ts: 0,
        provider: "claude",
        model: "claude-opus-4-8",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        ...over,
    };
}

describe("priceFor", () => {
    it("family-matches Claude and OpenAI model ids", () => {
        expect(priceFor("claude-opus-4-8")?.output).toBe(75);
        expect(priceFor("claude-sonnet-4-6")?.input).toBe(3);
        expect(priceFor("claude-3-5-haiku")?.input).toBe(0.8);
        expect(priceFor("gpt-5.5")?.output).toBe(30);
        expect(priceFor("codex-auto-review")?.input).toBe(1.25); // codex family
        expect(priceFor("gpt-5")?.input).toBe(1.25);
    });
    it("prefers gpt-5.5 over the gpt-5 base family", () => {
        expect(priceFor("gpt-5.5")?.input).toBe(5);
    });
    it("returns undefined for unknown models", () => {
        expect(priceFor("gemini-2.5-pro")).toBeUndefined();
    });
});

describe("spendOf", () => {
    it("prices opus tokens with 5m cache writes by class", () => {
        // 100*15 + 50*75 + 1000*1.5 + 200*18.75 = 10500 (per 1e6) = 0.0105
        const s = spendOf(rec({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheCreateTokens: 200 }));
        expect(s).toBeCloseTo(0.0105, 6);
    });
    it("prices opus 1h cache writes at the higher 1h rate", () => {
        // 200 cache-create tokens, all 1h => 200*30 = 6000 (per 1e6)
        expect(spendOf(rec({ cacheCreateTokens: 200, cacheCreate1hTokens: 200 }))).toBeCloseTo(0.006, 6);
    });
    it("splits mixed 5m/1h cache writes", () => {
        // 300 cache-create, 100 of them 1h => 200*18.75 + 100*30 = 6750 (per 1e6)
        expect(spendOf(rec({ cacheCreateTokens: 300, cacheCreate1hTokens: 100 }))).toBeCloseTo(0.00675, 6);
    });
    it("prices gpt-5.5 input/output/cached (no cache-write charge)", () => {
        // 1000*5 + 100*30 + 5000*0.5 = 10500 (per 1e6) = 0.0105
        const s = spendOf(
            rec({ provider: "codex", model: "gpt-5.5", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 5000 })
        );
        expect(s).toBeCloseTo(0.0105, 6);
    });
    it("returns 0 for unknown models (tokens still counted elsewhere)", () => {
        expect(spendOf(rec({ model: "gemini-2.5-pro", inputTokens: 1000 }))).toBe(0);
    });
});
