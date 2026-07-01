// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Single source of truth for usage cost. Per-million-token prices for the model families seen in
// agent transcripts, bundled offline (the cockpit makes no network call for pricing). Sourced from
// the Claude pricing reference + OpenAI Codex rate card, 2026-07; current-generation pricing. Cost
// is a client-side ESTIMATE — no costUSD is persisted in Claude/Codex transcripts.
//
// Family-substring pricing loses the model version, so a historical Claude-Opus-4.0 transcript
// (which billed $15/$75) is priced at the current Opus tier ($5/$25). Acceptable: the cockpit's
// spend is an estimate and the bulk of real data is current-generation. Refresh when plans change.

import type { UsageRecord } from "./usagestats";

export interface ModelPrice {
    input: number; // $ per 1M tokens
    output: number;
    cacheRead: number;
    cacheWrite5m: number; // Anthropic 5-minute (default) cache write; OpenAI families: 0 (no cache-write charge)
    cacheWrite1h: number; // Anthropic 1-hour extended cache write (2x base input)
}

// Family -> price. OpenAI families don't bill cache writes (cacheWrite* = 0); Codex records carry
// cacheCreateTokens = 0 anyway. codex-auto-review and similar aliases fall under the codex family.
const MODEL_PRICES: Record<string, ModelPrice> = {
    fable: { input: 10, output: 50, cacheRead: 1.0, cacheWrite5m: 12.5, cacheWrite1h: 20 },
    opus: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
    haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
    "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite5m: 0, cacheWrite1h: 0 },
    codex: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 0, cacheWrite1h: 0 },
    "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 0, cacheWrite1h: 0 },
};

// Family substring match. Order matters: gpt-5.5 before the gpt-5 base, and codex before gpt-5 (a
// codex alias like "codex-auto-review" has no gpt-5 substring). Unknown -> undefined (spend 0).
export function priceFor(model: string): ModelPrice | undefined {
    const m = model.toLowerCase();
    if (m.includes("fable")) return MODEL_PRICES.fable;
    if (m.includes("opus")) return MODEL_PRICES.opus;
    if (m.includes("sonnet")) return MODEL_PRICES.sonnet;
    if (m.includes("haiku")) return MODEL_PRICES.haiku;
    if (m.includes("gpt-5.5")) return MODEL_PRICES["gpt-5.5"];
    if (m.includes("codex")) return MODEL_PRICES.codex;
    if (m.includes("gpt-5")) return MODEL_PRICES["gpt-5"];
    return undefined;
}

export interface SpendBreakdown {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number; // 1h + 5m cache-write tiers folded together
}

// Client-side cost estimate, broken out per token class. Cache writes split into 1h (extended) vs
// 5m (default) tiers internally; the 1h portion is a subset of cacheCreateTokens, the remainder 5m.
// Unknown models price at 0 (tokens still counted elsewhere; spend under-reports rather than guesses).
export function spendBreakdown(r: UsageRecord): SpendBreakdown {
    const p = priceFor(r.model);
    if (!p) {
        return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    }
    const cache1h = r.cacheCreate1hTokens ?? 0;
    const cache5m = Math.max(0, r.cacheCreateTokens - cache1h);
    return {
        input: (r.inputTokens * p.input) / 1_000_000,
        output: (r.outputTokens * p.output) / 1_000_000,
        cacheRead: (r.cacheReadTokens * p.cacheRead) / 1_000_000,
        cacheWrite: (cache5m * p.cacheWrite5m + cache1h * p.cacheWrite1h) / 1_000_000,
    };
}

// Total client-side cost estimate (sum of the per-class breakdown).
export function spendOf(r: UsageRecord): number {
    const b = spendBreakdown(r);
    return b.input + b.output + b.cacheRead + b.cacheWrite;
}
