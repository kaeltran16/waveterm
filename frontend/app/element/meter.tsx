// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit's meter primitives: one number, as a bar or a ring. These are deliberately NOT charts —
// no scales, no axes, no library (the one real chart is DailyChart, on visx). Consolidates the nine
// bars/rings that were hand-rolled across the cockpit; see
// docs/superpowers/specs/2026-07-30-usage-charts-design.md.
//
// Fills are tailwind utility classes ("bg-accent", "bg-success") because Tailwind 4 generates a
// bg-* utility for every @theme --color-* token, so callers never name a raw color. ArcMeter is the
// exception: conic-gradient needs a color VALUE, so it takes a var(--color-*) reference.

import { meterPct, meterSegments, type MeterSeg } from "@/app/element/metergeometry";
import { MOTION, easeFluidCss } from "@/app/element/motiontokens";
import { cn } from "@/util/util";
import { useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";

// undefined under reduced motion so the value snaps instead of tweening
export function widthTween(reduce: boolean | null): string | undefined {
    return reduce ? undefined : `width ${MOTION.durMacro}s ${easeFluidCss}`;
}

export function Meter({
    pct,
    fill,
    height = 7,
    radius = 4,
    track = "bg-surface-hover",
    className,
}: {
    pct: number;
    fill: string;
    height?: number;
    radius?: number;
    track?: string;
    className?: string;
}) {
    const reduce = useReducedMotion();
    return (
        <div className={cn("overflow-hidden", track, className)} style={{ height, borderRadius: radius }}>
            <div
                className={cn("h-full", fill)}
                style={{ width: `${meterPct(pct)}%`, borderRadius: radius, transition: widthTween(reduce) }}
            />
        </div>
    );
}

export function StackedMeter({
    segs,
    total,
    height = 11,
    radius = 5,
    track = "bg-surface-hover",
    className,
}: {
    segs: MeterSeg[];
    total?: number;
    height?: number;
    radius?: number;
    track?: string;
    className?: string;
}) {
    const reduce = useReducedMotion();
    const slices = meterSegments(segs, total);
    return (
        <div
            className={cn("flex gap-[2px] overflow-hidden", track, className)}
            style={{ height, borderRadius: radius }}
        >
            {slices.map((s) => (
                <div
                    key={s.key}
                    className={cn("h-full", s.fill)}
                    style={{ width: `${s.pct}%`, transition: widthTween(reduce) }}
                />
            ))}
        </div>
    );
}

// Ring gauge. The sweep animates via the @property-registered --usage-arc (tailwindsetup.css) — a bare
// custom property would not transition. Registration is global but VALUES inherit per element, so any
// number of ArcMeters can animate independently without extra scoping.
export function ArcMeter({
    pct,
    size,
    thickness,
    color,
    track = "var(--color-edge-strong)",
    center = "bg-background",
    className,
    children,
}: {
    pct?: number;
    size: number;
    thickness: number;
    color: string; // a var(--color-*) reference
    track?: string;
    center?: string;
    className?: string;
    children?: ReactNode;
}) {
    const reduce = useReducedMotion();
    const has = pct != null;
    const hole = size - thickness * 2;
    const style = {
        width: size,
        height: size,
        background: `conic-gradient(${has ? color : "var(--color-edge-strong)"} 0 var(--usage-arc), ${track} 0)`,
        "--usage-arc": `${has ? meterPct(pct) : 0}%`,
        transition: reduce ? undefined : `--usage-arc ${MOTION.durMacro}s ${easeFluidCss}`,
    } as CSSProperties;
    return (
        <div className={cn("flex flex-none items-center justify-center rounded-full", className)} style={style}>
            <div
                className={cn("flex flex-none items-center justify-center rounded-full", center)}
                style={{ width: hole, height: hole }}
            >
                {children}
            </div>
        </div>
    );
}
