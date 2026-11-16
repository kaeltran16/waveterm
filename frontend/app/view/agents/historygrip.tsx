// frontend/app/view/agents/historygrip.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The drag edge of the Diff surface's list column. The width rules are difflayout.ts's; this owns only
// the pointer and the keys, the same way the Code sidebar's grip does.

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { HISTORY_MIN_PX, nextHistoryWidth } from "./difflayout";

type Drag = { pointerId: number; startX: number; startWidth: number };

export function HistoryGrip({
    width,
    max,
    onChange,
}: {
    width: number;
    max: number;
    onChange: (width: number) => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const drag = useRef<Drag | null>(null);
    const clamp = (w: number) => Math.round(Math.min(max, Math.max(HISTORY_MIN_PX, w)));

    const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
        drag.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: width };
        ref.current?.setPointerCapture(e.pointerId);
        e.preventDefault();
    };
    const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (d != null && d.pointerId === e.pointerId) {
            onChange(clamp(d.startWidth + e.clientX - d.startX));
        }
    };
    const end = (e: PointerEvent<HTMLDivElement>, commit: boolean) => {
        const d = drag.current;
        if (d == null || d.pointerId !== e.pointerId) {
            return;
        }
        drag.current = null;
        if (ref.current?.hasPointerCapture(e.pointerId)) {
            ref.current.releasePointerCapture(e.pointerId);
        }
        if (!commit) {
            onChange(d.startWidth);
        }
    };
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.altKey || e.ctrlKey || e.metaKey) {
            return;
        }
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") {
            return;
        }
        // the surface's own keys must not also act on an arrow meant for the edge
        e.preventDefault();
        e.stopPropagation();
        onChange(nextHistoryWidth(width, e.key, e.shiftKey, max));
    };

    return (
        <div
            ref={ref}
            data-history-grip
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label="Resize history"
            aria-valuemin={HISTORY_MIN_PX}
            aria-valuemax={max}
            aria-valuenow={width}
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => end(e, true)}
            onPointerCancel={(e) => end(e, false)}
            onLostPointerCapture={(e) => end(e, true)}
            className="group absolute inset-y-0 -right-[4px] z-10 flex w-2 cursor-col-resize justify-center focus-visible:outline-none"
        >
            <span className="h-full w-[2px] bg-transparent group-hover:bg-accent group-focus-visible:bg-accent" />
        </div>
    );
}
