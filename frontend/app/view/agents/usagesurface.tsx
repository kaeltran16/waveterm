// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Usage surface (usage-redesign Page.dc.html). A horizontal scope bar pinned under the header, over a
// full-width detail holding the scope's two trust zones side by side — LIVE LIMITS (ephemeral
// 5h/weekly quota, merged live-over-saved via ratelimitstore so it survives idle) and HISTORICAL
// (durable stat cards) — then the daily series by model and where the usage goes, folded from the
// backend usage scan. Scope selection IS usageHarnessFilterAtom, so the scope picker and the
// historical filter are one piece of state rather than two that can disagree; that atom re-aggregates
// model.usageStatsAtom, so the detail is simply the surface scoped to one harness.
// Loads on mount + a 60s refresh for the current window; a 1s tick keeps reset countdowns current.
// A second lens, By work, re-scopes the same detail page to what the usage paid for: all usage, a
// project, a run or a session (usageattribution.ts). It has no Live limits: quota is per provider.

import { Meter } from "@/app/element/meter";
import { useDidBecomeTrue } from "@/app/element/motionhooks";
import { cardVariants } from "@/app/element/motiontokens";
import { Segmented } from "@/app/element/segmented";
import { SkeletonLine } from "@/app/element/skeleton";
import { useSurfaceListNav, type ListNavController } from "@/app/store/keybindings/listnav";
import { REGION_LABEL } from "@/app/view/jarvis/briefstyle";
import { openTarget } from "@/app/view/jarvis/openref";
import { AVATAR_SURFACE_REACH_PX } from "@/app/view/jarvis/petview";
import { cn, fireAndForget } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { MotionConfig, motion } from "motion/react";
import { useEffect, useMemo, type ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import { formatReset, liveWindowAgents, providerPlanUsage, usageLevel } from "./agentsviewmodel";
import { providerDot, providerLabel } from "./cockpitrailmodel";
import { DailyChart } from "./dailychart";
import { harnessesAtom } from "./harnessstore";
import { mergeRateLimitWindows, savedRateLimitsAtom, type DonutWindow } from "./ratelimitstore";
import { SurfaceError, SurfaceToolbar, ToolbarFact } from "./surfacescaffold";
import {
    ALL_SCOPE,
    buildAttribution,
    classSplit,
    itemScopeKey,
    listPage,
    otherFoldersText,
    plural,
    resolveScope,
    scopeBuckets,
    scopeId,
    scopeList,
    scopeName,
    scopeSplit,
    splitTable,
    type WorkList,
    type WorkScope,
} from "./usageattribution";
import { modelLegend } from "./usagedaily";
import {
    buildUsageRail,
    countReporting,
    railRows,
    worstWindow,
    type AggregateWindow,
    type UsageRailRow,
} from "./usagerail";
import { SplitTable } from "./usagesplittable";
import type { UsageStats } from "./usagestats";
import { aggregateBuckets, fmt, pctStr, usd } from "./usagestats";
import {
    allUsageStatsAtom,
    loadUsage,
    usageBucketsAtom,
    usageErrorAtom,
    usageLensAtom,
    usageListExpandedAtom,
    usageLoadedAtom,
    usageMetricAtom,
    usageSessionsAtom,
    usageWindowAtom,
    usageWorkItemAtom,
    usageWorkScopeAtom,
    type UsageLens,
} from "./usagestore";
import { formatProjectedDate, projectWeeklyExhaustion } from "./weeklyforecast";

const ALL = "all";

const LEVEL_FILL: Record<"ok" | "warn" | "hot", string> = {
    ok: "bg-success",
    warn: "bg-warning",
    hot: "bg-error",
};
const LEVEL_TEXT: Record<"ok" | "warn" | "hot", string> = {
    ok: "text-success",
    warn: "text-warning",
    hot: "text-error",
};
// Selected/idle treatment for a scope card, matching the Sessions rail rather than minting a second
// selection vocabulary for one surface. Cards hold 220-340px; the bar scrolls sideways before it squashes.
const CARD_BASE =
    "flex min-w-[220px] max-w-[340px] flex-1 flex-col gap-[7px] cursor-pointer rounded-[10px] border px-3 py-2.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const ROW_ON = "border-accent bg-surface-hover";
const ROW_OFF = "border-border bg-surface hover:border-edge-strong";

function ageStr(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h";
    return Math.floor(h / 24) + "d";
}

// Rail/detail state chrome. Status is never color alone here — every use pairs this with the label.
// `color` is a var() reference applied through `style`, so the one value drives both the text and the
// currentColor tint behind it.
const PILL_TINT = "color-mix(in srgb, currentColor 14%, transparent)";

function stateMeta(row: UsageRailRow, now: number): { label: string; long: string; color: string } {
    if (row.state === "live") {
        return { label: "Live", long: "live", color: "var(--color-success)" };
    }
    if (row.state === "saved") {
        const age = row.capturedAt != null ? ageStr(now - row.capturedAt) : "?";
        return { label: "Saved", long: `as of ${age} ago`, color: "var(--color-warning)" };
    }
    return { label: "No reading", long: "no quota reading", color: "var(--color-muted)" };
}

// An h3, not a styled span: these head real sections, so the heading level has to survive the eyebrow
// styling.
function SectionRule({ label, meta }: { label: string; meta?: string }) {
    return (
        <div className="mb-3 flex items-center gap-2.5">
            <h3 className={cn(REGION_LABEL, "text-muted")}>{label}</h3>
            <div className="h-px flex-1 bg-edge-faint" />
            {meta != null ? <span className="font-mono text-[10.5px] text-muted">{meta}</span> : null}
        </div>
    );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div className="rounded-[11px] border border-border bg-surface-raised px-4 py-[14px]">
            <div className="mb-2 font-mono text-[10.5px] text-muted">{label}</div>
            <div className="mb-1.5 font-mono text-[21px] font-bold text-primary">{value}</div>
            {sub ? <div className="font-mono text-[10.5px] text-muted">{sub}</div> : null}
        </div>
    );
}

// One quota window as a bar. The redesign trades the arc donuts for bars because the detail pane
// gives two windows the full width, and a bar reads a percentage against its track far better than a
// 40px ring did. `used` carries the source harness on the aggregate row, where "62%" alone would not
// say whose account it describes.
function LimitCard({
    kind,
    title,
    w,
    now,
    used,
    projectedExhaustion,
}: {
    kind: string;
    title: string;
    w: DonutWindow;
    now: number;
    used?: string;
    projectedExhaustion?: number | null;
}) {
    const level = usageLevel(w.pct ?? 0);
    const has = w.pct != null;
    return (
        <div
            data-usage-limit={kind}
            className="rounded-[11px] border border-border bg-surface-raised px-[15px] py-[13px]"
        >
            <div className="mb-2 flex items-baseline justify-between">
                <span className="font-mono text-[10.5px] font-semibold text-ink-mid">{title}</span>
                <span className={cn("font-mono text-[13px] font-bold", has ? LEVEL_TEXT[level] : "text-muted")}>
                    {has ? Math.round(w.pct!) + "%" : "—"}
                </span>
            </div>
            <Meter pct={w.pct ?? 0} fill={has ? LEVEL_FILL[level] : "bg-edge-strong"} height={7} radius={4} />
            <div className="mt-1.5 flex justify-between gap-2 font-mono text-[10.5px] text-muted">
                <span className="truncate">{used ?? (has ? "in window" : "no reading")}</span>
                <span className="flex-none whitespace-nowrap">
                    {w.reset ? "resets " + formatReset(w.reset, now) : "—"}
                </span>
            </div>
            {projectedExhaustion != null ? (
                <div className="mt-1 font-mono text-[10.5px] text-warning">
                    ~100% by {formatProjectedDate(projectedExhaustion)}
                </div>
            ) : null}
        </div>
    );
}

// One card of the scope bar: dot, name and pill over the scope's tokens and spend, and a right-hand fact.
// `harness` or `project` keys the card for the scenarios; All usage carries harness "all" in both lenses.
function ScopeCard({
    harness,
    project,
    title,
    active,
    onSelect,
    dot,
    name,
    pill,
    pillColor,
    tokens,
    spendUsd,
    fact,
}: {
    harness?: string;
    project?: string;
    title?: string;
    active: boolean;
    onSelect: () => void;
    dot: string;
    name: string;
    pill: string;
    pillColor: string; // a var() reference; it also tints the pill behind the text
    tokens: number;
    spendUsd: number;
    fact: string;
}) {
    return (
        <motion.button
            layout
            variants={cardVariants}
            initial="initial"
            animate="animate"
            type="button"
            data-usage-harness={harness}
            data-usage-project={project}
            aria-pressed={active}
            title={title}
            onClick={onSelect}
            className={cn(CARD_BASE, active ? ROW_ON : ROW_OFF)}
        >
            <span className="flex w-full items-center gap-2">
                <span className={cn("h-2 w-2 flex-none rounded-full", dot)} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-primary">{name}</span>
                <span
                    className="flex-none rounded-[4px] px-1.5 py-0.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.06em]"
                    style={{ color: pillColor, backgroundColor: PILL_TINT }}
                >
                    {pill}
                </span>
            </span>
            <span className="flex w-full gap-2 whitespace-nowrap font-mono text-[10.5px] text-muted">
                <span className="text-secondary">{fmt(tokens)} tok</span>
                <span>·</span>
                <span>≈ {usd(spendUsd)}</span>
                <span className="flex-1" />
                <span>{fact}</span>
            </span>
        </motion.button>
    );
}

function quotaFact(row: UsageRailRow): string {
    if (row.state === "none") {
        return "history only";
    }
    const pct = (w: { pct?: number }) => (w.pct != null ? Math.round(w.pct) + "%" : "—");
    return `5h ${pct(row.fivehour)} · wk ${pct(row.week)}`;
}

const LENS_OPTIONS: { key: UsageLens; label: string }[] = [
    { key: "provider", label: "By provider" },
    { key: "work", label: "By work" },
];

const RANGE_OPTIONS: { key: "7d" | "all"; label: string }[] = [
    { key: "7d", label: "7 days" },
    { key: "all", label: "All time" },
];

interface DetailHead {
    title: string;
    meta: [string, string][];
    action?: ReactNode;
}

// the header meta every scope shares, after whatever names the scope itself
function statsMeta(stats: UsageStats): [string, string][] {
    const reported = stats.totals.reportedCostWindowPresent ? usd(stats.totals.reportedCostWindowUsd) : "not reported";
    return [
        ["tokens", fmt(stats.totals.tokensWindow)],
        ["reported", reported],
        ["api-equiv", `≈ ${usd(stats.totals.spendWindowUsd)}`],
        ["models", String(stats.models.length)],
    ];
}

function providerHead(sel: string, stats: UsageStats, reportingLabel: string): DetailHead {
    if (sel === ALL) {
        return { title: "All usage", meta: [...statsMeta(stats), ["quota", reportingLabel]] };
    }
    return { title: providerLabel(sel), meta: statsMeta(stats) };
}

function workHead(scope: WorkScope, stats: UsageStats, action: ReactNode): DetailHead {
    if (scope.kind === "all") {
        return { title: "All usage", meta: statsMeta(stats) };
    }
    if (scope.kind === "project") {
        const { label, count } = scope.project;
        return { title: label, meta: [["runs and sessions", String(count)], ...statsMeta(stats)] };
    }
    const { item } = scope;
    const named: [string, string][] = item.projectLabel !== "" ? [["project", item.projectLabel]] : [];
    return {
        title: item.title,
        meta: [...named, ["sessions", String(item.sessions.length)], ...statsMeta(stats)],
        action,
    };
}

function DetailHeader({ head }: { head: DetailHead }) {
    return (
        <div data-usage-head className="flex items-baseline gap-4">
            <h2 className="min-w-0 truncate text-[14px] font-semibold text-primary" title={head.title}>
                {head.title}
            </h2>
            <div className="flex min-w-[240px] flex-1 flex-wrap gap-x-3.5 gap-y-1 font-mono text-[11px] text-muted">
                {head.meta.map(([k, v]) => (
                    <span key={k}>
                        {k} <span className="text-secondary">{v}</span>
                    </span>
                ))}
            </div>
            {head.action}
        </div>
    );
}

const QUIET_BUTTON =
    "cursor-pointer rounded border border-edge-mid bg-surface-raised text-[12px] hover:border-edge-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

function RowIcon({ run }: { run: boolean }) {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {run ? (
                <>
                    <rect x="3" y="3" width="6" height="6" rx="1" />
                    <rect x="15" y="15" width="6" height="6" rx="1" />
                    <path d="M6 9v4a3 3 0 0 0 3 3h6" />
                </>
            ) : (
                <>
                    <path d="m4 17 6-5-6-5" />
                    <path d="M12 19h8" />
                </>
            )}
        </svg>
    );
}

function Chevron({ back = false }: { back?: boolean }) {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d={back ? "m15 6-6 6 6 6" : "m9 6 6 6-6 6"} />
        </svg>
    );
}

const LIST_ROW =
    "grid min-h-[48px] w-full grid-cols-[22px_minmax(0,1fr)_150px_64px_74px_14px] items-center gap-x-3.5 border-0 border-b border-edge-faint bg-transparent px-1 py-1.5 text-left";

// The one ranked list of a By work page. On All usage and a project a row opens its run or session;
// a run's own sessions are read-only rows.
function WorkListCard({
    list,
    expanded,
    onOpen,
    onToggle,
}: {
    list: WorkList;
    expanded: boolean;
    onOpen: (key: string) => void;
    onToggle: () => void;
}) {
    const page = listPage(list, expanded);
    return (
        <div data-usage-list className="rounded-[14px] border border-border bg-surface-raised px-5 py-[18px]">
            <SectionRule label={list.title} meta={list.meta} />
            {list.summary != null ? (
                <p className="mb-2.5 max-w-[680px] text-[12.5px] leading-[1.55] text-secondary">{list.summary}</p>
            ) : null}
            <div className="flex flex-col">
                {page.rows.map((r) => {
                    const cells = (
                        <>
                            <span className="flex items-center justify-center text-ink-mid">
                                <RowIcon run={r.isRun} />
                            </span>
                            <span className="flex min-w-0 flex-col gap-0.5">
                                <span className="truncate text-[13px] font-semibold text-primary">{r.title}</span>
                                <span className="truncate font-mono text-[10.5px] text-muted">{r.sub}</span>
                            </span>
                            <Meter pct={r.pct} fill="bg-accent" height={7} radius={4} track="bg-edge-strong" />
                            <span className="text-right font-mono text-[11px] text-muted">{fmt(r.tokens)}</span>
                            <span className="flex flex-col items-end font-mono text-[12px] font-semibold text-secondary">
                                <span>{r.reported ? usd(r.cost) : `≈ ${usd(r.cost)}`}</span>
                                {r.reported ? (
                                    <span data-usage-reported className="text-[10.5px] font-normal text-muted">
                                        reported
                                    </span>
                                ) : null}
                            </span>
                            <span className="flex text-ink-faint">{list.nav ? <Chevron /> : null}</span>
                        </>
                    );
                    return list.nav ? (
                        <button
                            key={r.key}
                            type="button"
                            data-usage-item={r.key}
                            onClick={() => onOpen(r.key)}
                            className={cn(
                                LIST_ROW,
                                "cursor-pointer hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                            )}
                        >
                            {cells}
                        </button>
                    ) : (
                        <div key={r.key} data-usage-item={r.key} className={LIST_ROW}>
                            {cells}
                        </div>
                    );
                })}
            </div>
            {page.hasMore ? (
                <button
                    type="button"
                    data-usage-more
                    aria-expanded={expanded}
                    onClick={onToggle}
                    className={cn(QUIET_BUTTON, "mt-3 px-3 py-1.5 text-muted")}
                >
                    {page.moreLabel}
                </button>
            ) : null}
        </div>
    );
}

// "Claude 1.2K · OpenCode 300" for the token summary-card secondary line.
function harnessSub(byHarness: Record<string, number>): string {
    const parts = Object.entries(byHarness)
        .filter(([, n]) => n > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([h, n]) => `${providerLabel(h)} ${fmt(n)}`);
    return parts.length > 0 ? parts.join(" · ") : "no usage in scope";
}

// The four stat cards. `all` is the unscoped page (it names the harnesses behind the token count);
// `of` is set on a narrower By work scope, whose cards say what share of everything they are.
function HistoryCards({
    stats,
    window: win,
    all,
    of,
    reveal,
}: {
    stats: UsageStats;
    window: "7d" | "all";
    all: boolean;
    of?: UsageStats;
    reveal: boolean;
}) {
    const t = stats.totals;
    const week = win === "7d";
    const span = week ? "7 days" : "all time";
    const tokens = week ? t.tokensWeek : t.tokensWindow;
    const spend = week ? t.spendWeekUsd : t.spendWindowUsd;
    const coverage = week ? t.pricingCoverageWeekPct : t.pricingCoverageWindowPct;
    const reportedPresent = week ? t.reportedCostWeekPresent : t.reportedCostWindowPresent;
    const reportedUsd = week ? t.reportedCostWeekUsd : t.reportedCostWindowUsd;
    const sources = week ? t.reportedCostWeekHarnesses : t.reportedCostWindowHarnesses;

    const share = (part: number, whole: number) => pctStr(whole > 0 ? (part / whole) * 100 : 0);
    const allTokens = of ? (week ? of.totals.tokensWeek : of.totals.tokensWindow) : 0;
    const allSpend = of ? (week ? of.totals.spendWeekUsd : of.totals.spendWindowUsd) : 0;
    const tokenShare = of ? `${share(tokens, allTokens)} of all usage` : undefined;
    const priced = coverage == null ? "no priced tokens" : `${Math.round(coverage)}% of tokens priced`;
    const reportedSub = !reportedPresent
        ? "no source reports cost"
        : of
          ? "recorded by the source"
          : sources.length > 0
            ? `from ${sources.join(" · ")}`
            : "no source reports cost";

    const reportedCard = (
        <StatCard
            label={`Reported cost · ${span}`}
            value={reportedPresent ? usd(reportedUsd) : "—"}
            sub={reportedSub}
        />
    );
    const estimateCard = (
        <StatCard
            label={`API-equivalent · ${span}`}
            value={`≈ ${usd(spend)}`}
            sub={of ? `${share(spend, allSpend)} of all spend · ${priced}` : priced}
        />
    );
    return (
        <motion.div
            data-usage-stats
            variants={cardVariants}
            initial={reveal ? "initial" : false}
            animate="animate"
            className="grid flex-1 grid-cols-2 gap-3 xl:grid-cols-4"
        >
            {estimateCard}
            {reportedCard}
            {week ? (
                <>
                    <StatCard label="Tokens · 7 days" value={fmt(t.tokensWeek)} sub={tokenShare} />
                    <StatCard
                        label="Tokens · today"
                        value={fmt(t.tokensToday)}
                        sub={all ? harnessSub(t.tokensTodayByHarness) : undefined}
                    />
                </>
            ) : (
                <>
                    <StatCard
                        label="Tokens · all time"
                        value={fmt(t.tokensWindow)}
                        sub={all ? harnessSub(t.tokensWindowByHarness) : tokenShare}
                    />
                    <StatCard
                        label="Daily avg"
                        value={fmt(t.activeDays > 0 ? t.tokensWindow / t.activeDays : 0)}
                        sub={`over ${t.activeDays} active day${t.activeDays === 1 ? "" : "s"}`}
                    />
                </>
            )}
        </motion.div>
    );
}

const SKELETON_BARS = ["h-[22%]", "h-[45%]", "h-[30%]", "h-[58%]", "h-[36%]", "h-[70%]", "h-[48%]"];
const SKELETON_LEGEND_ROWS = 6;

function StatsSkeleton() {
    return (
        <div data-usage-skeleton className="grid flex-1 grid-cols-2 gap-3 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
                <div
                    key={i}
                    className="flex h-[92px] flex-col gap-2.5 rounded-[11px] border border-border bg-surface p-4"
                >
                    <SkeletonLine className="h-[9px] w-[70px]" />
                    <SkeletonLine className="h-[18px] w-[90px]" />
                    <SkeletonLine className="h-[7px] w-[120px]" />
                </div>
            ))}
        </div>
    );
}

// the Daily card's footprint: seven columns beside a column of legend lines
function ChartSkeleton() {
    return (
        <div
            data-usage-skeleton
            className="flex h-[330px] gap-7 rounded-[14px] border border-border bg-surface p-[18px]"
        >
            <div className="flex flex-1 items-end gap-4">
                {SKELETON_BARS.map((h, i) => (
                    <SkeletonLine key={i} className={cn("flex-1 rounded-[3px]", h)} />
                ))}
            </div>
            <div className="flex w-[330px] flex-none flex-col gap-3">
                {Array.from({ length: SKELETON_LEGEND_ROWS }, (_, i) => (
                    <SkeletonLine key={i} className="h-[14px]" />
                ))}
            </div>
        </div>
    );
}

export function UsageSurface({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const allStats: UsageStats = useAtomValue(allUsageStatsAtom);
    const providerStats: UsageStats = useAtomValue(model.usageStatsAtom);
    const buckets = useAtomValue(usageBucketsAtom);
    const sessions = useAtomValue(usageSessionsAtom);
    const loadError = useAtomValue(usageErrorAtom);
    const usageLoaded = useAtomValue(usageLoadedAtom);
    const saved = useAtomValue(savedRateLimitsAtom);
    const now = useAtomValue(model.nowAtom);
    const [usageWindow, setUsageWindow] = useAtom(usageWindowAtom);
    const [usageMetric, setUsageMetric] = useAtom(usageMetricAtom);
    // the scope bar's selection and the historical scope filter are the same state, by construction
    const [sel, setSel] = useAtom(model.usageHarnessFilterAtom);
    const [lens, setLens] = useAtom(usageLensAtom);
    const [workScope, setWorkScope] = useAtom(usageWorkScopeAtom);
    const [workItem, setWorkItem] = useAtom(usageWorkItemAtom);
    const [listExpanded, setListExpanded] = useAtom(usageListExpandedAtom);
    const work = lens === "work";

    useEffect(() => {
        const days = usageWindow === "7d" ? 7 : 0;
        void loadUsage(days);
        const refresh = setInterval(() => void loadUsage(days), 60_000);
        return () => clearInterval(refresh);
    }, [usageWindow]);

    const harnesses = useAtomValue(harnessesAtom);
    const catalogOrder = useMemo(() => harnesses.map((h) => h.runtime), [harnesses]);
    const donuts = mergeRateLimitWindows(providerPlanUsage(liveWindowAgents(agents)), saved, now);
    const groups = useMemo(
        () => buildUsageRail(allStats.availableHarnesses, allStats.daily, donuts, catalogOrder),
        [allStats.availableHarnesses, allStats.daily, donuts, catalogOrder]
    );
    const rows = useMemo(() => railRows(groups), [groups]);
    const selRow = rows.find((r) => r.harness === sel);

    const attr = useMemo(() => buildAttribution(buckets, sessions), [buckets, sessions]);
    const scope = useMemo(() => resolveScope(attr, workScope, workItem?.key ?? null), [attr, workScope, workItem]);
    const workStats = useMemo(
        () => (scope.kind === "all" ? allStats : aggregateBuckets(scopeBuckets(buckets, attr, scope), Date.now())),
        [allStats, buckets, attr, scope]
    );
    const stats = work ? workStats : providerStats;

    const selectWork = (scopeKey: string) => {
        setWorkScope(scopeKey);
        setWorkItem(null);
        setListExpanded(false);
    };
    const pickLens = (next: UsageLens) => {
        setLens(next);
        setSel(ALL);
        selectWork(ALL_SCOPE);
    };
    const pickWindow = (next: "7d" | "all") => {
        setUsageWindow(next);
        selectWork(ALL_SCOPE);
    };
    const openItem = (key: string) => {
        const item = attr.items.find((it) => it.key === key);
        if (!item) {
            return;
        }
        setWorkItem({ key, back: workScope });
        setWorkScope(itemScopeKey(attr, item));
        setListExpanded(false);
    };

    // A window reload can remove the selected harness from the rail (e.g. its history falls outside
    // the window and it reports no quota). Fall back to the aggregate so the detail never points at a
    // row that isn't there. Only once loaded — an empty rail mid-load would otherwise reset a
    // deliberate selection on every window switch.
    useEffect(() => {
        if (usageLoaded && sel !== ALL && !rows.some((r) => r.harness === sel)) {
            setSel(ALL);
        }
    }, [usageLoaded, rows, sel, setSel]);
    // the same for By work: a project that left the rail takes its drilled item with it, and an item
    // the window no longer holds falls back to the scope it sat under
    useEffect(() => {
        if (!usageLoaded) {
            return;
        }
        if (workScope !== ALL_SCOPE && !attr.projects.some((p) => p.key === workScope)) {
            setWorkScope(ALL_SCOPE);
            setWorkItem(null);
            setListExpanded(false);
        } else if (workItem != null && !attr.items.some((it) => it.key === workItem.key)) {
            setWorkItem(null);
        }
    }, [usageLoaded, attr, workScope, workItem, setWorkScope, setWorkItem, setListExpanded]);

    const listNav = useMemo<ListNavController>(
        () =>
            work
                ? {
                      surface: "usage",
                      navigableIds: [ALL_SCOPE, ...attr.projects.map((p) => p.key)],
                      cursorId: workItem != null ? undefined : workScope,
                      setCursor: (id) => {
                          setWorkScope(id);
                          setWorkItem(null);
                          setListExpanded(false);
                      },
                  }
                : {
                      surface: "usage",
                      navigableIds: [ALL, ...rows.map((r) => r.harness)],
                      cursorId: sel,
                      setCursor: setSel,
                  },
        [work, attr, workItem, workScope, rows, sel, setSel, setWorkScope, setWorkItem, setListExpanded]
    );
    useSurfaceListNav(listNav);

    const claudeRow = rows.find((r) => r.harness === "claude");
    const weeklyProjectionMs =
        claudeRow?.week.pct != null && claudeRow.week.reset != null
            ? projectWeeklyExhaustion(
                  allStats.daily.map((d) => ({ day: d.day, tokens: d.byHarness.claude?.tokens ?? 0 })),
                  claudeRow.week.pct,
                  claudeRow.week.reset,
                  now
              )
            : null;

    const reporting = countReporting(groups);
    const reportingLabel = `${reporting} of ${rows.length} reporting`;
    // `all` is the unscoped page of whichever lens is on screen
    const all = work ? scope.kind === "all" : sel === ALL;
    // the aggregate can't average independent per-account quotas — it reports whichever is closest to
    // its cap (worstWindow) and says whose it is.
    const fiveHour: AggregateWindow = all ? worstWindow(rows, "fivehour") : (selRow?.fivehour ?? {});
    const week: AggregateWindow = all ? worstWindow(rows, "week") : (selRow?.week ?? {});
    const hasLimits = all ? fiveHour.pct != null || week.pct != null : selRow != null && selRow.state !== "none";
    const projectionForWeek = all
        ? week.harness === "claude"
            ? weeklyProjectionMs
            : null
        : sel === "claude"
          ? weeklyProjectionMs
          : null;

    const hasHistory = stats.models.length > 0 || stats.totals.tokensWindow > 0;
    const revealHistory = useDidBecomeTrue(hasHistory);
    const legend = useMemo(
        () =>
            modelLegend(
                stats.models,
                rows.map((r) => r.harness),
                usageMetric
            ),
        [stats.models, rows, usageMetric]
    );
    const windowLabel = usageWindow === "7d" ? "last 7 days" : "all time";
    const scopeLabel = work
        ? scope.kind === "item"
            ? scope.item.title
            : scope.kind === "project"
              ? scope.project.label
              : "all usage"
        : all
          ? "all usage"
          : providerLabel(sel);
    const emptyFor = work || all ? "" : ` for ${providerLabel(sel)}`;

    const run = scope.kind === "item" && scope.item.runId != null ? scope.item : null;
    const openRun =
        run != null ? (
            <button
                type="button"
                data-usage-open-run
                onClick={() =>
                    fireAndForget(() =>
                        openTarget(
                            model,
                            run.channelId != null
                                ? { kind: "channel", channelId: run.channelId, runId: run.runId }
                                : { kind: "run", runId: run.runId! }
                        )
                    )
                }
                className={cn(QUIET_BUTTON, "flex-none px-3 py-[7px] text-secondary")}
            >
                Open run
            </button>
        ) : null;
    const head = work ? workHead(scope, stats, openRun) : providerHead(sel, stats, reportingLabel);
    const list = work ? scopeList(attr, scope, windowLabel) : null;
    const split = work ? scopeSplit(attr, scope, stats.split) : classSplit(stats.split);
    const selectAll = () => (work ? selectWork(ALL_SCOPE) : setSel(ALL));

    return (
        <MotionConfig reducedMotion="user">
            <div className="flex h-full min-h-0 flex-col bg-background">
                <SurfaceToolbar
                    title="Usage"
                    actions={
                        <>
                            <Segmented<UsageLens>
                                value={lens}
                                onChange={pickLens}
                                role="group"
                                ariaLabel="Lens"
                                options={LENS_OPTIONS}
                            />
                            <Segmented<"7d" | "all">
                                value={usageWindow}
                                onChange={pickWindow}
                                role="group"
                                ariaLabel="Range"
                                options={RANGE_OPTIONS}
                            />
                        </>
                    }
                >
                    {reporting > 0 ? (
                        <ToolbarFact className="text-accent-soft">
                            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                            {reporting} reporting
                        </ToolbarFact>
                    ) : null}
                </SurfaceToolbar>

                {loadError ? <SurfaceError message="Couldn’t refresh — showing the last loaded usage." /> : null}

                <div
                    data-usage-scopes
                    role="group"
                    aria-label="Scope"
                    className="flex flex-none items-center gap-2.5 overflow-x-auto border-b border-edge-faint px-5 py-3"
                >
                    <ScopeCard
                        harness={ALL}
                        active={all}
                        onSelect={selectAll}
                        dot="bg-accent"
                        name="All usage"
                        pill="All"
                        pillColor="var(--color-accent-soft)"
                        tokens={allStats.totals.tokensWindow}
                        spendUsd={allStats.totals.spendWindowUsd}
                        fact="every transcript"
                    />
                    {work ? (
                        <>
                            {attr.projects.map((p) => (
                                <ScopeCard
                                    key={p.key}
                                    project={p.key}
                                    title={p.key}
                                    active={workScope === p.key}
                                    onSelect={() => selectWork(p.key)}
                                    dot="bg-ink-faint"
                                    name={p.label}
                                    pill={pctStr(p.sharePct)}
                                    pillColor="var(--color-accent-soft)"
                                    tokens={p.tokens}
                                    spendUsd={p.spendUsd}
                                    fact={plural(p.count, "run or session", "runs and sessions")}
                                />
                            ))}
                            {attr.other.count > 0 ? (
                                <span
                                    data-usage-other
                                    className="min-w-[180px] max-w-[240px] flex-1 font-mono text-[10.5px] leading-[1.5] text-muted"
                                >
                                    {otherFoldersText(attr.other)}
                                </span>
                            ) : null}
                        </>
                    ) : (
                        rows.map((r) => {
                            const st = stateMeta(r, now);
                            return (
                                <ScopeCard
                                    key={r.harness}
                                    harness={r.harness}
                                    active={sel === r.harness}
                                    onSelect={() => setSel(r.harness)}
                                    dot={providerDot(r.harness)}
                                    name={providerLabel(r.harness)}
                                    pill={st.label}
                                    pillColor={st.color}
                                    tokens={r.tokens}
                                    spendUsd={r.spendUsd}
                                    fact={quotaFact(r)}
                                />
                            );
                        })
                    )}
                </div>

                <div data-usage-detail={work ? scopeId(scope) : sel} className="min-h-0 flex-1 overflow-y-auto">
                    {/* the end clears the avatar by one gap-5, or it covers Where it goes' Total at full scroll */}
                    <div className="flex flex-col gap-5 px-7 pt-[18px]" style={{ paddingBottom: AVATAR_SURFACE_REACH_PX + 20 }}>
                        {work && workItem != null && scope.kind === "item" ? (
                            <button
                                type="button"
                                data-usage-back
                                onClick={() => selectWork(workItem.back)}
                                className={cn(
                                    QUIET_BUTTON,
                                    "-mb-1.5 flex items-center gap-1.5 self-start py-[5px] pl-[7px] pr-[11px] text-ink-mid"
                                )}
                            >
                                <Chevron back />
                                Back to {scopeName(attr, workItem.back)}
                            </button>
                        ) : null}

                        <DetailHeader head={head} />

                        <div className="flex flex-col gap-3 xl:flex-row">
                            {work ? null : (
                                <section className="flex min-w-0 flex-col xl:flex-[2]">
                                    <SectionRule
                                        label="Live limits"
                                        meta={
                                            all
                                                ? "highest reading · ephemeral"
                                                : selRow
                                                  ? stateMeta(selRow, now).long
                                                  : "—"
                                        }
                                    />
                                    {hasLimits ? (
                                        <div className="grid flex-1 grid-cols-2 gap-3">
                                            <LimitCard
                                                kind="fivehour"
                                                title="5-hour"
                                                w={fiveHour}
                                                now={now}
                                                used={
                                                    all && fiveHour.harness
                                                        ? providerLabel(fiveHour.harness)
                                                        : undefined
                                                }
                                            />
                                            <LimitCard
                                                kind="week"
                                                title="Weekly"
                                                w={week}
                                                now={now}
                                                used={all && week.harness ? providerLabel(week.harness) : undefined}
                                                projectedExhaustion={projectionForWeek}
                                            />
                                        </div>
                                    ) : (
                                        <p
                                            data-usage-noquota
                                            className="flex-1 rounded-[11px] border border-border bg-surface px-4 py-3 font-mono text-[11px] leading-[1.55] text-muted"
                                        >
                                            No quota reading{all ? "" : ` for ${providerLabel(sel)}`}. Windows are known
                                            only while an agent that publishes them runs; the last snapshot is kept per
                                            provider, and rolls to empty once its window passes. History below is
                                            unaffected.
                                        </p>
                                    )}
                                </section>
                            )}

                            <section className="flex min-w-0 flex-col xl:flex-[4]">
                                <SectionRule label="Historical" meta={`durable · ${windowLabel}`} />
                                {!usageLoaded ? (
                                    <StatsSkeleton />
                                ) : !hasHistory ? (
                                    <div
                                        data-usage-empty
                                        className="flex min-h-[92px] flex-1 items-center justify-center text-[13px] text-muted"
                                    >
                                        No usage in this window{all ? " — start an agent." : `${emptyFor}.`}
                                    </div>
                                ) : (
                                    <HistoryCards
                                        stats={stats}
                                        window={usageWindow}
                                        all={all}
                                        of={work && !all ? allStats : undefined}
                                        reveal={revealHistory}
                                    />
                                )}
                            </section>
                        </div>

                        {!usageLoaded ? (
                            <ChartSkeleton />
                        ) : hasHistory ? (
                            <motion.div
                                variants={cardVariants}
                                initial={revealHistory ? "initial" : false}
                                animate="animate"
                                className="flex flex-col gap-5"
                            >
                                {list != null ? (
                                    <WorkListCard
                                        list={list}
                                        expanded={listExpanded}
                                        onOpen={openItem}
                                        onToggle={() => setListExpanded(!listExpanded)}
                                    />
                                ) : null}

                                <DailyChart
                                    daily={stats.daily}
                                    window={usageWindow}
                                    metric={usageMetric}
                                    onMetric={setUsageMetric}
                                    legend={legend}
                                />

                                <div
                                    data-usage-split
                                    className="rounded-[14px] border border-border bg-surface-raised px-5 py-[18px]"
                                >
                                    <SectionRule label="Where it goes" meta={`${scopeLabel} · by spend`} />
                                    <SplitTable table={splitTable(split)} />
                                </div>
                            </motion.div>
                        ) : null}
                    </div>
                </div>
            </div>
        </MotionConfig>
    );
}
