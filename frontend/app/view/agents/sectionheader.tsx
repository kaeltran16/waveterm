// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import type { ReactNode } from "react";

// Handoff section header: optional caret + colored dot + mono uppercase label + count pill + gradient
// divider + an optional right slot. Shared by LIVE AGENTS (accent, pulsing) and IDLE (muted, collapsible).
export function SectionHeader({
    label,
    labelClassName,
    count,
    dotClassName,
    pulse,
    countPillClassName,
    dividerClassName,
    right,
    caret,
    onClick,
    className,
}: {
    label: string;
    labelClassName?: string;
    count: number;
    dotClassName: string;
    pulse?: boolean;
    countPillClassName: string;
    dividerClassName: string;
    right?: ReactNode;
    caret?: string;
    onClick?: () => void;
    className?: string;
}) {
    return (
        <div className={cn("flex items-center gap-2.5", onClick && "cursor-pointer", className)} onClick={onClick}>
            {caret ? <span className="w-3 text-center font-mono text-[9px] text-muted">{caret}</span> : null}
            <span
                className={cn("h-[9px] w-[9px] shrink-0 rounded-full", dotClassName)}
                style={pulse ? { animation: "pulseDot 1.8s infinite" } : undefined}
            />
            <h2 className={cn("font-mono text-[12px] font-semibold uppercase tracking-[0.1em]", labelClassName)}>{label}</h2>
            <span className={cn("rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold", countPillClassName)}>{count}</span>
            <div className={cn("h-px flex-1", dividerClassName)} />
            {right}
        </div>
    );
}
