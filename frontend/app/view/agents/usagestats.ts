// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure usage aggregation for the Usage surface. Folds the backend's per-(provider, model, day)
// usage buckets (from GetUsageStatsCommand) into today/week + per-provider per-model totals
// (aggregateBuckets). Spend is computed from token counts via usagepricing. Pure module — no React
// or Wave runtime imports, unit-tested in isolation.

import { spendBreakdown } from "./usagepricing";

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
    pct: number; // share of the provider's window tokens
    spendUsd: number;
}

export interface ProviderUsage {
    provider: string;
    tokens: number; // window tokens (was tokensWeek; now window-scoped)
    models: ModelUsage[]; // desc by tokens
}

export type TokenClass = "input" | "output" | "cacheRead" | "cacheWrite";

export interface ClassUsage {
    cls: TokenClass;
    label: string;
    tokens: number;
    spendUsd: number;
}

export interface DailyUsage {
    day: string; // "YYYY-MM-DD"
    claudeTokens: number;
    codexTokens: number;
    claudeSpendUsd: number;
    codexSpendUsd: number;
}

export interface UsageStats {
    totals: {
        tokensToday: number;
        tokensWeek: number;
        spendTodayUsd: number;
        spendWeekUsd: number;
        // whole-loaded-window aggregates (all-time when the loader asks for windowdays=0); the card
        // row swaps to these under the All-time toggle. claude/codex split mirrors the today card.
        tokensWindow: number;
        spendWindowUsd: number;
        claudeTokensWindow: number;
        codexTokensWindow: number;
        activeDays: number; // distinct days with any usage in the window
        busiestDay: string | null; // "YYYY-MM-DD" of the day with the most tokens
        busiestTokens: number;
    };
    split: ClassUsage[]; // all providers, the window, fixed order [cacheRead, output, cacheWrite, input]
    daily: DailyUsage[]; // ascending; zero-filled idle days; capped to last 30 in range
    dailyTruncated: boolean; // true when the day range exceeded the cap
    providers: ProviderUsage[]; // window-scoped by-model, claude-first
}

// Mirrors agentsviewmodel's module-local PROVIDER_RANK (claude-first). Kept local to keep this a
// self-contained pure module rather than coupling it to the large view-model file.
const PROVIDER_RANK: Record<string, number> = { claude: 0, codex: 1 };

const DAY_MS = 24 * 60 * 60 * 1000;

const MAX_DAILY_DAYS = 30;
export const CLASS_ORDER: TokenClass[] = ["cacheRead", "output", "cacheWrite", "input"];
export const CLASS_LABEL: Record<TokenClass, string> = {
    cacheRead: "Cache read",
    output: "Output",
    cacheWrite: "Cache write",
    input: "Input",
};

function localDayKey(ms: number): string {
    const d = new Date(ms);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
}

// Inclusive list of local day-keys from startKey to endKey ("YYYY-MM-DD" sorts chronologically).
// Iterates via a local Date so month/DST rollovers are handled; bounded so a bad range can't spin.
function enumerateDays(startKey: string, endKey: string): string[] {
    const [y, m, d] = startKey.split("-").map(Number);
    const cur = new Date(y, m - 1, d);
    const days: string[] = [];
    for (let i = 0; i < 3650 && localDayKey(cur.getTime()) <= endKey; i++) {
        days.push(localDayKey(cur.getTime()));
        cur.setDate(cur.getDate() + 1);
    }
    return days;
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

// Fold backend buckets into the surface's UsageStats. today/week totals stay date-filtered
// (today = current local day; week = rolling 7); the window totals, split, daily series, and
// per-model breakdown fold the WHOLE loaded window (the window is chosen by the loader's windowdays).
export function aggregateBuckets(buckets: UsageBucket[], now: number): UsageStats {
    const today = localDayKey(now);
    const weekStart = localDayKey(now - 6 * DAY_MS);
    let tokensToday = 0;
    let tokensWeek = 0;
    let spendTodayUsd = 0;
    let spendWeekUsd = 0;
    let tokensWindow = 0;
    let spendWindowUsd = 0;
    let claudeTokensWindow = 0;
    let codexTokensWindow = 0;
    const dayTotal = new Map<string, number>(); // all-provider tokens per day, for activeDays/busiest

    const classTok: Record<TokenClass, number> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const classSpd: Record<TokenClass, number> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const byDay = new Map<string, { ct: number; xt: number; cs: number; xs: number }>();
    const byProvider = new Map<string, Map<string, { tokens: number; spend: number }>>();
    let minDay: string | null = null;
    let maxDay: string | null = null;

    for (const b of buckets) {
        const tk = bucketTokens(b);
        const sb = spendBreakdown(bucketAsRecord(b));
        const sp = sb.input + sb.output + sb.cacheRead + sb.cacheWrite;

        // token-class split (all providers, window)
        classTok.input += b.input;
        classTok.output += b.output;
        classTok.cacheRead += b.cacheread;
        classTok.cacheWrite += b.cachecreate;
        classSpd.input += sb.input;
        classSpd.output += sb.output;
        classSpd.cacheRead += sb.cacheRead;
        classSpd.cacheWrite += sb.cacheWrite;

        // daily series (window), keyed claude vs codex
        const day = byDay.get(b.day) ?? { ct: 0, xt: 0, cs: 0, xs: 0 };
        if (b.provider === "codex") {
            day.xt += tk;
            day.xs += sp;
        } else if (b.provider === "claude") {
            day.ct += tk;
            day.cs += sp;
        }
        byDay.set(b.day, day);
        if (minDay == null || b.day < minDay) minDay = b.day;
        if (maxDay == null || b.day > maxDay) maxDay = b.day;

        // by-model (window)
        let models = byProvider.get(b.provider);
        if (!models) {
            models = new Map();
            byProvider.set(b.provider, models);
        }
        const cur = models.get(b.model) ?? { tokens: 0, spend: 0 };
        cur.tokens += tk;
        cur.spend += sp;
        models.set(b.model, cur);

        // totals (date-filtered)
        if (b.day >= weekStart) {
            tokensWeek += tk;
            spendWeekUsd += sp;
        }
        if (b.day === today) {
            tokensToday += tk;
            spendTodayUsd += sp;
        }

        // window totals (whole loaded range, all providers)
        tokensWindow += tk;
        spendWindowUsd += sp;
        if (b.provider === "codex") {
            codexTokensWindow += tk;
        } else if (b.provider === "claude") {
            claudeTokensWindow += tk;
        }
        dayTotal.set(b.day, (dayTotal.get(b.day) ?? 0) + tk);
    }

    let activeDays = 0;
    let busiestDay: string | null = null;
    let busiestTokens = 0;
    for (const [day, tokens] of dayTotal) {
        if (tokens > 0) {
            activeDays++;
        }
        if (tokens > busiestTokens) {
            busiestTokens = tokens;
            busiestDay = day;
        }
    }

    const split: ClassUsage[] = CLASS_ORDER.map((cls) => ({
        cls,
        label: CLASS_LABEL[cls],
        tokens: classTok[cls],
        spendUsd: classSpd[cls],
    }));

    let daily: DailyUsage[] = [];
    let dailyTruncated = false;
    if (minDay != null) {
        const endKey = maxDay != null && maxDay > today ? maxDay : today;
        let dayKeys = enumerateDays(minDay, endKey);
        if (dayKeys.length > MAX_DAILY_DAYS) {
            dailyTruncated = true;
            dayKeys = dayKeys.slice(-MAX_DAILY_DAYS);
        }
        daily = dayKeys.map((day) => {
            const e = byDay.get(day) ?? { ct: 0, xt: 0, cs: 0, xs: 0 };
            return { day, claudeTokens: e.ct, codexTokens: e.xt, claudeSpendUsd: e.cs, codexSpendUsd: e.xs };
        });
    }

    const providers: ProviderUsage[] = [...byProvider.entries()]
        .map(([provider, models]) => {
            const tokens = [...models.values()].reduce((s, m) => s + m.tokens, 0);
            const modelUsages: ModelUsage[] = [...models.entries()]
                .map(([model, v]) => ({
                    model,
                    tokens: v.tokens,
                    spendUsd: v.spend,
                    pct: tokens > 0 ? (v.tokens / tokens) * 100 : 0,
                }))
                .sort((a, b) => b.tokens - a.tokens);
            return { provider, tokens, models: modelUsages };
        })
        .sort((a, b) => (PROVIDER_RANK[a.provider] ?? 99) - (PROVIDER_RANK[b.provider] ?? 99));

    return {
        totals: {
            tokensToday,
            tokensWeek,
            spendTodayUsd,
            spendWeekUsd,
            tokensWindow,
            spendWindowUsd,
            claudeTokensWindow,
            codexTokensWindow,
            activeDays,
            busiestDay,
            busiestTokens,
        },
        split,
        daily,
        dailyTruncated,
        providers,
    };
}

// Pure: the model-usage grid class. A single provider fills the full row (dropping lg:grid-cols-2, which
// otherwise leaves a lone card at half width with dead space beside it); two or more split into two
// columns on lg. Kept here so the layout decision is declarative and testable.
export function modelGridClass(providerCount: number): string {
    const base = "grid grid-cols-1 gap-[14px]";
    return providerCount <= 1 ? base : `${base} lg:grid-cols-2`;
}
