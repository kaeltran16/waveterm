import { describe, expect, it } from "vitest";
import { priceFor, spendBreakdown, spendOf } from "./usagepricing";
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
    it("family-matches Claude and OpenAI model ids (current-generation rates)", () => {
        expect(priceFor("claude-opus-4-8")?.output).toBe(25);
        expect(priceFor("claude-sonnet-4-6")?.input).toBe(3);
        expect(priceFor("claude-3-5-haiku")?.input).toBe(1); // historical haiku priced at current tier
        expect(priceFor("gpt-5.5")?.output).toBe(30);
        expect(priceFor("codex-auto-review")?.input).toBe(1.25); // codex family
        expect(priceFor("gpt-5")?.input).toBe(1.25);
    });
    it("prices the fable family", () => {
        expect(priceFor("claude-fable-5")?.input).toBe(10);
        expect(priceFor("claude-fable-5")?.output).toBe(50);
    });
    it("uses current-generation opus + haiku pricing", () => {
        expect(priceFor("claude-opus-4-8")?.input).toBe(5);
        expect(priceFor("claude-haiku-4-5")?.input).toBe(1);
        expect(priceFor("claude-haiku-4-5")?.output).toBe(5);
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
        // 100*5 + 50*25 + 1000*0.5 + 200*6.25 = 3500 (per 1e6) = 0.0035
        const s = spendOf(rec({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheCreateTokens: 200 }));
        expect(s).toBeCloseTo(0.0035, 6);
    });
    it("prices opus 1h cache writes at the higher 1h rate", () => {
        // 200 cache-create tokens, all 1h => 200*10 = 2000 (per 1e6)
        expect(spendOf(rec({ cacheCreateTokens: 200, cacheCreate1hTokens: 200 }))).toBeCloseTo(0.002, 6);
    });
    it("splits mixed 5m/1h cache writes", () => {
        // 300 cache-create, 100 of them 1h => 200*6.25 + 100*10 = 2250 (per 1e6)
        expect(spendOf(rec({ cacheCreateTokens: 300, cacheCreate1hTokens: 100 }))).toBeCloseTo(0.00225, 6);
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

describe("spendBreakdown", () => {
    const rec = (over: Partial<UsageRecord>): UsageRecord => ({
        ts: 0,
        provider: "claude",
        model: "claude-opus-4-8",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        ...over,
    });

    it("prices each class separately (opus rates, per 1M)", () => {
        const b = spendBreakdown(
            rec({ inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheCreateTokens: 1e6 })
        );
        expect(b.input).toBeCloseTo(5, 5);
        expect(b.output).toBeCloseTo(25, 5);
        expect(b.cacheRead).toBeCloseTo(0.5, 5);
        expect(b.cacheWrite).toBeCloseTo(6.25, 5); // all 5m (no 1h portion)
    });

    it("splits cache write into 1h vs 5m tiers", () => {
        const b = spendBreakdown(rec({ cacheCreateTokens: 1e6, cacheCreate1hTokens: 1e6 }));
        expect(b.cacheWrite).toBeCloseTo(10, 5); // opus cacheWrite1h
    });

    it("unknown model -> all zero", () => {
        const b = spendBreakdown(rec({ model: "mystery", inputTokens: 1e6 }));
        expect(b).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    });

    it("spendOf equals the sum of the breakdown", () => {
        const r = rec({ inputTokens: 5e5, outputTokens: 3e5, cacheReadTokens: 9e6, cacheCreateTokens: 2e5 });
        const b = spendBreakdown(r);
        expect(spendOf(r)).toBeCloseTo(b.input + b.output + b.cacheRead + b.cacheWrite, 9);
    });
});
