// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure usage aggregation for the Usage surface. Parses per-message token usage out of agent
// transcript JSONL (extractUsage) and folds it into today/week + per-provider per-model totals
// (aggregateUsage). Spend is a client-side estimate from a static pricing table. No React, no
// Wave runtime imports — unit-tested in isolation.

export const USAGE_WINDOW_DAYS = 7;

export interface UsageRecord {
    ts: number; // epoch ms
    provider: string; // "claude" | "codex"
    model: string; // raw model id
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
}

export interface ModelUsage {
    model: string;
    tokens: number;
    pct: number; // share of the provider's week tokens
    spendUsd: number;
}

export interface ProviderUsage {
    provider: string;
    tokensWeek: number;
    models: ModelUsage[]; // desc by tokens
}

export interface UsageStats {
    totals: { tokensToday: number; tokensWeek: number; spendTodayUsd: number; spendWeekUsd: number };
    providers: ProviderUsage[]; // claude-first
}

// $ per million tokens. Client-side ESTIMATE (like Claude Code's own cost figure); refresh as plans
// change. Unknown models price at 0 (tokens still counted; spend under-reports rather than guesses).
interface ModelPrice {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}
const PRICING: Record<string, ModelPrice> = {
    opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    haiku: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1.0 },
};

function priceFor(model: string): ModelPrice | undefined {
    const m = model.toLowerCase();
    if (m.includes("opus")) return PRICING.opus;
    if (m.includes("sonnet")) return PRICING.sonnet;
    if (m.includes("haiku")) return PRICING.haiku;
    return undefined;
}

export function tokensOf(r: UsageRecord): number {
    return r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreateTokens;
}

export function spendOf(r: UsageRecord): number {
    const p = priceFor(r.model);
    if (!p) {
        return 0;
    }
    return (
        (r.inputTokens * p.input +
            r.outputTokens * p.output +
            r.cacheReadTokens * p.cacheRead +
            r.cacheCreateTokens * p.cacheWrite) /
        1_000_000
    );
}

// Parse per-message token usage from raw transcript JSONL lines. Claude Code writes one assistant
// entry per turn with message.model + message.usage. Codex uses a different shape (no type:"assistant"
// with usage), so codex lines yield nothing here — deferred (see docs/deferred.md). Tolerant of
// malformed lines and missing fields, like the Activity event projector.
export function extractUsage(lines: string[], provider: string): UsageRecord[] {
    const out: UsageRecord[] = [];
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        if (rec?.type !== "assistant") {
            continue;
        }
        const msg = rec.message;
        const usage = msg?.usage;
        const model = msg?.model;
        const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
        if (!usage || typeof model !== "string" || Number.isNaN(ts)) {
            continue;
        }
        out.push({
            ts,
            provider,
            model,
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheCreateTokens: usage.cache_creation_input_tokens ?? 0,
        });
    }
    return out;
}

// Mirrors agentsviewmodel's module-local PROVIDER_RANK (claude-first). Kept local to keep this a
// self-contained pure module rather than coupling it to the large view-model file.
const PROVIDER_RANK: Record<string, number> = { claude: 0, codex: 1 };

function startOfLocalDay(now: number): number {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

// Fold records into today/week totals + per-provider per-model breakdown. The 7-day window is
// enforced here on the parsed message ts (not on file modtime, which is unit-agnostic).
export function aggregateUsage(records: UsageRecord[], now: number): UsageStats {
    const dayStart = startOfLocalDay(now);
    const weekStart = now - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    let tokensToday = 0;
    let tokensWeek = 0;
    let spendTodayUsd = 0;
    let spendWeekUsd = 0;
    const byProvider = new Map<string, Map<string, { tokens: number; spend: number }>>();
    for (const r of records) {
        if (r.ts < weekStart) {
            continue;
        }
        const tk = tokensOf(r);
        const sp = spendOf(r);
        tokensWeek += tk;
        spendWeekUsd += sp;
        if (r.ts >= dayStart) {
            tokensToday += tk;
            spendTodayUsd += sp;
        }
        let models = byProvider.get(r.provider);
        if (!models) {
            models = new Map();
            byProvider.set(r.provider, models);
        }
        const cur = models.get(r.model) ?? { tokens: 0, spend: 0 };
        cur.tokens += tk;
        cur.spend += sp;
        models.set(r.model, cur);
    }
    const providers: ProviderUsage[] = [...byProvider.entries()]
        .map(([provider, models]) => {
            const tokensWeekP = [...models.values()].reduce((s, m) => s + m.tokens, 0);
            const modelUsages: ModelUsage[] = [...models.entries()]
                .map(([model, v]) => ({
                    model,
                    tokens: v.tokens,
                    spendUsd: v.spend,
                    pct: tokensWeekP > 0 ? (v.tokens / tokensWeekP) * 100 : 0,
                }))
                .sort((a, b) => b.tokens - a.tokens);
            return { provider, tokensWeek: tokensWeekP, models: modelUsages };
        })
        .sort((a, b) => (PROVIDER_RANK[a.provider] ?? 99) - (PROVIDER_RANK[b.provider] ?? 99));
    return { totals: { tokensToday, tokensWeek, spendTodayUsd, spendWeekUsd }, providers };
}
