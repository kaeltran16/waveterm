// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure usage aggregation for the Usage surface. Parses per-message token usage out of agent
// transcript JSONL (extractUsage) and folds it into today/week + per-provider per-model totals
// (aggregateUsage). Spend is computed from token counts via usagepricing. Pure module — no React or
// Wave runtime imports, unit-tested in isolation.

import { spendOf } from "./usagepricing";

export const USAGE_WINDOW_DAYS = 7;

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

export function tokensOf(r: UsageRecord): number {
    return r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreateTokens;
}

// Parse per-message token usage from raw transcript JSONL lines. Claude Code writes one assistant
// entry per turn with message.model + message.usage. Codex uses a different shape (no type:"assistant"
// with usage), so codex lines yield nothing here — see extractCodexUsage for those. Tolerant of
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
        const id =
            typeof msg.id === "string" && typeof rec.requestId === "string"
                ? `${msg.id}:${rec.requestId}`
                : undefined;
        out.push({
            id,
            ts,
            provider,
            model,
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheCreateTokens: usage.cache_creation_input_tokens ?? 0,
            cacheCreate1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        });
    }
    return out;
}

// Codex transcripts (~/.codex/sessions/**/rollout-*.jsonl) use a different shape: token usage is in
// event_msg lines (payload.type "token_count") as a CUMULATIVE total_token_usage that grows
// monotonically over the session, and the model id lives on a preceding turn_context line (not on the
// token_count event). Summing per-turn last_token_usage over-counts, so we take the max cumulative —
// Codex's own authoritative session total. cached_input_tokens is a SUBSET of input_tokens (unlike
// Claude's separate buckets), so we map input = input - cached to keep tokensOf == total_tokens.
// One record per session file (no cross-file history copy, so no dedup key needed).
export function extractCodexUsage(lines: string[]): UsageRecord[] {
    let model = "codex";
    let best: { total: number; tu: any; ts: number; model: string } | undefined;
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        if (rec?.type === "turn_context") {
            const m = rec.payload?.model;
            if (typeof m === "string" && m) {
                model = m;
            }
            continue;
        }
        if (rec?.type !== "event_msg" || rec.payload?.type !== "token_count") {
            continue;
        }
        const tu = rec.payload.info?.total_token_usage;
        const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
        if (!tu || Number.isNaN(ts)) {
            continue;
        }
        const total = typeof tu.total_tokens === "number" ? tu.total_tokens : (tu.input_tokens ?? 0) + (tu.output_tokens ?? 0);
        if (!best || total > best.total) {
            best = { total, tu, ts, model };
        }
    }
    if (!best) {
        return [];
    }
    const input = best.tu.input_tokens ?? 0;
    const cached = best.tu.cached_input_tokens ?? 0;
    return [
        {
            ts: best.ts,
            provider: "codex",
            model: best.model,
            inputTokens: Math.max(0, input - cached),
            outputTokens: best.tu.output_tokens ?? 0,
            cacheReadTokens: cached,
            cacheCreateTokens: 0,
        },
    ];
}

// Claude Code writes the SAME logical request to the JSONL more than once: streaming snapshots that
// share message.id+requestId with a growing output_tokens, and the full prior history re-copied into
// a new file when a session is resumed/compacted. Summing every line double-counts (measured ~68% on
// real data). Mirror ccusage: collapse each message.id:requestId to one record — the largest
// output_tokens is the final/complete snapshot (input/cache are constant across snapshots). Records
// without a key (older lines, codex) can't be deduped, so they pass through untouched.
export function dedupeUsage(records: UsageRecord[]): UsageRecord[] {
    const byKey = new Map<string, UsageRecord>();
    const keyless: UsageRecord[] = [];
    for (const r of records) {
        if (!r.id) {
            keyless.push(r);
            continue;
        }
        const cur = byKey.get(r.id);
        if (!cur || r.outputTokens > cur.outputTokens) {
            byKey.set(r.id, r);
        }
    }
    return [...keyless, ...byKey.values()];
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
    for (const r of dedupeUsage(records)) {
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
