// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure per-session usage aggregation. Folds one transcript's backend buckets
// (GetTranscriptUsageCommand) into a per-class split + per-model breakdown + a derived insight.
// Spend is priced via usagepricing (single source of truth). No React/runtime imports; unit-tested.

import { spendBreakdown } from "./usagepricing";
import { CLASS_LABEL, CLASS_ORDER, type ClassUsage, type TokenClass } from "./usagestats";

export interface SessionModelUsage {
    model: string; // raw id; labelled via prettyModel at render
    tokens: number;
    spendUsd: number;
    classes: Record<TokenClass, number>; // per-class tokens (for the mini stacked bar)
}

export interface SessionInsight {
    readTokPct: number; // cache-read share of tokens
    readCostPct: number; // cache-read share of spend
    topCostClass: TokenClass; // class with the largest spend share
}

export interface SessionUsage {
    totalTokens: number;
    totalSpendUsd: number;
    classes: ClassUsage[]; // fixed CLASS_ORDER
    models: SessionModelUsage[]; // desc by tokens
    insight: SessionInsight | null; // null when the session has no tokens
}

function zeroClasses(): Record<TokenClass, number> {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function aggregateSessionUsage(buckets: UsageBucket[]): SessionUsage {
    const tok = zeroClasses();
    const spd = zeroClasses();
    const byModel = new Map<string, { tokens: number; spend: number; classes: Record<TokenClass, number> }>();

    for (const b of buckets) {
        const sb = spendBreakdown({
            ts: 0,
            provider: b.provider,
            model: b.model,
            inputTokens: b.input,
            outputTokens: b.output,
            cacheReadTokens: b.cacheread,
            cacheCreateTokens: b.cachecreate,
            cacheCreate1hTokens: b.cachecreate1h,
        });
        tok.input += b.input;
        tok.output += b.output;
        tok.cacheRead += b.cacheread;
        tok.cacheWrite += b.cachecreate;
        spd.input += sb.input;
        spd.output += sb.output;
        spd.cacheRead += sb.cacheRead;
        spd.cacheWrite += sb.cacheWrite;

        const m = byModel.get(b.model) ?? { tokens: 0, spend: 0, classes: zeroClasses() };
        m.tokens += b.input + b.output + b.cacheread + b.cachecreate;
        m.spend += sb.input + sb.output + sb.cacheRead + sb.cacheWrite;
        m.classes.input += b.input;
        m.classes.output += b.output;
        m.classes.cacheRead += b.cacheread;
        m.classes.cacheWrite += b.cachecreate;
        byModel.set(b.model, m);
    }

    const totalTokens = tok.input + tok.output + tok.cacheRead + tok.cacheWrite;
    const totalSpendUsd = spd.input + spd.output + spd.cacheRead + spd.cacheWrite;

    const classes: ClassUsage[] = CLASS_ORDER.map((cls) => ({
        cls,
        label: CLASS_LABEL[cls],
        tokens: tok[cls],
        spendUsd: spd[cls],
    }));

    const models: SessionModelUsage[] = [...byModel.entries()]
        .map(([model, v]) => ({ model, tokens: v.tokens, spendUsd: v.spend, classes: v.classes }))
        .sort((a, b) => b.tokens - a.tokens);

    let insight: SessionInsight | null = null;
    if (totalTokens > 0) {
        const topCostClass = CLASS_ORDER.reduce((top, c) => (spd[c] > spd[top] ? c : top), CLASS_ORDER[0]);
        insight = {
            readTokPct: (tok.cacheRead / totalTokens) * 100,
            readCostPct: totalSpendUsd > 0 ? (spd.cacheRead / totalSpendUsd) * 100 : 0,
            topCostClass,
        };
    }

    return { totalTokens, totalSpendUsd, classes, models, insight };
}
