// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: a run's tokens from the engine's usage rows (one per session and model, RunUsageCommand). Tokens only;
// every class counted once, as jarvis.UsageTokens counts them.

import { formatTokens } from "./agentsviewmodel";
import { shortModel } from "./modelname";

export interface UsageSummary {
    total: number;
    // the share of the total that was cache reads, which dominate a long session and cost a tenth of input
    cachedPct: number;
    // largest first
    byModel: { model: string; tokens: number }[];
    // sessions whose transcript could not be read, so the total leaves them out
    missing: number;
}

export function usageTokens(r: UsageRow): number {
    return r.input + r.output + r.cacheread + r.cachewrite + r.cachewrite1h;
}

// summarizeUsage totals a run's rows, or one task's (its worker and reviewer) when taskId is given; null when
// nothing was spent yet.
export function summarizeUsage(rows: UsageRow[] | undefined, taskId?: string): UsageSummary | null {
    const picked = (rows ?? []).filter((r) => taskId == null || r.taskid === taskId);
    const byModel = new Map<string, number>();
    let total = 0;
    let cached = 0;
    let missing = 0;
    for (const r of picked) {
        if (r.missing) {
            missing++;
            continue;
        }
        const tokens = usageTokens(r);
        total += tokens;
        cached += r.cacheread;
        const model = shortModel(r.model);
        byModel.set(model, (byModel.get(model) ?? 0) + tokens);
    }
    if (total === 0) {
        return null;
    }
    return {
        total,
        cachedPct: Math.round((cached * 100) / total),
        byModel: [...byModel]
            .filter(([, tokens]) => tokens > 0)
            .map(([model, tokens]) => ({ model, tokens }))
            .sort((a, b) => b.tokens - a.tokens),
        missing,
    };
}

// usageText is "12.4M tok · 88% cached". Unreadable sessions are named only once the total is sealed: on a live
// run a worker that has not written its transcript yet reads as missing too.
export function usageText(s: UsageSummary, sealed: boolean): string {
    const parts = [`${formatTokens(s.total)} tok`, `${s.cachedPct}% cached`];
    if (sealed && s.missing > 0) {
        parts.push(`${s.missing} unreadable`);
    }
    return parts.join(" · ");
}

// modelsText is "opus-5-5 9.1M · sonnet-5-5 3.3M"
export function modelsText(s: UsageSummary): string {
    return s.byModel.map((m) => `${m.model} ${formatTokens(m.tokens)}`).join(" · ");
}
