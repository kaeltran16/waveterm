// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import useResizeObserver from "@react-hook/resize-observer";
import { useLayoutEffect, useRef, useState } from "react";

// the line clamp per kind of clamped text, spelled out so tailwind sees each class
export const CLAMP_LINES = { bubble: "line-clamp-[8]", thought: "line-clamp-3" } as const;

// Long text clamped behind Show more. The clamp is measured, not estimated, so the toggle only shows when text is
// really hidden. A find over the transcript (unfold) passes clamp=false, since a match must never sit in hidden text.
export function ClampedText({
    lines,
    clamp,
    findTurn,
    className,
    children,
}: {
    lines: keyof typeof CLAMP_LINES;
    clamp: boolean;
    findTurn?: boolean;
    className?: string;
    children: React.ReactNode;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [overflows, setOverflows] = useState(false);
    const clamped = clamp && !open;
    const measure = () => {
        const el = ref.current;
        if (el != null && clamped) {
            setOverflows(el.scrollHeight > el.clientHeight + 1);
        }
    };
    useLayoutEffect(measure, [children, clamped]);
    useResizeObserver(ref, measure);
    return (
        <>
            <div ref={ref} data-find-turn={findTurn || undefined} className={cn(className, clamped && CLAMP_LINES[lines])}>
                {children}
            </div>
            {clamp && (overflows || open) ? (
                <button
                    type="button"
                    data-clamp-more
                    aria-expanded={open}
                    onClick={() => setOpen((v) => !v)}
                    className="mt-1 cursor-pointer text-[12px] text-accent-soft hover:text-primary"
                >
                    {open ? "Show less" : "Show more"}
                </button>
            ) : null}
        </>
    );
}
