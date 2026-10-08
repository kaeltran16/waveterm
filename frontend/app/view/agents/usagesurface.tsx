// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Usage surface (handoff redesign: Wave-usage-redesign.dc.html artboard 1B). Master-detail, the same
// shape Sessions and Radar use: a harness rail on the left grouped by whether the harness reports a
// quota window at all, and a detail pane holding that harness's two trust zones — LIVE LIMITS
// (ephemeral 5h/weekly quota, merged live-over-saved via ratelimitstore so it survives idle) and
// HISTORICAL (durable token-class split, daily series, per-model breakdown, folded from the backend
// usage scan). Rail selection IS usageHarnessFilterAtom, so the scope picker and the historical
// filter are one piece of state rather than two that can disagree; that atom re-aggregates
// model.usageStatsAtom, so the detail is simply the surface scoped to one harness.
// Loads on mount + a 60s refresh for the current window; a 1s tick keeps reset countdowns current.
// A second lens, By work, re-scopes the same detail page to what the usage paid for: all usage, a
// project, a run or a session (usageattribution.ts). It has no Live limits: quota is per provider.

import { Meter, StackedMeter } from "@/app/element/meter";
import { useDidBecomeTrue } from "@/app/element/motionhooks";
import { cardVariants } from "@/app/element/motiontokens";
import { Segmented } from "@/app/element/segmented";
import { SkeletonLine } from "@/app/element/skeleton";
import { useSurfaceListNav, type ListNavController } from "@/app/store/keybindings/listnav";
import { REGION_LABEL } from "@/app/view/jarvis/briefstyle";
import { openTarget } from "@/app/view/jarvis/openref";
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
import { runtimeMeta } from "./runtimemeta";
import { SurfaceError, SurfaceHeader } from "./surfacescaffold";
import {
    ALL_SCOPE,
    buildAttribution,
    classSplit,
    itemScopeKey,
    kindLabel,
    listPage,
    otherFoldersText,
    plural,
    resolveScope,
    scopeBuckets,
    scopeId,
    scopeList,
    scopeName,
    scopeSplit,
    type ProjectUsage,
    type WorkList,
    type WorkScope,
    type WorkSplit,
} from "./usageattribution";
import {
    buildUsageRail,
    countReporting,
    railRows,
    worstWindow,
    type AggregateWindow,
    type UsageRailGroup,
    type UsageRailRow,
} from "./usagerail";
import type { ProviderUsage, UsageStats } from "./usagestats";
import { aggregateBuckets, fmt, foldModels, modelGridClass, pctStr, usd } from "./usagestats";
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
// Ranked magnitude within one provider is an ORDINAL job, not categorical: one hue, monotone
// lightness, indexed by rank. Four stops off the existing accent scale — no new colors. Stops are two
// apart so adjacent ranks stay tellable; --color-accent sits next to --color-accent-300 on the ramp.
const MODEL_SEQ = ["bg-accent-200", "bg-accent-400", "bg-accent-600", "bg-accent-800"];
const MAX_MODEL_ROWS = MODEL_SEQ.length;

// Selected/idle treatment for a rail row, matching the Sessions rail (the surface this body is
// modeled on) rather than minting a second selection vocabulary for one surface.
const ROW_BASE =
    "cursor-pointer rounded-[11px] border px-[13px] py-[11px] text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
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

// An h3, not a styled span: these head real sections (and the by-model cards, where the heading IS the
// provider name), so the heading level has to survive the eyebrow styling.
function SectionRule({ label, meta, accent = false }: { label: string; meta?: string; accent?: boolean }) {
    return (
        <div className="mb-3 flex items-center gap-2.5">
            <h3 className={cn(REGION_LABEL, accent ? "text-accent-soft" : "text-muted")}>{label}</h3>
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

function RailRow({
    row,
    active,
    now,
    onSelect,
}: {
    row: UsageRailRow;
    active: boolean;
    now: number;
    onSelect: () => void;
}) {
    const st = stateMeta(row, now);
    return (
        <motion.button
            layout
            variants={cardVariants}
            initial="initial"
            animate="animate"
            type="button"
            data-usage-harness={row.harness}
            aria-pressed={active}
            onClick={onSelect}
            className={cn("flex flex-col gap-2", ROW_BASE, active ? ROW_ON : ROW_OFF)}
        >
            <span className="flex items-center gap-2.5">
                <span className={cn("h-2 w-2 flex-none rounded-full", providerDot(row.harness))} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-primary">
                    {providerLabel(row.harness)}
                </span>
                <span
                    className="flex-none rounded-[4px] px-1.5 py-0.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.06em]"
                    style={{ color: st.color, backgroundColor: PILL_TINT }}
                >
                    {st.label}
                </span>
            </span>
            <span className="flex items-center gap-2 font-mono text-[10.5px] text-muted">
                <span className="text-secondary">{fmt(row.tokens)} tok</span>
                <span className="text-muted">·</span>
                <span>≈ {usd(row.spendUsd)}</span>
                <span className="flex-1" />
                {row.state === "none" ? (
                    <span>history only</span>
                ) : (
                    <>
                        <span>5h {row.fivehour.pct != null ? Math.round(row.fivehour.pct) + "%" : "—"}</span>
                        <span className="text-muted">·</span>
                        <span>wk {row.week.pct != null ? Math.round(row.week.pct) + "%" : "—"}</span>
                    </>
                )}
            </span>
        </motion.button>
    );
}

function ProjectRow({ project, active, onSelect }: { project: ProjectUsage; active: boolean; onSelect: () => void }) {
    return (
        <button
            type="button"
            data-usage-project={project.key}
            aria-pressed={active}
            title={project.key}
            onClick={onSelect}
            className={cn("flex flex-col gap-2", ROW_BASE, active ? ROW_ON : ROW_OFF)}
        >
            <span className="flex items-center gap-2.5">
                <span className="h-2 w-2 flex-none rounded-full bg-ink-faint" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-primary">{project.label}</span>
                <span
                    className="flex-none rounded-[4px] px-1.5 py-0.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.06em]"
                    style={{ color: "var(--color-accent-soft)", backgroundColor: PILL_TINT }}
                >
                    {pctStr(project.sharePct)}
                </span>
            </span>
            <span className="flex items-center gap-2 font-mono text-[10.5px] text-muted">
                <span className="text-secondary">{fmt(project.tokens)} tok</span>
                <span className="text-muted">·</span>
                <span>≈ {usd(project.spendUsd)}</span>
                <span className="flex-1" />
                <span>{plural(project.count, "run or session", "runs and sessions")}</span>
            </span>
        </button>
    );
}

const LENS_OPTIONS: { key: UsageLens; label: string }[] = [
    { key: "provider", label: "By provider" },
    { key: "work", label: "By work" },
];

// The rail's fixed top (All usage, then the lens switch) over the rows of the lens on screen.
function UsageRail({
    allOn,
    totalTokens,
    onAll,
    lens,
    onLens,
    children,
}: {
    allOn: boolean;
    totalTokens: number;
    onAll: () => void;
    lens: UsageLens;
    onLens: (lens: UsageLens) => void;
    children: ReactNode;
}) {
    return (
        <div className="w-[392px] flex-none overflow-y-auto border-r border-edge-faint p-3 pb-10">
            <button
                type="button"
                data-usage-harness={ALL}
                aria-pressed={allOn}
                onClick={onAll}
                className={cn("mb-3.5 flex w-full items-center gap-[11px]", ROW_BASE, allOn ? ROW_ON : ROW_OFF)}
            >
                <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px] border border-accent bg-accentbg font-mono text-[14px] font-semibold text-accent-soft">
                    Σ
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-primary">All usage</span>
                    <span className="block font-mono text-[11px] text-muted">every transcript in window</span>
                </span>
                <span className="flex-none rounded-full bg-surface-hover px-2 py-0.5 font-mono text-[11px] text-secondary">
                    {fmt(totalTokens)}
                </span>
            </button>

            <div className="mb-3.5 flex rounded border border-border bg-surface-raised p-[3px]">
                {LENS_OPTIONS.map((o) => (
                    <button
                        key={o.key}
                        type="button"
                        data-usage-lens={o.key}
                        aria-pressed={lens === o.key}
                        onClick={() => onLens(o.key)}
                        className={cn(
                            "flex-1 cursor-pointer rounded-sm border-0 px-[12px] py-[6px] font-mono text-[11px] font-semibold",
                            lens === o.key ? "bg-accentbg text-primary" : "bg-transparent text-muted"
                        )}
                    >
                        {o.label}
                    </button>
                ))}
            </div>

            {children}
        </div>
    );
}

function ProviderRows({
    groups,
    sel,
    now,
    onSelect,
}: {
    groups: UsageRailGroup[];
    sel: string;
    now: number;
    onSelect: (id: string) => void;
}) {
    return (
        <>
            {groups.map((g) => (
                <div key={g.key} className="mb-3.5">
                    <SectionRule label={g.label} meta={String(g.rows.length)} accent={g.key === "reporting"} />
                    <div className="flex flex-col gap-[7px]">
                        {g.rows.map((r) => (
                            <RailRow
                                key={r.harness}
                                row={r}
                                active={sel === r.harness}
                                now={now}
                                onSelect={() => onSelect(r.harness)}
                            />
                        ))}
                    </div>
                </div>
            ))}
        </>
    );
}

function ProjectRows({
    projects,
    other,
    sel,
    onSelect,
}: {
    projects: ProjectUsage[];
    other: string | null;
    sel: string;
    onSelect: (key: string) => void;
}) {
    return (
        <div className="mb-3.5">
            <SectionRule label="Projects" meta={String(projects.length)} />
            <div className="flex flex-col gap-[7px]">
                {projects.map((p) => (
                    <ProjectRow key={p.key} project={p} active={sel === p.key} onSelect={() => onSelect(p.key)} />
                ))}
                {other != null ? (
                    <div data-usage-other className="px-[13px] py-1 font-mono text-[10.5px] leading-[1.5] text-muted">
                        {other}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

// Where it goes: the same two bars over whatever the scope divides into (token classes for a provider
// or a single session; projects, kinds of work or roles in By work).
function SplitCard({ split, scope }: { split: WorkSplit; scope: string }) {
    const { parts } = split;
    const tokTotal = parts.reduce((s, c) => s + c.tokens, 0);
    const spdTotal = parts.reduce((s, c) => s + c.spendUsd, 0);
    return (
        <div data-usage-split className="mb-3.5 rounded-[14px] border border-border bg-surface-raised px-5 py-[18px]">
            <SectionRule label="Where it goes" meta={scope} />
            <p className="mb-[18px] max-w-[680px] text-[12.5px] leading-[1.55] text-secondary">{split.note}</p>

            <div className="mb-[7px] flex items-baseline justify-between">
                <span className="font-mono text-[10.5px] font-semibold text-ink-mid">Tokens</span>
                <span className="font-mono text-[12px] font-bold text-primary">{fmt(tokTotal)}</span>
            </div>
            <StackedMeter
                className="mb-4"
                height={26}
                radius={7}
                track="bg-background"
                segs={parts.map((c) => ({ key: c.key, value: c.tokens, fill: c.fill }))}
            />

            <div className="mb-[7px] flex items-baseline justify-between">
                <span className="font-mono text-[10.5px] font-semibold text-ink-mid">
                    Spend <span className="font-medium text-muted">≈ API-equiv</span>
                </span>
                <span className="font-mono text-[12px] font-bold text-primary">{usd(spdTotal)}</span>
            </div>
            <StackedMeter
                className="mb-[18px]"
                height={26}
                radius={7}
                track="bg-background"
                segs={parts.map((c) => ({ key: c.key, value: c.spendUsd, fill: c.fill }))}
            />

            <div className="grid grid-cols-2 gap-x-3 gap-y-3.5 border-t border-edge-faint pt-[15px] lg:grid-cols-3 xl:grid-cols-5">
                {parts.map((c) => (
                    <div key={c.key} data-usage-split-part={c.key}>
                        <div className="mb-[7px] flex items-center gap-[7px]">
                            <span className={cn("h-[9px] w-[9px] flex-none rounded-[3px]", c.fill)} />
                            <span className="min-w-0 truncate text-[11.5px] font-semibold text-secondary">
                                {c.label}
                            </span>
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

// Grouped by UPSTREAM provider ("anthropic" | "openai"), which is what the transcript buckets carry —
// deliberately a different axis from the harness rail, so the heading names the provider raw.
function ModelGroup({ p }: { p: ProviderUsage }) {
    return (
        <div className="rounded-[14px] border border-border bg-surface-raised px-5 py-[18px]">
            <SectionRule label={p.provider} meta={fmt(p.tokens)} />
            {foldModels(p.models, MAX_MODEL_ROWS).map((m, i) => (
                <div key={m.model} className="mb-3">
                    <div className="mb-1.5 flex items-baseline justify-between gap-3">
                        {/* the provider prefix is what tells Pi's openai-codex/gpt-5.5 from Codex's
                            openai/gpt-5.5 — same model id, different upstream bucket */}
                        <span
                            className="min-w-0 truncate font-mono text-[11.5px] text-secondary"
                            title={`${p.provider}/${m.model}`}
                        >
                            {m.model === "Other" ? m.model : `${p.provider}/${m.model}`}
                        </span>
                        <span className="flex-none font-mono text-[10.5px] text-muted">
                            {fmt(m.tokens)} · <span className="font-semibold text-secondary">{pctStr(m.pct)}</span>
                        </span>
                    </div>
                    <Meter pct={m.pct} fill={MODEL_SEQ[i]} height={7} radius={4} track="bg-edge-strong" />
                </div>
            ))}
        </div>
    );
}

interface DetailHead {
    glyph: string;
    glyphClass: string;
    title: string;
    pill: string;
    pillColor: string; // a var() reference; it also tints the pill behind the text
    meta: [string, string][];
    action?: ReactNode;
}

const AGGREGATE_GLYPH = "border-accent bg-accentbg text-accent-soft";
const AGGREGATE_PILL = "var(--color-accent-soft)";

// the header meta every scope shares, after whatever names the scope itself
function statsMeta(stats: UsageStats): [string, string][] {
    const reported = stats.totals.reportedCostWindowPresent ? usd(stats.totals.reportedCostWindowUsd) : "not reported";
    const modelCount = stats.providers.reduce((s, p) => s + p.models.length, 0);
    return [
        ["tokens", fmt(stats.totals.tokensWindow)],
        ["reported", reported],
        ["api-equiv", `≈ ${usd(stats.totals.spendWindowUsd)}`],
        ["models", String(modelCount)],
    ];
}

function providerHead(
    sel: string,
    row: UsageRailRow | undefined,
    stats: UsageStats,
    now: number,
    reportingLabel: string
): DetailHead {
    if (sel === ALL) {
        return {
            glyph: "Σ",
            glyphClass: AGGREGATE_GLYPH,
            title: "All usage",
            pill: "Aggregate",
            pillColor: AGGREGATE_PILL,
            meta: [...statsMeta(stats), ["quota", reportingLabel]],
        };
    }
    const meta = runtimeMeta(sel);
    const st = row != null ? stateMeta(row, now) : null;
    return {
        glyph: meta.glyph,
        glyphClass: cn(meta.line, meta.softBg, meta.text),
        title: providerLabel(sel),
        pill: st?.label ?? "No reading",
        pillColor: st?.color ?? "var(--color-muted)",
        meta: statsMeta(stats),
    };
}

function workHead(scope: WorkScope, stats: UsageStats, action: ReactNode): DetailHead {
    const base = { glyphClass: AGGREGATE_GLYPH, pillColor: AGGREGATE_PILL };
    if (scope.kind === "all") {
        return { ...base, glyph: "Σ", title: "All usage", pill: "Aggregate", meta: statsMeta(stats) };
    }
    if (scope.kind === "project") {
        const { label, count } = scope.project;
        return {
            ...base,
            glyph: label.charAt(0).toUpperCase(),
            title: label,
            pill: "Project",
            meta: [["runs and sessions", String(count)], ...statsMeta(stats)],
        };
    }
    const { item } = scope;
    const named: [string, string][] = item.projectLabel !== "" ? [["project", item.projectLabel]] : [];
    return {
        ...base,
        glyph: item.kind === "session" ? "S" : "R",
        title: item.title,
        pill: kindLabel(item.kind),
        meta: [...named, ["sessions", String(item.sessions.length)], ...statsMeta(stats)],
        action,
    };
}

function DetailHeader({ head }: { head: DetailHead }) {
    return (
        <div className="mb-5 flex items-start gap-3.5 border-b border-edge-faint pb-4">
            <span
                className={cn(
                    "flex h-[42px] w-[42px] flex-none items-center justify-center rounded-[11px] border font-mono text-[15px] font-semibold",
                    head.glyphClass
                )}
            >
                {head.glyph}
            </span>
            <div className="min-w-0 flex-1">
                <div className="mb-1.5 flex items-center gap-2.5">
                    <h2 className="min-w-0 truncate text-[19px] font-bold tracking-[-0.01em] text-primary">
                        {head.title}
                    </h2>
                    <span
                        className="flex-none rounded-[5px] px-1.5 py-[3px] font-mono text-[10.5px] font-bold uppercase tracking-[0.06em]"
                        style={{ color: head.pillColor, backgroundColor: PILL_TINT }}
                    >
                        {head.pill}
                    </span>
                </div>
                <div className="flex flex-wrap gap-x-2.5 gap-y-1 font-mono text-[11px] text-muted">
                    {head.meta.map(([k, v]) => (
                        <span key={k}>
                            {k} <span className="text-secondary">{v}</span>
                        </span>
                    ))}
                </div>
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
        <div data-usage-list className="mb-3.5 rounded-[14px] border border-border bg-surface-raised px-5 py-[18px]">
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
}: {
    stats: UsageStats;
    window: "7d" | "all";
    all: boolean;
    of?: UsageStats;
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
        <div className="mb-3.5 grid grid-cols-2 gap-3 xl:grid-cols-4">
            {week ? (
                <>
                    <StatCard
                        label="Tokens · today"
                        value={fmt(t.tokensToday)}
                        sub={all ? harnessSub(t.tokensTodayByHarness) : undefined}
                    />
                    <StatCard label="Tokens · 7 days" value={fmt(t.tokensWeek)} sub={tokenShare} />
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
            {reportedCard}
            {estimateCard}
        </div>
    );
}

function UsageHistorySkeleton() {
    return (
        <div>
            <div className="mb-3.5 grid grid-cols-2 gap-3 xl:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="rounded-[11px] border border-border bg-surface-raised px-4 py-[14px]">
                        <SkeletonLine className="mb-3 h-[11px] w-[72px]" />
                        <SkeletonLine className="mb-2 h-[21px] w-[92px]" />
                        <SkeletonLine className="h-[10px] w-[118px]" />
                    </div>
                ))}
            </div>
            <div className="mb-3.5 rounded-[14px] border border-border bg-surface-raised px-5 py-[18px]">
                <SkeletonLine className="mb-3 h-[13px] w-[128px]" />
                <SkeletonLine className="mb-[18px] h-[12px] w-[62%]" />
                <SkeletonLine className="mb-4 h-[26px] w-full rounded-[7px]" />
                <SkeletonLine className="h-[26px] w-full rounded-[7px]" />
            </div>
            <div className="rounded-[14px] border border-border bg-surface-raised px-5 py-[18px]">
                <SkeletonLine className="mb-5 h-[13px] w-[92px]" />
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
    // the rail's selection and the historical scope filter are the same state, by construction
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

    const hasHistory = stats.providers.length > 0 || stats.totals.tokensWindow > 0;
    const revealHistory = useDidBecomeTrue(hasHistory);
    const railHarnesses = rows.map((r) => r.harness);
    const chartHarnesses = work
        ? all
            ? railHarnesses
            : railHarnesses.filter((h) => (stats.totals.tokensWindowByHarness[h] ?? 0) > 0)
        : all
          ? railHarnesses
          : [sel];
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
    const head = work ? workHead(scope, stats, openRun) : providerHead(sel, selRow, stats, now, reportingLabel);
    const list = work ? scopeList(attr, scope, windowLabel) : null;
    const split = work ? scopeSplit(attr, scope, stats.split) : classSplit(stats.split);

    return (
        <MotionConfig reducedMotion="user">
            <div className="flex h-full min-h-0 flex-col bg-background">
                <SurfaceHeader
                    title="Usage"
                    badge={
                        reporting > 0 ? (
                            <span className="inline-flex items-center gap-1.5 rounded-sm border border-accent bg-accentbg px-2 py-[3px] font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-accent-soft">
                                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                                {reporting} reporting
                            </span>
                        ) : null
                    }
                    subtitle={
                        <span className="block max-w-[680px] leading-[1.5]">
                            Live provider quota while agents run, and the durable history behind it. Pick a scope on the
                            left, by provider or by the work it paid for; reported cost is what each agent source
                            recorded, the API-equivalent estimate comes from a bundled price table. Neither is a bill.
                        </span>
                    }
                    actions={
                        <Segmented<"7d" | "all">
                            value={usageWindow}
                            onChange={pickWindow}
                            options={[
                                { key: "7d", label: "7 days" },
                                { key: "all", label: "All time" },
                            ]}
                        />
                    }
                />

                {loadError ? <SurfaceError message="Couldn’t refresh — showing the last loaded usage." /> : null}

                <div className="flex min-h-0 flex-1">
                    <UsageRail
                        allOn={all}
                        totalTokens={allStats.totals.tokensWindow}
                        onAll={() => (work ? selectWork(ALL_SCOPE) : setSel(ALL))}
                        lens={lens}
                        onLens={pickLens}
                    >
                        {work ? (
                            <ProjectRows
                                projects={attr.projects}
                                other={attr.other.count > 0 ? otherFoldersText(attr.other) : null}
                                sel={workScope}
                                onSelect={selectWork}
                            />
                        ) : (
                            <ProviderRows groups={groups} sel={sel} now={now} onSelect={setSel} />
                        )}
                    </UsageRail>

                    <div
                        data-usage-detail={work ? scopeId(scope) : sel}
                        className="min-w-0 flex-1 overflow-y-auto px-7 pb-12 pt-5"
                    >
                        {work && workItem != null && scope.kind === "item" ? (
                            <button
                                type="button"
                                data-usage-back
                                onClick={() => selectWork(workItem.back)}
                                className={cn(
                                    QUIET_BUTTON,
                                    "mb-3.5 flex items-center gap-1.5 py-[5px] pl-[7px] pr-[11px] text-ink-mid"
                                )}
                            >
                                <Chevron back />
                                Back to {scopeName(attr, workItem.back)}
                            </button>
                        ) : null}

                        <DetailHeader head={head} />

                        {work ? null : (
                            <>
                                <SectionRule
                                    label="Live limits"
                                    meta={
                                        all ? "highest reading · ephemeral" : selRow ? stateMeta(selRow, now).long : "—"
                                    }
                                />
                                {hasLimits ? (
                                    <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                                        <LimitCard
                                            kind="fivehour"
                                            title="5-hour"
                                            w={fiveHour}
                                            now={now}
                                            used={all && fiveHour.harness ? providerLabel(fiveHour.harness) : undefined}
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
                                    <p className="mb-6 rounded-[11px] border border-border bg-surface px-4 py-3 font-mono text-[11px] leading-[1.55] text-muted">
                                        No quota reading{all ? "" : ` for ${providerLabel(sel)}`}. Windows are known
                                        only while an agent that publishes them runs; the last snapshot is kept per
                                        provider, and rolls to empty once its window passes. History below is
                                        unaffected.
                                    </p>
                                )}
                            </>
                        )}

                        <SectionRule label="Historical" meta={`durable · ${windowLabel}`} />

                        {!usageLoaded ? (
                            <UsageHistorySkeleton />
                        ) : !hasHistory ? (
                            <div className="mt-10 text-center text-[13px] text-muted">
                                No usage in this window{all ? " — start an agent." : `${emptyFor}.`}
                            </div>
                        ) : (
                            <motion.div
                                variants={cardVariants}
                                initial={revealHistory ? "initial" : false}
                                animate="animate"
                            >
                                <HistoryCards
                                    stats={stats}
                                    window={usageWindow}
                                    all={all}
                                    of={work && !all ? allStats : undefined}
                                />

                                {list != null ? (
                                    <WorkListCard
                                        list={list}
                                        expanded={listExpanded}
                                        onOpen={openItem}
                                        onToggle={() => setListExpanded(!listExpanded)}
                                    />
                                ) : null}

                                <SplitCard split={split} scope={scopeLabel} />

                                <DailyChart
                                    daily={stats.daily}
                                    window={usageWindow}
                                    metric={usageMetric}
                                    onMetric={setUsageMetric}
                                    harnesses={chartHarnesses}
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
            </div>
        </MotionConfig>
    );
}
