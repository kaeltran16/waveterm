// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure usage aggregation for the Usage surface. Folds the backend's per-(harness, provider, model,
// day) usage buckets (from GetUsageStatsCommand) into today/week, window and per-model totals
// (aggregateBuckets). Spend is computed from token counts via usagepricing. Pure module — no React
// or Wave runtime imports, unit-tested in isolation.

import { priceFor, spendBreakdown, spendOf } from "./usagepricing";

export type HarnessFilter = "all" | string;

export interface UsageRecord {
    id?: string; // `${message.id}:${requestId}` dedup key; undefined when either is absent
    ts: number; // epoch ms
    harness: string; // the application that ran the session ("claude" | "codex" | "opencode" | "pi")
    provider: string; // upstream model provider ("anthropic" | "openai" | ...)
    model: string; // raw model id
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    cacheCreate1hTokens?: number; // subset of cacheCreateTokens billed at the 1h extended-cache rate (else 5m)
}

export type TokenClass = "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite";

export interface ClassUsage {
    cls: TokenClass;
    label: string;
    tokens: number;
    spendUsd: number;
}

export interface DailyHarnessUsage {
    tokens: number;
    spendUsd: number;
}

export interface DailyUsage {
    day: string; // "YYYY-MM-DD"
    byHarness: Record<string, DailyHarnessUsage>;
    byModel: Record<string, DailyHarnessUsage>; // keyed by modelKey
}

// one model's window totals. identity is harness + provider + model: pi's openai-codex/gpt-5.5 and
// codex's openai/gpt-5.5 are two series, never one
export interface ModelSeries {
    key: string;
    harness: string;
    provider: string;
    model: string;
    tokens: number;
    spendUsd: number;
}

export interface UsageStats {
    availableHarnesses: string[];
    totals: {
        tokensToday: number;
        tokensWeek: number;
        spendTodayUsd: number;
        spendWeekUsd: number;
        // whole-loaded-window aggregates (all-time when the loader asks for windowdays=0); the card
        // row swaps to these under the All-time toggle.
        tokensWindow: number;
        spendWindowUsd: number;
        activeDays: number; // distinct days with any usage in the window
        reportedCostWeekUsd: number;
        reportedCostWeekPresent: boolean;
        reportedCostWeekHarnesses: string[];
        reportedCostWindowUsd: number;
        reportedCostWindowPresent: boolean;
        reportedCostWindowHarnesses: string[];
        pricedTokensWeek: number;
        pricedTokensWindow: number;
        pricingCoverageWeekPct: number | null; // priced tokens / all tokens; null when no tokens
        pricingCoverageWindowPct: number | null;
        tokensTodayByHarness: Record<string, number>;
        tokensWindowByHarness: Record<string, number>;
    };
    split: ClassUsage[]; // all providers, the window, fixed CLASS_ORDER
    daily: DailyUsage[]; // ascending; zero-filled idle days; every day in range (the chart brushes it)
    models: ModelSeries[]; // window-scoped; tokens desc then key asc; zero-token models excluded
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const CLASS_ORDER: TokenClass[] = ["cacheRead", "reasoning", "output", "cacheWrite", "input"];
export const CLASS_LABEL: Record<TokenClass, string> = {
    cacheRead: "Cache read",
    reasoning: "Reasoning",
    output: "Output",
    cacheWrite: "Cache write",
    input: "Input",
};

// Tailwind fill utility per token class. Single source of truth — this was previously duplicated
// verbatim in usagesurface.tsx and tokenusagesection.tsx as inline var(--color-*) strings. Same
// existing design-system tokens as before, just named once: --color-cacheread carries the grey
// "low-value, high-volume" read of cache reads, and the other three keep their long-standing pairing.
export const CLASS_FILL: Record<TokenClass, string> = {
    cacheRead: "bg-cacheread",
    reasoning: "bg-accent-300",
    output: "bg-accent",
    cacheWrite: "bg-warning",
    input: "bg-success",
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

// json of the triple: unique (no separator a model id could contain collides) and stable
export function modelKey(harness: string, provider: string, model: string): string {
    return JSON.stringify([harness, provider, model]);
}

// Reuse the pricing path by shaping a bucket as a UsageRecord (pricing reads model + token fields).
function bucketAsRecord(b: UsageBucket): UsageRecord {
    return {
        ts: 0,
        harness: b.harness,
        provider: b.provider,
        model: b.model,
        inputTokens: b.input,
        outputTokens: b.output,
        reasoningTokens: b.reasoning,
        cacheReadTokens: b.cacheread,
        cacheCreateTokens: b.cachecreate,
        cacheCreate1hTokens: b.cachecreate1h,
    };
}

export function bucketTokens(b: UsageBucket): number {
    return b.input + b.output + b.reasoning + b.cacheread + b.cachecreate;
}

export function bucketSpend(b: UsageBucket): number {
    return spendOf(bucketAsRecord(b));
}

// availableHarnesses of the UNFILTERED bucket set, in first-seen order — a filter chip only appears
// when records for it exist in the loaded window, regardless of the current harness filter.
function harnessesOf(buckets: UsageBucket[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const b of buckets) {
        if (!seen.has(b.harness)) {
            seen.add(b.harness);
            out.push(b.harness);
        }
    }
    return out;
}

// Fold backend buckets into the surface's UsageStats. The harness filter is applied once at the top;
// every total, split, daily row, and model series consumes the same filtered list. today/week
// totals stay date-filtered (today = current local day; week = rolling 7); the window totals, split,
// daily series, and per-model breakdown fold the WHOLE loaded window (the window is chosen by the
// loader's windowdays). Reported cost is summed only where a bucket reports it (present zero counts,
// absent does not); API-equivalent spend always comes from the pricing table.
export function aggregateBuckets(buckets: UsageBucket[], now: number, harnessFilter: HarnessFilter = "all"): UsageStats {
    const today = localDayKey(now);
    const weekStart = localDayKey(now - 6 * DAY_MS);
    const availableHarnesses = harnessesOf(buckets);
    const scope = harnessFilter === "all" ? buckets : buckets.filter((b) => b.harness === harnessFilter);

    let tokensToday = 0;
    let tokensWeek = 0;
    let spendTodayUsd = 0;
    let spendWeekUsd = 0;
    let tokensWindow = 0;
    let spendWindowUsd = 0;
    let reportedCostWeekUsd = 0;
    let reportedCostWeekPresent = false;
    let reportedCostWindowUsd = 0;
    let reportedCostWindowPresent = false;
    let allTokensWeek = 0;
    let pricedTokensWeek = 0;
    let pricedTokensWindow = 0;
    const reportedCostWeekHarnesses = new Set<string>();
    const reportedCostWindowHarnesses = new Set<string>();
    const tokensTodayByHarness: Record<string, number> = {};
    const tokensWindowByHarness: Record<string, number> = {};
    const dayTotal = new Map<string, number>(); // all-provider tokens per day, for activeDays

    const classTok: Record<TokenClass, number> = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    const classSpd: Record<TokenClass, number> = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    const byDay = new Map<string, Record<string, DailyHarnessUsage>>();
    const byDayModel = new Map<string, Record<string, DailyHarnessUsage>>();
    const byModel = new Map<string, ModelSeries>();
    let minDay: string | null = null;
    let maxDay: string | null = null;

    for (const b of scope) {
        const tk = bucketTokens(b);
        const sb = spendBreakdown(bucketAsRecord(b));
        const sp = sb.input + sb.output + sb.reasoning + sb.cacheRead + sb.cacheWrite;

        // token-class split (all providers, window)
        classTok.input += b.input;
        classTok.output += b.output;
        classTok.reasoning += b.reasoning;
        classTok.cacheRead += b.cacheread;
        classTok.cacheWrite += b.cachecreate;
        classSpd.input += sb.input;
        classSpd.output += sb.output;
        classSpd.reasoning += sb.reasoning;
        classSpd.cacheRead += sb.cacheRead;
        classSpd.cacheWrite += sb.cacheWrite;

        // daily series (window), keyed by harness
        const day = byDay.get(b.day) ?? {};
        const h = day[b.harness] ?? { tokens: 0, spendUsd: 0 };
        h.tokens += tk;
        h.spendUsd += sp;
        day[b.harness] = h;
        byDay.set(b.day, day);
        if (minDay == null || b.day < minDay) minDay = b.day;
        if (maxDay == null || b.day > maxDay) maxDay = b.day;

        // daily series (window), keyed by model
        const key = modelKey(b.harness, b.provider, b.model);
        const dayModels = byDayModel.get(b.day) ?? {};
        const dm = dayModels[key] ?? { tokens: 0, spendUsd: 0 };
        dm.tokens += tk;
        dm.spendUsd += sp;
        dayModels[key] = dm;
        byDayModel.set(b.day, dayModels);
        const series = byModel.get(key) ?? {
            key,
            harness: b.harness,
            provider: b.provider,
            model: b.model,
            tokens: 0,
            spendUsd: 0,
        };
        series.tokens += tk;
        series.spendUsd += sp;
        byModel.set(key, series);

        const inWeek = b.day >= weekStart;
        if (inWeek) {
            tokensWeek += tk;
            spendWeekUsd += sp;
            allTokensWeek += tk;
            if (priceFor(b.model) != null) pricedTokensWeek += tk;
        }
        if (b.day === today) {
            tokensToday += tk;
            spendTodayUsd += sp;
            tokensTodayByHarness[b.harness] = (tokensTodayByHarness[b.harness] ?? 0) + tk;
        }

        // window totals (whole loaded range, all providers)
        tokensWindow += tk;
        spendWindowUsd += sp;
        if (priceFor(b.model) != null) pricedTokensWindow += tk;
        tokensWindowByHarness[b.harness] = (tokensWindowByHarness[b.harness] ?? 0) + tk;
        dayTotal.set(b.day, (dayTotal.get(b.day) ?? 0) + tk);

        if (b.reportedcostusd !== undefined) {
            if (inWeek) {
                reportedCostWeekPresent = true;
                reportedCostWeekUsd += b.reportedcostusd;
                reportedCostWeekHarnesses.add(b.harness);
            }
            reportedCostWindowPresent = true;
            reportedCostWindowUsd += b.reportedcostusd;
            reportedCostWindowHarnesses.add(b.harness);
        }
    }

    let activeDays = 0;
    for (const tokens of dayTotal.values()) {
        if (tokens > 0) {
            activeDays++;
        }
    }

    const split: ClassUsage[] = CLASS_ORDER.map((cls) => ({
        cls,
        label: CLASS_LABEL[cls],
        tokens: classTok[cls],
        spendUsd: classSpd[cls],
    }));

    let daily: DailyUsage[] = [];
    if (minDay != null) {
        const endKey = maxDay != null && maxDay > today ? maxDay : today;
        daily = enumerateDays(minDay, endKey).map((day) => ({
            day,
            byHarness: byDay.get(day) ?? {},
            byModel: byDayModel.get(day) ?? {},
        }));
    }

    // a failed request's zero-token bucket is no usage; it never yields a legend row
    const models = [...byModel.values()]
        .filter((m) => m.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    return {
        availableHarnesses,
        totals: {
            tokensToday,
            tokensWeek,
            spendTodayUsd,
            spendWeekUsd,
            tokensWindow,
            spendWindowUsd,
            activeDays,
            reportedCostWeekUsd,
            reportedCostWeekPresent,
            reportedCostWeekHarnesses: [...reportedCostWeekHarnesses],
            reportedCostWindowUsd,
            reportedCostWindowPresent,
            reportedCostWindowHarnesses: [...reportedCostWindowHarnesses],
            pricedTokensWeek,
            pricedTokensWindow,
            pricingCoverageWeekPct: allTokensWeek > 0 ? (pricedTokensWeek / allTokensWeek) * 100 : null,
            pricingCoverageWindowPct: tokensWindow > 0 ? (pricedTokensWindow / tokensWindow) * 100 : null,
            tokensTodayByHarness,
            tokensWindowByHarness,
        },
        split,
        daily,
        models,
    };
}

// Compact token/dollar formatters for the usage cards and the Daily chart's axis + tooltip. Denser than
// viewmodel.formatTokens (adds B, rounds large M) to match the redesign's compact cards. They live here
// rather than in usagesurface.tsx so dailychart.tsx can reuse the EXACT same formatters without importing
// the surface — which would be a cycle, and would drag the RPC-backed usagestore into unit tests.
export function fmt(n: number): string {
    if (n >= 1e9) return +(n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return +(n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "K";
    return String(Math.round(n));
}

export function usd(n: number): string {
    if (n >= 1000) return "$" + +(n / 1000).toFixed(1) + "K";
    if (n >= 100) return "$" + Math.round(n);
    return "$" + n.toFixed(2);
}

export function pctStr(n: number): string {
    if (n >= 10) return Math.round(n) + "%";
    if (n < 0.1) return n <= 0 ? "0%" : "<0.1%";
    return +n.toFixed(1) + "%";
}
