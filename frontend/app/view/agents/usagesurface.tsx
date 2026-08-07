// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Usage surface (handoff redesign: Wave-cockpit-live.dc.html isUsage block). Two trust zones:
// LIVE LIMITS — ephemeral 5h/weekly quota donuts, merged live-over-saved (ratelimitstore) so they
// survive idle; and HISTORICAL — durable token-class split, daily series, and per-model breakdown
// folded from the backend usage scan (usagestore/usagestats), scoped by a 7-day / All-time toggle.
// Loads on mount + a 60s refresh for the current window; a 1s tick keeps reset countdowns current.

import { ArcMeter, Meter, StackedMeter } from "@/app/element/meter";
import { useDidBecomeTrue } from "@/app/element/motionhooks";
import { Segmented } from "@/app/element/segmented";
import { SkeletonLine } from "@/app/element/skeleton";
import { cardVariants } from "@/app/element/motiontokens";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { MotionConfig, motion } from "motion/react";
import { useEffect } from "react";
import type { AgentsViewModel } from "./agents";
import { DailyChart } from "./dailychart";
import { formatReset, liveWindowAgents, providerPlanUsage, usageLevel } from "./agentsviewmodel";
import { prettyModel } from "./modellabel";
import { mergeRateLimitWindows, savedRateLimitsAtom, type ProviderDonuts } from "./ratelimitstore";
import { SurfaceError, SurfaceHeader } from "./surfacescaffold";
import { CLASS_FILL, fmt, foldModels, modelGridClass, usd } from "./usagestats";
import type { ClassUsage, ProviderUsage, UsageStats } from "./usagestats";
import { loadUsage, usageErrorAtom, usageLoadedAtom, usageMetricAtom, usageStatsAtom, usageWindowAtom } from "./usagestore";
import { formatProjectedDate, projectWeeklyExhaustion } from "./weeklyforecast";

const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "opencode" };
const RING: Record<"ok" | "warn" | "hot", string> = {
    ok: "var(--color-success)",
    warn: "var(--color-warning)",
    hot: "var(--color-error)",
};
// Ranked magnitude within one provider is an ORDINAL job, not categorical: one hue, monotone
// lightness, indexed by rank. Four stops off the existing accent scale — no new colors. The previous
// set mixed accent/success/warning/accent-300/muted-foreground, cycled with `i % len` AND keyed on
// rank, so one model overtaking another repainted both bars; an ordinal ramp is meant to follow rank.
// It also put --color-accent next to --color-accent-300, which are too close to tell apart (the two
// are one step off the same ramp), so models 1 and 4 read as the same color. These stops are 2 apart.
const MODEL_SEQ = ["bg-accent-200", "bg-accent-400", "bg-accent-600", "bg-accent-800"];
const MAX_MODEL_ROWS = MODEL_SEQ.length;

function pctStr(n: number): string {
    if (n >= 10) return Math.round(n) + "%";
    if (n < 0.1) return n <= 0 ? "0%" : "<0.1%";
    return +n.toFixed(1) + "%";
}
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "YYYY-MM-DD" -> "Jul 15" for the busiest-day card sub-line.
function dayLabel(day: string): string {
    const [, m, d] = day.split("-").map(Number);
    return `${MONTH_SHORT[m - 1] ?? "?"} ${d}`;
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

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div className="rounded-lg border border-border bg-surface-raised px-[17px] py-[15px]">
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
    const has = pct != null;
    return (
        <div className="flex items-center gap-[7px]">
            <ArcMeter pct={pct} size={40} thickness={5.5} color={RING[usageLevel(pct ?? 0)]}>
                <span className="font-mono text-[10px] font-bold text-primary">
                    {pct != null ? Math.round(pct) + "%" : "—"}
                </span>
            </ArcMeter>
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
            <StackedMeter
                className="mb-[18px]"
                height={30}
                radius={7}
                track="bg-background"
                segs={split.map((c) => ({ key: c.cls, value: c.tokens, fill: CLASS_FILL[c.cls] }))}
            />

            <div className="mb-[7px] flex items-baseline justify-between">
                <span className="font-mono text-[11px] font-semibold text-secondary">
                    Spend <span className="font-medium text-muted">≈ API-equiv</span>
                </span>
                <span className="font-mono text-[13px] font-bold text-primary">{usd(spdTotal)}</span>
            </div>
            <StackedMeter
                className="mb-[18px]"
                height={30}
                radius={7}
                track="bg-background"
                segs={split.map((c) => ({ key: c.cls, value: c.spendUsd, fill: CLASS_FILL[c.cls] }))}
            />

            <div className="grid grid-cols-2 gap-x-[12px] gap-y-[14px] border-t border-border pt-4 sm:grid-cols-4">
                {split.map((c) => (
                    <div key={c.cls}>
                        <div className="mb-2 flex items-center gap-[7px]">
                            <span className={cn("h-[10px] w-[10px] flex-none rounded-[3px]", CLASS_FILL[c.cls])} />
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

function ModelGroup({ p }: { p: ProviderUsage }) {
    return (
        <div className="rounded-[14px] border border-border bg-surface-raised px-[20px] py-[18px]">
            <div className="mb-4 flex items-baseline justify-between">
                <div className="flex items-center gap-[9px]">
                    <h3 className="text-[14px] font-bold tracking-[-0.01em] text-primary">{PROVIDER_LABEL[p.provider] ?? p.provider}</h3>
                    <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">by model</span>
                </div>
                <span className="font-mono text-[12px] font-bold text-secondary">{fmt(p.tokens)}</span>
            </div>
            {foldModels(p.models, MAX_MODEL_ROWS).map((m, i) => (
                <div key={m.model} className="mb-[13px]">
                    <div className="mb-[6px] flex items-baseline justify-between">
                        <span className="font-mono text-[12px] text-secondary" title={m.model}>{prettyModel(m.model)}</span>
                        <span className="font-mono text-[11px] text-muted">
                            {fmt(m.tokens)} · <span className="font-semibold text-secondary">{pctStr(m.pct)}</span>
                        </span>
                    </div>
                    <Meter pct={m.pct} fill={MODEL_SEQ[i]} height={7} radius={4} track="bg-edge-strong" />
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
                    <div key={i} className="rounded-lg border border-border bg-surface-raised px-[17px] py-[15px]">
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
    const [usageWindow, setUsageWindow] = useAtom(usageWindowAtom);
    const [usageMetric, setUsageMetric] = useAtom(usageMetricAtom);

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

    const donuts = mergeRateLimitWindows(providerPlanUsage(liveWindowAgents(agents)), saved, now);
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
                    <div className="mb-[22px]">
                        <SurfaceHeader
                            border={false}
                            title="Usage"
                            subtitle={
                                <span className="max-w-[640px] leading-[1.5]">
                                    Durable history from transcripts, plus live quota while agents run. Spend is an{" "}
                                    <span className="text-muted-foreground">≈ API-equivalent</span> estimate from a bundled
                                    price table — never a bill.
                                </span>
                            }
                            actions={
                                <Segmented<"7d" | "all">
                                    value={usageWindow}
                                    onChange={setUsageWindow}
                                    options={[
                                        { key: "7d", label: "7 days" },
                                        { key: "all", label: "All time" },
                                    ]}
                                />
                            }
                        />
                        {loadError ? (
                            <SurfaceError message="Couldn’t refresh — showing the last loaded usage." />
                        ) : null}
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
                                {usageWindow === "7d" ? (
                                    <>
                                        <StatCard
                                            label="Tokens · today"
                                            value={fmt(claudeToday + codexToday)}
                                            sub={`claude ${fmt(claudeToday)} · codex ${fmt(codexToday)}`}
                                        />
                                        <StatCard label="Spend · today" value={`≈ ${usd(stats.totals.spendTodayUsd)}`} sub="API-equivalent" />
                                        <StatCard label="Tokens · 7 days" value={fmt(stats.totals.tokensWeek)} sub={cachePctSub} />
                                        <StatCard label="Spend · 7 days" value={`≈ ${usd(stats.totals.spendWeekUsd)}`} sub="API-equivalent" />
                                    </>
                                ) : (
                                    <>
                                        <StatCard
                                            label="Tokens · all time"
                                            value={fmt(stats.totals.tokensWindow)}
                                            sub={`claude ${fmt(stats.totals.claudeTokensWindow)} · codex ${fmt(stats.totals.codexTokensWindow)}`}
                                        />
                                        <StatCard label="Spend · all time" value={`≈ ${usd(stats.totals.spendWindowUsd)}`} sub="API-equivalent" />
                                        <StatCard
                                            label="Daily avg"
                                            value={fmt(stats.totals.activeDays > 0 ? stats.totals.tokensWindow / stats.totals.activeDays : 0)}
                                            sub={`over ${stats.totals.activeDays} active day${stats.totals.activeDays === 1 ? "" : "s"}`}
                                        />
                                        <StatCard
                                            label="Busiest day"
                                            value={fmt(stats.totals.busiestTokens)}
                                            sub={stats.totals.busiestDay ? dayLabel(stats.totals.busiestDay) : "—"}
                                        />
                                    </>
                                )}
                            </div>

                            <SplitCard split={stats.split} />

                            <DailyChart
                                daily={stats.daily}
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
