// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Single source of truth for usage cost. Per-million-token prices for the model families seen in
// agent transcripts, bundled offline (the cockpit makes no network call for pricing). Sourced from
// the Claude pricing reference + OpenAI Codex rate card, 2026-07; the OpenCode Go curated lineup
// (opencode.ai/docs/go) + DeepSeek API docs, 2026-08; current-generation pricing. Go's rate card
// is flat per tier; tiered models (gpt-5.6-luna, qwen3.7/3.6-plus) are priced at their lower
// (≤272K/≤256K) tier, which covers typical agent traffic. DeepSeek has announced a price increase
// ("significant") — refresh the deepseek rows when it lands. Cost is a client-side ESTIMATE — no
// costUSD is persisted in Claude/Codex transcripts.
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
    "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite5m: 0.25, cacheWrite1h: 0 },
    "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite5m: 0, cacheWrite1h: 0 },
    codex: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 0, cacheWrite1h: 0 },
    "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 0, cacheWrite1h: 0 },
    "grok-4.5": { input: 2, output: 6, cacheRead: 0.3, cacheWrite5m: 0, cacheWrite1h: 0 },
    "glm-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite5m: 0, cacheWrite1h: 0 },
    "glm-5.1": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite5m: 0, cacheWrite1h: 0 },
    "kimi-k3": { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 0, cacheWrite1h: 0 },
    "kimi-k2.7-code": { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite5m: 0, cacheWrite1h: 0 },
    "kimi-k2.6": { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite5m: 0, cacheWrite1h: 0 },
    "mimo-v2.5-pro": { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite5m: 0, cacheWrite1h: 0 },
    "mimo-v2.5": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite5m: 0, cacheWrite1h: 0 },
    "minimax-m3": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite5m: 0, cacheWrite1h: 0 },
    "minimax-m2.7": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite5m: 0.375, cacheWrite1h: 0 },
    "minimax-m2.5": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite5m: 0.375, cacheWrite1h: 0 },
    "qwen3.8-max": { input: 2, output: 6, cacheRead: 0.25, cacheWrite5m: 2.5, cacheWrite1h: 0 },
    "qwen3.7-max": { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite5m: 3.125, cacheWrite1h: 0 },
    "qwen3.7-plus": { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite5m: 0.5, cacheWrite1h: 0 },
    "qwen3.6-plus": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 0 },
    "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite5m: 0, cacheWrite1h: 0 },
    "deepseek-v4-pro": { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite5m: 0, cacheWrite1h: 0 },
    hy3: { input: 0.14, output: 0.58, cacheRead: 0.035, cacheWrite5m: 0, cacheWrite1h: 0 },
};

// Family substring match. Order matters: gpt-5.6-luna before the gpt-5.5/gpt-5 bases (it contains
// "gpt-5"), gpt-5.5 before the gpt-5 base, codex before gpt-5 (a codex alias like "codex-auto-review"
// has no gpt-5 substring), and mimo-v2.5-pro before the mimo-v2.5 base. Unknown -> undefined (spend 0).
export function priceFor(model: string): ModelPrice | undefined {
    const m = model.toLowerCase();
    if (m.includes("fable")) return MODEL_PRICES.fable;
    if (m.includes("opus")) return MODEL_PRICES.opus;
    if (m.includes("sonnet")) return MODEL_PRICES.sonnet;
    if (m.includes("haiku")) return MODEL_PRICES.haiku;
    if (m.includes("gpt-5.6-luna")) return MODEL_PRICES["gpt-5.6-luna"];
    if (m.includes("gpt-5.5")) return MODEL_PRICES["gpt-5.5"];
    if (m.includes("codex")) return MODEL_PRICES.codex;
    if (m.includes("gpt-5")) return MODEL_PRICES["gpt-5"];
    if (m.includes("grok-4.5")) return MODEL_PRICES["grok-4.5"];
    if (m.includes("glm-5.2")) return MODEL_PRICES["glm-5.2"];
    if (m.includes("glm-5.1")) return MODEL_PRICES["glm-5.1"];
    if (m.includes("kimi-k3")) return MODEL_PRICES["kimi-k3"];
    if (m.includes("kimi-k2.7-code")) return MODEL_PRICES["kimi-k2.7-code"];
    if (m.includes("kimi-k2.6")) return MODEL_PRICES["kimi-k2.6"];
    if (m.includes("mimo-v2.5-pro")) return MODEL_PRICES["mimo-v2.5-pro"];
    if (m.includes("mimo-v2.5")) return MODEL_PRICES["mimo-v2.5"];
    if (m.includes("minimax-m3")) return MODEL_PRICES["minimax-m3"];
    if (m.includes("minimax-m2.7")) return MODEL_PRICES["minimax-m2.7"];
    if (m.includes("minimax-m2.5")) return MODEL_PRICES["minimax-m2.5"];
    if (m.includes("qwen3.8-max")) return MODEL_PRICES["qwen3.8-max"];
    if (m.includes("qwen3.7-max")) return MODEL_PRICES["qwen3.7-max"];
    if (m.includes("qwen3.7-plus")) return MODEL_PRICES["qwen3.7-plus"];
    if (m.includes("qwen3.6-plus")) return MODEL_PRICES["qwen3.6-plus"];
    if (m.includes("deepseek-v4-flash")) return MODEL_PRICES["deepseek-v4-flash"];
    if (m.includes("deepseek-v4-pro")) return MODEL_PRICES["deepseek-v4-pro"];
    if (m.includes("hy3")) return MODEL_PRICES.hy3;
    return undefined;
}

export interface SpendBreakdown {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number; // 1h + 5m cache-write tiers folded together
}

// Client-side cost estimate, broken out per token class. Cache writes split into 1h (extended) vs
// 5m (default) tiers internally; the 1h portion is a subset of cacheCreateTokens, the remainder 5m.
// Reasoning tokens bill at the model's output rate. Unknown models price at 0 (tokens still counted
// elsewhere; spend under-reports rather than guesses).
export function spendBreakdown(r: UsageRecord): SpendBreakdown {
    const p = priceFor(r.model);
    if (!p) {
        return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    }
    const cache1h = r.cacheCreate1hTokens ?? 0;
    const cache5m = Math.max(0, r.cacheCreateTokens - cache1h);
    return {
        input: (r.inputTokens * p.input) / 1_000_000,
        output: (r.outputTokens * p.output) / 1_000_000,
        reasoning: (r.reasoningTokens * p.output) / 1_000_000,
        cacheRead: (r.cacheReadTokens * p.cacheRead) / 1_000_000,
        cacheWrite: (cache5m * p.cacheWrite5m + cache1h * p.cacheWrite1h) / 1_000_000,
    };
}

// Total client-side cost estimate (sum of the per-class breakdown).
export function spendOf(r: UsageRecord): number {
    const b = spendBreakdown(r);
    return b.input + b.output + b.reasoning + b.cacheRead + b.cacheWrite;
}
