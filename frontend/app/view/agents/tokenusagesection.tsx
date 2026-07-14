// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// "Token usage" rail section for the focused agent: per-class split (tokens + ≈ spend) and a
// per-model breakdown, from the session's own transcript (transcriptusagestore/sessionusage).
// Class colors mirror usagesurface.tsx's CLASS_COLOR (theme tokens only). Spend is an estimate.

import { SkeletonLine } from "@/app/element/skeleton";
import { useAtomValue } from "jotai";
import { prettyModel } from "./modellabel";
import { sessionUsageAtom } from "./transcriptusagestore";
import type { TokenClass } from "./usagestats";

const CLASS_COLOR: Record<TokenClass, string> = {
    cacheRead: "var(--color-cacheread)",
    output: "var(--color-accent)",
    cacheWrite: "var(--color-warning)",
    input: "var(--color-success)",
};

function fmt(n: number): string {
    if (n >= 1e9) return +(n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return +(n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "K";
    return String(Math.round(n));
}
function usd(n: number): string {
    if (n >= 1000) return "$" + +(n / 1000).toFixed(1) + "K";
    if (n >= 100) return "$" + Math.round(n);
    return "$" + n.toFixed(2);
}
function pctStr(n: number): string {
    if (n >= 10) return Math.round(n) + "%";
    if (n <= 0) return "0%";
    if (n < 0.1) return "<0.1%";
    return +n.toFixed(1) + "%";
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[.1em] text-ink-mid">{children}</h3>;
}

function StackedBar({ segs, total }: { segs: { cls: TokenClass; value: number }[]; total: number }) {
    const denom = total || 1;
    return (
        <div className="flex h-[11px] overflow-hidden rounded-[5px] bg-surface-hover">
            {segs.map((s) =>
                s.value > 0 ? (
                    <span key={s.cls} style={{ width: `${(s.value / denom) * 100}%`, background: CLASS_COLOR[s.cls] }} />
                ) : null
            )}
        </div>
    );
}

export function TokenUsageSection() {
    const usage = useAtomValue(sessionUsageAtom);

    if (usage == null) {
        return (
            <div>
                <SectionLabel>Token usage</SectionLabel>
                <SkeletonLine className="mt-[12px] h-[24px] w-[120px]" />
                <SkeletonLine className="mt-[12px] h-[11px] w-full rounded-[5px]" />
                <SkeletonLine className="mt-[10px] h-[11px] w-full rounded-[5px]" />
            </div>
        );
    }
    if (usage.totalTokens === 0) {
        return (
            <div>
                <SectionLabel>Token usage</SectionLabel>
                <div className="mt-[10px] text-[11.5px] text-muted">No token usage recorded yet.</div>
            </div>
        );
    }

    const { classes, models, insight, totalTokens, totalSpendUsd } = usage;
    const single = models.length === 1;
    const topLabel = insight ? classes.find((c) => c.cls === insight.topCostClass)?.label ?? "" : "";

    return (
        <div>
            <div className="flex items-baseline justify-between">
                <SectionLabel>Token usage</SectionLabel>
                <span className="font-mono text-[11px] font-semibold text-accent">{fmt(totalTokens)}</span>
            </div>

            {/* headline pair */}
            <div className="mt-[13px] mb-[15px] flex items-end justify-between">
                <div>
                    <div className="font-mono text-[22px] font-bold leading-none text-primary">{fmt(totalTokens)}</div>
                    <div className="mt-[4px] font-mono text-[10px] text-muted">total tokens</div>
                </div>
                <div className="text-right">
                    <div className="font-mono text-[22px] font-bold leading-none text-success">≈ {usd(totalSpendUsd)}</div>
                    <div className="mt-[4px] font-mono text-[10px] text-muted">API-equivalent</div>
                </div>
            </div>

            {/* tokens bar */}
            <div className="mb-[6px] flex items-baseline justify-between">
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-muted">Tokens</span>
                <span className="font-mono text-[11px] text-secondary">{fmt(totalTokens)}</span>
            </div>
            <StackedBar segs={classes.map((c) => ({ cls: c.cls, value: c.tokens }))} total={totalTokens} />

            {/* spend bar */}
            <div className="mb-[6px] mt-[13px] flex items-baseline justify-between">
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-muted">≈ Spend</span>
                <span className="font-mono text-[11px] text-secondary">{usd(totalSpendUsd)}</span>
            </div>
            <StackedBar segs={classes.map((c) => ({ cls: c.cls, value: c.spendUsd }))} total={totalSpendUsd} />

            {/* insight */}
            {insight ? (
                <div className="mt-[13px] flex gap-[8px] rounded-[9px] border border-border bg-surface-raised px-[11px] py-[9px]">
                    <span className="flex-none text-[12px] leading-[1.4] text-warning">◆</span>
                    <p className="text-[11.5px] leading-[1.5] text-secondary">
                        Cache reads are {pctStr(insight.readTokPct)} of tokens but {pctStr(insight.readCostPct)} of spend;{" "}
                        {topLabel.toLowerCase()} drives the cost.
                    </p>
                </div>
            ) : null}

            {/* per-class table */}
            <div className="mt-[14px] flex flex-col">
                {classes.map((c) => (
                    <div
                        key={c.cls}
                        className="flex items-center gap-[9px] border-b border-edge-faint py-[7px] last:border-b-0"
                    >
                        <span className="h-[9px] w-[9px] flex-none rounded-[3px]" style={{ background: CLASS_COLOR[c.cls] }} />
                        <span className="min-w-0 flex-1 text-[12px] text-secondary">{c.label}</span>
                        <span className="w-[52px] text-right font-mono text-[11.5px] text-secondary">{fmt(c.tokens)}</span>
                        <span className="w-[34px] text-right font-mono text-[9.5px] text-muted">
                            {pctStr(totalTokens > 0 ? (c.tokens / totalTokens) * 100 : 0)}
                        </span>
                        <span className="w-[48px] text-right font-mono text-[11.5px] text-muted">{usd(c.spendUsd)}</span>
                    </div>
                ))}
            </div>

            {/* by model */}
            <div className="mb-[11px] mt-[16px] flex items-center gap-[8px]">
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-muted">By model</span>
                <div className="h-px flex-1 bg-edge-faint" />
                <span className="font-mono text-[10px] text-muted">{single ? "1 model" : `${models.length} models`}</span>
            </div>
            <div className="flex flex-col gap-[11px]">
                {models.map((m) => (
                    <div key={m.model}>
                        <div className="mb-[6px] flex items-center gap-[8px]">
                            <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold text-secondary" title={m.model}>
                                {prettyModel(m.model)}
                            </span>
                            <span className="font-mono text-[11px] text-muted">{fmt(m.tokens)}</span>
                            <span className="w-[48px] text-right font-mono text-[11px] text-muted">{usd(m.spendUsd)}</span>
                        </div>
                        {single ? null : (
                            <StackedBar
                                segs={(Object.keys(m.classes) as TokenClass[]).map((cls) => ({ cls, value: m.classes[cls] }))}
                                total={m.tokens}
                            />
                        )}
                    </div>
                ))}
            </div>

            <p className="mt-[13px] font-mono text-[10px] leading-[1.5] text-muted">
                Priced per class from a bundled table. Subagents run in separate transcripts — see Subagents.
            </p>
        </div>
    );
}
