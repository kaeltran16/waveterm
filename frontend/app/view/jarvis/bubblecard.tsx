// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The bubble's look, drawn by the in-app creature (petbubble.tsx) and by the desktop popup page
// (frontend/tauri/popup.tsx). The popup page opens no wavesrv connection, so nothing here may import the
// cockpit store: the text arrives already rendered.

import { cn } from "@/util/util";
import type { ReactNode } from "react";

// how long a bubble stays up, in the app and on the desktop
export const BUBBLE_MS = 6_000;

// the register as a label: the dot (when the kind earns one) and the words
export function BubbleLabel({
    label,
    dot,
    tone,
    className,
}: {
    label: string;
    dot: string | null;
    tone: string;
    className?: string;
}) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5 font-mono font-semibold uppercase tracking-[.09em]",
                tone,
                className
            )}
        >
            {dot != null ? <span className={cn("h-1.5 w-1.5 flex-none rounded-full", dot)} /> : null}
            {label}
        </span>
    );
}

export function BubbleCard({
    marker,
    label,
    dot,
    tone,
    name,
    project,
    text,
    detail,
    more = 0,
    onClick,
}: {
    // prefix of the card's data attributes (`data-<marker>`, `-agent`, `-detail`, `-more`), which cdp scenarios query
    marker: string;
    label: string;
    dot: string | null;
    tone: string;
    name?: string;
    project?: string;
    text: ReactNode;
    detail?: ReactNode;
    more?: number;
    onClick: () => void;
}) {
    const mark = (part?: string) => ({ [`data-${marker}${part ? `-${part}` : ""}`]: "" });
    return (
        <div className="w-[268px] rounded-[12px] border border-border bg-surface-raised shadow-popover-md has-[button:hover]:border-edge-strong">
            <button
                type="button"
                {...mark()}
                onClick={onClick}
                className="flex w-full cursor-pointer flex-col gap-1.5 rounded-[12px] px-3 py-[11px] text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
                <BubbleLabel label={label} dot={dot} tone={tone} className="text-[10.5px]" />
                {name ? (
                    <span {...mark("agent")} className="flex min-w-0 items-baseline gap-1.5">
                        <span
                            {...mark("agent-name")}
                            className="min-w-0 truncate text-[12px] font-semibold text-primary"
                        >
                            {name}
                        </span>
                        {project ? (
                            <span {...mark("agent-project")} className="flex-none font-mono text-[10.5px] text-muted">
                                {project}
                            </span>
                        ) : null}
                    </span>
                ) : null}
                {/* clamped: a notification title passes through verbatim and would otherwise stretch
                    the bubble */}
                <span className="line-clamp-3 text-[12px] leading-[1.45] text-secondary [overflow-wrap:anywhere]">
                    {text}
                </span>
                {detail ? (
                    <span {...mark("detail")} className="text-[12px] text-ink-mid [overflow-wrap:anywhere]">
                        {detail}
                    </span>
                ) : null}
                {more > 0 ? (
                    <span {...mark("more")} className="font-mono text-[10.5px] text-muted">
                        +{more} more waiting
                    </span>
                ) : null}
            </button>
        </div>
    );
}
