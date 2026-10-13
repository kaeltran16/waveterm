// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Usage tab's one real chart: daily columns stacked by model over a band day-axis, beside a
// legend grouped by harness. On visx for scales/ticks/tooltip, but the bars are motion.rect so the
// cockpit keeps ONE animation system —
// visx supplies no animation of its own, which is why it was chosen over recharts (whose built-in
// tween re-grows from the baseline on every data change, and usagesurface refreshes silently every 60s).
//
// Split out of usagesurface.tsx: it is the largest component there and its tooltip/brush change with it.

import { MOTION, easeFluidCss } from "@/app/element/motiontokens";
import { Segmented } from "@/app/element/segmented";
import useResizeObserver from "@react-hook/resize-observer";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { Brush } from "@visx/brush";
import { scaleBand, scaleLinear } from "@visx/scale";
import { useTooltip, useTooltipInPortal } from "@visx/tooltip";
import { motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useState } from "react";
import {
    legendSeries,
    modelRows,
    type LegendGroup,
    type LegendModel,
    type ModelRow,
    type UsageMetric,
} from "./usagedaily";
import { fmt, pctStr, usd, type DailyUsage } from "./usagestats";

// the plot's floor; it grows past this to the side legend's height
const PLOT_MIN_H = 240;
const BRUSH_H = 28;
// the brush svg (BRUSH_H + 18) plus its mt-1
const BRUSH_BLOCK_H = BRUSH_H + 18 + 4;
const MARGIN = { top: 6, right: 4, bottom: 22, left: 46 };
const BAR_MAX = 30;
// Above this many columns the per-column entrance is dropped and the bars snap in. The cascade is
// delay: ri * 0.025, which was written when the series was capped at 30 days (0.75s). Uncapped, an
// all-time range animates hundreds of SVG rects on a staggered clock: measured over CDP, a 113-day
// range had painted only 13% of its bars 3.2s after mount, so the chart read as EMPTY on arrival.
// A cascade across hundreds of columns communicates nothing anyway — it only reads as motion at small n.
const STAGGER_MAX_COLS = 40;
// A rect's rx rounds ALL FOUR corners, so using it for the top segment made that segment read as a
// detached pill floating above a square bar instead of as the cap of one stack. The stack has to read as
// a single bar: rounded top, flat baseline. Hence paths with top-only corners — the lower segment goes
// fully square whenever something sits above it. (The pre-visx chart got this from `rounded-t-[3px]`.)
function barPath(x: number, y: number, w: number, h: number, r: number): string {
    const rr = Math.max(0, Math.min(r, w / 2, h));
    if (rr === 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
    return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function DailyChart({
    daily,
    window: win,
    metric,
    onMetric,
    legend,
}: {
    daily: DailyUsage[];
    window: "7d" | "all";
    metric: UsageMetric;
    onMetric: (m: UsageMetric) => void;
    legend: LegendGroup[];
}) {
    const reduce = useReducedMotion();
    // the host as state, not a ref: it mounts late whenever the chart first shows "No activity"
    const [host, setHost] = useState<HTMLDivElement | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    useLayoutEffect(() => {
        if (host) setSize({ width: host.clientWidth, height: host.clientHeight });
    }, [host]);
    useResizeObserver(host, (e) => setSize({ width: e.contentRect.width, height: e.contentRect.height }));
    const width = size.width;

    const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } = useTooltip<ModelRow>();
    const { containerRef, TooltipInPortal } = useTooltipInPortal({ scroll: true, detectBounds: true });

    const series = legendSeries(legend);
    const only = series.length === 1 ? series[0] : null;
    const rows = modelRows(
        daily,
        series.map((m) => m.key),
        metric
    );
    const [range, setRange] = useState<[number, number] | null>(null);
    // All-time can span years; 7d never needs a brush. Reset the range when the window or the row
    // count changes so a stale slice can't outlive its data.
    const showBrush = win === "all" && rows.length > 14;
    useLayoutEffect(() => {
        setRange(null);
    }, [win, rows.length]);
    const [lo, hi] = range ?? [0, rows.length - 1];
    const view = showBrush ? rows.slice(lo, hi + 1) : rows;

    const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
    const brushH = showBrush ? BRUSH_BLOCK_H : 0;
    // the host stretches to the legend; its content is absolutely placed so the plot it sizes never
    // feeds back into the host's own height
    const hostMinH = PLOT_MIN_H + MARGIN.top + MARGIN.bottom + brushH;
    const plotH = Math.max(PLOT_MIN_H, size.height - brushH - MARGIN.top - MARGIN.bottom);
    const axisFmt = (v: number) => (metric === "tokens" ? fmt(v) : usd(v));

    const x = scaleBand<string>({ domain: view.map((r) => r.day), range: [0, innerW], padding: 0.28 });
    const y = scaleLinear<number>({
        domain: [0, Math.max(1, ...view.map((r) => r.total))],
        range: [plotH, 0],
        nice: true,
    });
    const bandW = Math.min(BAR_MAX, x.bandwidth());
    const cascade = view.length <= STAGGER_MAX_COLS;
    // thin day labels so they never collide: keep every nth so at most ~12 render
    const tickEvery = Math.max(1, Math.ceil(view.length / 12));
    const tickDays = view.filter((_, i) => i % tickEvery === 0).map((r) => r.day);

    // The brush runs over day INDEX on a linear scale, not the band scale: @visx/brush is unreliable
    // over scaleBand, and an index pair is exactly what the slice above needs.
    const bx = scaleBand<number>({ domain: rows.map((_, i) => i), range: [0, innerW], padding: 0.2 });
    const bxLinear = scaleLinear<number>({ domain: [0, Math.max(1, rows.length - 1)], range: [0, innerW] });
    const byLinear = scaleLinear<number>({ domain: [0, 1], range: [BRUSH_H, 0] });
    const brushMax = Math.max(1, ...rows.map((r) => r.total));

    // Cumulative y-offset from the bottom for each model segment (legend order, bottom-up), plus the
    // height of the top (highest) non-zero segment — only that one gets rounded top corners.
    function segmentOffsets(r: ModelRow): { offsets: number[]; top: { index: number; h: number } | null } {
        const offsets: number[] = [];
        let acc = 0;
        let top: { index: number; h: number } | null = null;
        series.forEach((m, i) => {
            const v = r.values[m.key] ?? 0;
            offsets.push(acc);
            if (v > 0) {
                acc += v;
                top = { index: i, h: v };
            }
        });
        return { offsets, top };
    }

    return (
        <div
            data-usage-daily
            className="flex flex-col gap-[14px] rounded-[14px] border border-border bg-surface-raised px-5 pb-[18px] pt-[18px]"
        >
            <div className="flex flex-wrap items-center gap-[10px]">
                <h3 className="text-[14px] font-semibold text-primary">Daily</h3>
                <span className="font-mono text-[11px] text-muted">
                    {win === "7d"
                        ? "last 7 days · by model"
                        : view.length === rows.length
                          ? "all time · by model"
                          : `${view[0]?.day ?? ""} – ${view[view.length - 1]?.day ?? ""}`}
                </span>
                <div className="flex-1" />
                {only != null ? (
                    <span
                        data-usage-daily-only
                        className="flex items-center gap-[6px] font-mono text-[11px] text-muted"
                    >
                        <Swatch fill={only.fill} />
                        <span className="text-secondary" title={only.title}>
                            {only.model}
                        </span>
                        <span>
                            <span className="text-secondary">{axisFmt(only.value)}</span> · {pctStr(only.pct)}
                        </span>
                    </span>
                ) : null}
                <Segmented
                    value={metric}
                    onChange={onMetric}
                    role="group"
                    ariaLabel="Metric"
                    options={[
                        { key: "tokens" as const, label: "Tokens" },
                        { key: "spend" as const, label: "Spend" },
                    ]}
                />
            </div>

            {rows.length === 0 || series.length === 0 ? (
                <div className="py-8 text-center font-mono text-[12px] text-muted">No activity in range.</div>
            ) : (
                <div className="flex gap-[28px]">
                    <div ref={setHost} className="relative min-w-0 flex-1" style={{ minHeight: hostMinH }}>
                        <div className="absolute inset-0">
                            <svg ref={containerRef} width={width} height={plotH + MARGIN.top + MARGIN.bottom}>
                                <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
                                    <AxisLeft
                                        scale={y}
                                        numTicks={3}
                                        tickFormat={(v) => axisFmt(Number(v))}
                                        stroke="var(--color-border)"
                                        tickStroke="var(--color-border)"
                                        tickLabelProps={() => ({
                                            fill: "var(--color-muted)",
                                            fontSize: 10.5,
                                            fontFamily: "var(--font-mono)",
                                            textAnchor: "end",
                                            dx: -4,
                                            dy: 3,
                                        })}
                                    />
                                    <AxisBottom
                                        top={plotH}
                                        scale={x}
                                        tickValues={tickDays}
                                        stroke="var(--color-border)"
                                        tickStroke="var(--color-border)"
                                        tickLabelProps={() => ({
                                            fill: "var(--color-muted)",
                                            fontSize: 10.5,
                                            fontFamily: "var(--font-mono)",
                                            textAnchor: "middle",
                                            dy: 2,
                                        })}
                                    />
                                    {view.map((r, ri) => {
                                        const cx = (x(r.day) ?? 0) + (x.bandwidth() - bandW) / 2;
                                        const { offsets, top } = segmentOffsets(r);
                                        const grow =
                                            reduce || !cascade
                                                ? {}
                                                : {
                                                      initial: { scaleY: 0 },
                                                      animate: { scaleY: 1 },
                                                      transition: {
                                                          delay: ri * 0.025,
                                                          duration: MOTION.durMacro,
                                                          ease: MOTION.easeFluid,
                                                      },
                                                  };
                                        // SVG needs transformBox:fill-box for transformOrigin:bottom to mean what
                                        // it means on a DOM element
                                        const originStyle = {
                                            transformBox: "fill-box" as const,
                                            transformOrigin: "bottom",
                                            transition: reduce
                                                ? undefined
                                                : `height ${MOTION.durMacro}s ${easeFluidCss}`,
                                        };
                                        const onEnter = () =>
                                            showTooltip({
                                                tooltipData: r,
                                                tooltipLeft: MARGIN.left + cx + bandW / 2,
                                                tooltipTop: MARGIN.top + Math.max(0, y(r.total) - 12),
                                            });
                                        return (
                                            <g key={r.day} onMouseEnter={onEnter} onMouseLeave={hideTooltip}>
                                                {/* hit target spans the whole column, wider than the mark */}
                                                <rect
                                                    x={x(r.day) ?? 0}
                                                    y={0}
                                                    width={x.bandwidth()}
                                                    height={plotH}
                                                    fill="transparent"
                                                />
                                                {tooltipOpen && tooltipData?.day === r.day ? (
                                                    <rect
                                                        x={x(r.day) ?? 0}
                                                        y={0}
                                                        width={x.bandwidth()}
                                                        height={plotH}
                                                        fill="var(--color-surface-hover)"
                                                        rx={3}
                                                    />
                                                ) : null}
                                                {r.total === 0 ? (
                                                    <rect
                                                        x={cx}
                                                        y={plotH - 2}
                                                        width={bandW}
                                                        height={2}
                                                        rx={1}
                                                        fill="var(--color-edge-strong)"
                                                    />
                                                ) : null}
                                                {series.map((m, i) => {
                                                    const v = r.values[m.key] ?? 0;
                                                    if (v <= 0) {
                                                        return null;
                                                    }
                                                    const hPx = plotH - y(v);
                                                    const yPx = y(offsets[i] + v);
                                                    const radius = top?.index === i ? 4 : 0;
                                                    return (
                                                        <motion.path
                                                            key={m.key}
                                                            {...grow}
                                                            d={barPath(cx, yPx, bandW, hPx, radius)}
                                                            fill={m.fill}
                                                            style={originStyle}
                                                        />
                                                    );
                                                })}
                                            </g>
                                        );
                                    })}
                                </g>
                            </svg>

                            {showBrush ? (
                                <svg width={width} height={BRUSH_H + 18} className="mt-1">
                                    <g transform={`translate(${MARGIN.left},4)`}>
                                        {rows.map((r, ri) => {
                                            const h = Math.round((r.total / brushMax) * BRUSH_H);
                                            return (
                                                <rect
                                                    key={r.day}
                                                    x={(bx(ri) ?? 0) + 0.5}
                                                    y={BRUSH_H - h}
                                                    width={Math.max(1, bx.bandwidth() - 1)}
                                                    height={h}
                                                    fill="var(--color-edge-strong)"
                                                />
                                            );
                                        })}
                                        <Brush
                                            xScale={bxLinear}
                                            yScale={byLinear}
                                            width={Math.max(1, innerW)}
                                            height={BRUSH_H}
                                            handleSize={8}
                                            resizeTriggerAreas={["left", "right"]}
                                            brushDirection="horizontal"
                                            onChange={(domain) => {
                                                if (!domain) {
                                                    setRange(null);
                                                    return;
                                                }
                                                const a = Math.max(0, Math.round(domain.x0));
                                                const b = Math.min(rows.length - 1, Math.round(domain.x1));
                                                setRange(b > a ? [a, b] : null);
                                            }}
                                            onClick={() => setRange(null)}
                                            selectedBoxStyle={{
                                                fill: "var(--color-accent)",
                                                fillOpacity: 0.14,
                                                stroke: "var(--color-accent)",
                                                strokeWidth: 1,
                                            }}
                                        />
                                    </g>
                                </svg>
                            ) : null}

                            {tooltipOpen && tooltipData ? (
                                <TooltipInPortal
                                    left={tooltipLeft}
                                    top={tooltipTop}
                                    className="!rounded-[7px] !border !border-border !bg-surface-raised !px-[10px] !py-[7px] !shadow-lg"
                                >
                                    <div className="mb-[5px] font-mono text-[10.5px] font-semibold text-primary">
                                        {tooltipData.day}
                                    </div>
                                    {series
                                        .filter((m) => (tooltipData.values[m.key] ?? 0) > 0)
                                        .map((m) => (
                                            <div
                                                key={m.key}
                                                data-usage-tip-model={m.key}
                                                className="flex items-center gap-[6px] font-mono text-[10.5px]"
                                            >
                                                <Swatch fill={m.fill} />
                                                <span className="text-muted">{m.model}</span>
                                                <span className="ml-auto pl-3 text-secondary">
                                                    {axisFmt(tooltipData.values[m.key])}
                                                </span>
                                            </div>
                                        ))}
                                    <div
                                        data-usage-tip-total
                                        className="mt-[5px] flex items-center gap-[6px] border-t border-border pt-[5px] font-mono text-[10.5px]"
                                    >
                                        <span className="text-muted">total</span>
                                        <span className="ml-auto pl-3 font-semibold text-primary">
                                            {axisFmt(tooltipData.total)}
                                        </span>
                                    </div>
                                </TooltipInPortal>
                            ) : null}
                        </div>
                    </div>
                    {series.length > 1 ? <Legend groups={legend} fmtValue={axisFmt} /> : null}
                </div>
            )}
        </div>
    );
}

function Swatch({ fill }: { fill: string }) {
    return <span className="h-[8px] w-[8px] flex-none rounded-[2px]" style={{ background: fill }} />;
}

// rows are not clickable: the legend reads out the stack, it does not filter it
function Legend({ groups, fmtValue }: { groups: LegendGroup[]; fmtValue: (v: number) => string }) {
    return (
        <div data-usage-legend className="flex w-[330px] flex-none flex-col">
            {groups.map((g) => (
                <div key={g.harness}>
                    {g.showHead ? (
                        <div
                            data-usage-legend-group={g.harness}
                            className="flex items-baseline pb-1 pt-2 font-mono text-[10px] text-ink-mid"
                        >
                            <span className="flex-1 font-bold uppercase tracking-[0.08em]">{g.label}</span>
                            <span>
                                {fmtValue(g.value)} · {pctStr(g.pct)}
                            </span>
                        </div>
                    ) : null}
                    {g.models.map((m) => (
                        <LegendRow key={m.key} m={m} fmtValue={fmtValue} />
                    ))}
                </div>
            ))}
        </div>
    );
}

function LegendRow({ m, fmtValue }: { m: LegendModel; fmtValue: (v: number) => string }) {
    return (
        <div
            data-usage-model={m.key}
            className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-x-2 border-t border-edge-faint py-[6px] font-mono text-[11px]"
        >
            <Swatch fill={m.fill} />
            <span className="truncate text-secondary" title={m.title}>
                {m.model}
            </span>
            <span className="text-muted">
                <span className="text-secondary">{fmtValue(m.value)}</span> · {pctStr(m.pct)}
            </span>
        </div>
    );
}
