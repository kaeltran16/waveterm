// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The one progress bar primitive: a clamped pct fill inside a hairline track.

import { widthTween } from "@/app/element/meter";
import { cn } from "@/util/util";
import { useReducedMotion } from "motion/react";

const FILL = {
    accent: "bg-gradient-to-r from-accent-600 to-accent",
    success: "bg-success",
    asking: "bg-asking",
} as const;

export function ProgressBar({
    pct,
    tone = "accent",
    className,
}: {
    pct: number;
    tone?: keyof typeof FILL;
    className?: string;
}) {
    const reduce = useReducedMotion();
    return (
        <div className={cn("h-[5px] overflow-hidden rounded-full bg-border", className)}>
            <div
                className={cn("h-full rounded-full", FILL[tone])}
                style={{ width: `${Math.min(100, Math.max(0, pct))}%`, transition: widthTween(reduce) }}
            />
        </div>
    );
}
