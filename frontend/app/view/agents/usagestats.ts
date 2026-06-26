// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure usage aggregation for the Usage surface. Folds the backend's per-(provider, model, day)
// usage buckets (from GetUsageStatsCommand) into today/week + per-provider per-model totals
// (aggregateBuckets). Spend is computed from token counts via usagepricing. Pure module — no React
// or Wave runtime imports, unit-tested in isolation.

import { spendOf } from "./usagepricing";

export interface UsageRecord {
    id?: string; // `${message.id}:${requestId}` dedup key; undefined when either is absent
    ts: number; // epoch ms
    provider: string; // "claude" | "codex"
    model: string; // raw model id
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    cacheCreate1hTokens?: number; // subset of cacheCreateTokens billed at the 1h extended-cache rate (else 5m)
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

// Mirrors agentsviewmodel's module-local PROVIDER_RANK (claude-first). Kept local to keep this a
// self-contained pure module rather than coupling it to the large view-model file.
const PROVIDER_RANK: Record<string, number> = { claude: 0, codex: 1 };

const DAY_MS = 24 * 60 * 60 * 1000;

function localDayKey(ms: number): string {
    const d = new Date(ms);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
}

// Reuse the pricing path by shaping a bucket as a UsageRecord (pricing reads model + token fields).
function bucketAsRecord(b: UsageBucket): UsageRecord {
    return {
        ts: 0,
        provider: b.provider,
        model: b.model,
        inputTokens: b.input,
        outputTokens: b.output,
        cacheReadTokens: b.cacheread,
        cacheCreateTokens: b.cachecreate,
        cacheCreate1hTokens: b.cachecreate1h,
    };
}

function bucketTokens(b: UsageBucket): number {
    return b.input + b.output + b.cacheread + b.cachecreate;
}

// Fold backend buckets into the surface's UsageStats. today = buckets on the local current day;
// week = rolling 7 days (independent of the scan window). The per-model breakdown is over the week.
export function aggregateBuckets(buckets: UsageBucket[], now: number): UsageStats {
    const today = localDayKey(now);
    const weekStart = localDayKey(now - 6 * DAY_MS);
    let tokensToday = 0;
    let tokensWeek = 0;
    let spendTodayUsd = 0;
    let spendWeekUsd = 0;
    const byProvider = new Map<string, Map<string, { tokens: number; spend: number }>>();
    for (const b of buckets) {
        if (b.day < weekStart) {
            continue;
        }
        const tk = bucketTokens(b);
        const sp = spendOf(bucketAsRecord(b));
        tokensWeek += tk;
        spendWeekUsd += sp;
        if (b.day === today) {
            tokensToday += tk;
            spendTodayUsd += sp;
        }
        let models = byProvider.get(b.provider);
        if (!models) {
            models = new Map();
            byProvider.set(b.provider, models);
        }
        const cur = models.get(b.model) ?? { tokens: 0, spend: 0 };
        cur.tokens += tk;
        cur.spend += sp;
        models.set(b.model, cur);
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
