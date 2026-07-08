// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Usage surface (handoff redesign: Wave-cockpit-live.dc.html isUsage block). Two trust zones:
// LIVE LIMITS — ephemeral 5h/weekly quota donuts, merged live-over-saved (ratelimitstore) so they
// survive idle; and HISTORICAL — durable token-class split, daily series, and per-model breakdown
// folded from the backend usage scan (usagestore/usagestats), scoped by a 7-day / All-time toggle.
// Loads on mount + a 60s refresh for the current window; a 1s tick keeps reset countdowns current.

import { useDidBecomeTrue } from "@/app/element/motionhooks";
import { SkeletonLine } from "@/app/element/skeleton";
import { MOTION, cardVariants, easeFluidCss } from "@/app/element/motiontokens";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { MotionConfig, motion, useReducedMotion } from "motion/react";
import { type CSSProperties, useEffect, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { formatReset, groupAgents, providerPlanUsage, usageLevel } from "./agentsviewmodel";
import { prettyModel } from "./modellabel";
import { mergeRateLimitWindows, savedRateLimitsAtom, type ProviderDonuts } from "./ratelimitstore";
import { modelGridClass } from "./usagestats";
import type { ClassUsage, DailyUsage, ProviderUsage, TokenClass, UsageStats } from "./usagestats";
import { loadUsage, usageErrorAtom, usageLoadedAtom, usageStatsAtom } from "./usagestore";
import { formatProjectedDate, projectWeeklyExhaustion } from "./weeklyforecast";

const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex" };
const RING: Record<"ok" | "warn" | "hot", string> = {
    ok: "var(--color-success)",
    warn: "var(--color-warning)",
    hot: "var(--color-error)",
};
const CLASS_COLOR: Record<TokenClass, string> = {
    cacheRead: "var(--color-cacheread)",
    output: "var(--color-accent)",
    cacheWrite: "var(--color-warning)",
    input: "var(--color-success)",
};
const MODEL_COLORS = [
    "var(--color-accent)",
    "var(--color-success)",
    "var(--color-warning)",
    "var(--color-accent-300)",
    "var(--color-muted-foreground)",
];
const DAILY_CHART_H = 156;

// Denser than viewmodel.formatTokens (adds B, rounds large M) to match the redesign's compact cards.
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
    if (n < 0.1) return n <= 0 ? "0%" : "<0.1%";
    return +n.toFixed(1) + "%";
}
function ageStr(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h";
    return Math.floor(h / 24) + "d";
}

// Files-precedent value transition (moment 7): tween a bar's width/height on recompute. Returns
// undefined under reduced motion so the value snaps. Token-sourced duration + ease.
function barTransition(reduce: boolean, prop: "width" | "height"): string | undefined {
    return reduce ? undefined : `${prop} ${MOTION.durMacro}s ${easeFluidCss}`;
}

function Segmented<T extends string>({
    value,
    options,
    onChange,
}: {
    value: T;
    options: { key: T; label: string }[];
    onChange: (v: T) => void;
}) {
    return (
        <div className="flex flex-none rounded-[8px] border border-border bg-surface-raised p-[3px]">
            {options.map((o) => (
                <button
                    key={o.key}
                    onClick={() => onChange(o.key)}
                    className={cn(
                        "cursor-pointer rounded-[6px] border-0 px-[12px] py-[5px] font-mono text-[11px] font-semibold",
                        value === o.key ? "bg-accentbg text-primary" : "bg-transparent text-muted"
                    )}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div className="rounded-[12px] border border-border bg-surface-raised px-[17px] py-[15px]">
            <div className="mb-[9px] font-mono text-[11px] font-medium text-muted">{label}</div>
            <div className="mb-[6px] font-mono text-[23px] font-bold text-primary">{value}</div>
            {sub ? <div className="font-mono text-[10px] text-muted">{sub}</div> : null}
        </div>
    );
}

function MiniDonut({
    title,
    pct,
    reset,
    now,
    projectedExhaustion,
}: {
    title: string;
    pct?: number;
    reset?: number;
    now: number;
    projectedExhaustion?: number | null;
}) {
    const reduce = useReducedMotion();
    const has = pct != null;
    const arc = has ? Math.min(100, pct) : 0;
    const color = has ? RING[usageLevel(pct)] : "var(--color-edge-strong)";
    const ringStyle = {
        background: `conic-gradient(${color} 0 var(--usage-arc), var(--color-edge-strong) 0)`,
        "--usage-arc": `${arc}%`,
        transition: reduce ? undefined : `--usage-arc ${MOTION.durMacro}s ${easeFluidCss}`,
    } as CSSProperties;
    return (
        <div className="flex items-center gap-[7px]">
            <div className="flex h-[40px] w-[40px] flex-none items-center justify-center rounded-full" style={ringStyle}>
                <div className="flex h-[29px] w-[29px] items-center justify-center rounded-full bg-background">
                    <span className="font-mono text-[10px] font-bold text-primary">{has ? Math.round(pct) + "%" : "—"}</span>
                </div>
            </div>
            <div>
                <div className="font-mono text-[10px] font-semibold text-secondary">{title}</div>
                <div className="whitespace-nowrap font-mono text-[9px] text-muted">
                    {reset ? "resets " + formatReset(reset, now) : has ? "live" : "no data"}
                </div>
                {projectedExhaustion != null ? (
                    <div className="whitespace-nowrap font-mono text-[9px] text-warning">
                        ~100% by {formatProjectedDate(projectedExhaustion)}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function LiveLimitCard({
    d,
    now,
    weeklyProjectionMs,
}: {
    d: ProviderDonuts;
    now: number;
    weeklyProjectionMs?: number | null;
}) {
    const stale = d.stale != null;
    const dot = stale ? "var(--color-warning)" : "var(--color-success)";
    const label = stale ? "as of " + ageStr(now - d.stale!.capturedAt) + " ago" : "Live";
    const border = stale
        ? "color-mix(in srgb, var(--color-warning) 22%, transparent)"
        : "color-mix(in srgb, var(--color-success) 22%, transparent)";
    return (
        <motion.div
            variants={cardVariants}
            initial="initial"
            animate="animate"
            className="flex items-center gap-[11px] rounded-[11px] border bg-surface-raised px-[14px] py-[12px]"
            style={{ borderColor: border }}
        >
            <div className="w-[94px] flex-none">
                <div className="mb-[5px] flex items-center gap-[7px]">
                    <span className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: dot }} />
                    <span className="truncate font-semibold text-[13px] text-primary">{PROVIDER_LABEL[d.provider] ?? d.provider}</span>
                </div>
                <div className="whitespace-nowrap font-mono text-[10px]" style={{ color: dot }}>
                    {label}
                </div>
            </div>
            <div className="flex flex-1 justify-end gap-[10px]">
                <MiniDonut title="5-hour" pct={d.fivehour.pct} reset={d.fivehour.reset} now={now} />
                <MiniDonut
                    title="Weekly"
                    pct={d.week.pct}
                    reset={d.week.reset}
                    now={now}
                    projectedExhaustion={weeklyProjectionMs}
                />
            </div>
        </motion.div>
    );
}

function SplitBar({ items, totalOf }: { items: ClassUsage[]; totalOf: (c: ClassUsage) => number }) {
    const reduce = useReducedMotion();
    const total = items.reduce((s, c) => s + totalOf(c), 0) || 1;
    return (
        <div className="mb-[18px] flex h-[30px] overflow-hidden rounded-[7px] bg-background">
            {items.map((c) => (
                <div
                    key={c.cls}
                    style={{
                        width: `${(totalOf(c) / total) * 100}%`,
                        background: CLASS_COLOR[c.cls],
                        transition: barTransition(reduce, "width"),
                    }}
                />
            ))}
        </div>
    );
}

function SplitCard({ split }: { split: ClassUsage[] }) {
    const tokTotal = split.reduce((s, c) => s + c.tokens, 0);
    const spdTotal = split.reduce((s, c) => s + c.spendUsd, 0);
    const cacheRead = split.find((c) => c.cls === "cacheRead");
    const cachePct = tokTotal > 0 && cacheRead ? (cacheRead.tokens / tokTotal) * 100 : 0;
    return (
        <div className="mb-4 rounded-[14px] border border-border bg-surface-raised px-[22px] py-[20px]">
            <div className="mb-1 flex items-baseline gap-[10px]">
                <h3 className="text-[15px] font-bold tracking-[-0.01em] text-primary">Where it goes</h3>
                <span className="font-mono text-[11px] text-muted">all providers</span>
            </div>
            <p className="mb-5 max-w-[680px] text-[12.5px] leading-[1.5] text-secondary">
                {pctStr(cachePct)} of the token count is cache reads — so a single “tokens” number misleads. Cache reads
                price at a fraction of input, so the two bars tell different stories.
            </p>

            <div className="mb-[7px] flex items-baseline justify-between">
                <span className="font-mono text-[11px] font-semibold text-secondary">Tokens</span>
                <span className="font-mono text-[13px] font-bold text-primary">{fmt(tokTotal)}</span>
            </div>
            <SplitBar items={split} totalOf={(c) => c.tokens} />

            <div className="mb-[7px] flex items-baseline justify-between">
                <span className="font-mono text-[11px] font-semibold text-secondary">
                    Spend <span className="font-medium text-muted">≈ API-equiv</span>
                </span>
                <span className="font-mono text-[13px] font-bold text-primary">{usd(spdTotal)}</span>
            </div>
            <SplitBar items={split} totalOf={(c) => c.spendUsd} />

            <div className="grid grid-cols-2 gap-x-[12px] gap-y-[14px] border-t border-border pt-4 sm:grid-cols-4">
                {split.map((c) => (
                    <div key={c.cls}>
                        <div className="mb-2 flex items-center gap-[7px]">
                            <span className="h-[10px] w-[10px] flex-none rounded-[3px]" style={{ background: CLASS_COLOR[c.cls] }} />
                            <span className="text-[11.5px] font-semibold text-secondary">{c.label}</span>
                        </div>
                        <div className="mb-[3px] flex justify-between font-mono text-[10.5px] text-muted">
                            <span>tokens</span>
                            <span className="text-secondary">
                                {fmt(c.tokens)} · {pctStr(tokTotal > 0 ? (c.tokens / tokTotal) * 100 : 0)}
                            </span>
                        </div>
                        <div className="flex justify-between font-mono text-[10.5px] text-muted">
                            <span>spend</span>
                            <span className="text-secondary">
                                {usd(c.spendUsd)} · {pctStr(spdTotal > 0 ? (c.spendUsd / spdTotal) * 100 : 0)}
                            </span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function DailyChart({
    daily,
    truncated,
    window,
    metric,
    onMetric,
}: {
    daily: DailyUsage[];
    truncated: boolean;
    window: "7d" | "all";
    metric: "tokens" | "spend";
    onMetric: (m: "tokens" | "spend") => void;
}) {
    const reduce = useReducedMotion();
    const rows = daily.map((d) => {
        const a = metric === "tokens" ? d.claudeTokens : d.claudeSpendUsd;
        const b = metric === "tokens" ? d.codexTokens : d.codexSpendUsd;
        return { day: d.day.slice(5), a, b, total: a + b };
    });
    const dmax = Math.max(1, ...rows.map((r) => r.total));
    const axis = (v: number) => (metric === "tokens" ? fmt(v) : usd(v));
    const label = window === "7d" ? "last 7 days" : truncated ? "last 30 days" : "all time";
    return (
        <div className="mb-4 rounded-[14px] border border-border bg-surface-raised px-[22px] pb-5 pt-[18px]">
            <div className="mb-5 flex flex-wrap items-center gap-3">
                <h3 className="text-[15px] font-bold tracking-[-0.01em] text-primary">Daily</h3>
                <span className="font-mono text-[11px] text-muted">{label}</span>
                <div className="flex-1" />
                <div className="flex items-center gap-[14px]">
                    <span className="flex items-center gap-[5px] font-mono text-[10.5px] text-secondary">
                        <span className="h-[9px] w-[9px] rounded-[2px] bg-accent" />
                        claude
                    </span>
                    <span className="flex items-center gap-[5px] font-mono text-[10.5px] text-secondary">
                        <span className="h-[9px] w-[9px] rounded-[2px] bg-success" />
                        codex
                    </span>
                </div>
                <Segmented
                    value={metric}
                    onChange={onMetric}
                    options={[
                        { key: "tokens", label: "Tokens" },
                        { key: "spend", label: "Spend" },
                    ]}
                />
            </div>
            {rows.length === 0 ? (
                <div className="py-8 text-center font-mono text-[12px] text-muted">No activity in range.</div>
            ) : (
                <div className="flex gap-2">
                    <div className="flex h-[156px] w-[42px] flex-none flex-col items-end justify-between pb-5">
                        <span className="font-mono text-[9.5px] text-muted">{axis(dmax)}</span>
                        <span className="font-mono text-[9.5px] text-muted">{axis(dmax / 2)}</span>
                        <span className="font-mono text-[9.5px] text-muted">0</span>
                    </div>
                    <div className="flex flex-1 items-end gap-[7px] border-b border-l border-border px-1">
                        {rows.map((r, ri) => {
                            const aH = Math.round((r.a / dmax) * DAILY_CHART_H);
                            const bH = Math.round((r.b / dmax) * DAILY_CHART_H);
                            const idle = r.total === 0;
                            const tip = `${r.day} · ${metric === "tokens" ? fmt(r.total) + " tok" : usd(r.total) + " ≈"}`;
                            // grow each column up from the baseline on mount, left-to-right stagger (scaleY,
                            // not height, so it's GPU-composited and never fights the height recompute tween)
                            const grow = reduce
                                ? {}
                                : {
                                      initial: { scaleY: 0 },
                                      animate: { scaleY: 1 },
                                      transition: { delay: ri * 0.025, duration: MOTION.durMacro, ease: MOTION.easeFluid },
                                  };
                            return (
                                <div key={r.day} title={tip} className="flex flex-1 cursor-default flex-col items-center gap-[7px]">
                                    <div className="flex h-[156px] w-full flex-col items-center justify-end gap-[2px]">
                                        {r.b > 0 ? (
                                            <motion.div
                                                {...grow}
                                                className="w-[64%] max-w-[30px] rounded-t-[3px] bg-success"
                                                style={{ height: bH, transformOrigin: "bottom", transition: barTransition(reduce, "height") }}
                                            />
                                        ) : null}
                                        <motion.div
                                            {...grow}
                                            className={cn("w-[64%] max-w-[30px] bg-accent", r.b > 0 ? "" : "rounded-t-[3px]")}
                                            style={{ height: aH, transformOrigin: "bottom", transition: barTransition(reduce, "height") }}
                                        />
                                        {idle ? <div className="h-[2px] w-[64%] max-w-[30px] rounded-[2px] bg-edge-strong" /> : null}
                                    </div>
                                    <span className="font-mono text-[9.5px] text-muted">{r.day}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

function ModelGroup({ p }: { p: ProviderUsage }) {
    const reduce = useReducedMotion();
    return (
        <div className="rounded-[14px] border border-border bg-surface-raised px-[20px] py-[18px]">
            <div className="mb-4 flex items-baseline justify-between">
                <div className="flex items-center gap-[9px]">
                    <h3 className="text-[14px] font-bold tracking-[-0.01em] text-primary">{PROVIDER_LABEL[p.provider] ?? p.provider}</h3>
                    <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">by model</span>
                </div>
                <span className="font-mono text-[12px] font-bold text-secondary">{fmt(p.tokens)}</span>
            </div>
            {p.models.map((m, i) => (
                <div key={m.model} className="mb-[13px]">
                    <div className="mb-[6px] flex items-baseline justify-between">
                        <span className="font-mono text-[12px] text-secondary" title={m.model}>{prettyModel(m.model)}</span>
                        <span className="font-mono text-[11px] text-muted">
                            {fmt(m.tokens)} · <span className="font-semibold text-secondary">{pctStr(m.pct)}</span>
                        </span>
                    </div>
                    <div className="h-[7px] overflow-hidden rounded-[4px] bg-edge-strong">
                        <motion.div
                            className="h-full rounded-[4px]"
                            style={{
                                width: `${m.pct}%`,
                                transformOrigin: "left",
                                background: MODEL_COLORS[i % MODEL_COLORS.length],
                                transition: barTransition(reduce, "width"),
                            }}
                            initial={reduce ? false : { scaleX: 0 }}
                            animate={{ scaleX: 1 }}
                            transition={reduce ? { duration: 0 } : { delay: i * 0.04, duration: MOTION.durMacro, ease: MOTION.easeFluid }}
                        />
                    </div>
                </div>
            ))}
        </div>
    );
}

function UsageHistorySkeleton() {
    return (
        <div>
            <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="rounded-[12px] border border-border bg-surface-raised px-[17px] py-[15px]">
                        <SkeletonLine className="mb-[12px] h-[11px] w-[72px]" />
                        <SkeletonLine className="mb-[9px] h-[23px] w-[92px]" />
                        <SkeletonLine className="h-[10px] w-[118px]" />
                    </div>
                ))}
            </div>
            <div className="mb-4 rounded-[14px] border border-border bg-surface-raised px-[22px] py-[20px]">
                <SkeletonLine className="mb-3 h-[15px] w-[128px]" />
                <SkeletonLine className="mb-5 h-[12px] w-[62%]" />
                <SkeletonLine className="mb-[18px] h-[30px] w-full rounded-[7px]" />
                <SkeletonLine className="h-[30px] w-full rounded-[7px]" />
            </div>
            <div className="rounded-[14px] border border-border bg-surface-raised px-[22px] py-[18px]">
                <SkeletonLine className="mb-5 h-[15px] w-[92px]" />
                <div className="flex h-[156px] items-end gap-[7px] border-b border-l border-border px-1">
                    <SkeletonLine className="h-[42px] flex-1 rounded-t-[3px]" />
                    <SkeletonLine className="h-[75px] flex-1 rounded-t-[3px]" />
                    <SkeletonLine className="h-[58px] flex-1 rounded-t-[3px]" />
                    <SkeletonLine className="h-[104px] flex-1 rounded-t-[3px]" />
                    <SkeletonLine className="h-[66px] flex-1 rounded-t-[3px]" />
                    <SkeletonLine className="h-[122px] flex-1 rounded-t-[3px]" />
                    <SkeletonLine className="h-[84px] flex-1 rounded-t-[3px]" />
                </div>
            </div>
        </div>
    );
}
export function UsageSurface({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const stats: UsageStats = useAtomValue(usageStatsAtom);
    const loadError = useAtomValue(usageErrorAtom);
    const usageLoaded = useAtomValue(usageLoadedAtom);
    const saved = useAtomValue(savedRateLimitsAtom);
    const now = useAtomValue(model.nowAtom);
    const [usageWindow, setUsageWindow] = useState<"7d" | "all">("7d");
    const [usageMetric, setUsageMetric] = useState<"tokens" | "spend">("tokens");
    const { asking, working, idle } = groupAgents(agents);

    useEffect(() => {
        const days = usageWindow === "7d" ? 7 : 0;
        // reset loaded so the skeleton shows while the newly-selected window loads (esp. the heavy
        // all-time scan), instead of leaving the previous window's stats on screen until it resolves.
        // The 60s refresh below does NOT reset — it silently refreshes in place.
        globalStore.set(usageLoadedAtom, false);
        void loadUsage(days);
        const refresh = setInterval(() => void loadUsage(days), 60_000);
        return () => clearInterval(refresh);
    }, [usageWindow]);

    useEffect(() => {
        const tick = setInterval(() => globalStore.set(model.nowAtom, Date.now()), 1000);
        return () => clearInterval(tick);
    }, [model]);

    const donuts = mergeRateLimitWindows(providerPlanUsage([...asking, ...working, ...idle]), saved, now);
    const claudeDonut = donuts.find((d) => d.provider === "claude");
    const weeklyProjectionMs =
        claudeDonut?.week.pct != null && claudeDonut.week.reset != null
            ? projectWeeklyExhaustion(
                  stats.daily.map((d) => ({ day: d.day, tokens: d.claudeTokens })),
                  claudeDonut.week.pct,
                  claudeDonut.week.reset,
                  now
              )
            : null;
    const tokTotal = stats.split.reduce((s, c) => s + c.tokens, 0);
    const cacheRead = stats.split.find((c) => c.cls === "cacheRead");
    const cachePctSub =
        tokTotal > 0 && cacheRead ? `${pctStr((cacheRead.tokens / tokTotal) * 100)} are cache reads` : "API-equivalent";
    const claudeToday = stats.daily.length ? stats.daily[stats.daily.length - 1].claudeTokens : 0;
    const codexToday = stats.daily.length ? stats.daily[stats.daily.length - 1].codexTokens : 0;
    const hasHistory = stats.providers.length > 0 || stats.totals.tokensWeek > 0;
    const revealHistory = useDidBecomeTrue(hasHistory);

    return (
        <MotionConfig reducedMotion="user">
            <div className="absolute inset-0 overflow-y-auto">
                <div className="mx-auto max-w-[1060px] px-[30px] pb-[90px] pt-[28px]">
                    <div className="mb-[22px] flex items-end gap-[18px]">
                        <div className="min-w-0 flex-1">
                            <h1 className="mb-[5px] text-[25px] font-bold tracking-[-0.02em] text-primary">Usage</h1>
                            <p className="max-w-[640px] text-[13.5px] leading-[1.5] text-secondary">
                                Durable history from transcripts, plus live quota while agents run. Spend is an{" "}
                                <span className="text-muted-foreground">≈ API-equivalent</span> estimate from a bundled price
                                table — never a bill.
                            </p>
                            {loadError ? (
                                <p className="mt-1 text-[12px] text-warning">Couldn’t refresh — showing the last loaded usage.</p>
                            ) : null}
                        </div>
                        <Segmented<"7d" | "all">
                            value={usageWindow}
                            onChange={setUsageWindow}
                            options={[
                                { key: "7d", label: "7 days" },
                                { key: "all", label: "All time" },
                            ]}
                        />
                    </div>

                    {/* LIVE LIMITS */}
                    <div className="mb-[10px] rounded-[14px] border border-border bg-background px-[18px] py-[15px]">
                        <div className="mb-[14px] flex flex-wrap items-center gap-[11px]">
                            <span className="flex items-center gap-2">
                                <span className="h-[8px] w-[8px] flex-none animate-[pulseDot_1.6s_infinite] rounded-full bg-success" />
                                <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-secondary">
                                    Live limits
                                </span>
                            </span>
                            <span className="font-mono text-[10.5px] text-muted">ephemeral · known only while a Claude agent runs</span>
                            <div className="flex-1" />
                            <div className="flex items-center gap-[13px] font-mono text-[10px] text-secondary">
                                <span className="flex items-center gap-[5px]">
                                    <span className="h-[7px] w-[7px] rounded-full bg-success" />
                                    live
                                </span>
                                <span className="flex items-center gap-[5px]">
                                    <span className="h-[7px] w-[7px] rounded-full bg-warning opacity-[0.65]" />
                                    as of …
                                </span>
                            </div>
                        </div>
                        {donuts.length === 0 ? (
                            <div className="py-3 text-center font-mono text-[11px] text-muted">
                                No quota readings yet — start a Claude agent.
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                {donuts.map((d) => (
                                    <LiveLimitCard
                                        key={d.provider}
                                        d={d}
                                        now={now}
                                        weeklyProjectionMs={d.provider === "claude" ? weeklyProjectionMs : null}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                    <p className="mb-8 ml-[2px] font-mono text-[10.5px] leading-[1.5] text-muted">
                        Each donut keeps its last snapshot per provider — countdowns stay correct off absolute reset times,
                        rolling to empty once a window passes. Codex quota isn’t wired through the live roster yet.
                    </p>

                    {/* HISTORICAL */}
                    <div className="mb-4 flex items-center gap-[11px]">
                        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Historical</span>
                        <span className="font-mono text-[10.5px] text-muted">durable · every transcript in window</span>
                        <div className="h-px flex-1 bg-border" />
                    </div>

                    {!usageLoaded ? (
                        <UsageHistorySkeleton />
                    ) : !hasHistory ? (
                        <div className="mt-10 text-center text-[13px] text-muted">No usage yet — start an agent.</div>
                    ) : (
                        <motion.div variants={cardVariants} initial={revealHistory ? "initial" : false} animate="animate">
                            <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                                <StatCard
                                    label="Tokens · today"
                                    value={fmt(claudeToday + codexToday)}
                                    sub={`claude ${fmt(claudeToday)} · codex ${fmt(codexToday)}`}
                                />
                                <StatCard label="Spend · today" value={`≈ ${usd(stats.totals.spendTodayUsd)}`} sub="API-equivalent" />
                                <StatCard label="Tokens · 7 days" value={fmt(stats.totals.tokensWeek)} sub={cachePctSub} />
                                <StatCard label="Spend · 7 days" value={`≈ ${usd(stats.totals.spendWeekUsd)}`} sub="API-equivalent" />
                            </div>

                            <SplitCard split={stats.split} />

                            <DailyChart
                                daily={stats.daily}
                                truncated={stats.dailyTruncated}
                                window={usageWindow}
                                metric={usageMetric}
                                onMetric={setUsageMetric}
                            />

                            <div className={modelGridClass(stats.providers.length)}>
                                {stats.providers.map((p) => (
                                    <ModelGroup key={p.provider} p={p} />
                                ))}
                            </div>
                        </motion.div>
                    )}
                </div>
            </div>
        </MotionConfig>
    );
}
