// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A ```chart block drawn as a card (chartspec.ts holds the schema). Line, area and scatter use visx
// scales and axes as dailychart.tsx does; bars are horizontal HTML rows as the prototype draws them.
// Must not import markdownmessage.tsx: renderregistry imports this module, and markdownmessage imports
// renderregistry.

import { MOTION } from "@/app/element/motiontokens";
import useResizeObserver from "@react-hook/resize-observer";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { scaleLinear, scalePoint } from "@visx/scale";
import { motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useMemo, useState, type CSSProperties } from "react";
import {
    chartCategories,
    fmtChartValue,
    hasNumericX,
    parseChartSpec,
    segmentsPath,
    valueDomain,
    type ChartSpec,
} from "./chartspec";
import { CodeBlock } from "./codeblock";

// series colors, by index; tokens so runtime themes apply
const SERIES_COLORS = [
    "var(--color-accent)",
    "var(--color-graphlane-2)",
    "var(--color-graphlane-3)",
    "var(--color-graphlane-4)",
    "var(--color-graphlane-5)",
    "var(--color-graphlane-6)",
    "var(--color-conn-6)",
    "var(--color-conn-7)",
];
const PLOT_H = 200;
const MARGIN = { top: 8, right: 12, bottom: 24, left: 46 };
const AXIS_TICKS = 4;
// past this many categories the bottom axis labels are thinned
const MAX_X_LABELS = 8;
const POINT_R = 3.5;
const AXIS_LABEL = {
    fill: "var(--color-muted)",
    fontSize: 10.5,
    fontFamily: "var(--font-mono)",
};
const DRAW = { duration: MOTION.durMacro, ease: MOTION.easeFluid };

function color(i: number): string {
    return SERIES_COLORS[i % SERIES_COLORS.length];
}

export function ChartCard({ raw }: { raw: string }) {
    const parsed = useMemo(() => parseChartSpec(raw), [raw]);
    const [showSpec, setShowSpec] = useState(false);
    if ("reason" in parsed) {
        return (
            <div data-chart-fallback className="my-1.5">
                <div className="font-mono text-[11px] text-error">chart not drawn: {parsed.reason}</div>
                <CodeBlock code={raw} lang="chart" />
            </div>
        );
    }
    const spec = parsed.spec;
    return (
        <div
            data-chart-card
            data-chart-type={spec.type}
            className="my-1.5 overflow-hidden rounded-[8px] border border-edge-mid bg-surface-code"
        >
            <div className="flex items-center gap-2 border-b border-edge-faint px-[11px] py-[7px]">
                <span className="font-mono text-[10.5px] text-accent-soft">chart</span>
                <span className="min-w-0 truncate text-[12.5px] font-semibold text-primary">{spec.title}</span>
                <span className="flex-1" />
                <button
                    type="button"
                    data-chart-spec-toggle
                    aria-pressed={showSpec}
                    onClick={() => setShowSpec((v) => !v)}
                    className={`cursor-pointer px-1 py-0.5 font-mono text-[10.5px] hover:text-primary ${showSpec ? "text-primary" : "text-ink-mid"}`}
                >
                    spec
                </button>
            </div>
            {showSpec ? (
                <div className="px-3 pb-1">
                    <CodeBlock code={raw} lang="chart" />
                </div>
            ) : (
                <div className="flex flex-col gap-2 px-4 pb-3 pt-[14px]">
                    {spec.x?.label || spec.y?.label ? <AxisTitles spec={spec} /> : null}
                    {spec.type === "bar" ? <BarChart spec={spec} /> : <PlotChart spec={spec} />}
                    {spec.series.length > 1 ? <Legend spec={spec} /> : null}
                </div>
            )}
        </div>
    );
}

function AxisTitles({ spec }: { spec: ChartSpec }) {
    // bars run horizontally, so the value axis reads along the bottom
    const value = [spec.y?.label, spec.y?.unit ? `(${spec.y.unit})` : ""].filter(Boolean).join(" ");
    return (
        <div className="flex font-mono text-[10.5px] text-muted">
            <span>{spec.type === "bar" ? spec.x?.label : value}</span>
            <span className="flex-1" />
            <span>{spec.type === "bar" ? value : spec.x?.label}</span>
        </div>
    );
}

function Legend({ spec }: { spec: ChartSpec }) {
    return (
        <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
            {spec.series.map((s, i) => (
                <span key={i} className="flex items-center gap-[6px] font-mono text-[10.5px] text-secondary">
                    <span className="h-[8px] w-[8px] flex-none rounded-[2px]" style={{ background: color(i) }} />
                    {s.name}
                </span>
            ))}
        </div>
    );
}

function BarChart({ spec }: { spec: ChartSpec }) {
    const reduce = useReducedMotion();
    const cats = chartCategories(spec);
    const byCat = spec.series.map((s) => new Map(s.points.map((p) => [String(p.x), p.y])));
    const values = spec.series.flatMap((s) => s.points.map((p) => p.y));
    const scale = scaleLinear<number>({ domain: valueDomain(values, true), range: [0, 100], nice: AXIS_TICKS });
    const ticks = scale.ticks(AXIS_TICKS);
    const zero = scale(0);
    const unit = spec.y?.unit;
    const multi = spec.series.length > 1;
    return (
        <div className="flex flex-col gap-2">
            {cats.map((cat) => (
                <div key={cat} className="grid grid-cols-[130px_minmax(0,1fr)_56px] items-center gap-[10px]">
                    <span className="truncate text-right font-mono text-[11.5px] text-secondary" title={cat}>
                        {cat}
                    </span>
                    <div className="flex flex-col gap-[2px]">
                        {byCat.map((m, i) => {
                            const v = m.get(cat);
                            const left = v == null ? zero : Math.min(zero, scale(v));
                            const width = v == null ? 0 : Math.abs(scale(v) - zero);
                            return (
                                <div
                                    key={i}
                                    className={`relative overflow-hidden rounded-[3px] bg-lane ${multi ? "h-[8px]" : "h-[14px]"}`}
                                >
                                    {v == null ? null : (
                                        <motion.div
                                            data-chart-mark
                                            className="absolute inset-y-0 rounded-[3px]"
                                            style={{ left: `${left}%`, background: color(i) }}
                                            initial={reduce ? false : { width: 0 }}
                                            animate={{ width: `${width}%` }}
                                            transition={DRAW}
                                            title={`${spec.series[i].name}: ${fmtChartValue(v, unit)}`}
                                        />
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    <span className="flex flex-col font-mono text-[11px] leading-[1.25] text-ink-mid">
                        {byCat.map((m, i) => (
                            <span key={i}>{m.has(cat) ? fmtChartValue(m.get(cat), unit) : ""}</span>
                        ))}
                    </span>
                </div>
            ))}
            <div className="mt-0.5 grid grid-cols-[130px_minmax(0,1fr)_56px] gap-[10px]">
                <span />
                <div className="relative h-[18px] border-t border-edge-mid font-mono text-[10.5px] text-ink-faint">
                    {ticks.map((t, i) => (
                        <span
                            key={t}
                            className="absolute top-1 whitespace-nowrap"
                            style={tickStyle(scale(t), i, ticks.length)}
                        >
                            {fmtChartValue(t, unit)}
                        </span>
                    ))}
                </div>
                <span />
            </div>
        </div>
    );
}

// end ticks align inward so their labels stay inside the row
function tickStyle(pct: number, i: number, n: number): CSSProperties {
    if (i === 0 && pct <= 0.5) return { left: 0 };
    if (i === n - 1 && pct >= 99.5) return { right: 0 };
    return { left: `${pct}%`, transform: "translateX(-50%)" };
}

function PlotChart({ spec }: { spec: ChartSpec }) {
    const reduce = useReducedMotion();
    // the host as state, not a ref, so the first measure runs once it mounts
    const [host, setHost] = useState<HTMLDivElement | null>(null);
    const [width, setWidth] = useState(0);
    useLayoutEffect(() => {
        if (host) setWidth(host.clientWidth);
    }, [host]);
    useResizeObserver(host, (e) => setWidth(e.contentRect.width));

    const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
    const numericX = hasNumericX(spec);
    const cats = numericX ? [] : chartCategories(spec);
    const xNum = scaleLinear<number>({
        domain: numericX
            ? valueDomain(
                  spec.series.flatMap((s) => s.points.map((p) => p.x as number)),
                  false
              )
            : [0, 1],
        range: [0, innerW],
        nice: numericX ? AXIS_TICKS : false,
    });
    const xCat = scalePoint<string>({ domain: cats, range: [0, innerW], padding: 0.5 });
    const xOf = (x: string | number): number => (numericX ? xNum(x as number) : (xCat(String(x)) ?? 0));
    const y = scaleLinear<number>({
        domain: valueDomain(
            spec.series.flatMap((s) => s.points.map((p) => p.y)),
            spec.type !== "scatter"
        ),
        range: [PLOT_H, 0],
        nice: AXIS_TICKS,
    });
    const base = y(Math.max(0, y.domain()[0]));
    const every = Math.max(1, Math.ceil(cats.length / MAX_X_LABELS));
    const unit = spec.y?.unit;

    return (
        <div ref={setHost} className="w-full" style={{ height: PLOT_H + MARGIN.top + MARGIN.bottom }}>
            {width > 0 ? (
                <svg width={width} height={PLOT_H + MARGIN.top + MARGIN.bottom}>
                    <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
                        <AxisLeft
                            scale={y}
                            numTicks={AXIS_TICKS}
                            tickFormat={(v) => fmtChartValue(Number(v), unit)}
                            stroke="var(--color-border)"
                            tickStroke="var(--color-border)"
                            tickLabelProps={() => ({ ...AXIS_LABEL, textAnchor: "end", dx: -4, dy: 3 })}
                        />
                        {numericX ? (
                            <AxisBottom
                                top={PLOT_H}
                                scale={xNum}
                                numTicks={AXIS_TICKS}
                                tickFormat={(v) => fmtChartValue(Number(v))}
                                stroke="var(--color-border)"
                                tickStroke="var(--color-border)"
                                tickLabelProps={() => ({ ...AXIS_LABEL, textAnchor: "middle", dy: 2 })}
                            />
                        ) : (
                            <AxisBottom
                                top={PLOT_H}
                                scale={xCat}
                                tickValues={cats.filter((_, i) => i % every === 0)}
                                stroke="var(--color-border)"
                                tickStroke="var(--color-border)"
                                tickLabelProps={() => ({ ...AXIS_LABEL, textAnchor: "middle", dy: 2 })}
                            />
                        )}
                        {spec.series.map((s, i) => {
                            const xy = s.points.map((p): [number, number] => [xOf(p.x), y(p.y)]);
                            const c = color(i);
                            if (spec.type === "scatter") {
                                return (
                                    <g key={i}>
                                        {xy.map(([cx, cy], j) => (
                                            <motion.circle
                                                key={j}
                                                data-chart-mark
                                                cx={cx}
                                                cy={cy}
                                                r={POINT_R}
                                                fill={c}
                                                fillOpacity={0.85}
                                                initial={reduce ? false : { opacity: 0 }}
                                                animate={{ opacity: 1 }}
                                                transition={DRAW}
                                            />
                                        ))}
                                    </g>
                                );
                            }
                            const line = segmentsPath(xy);
                            return (
                                <g key={i}>
                                    {spec.type === "area" && xy.length > 0 ? (
                                        <motion.path
                                            data-chart-mark
                                            d={`${line} L${xy[xy.length - 1][0].toFixed(1)},${base.toFixed(1)} L${xy[0][0].toFixed(1)},${base.toFixed(1)} Z`}
                                            fill={c}
                                            fillOpacity={0.18}
                                            initial={reduce ? false : { opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            transition={DRAW}
                                        />
                                    ) : null}
                                    <motion.path
                                        data-chart-mark
                                        d={line}
                                        fill="none"
                                        stroke={c}
                                        strokeWidth={1.75}
                                        strokeLinejoin="round"
                                        initial={reduce ? false : { pathLength: 0 }}
                                        animate={{ pathLength: 1 }}
                                        transition={DRAW}
                                    />
                                </g>
                            );
                        })}
                    </g>
                </svg>
            ) : null}
        </div>
    );
}
