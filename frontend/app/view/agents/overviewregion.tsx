// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The parts every project Overview region shares (projectoverview.tsx): the head row, the empty sentence, the
// failure line with its Retry. Each region draws its own loading shape, the size of what it loads.

import { MONO_META, REGION_LABEL, SMALL_BTN } from "@/app/view/jarvis/briefstyle";
import { cn } from "@/util/util";
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentsViewModel } from "./agents";

export type OverviewRegionProps = { model: AgentsViewModel; project: string; path: string; close: () => void };

// the label, an optional count, a rule to the right edge, and an optional aside (a faint caption or a link)
export function RegionHead({ label, count, aside }: { label: string; count?: ReactNode; aside?: ReactNode }) {
    return (
        <div className="flex items-center gap-[9px]">
            <span className={cn(REGION_LABEL, "text-ink-mid")}>{label}</span>
            {count != null ? (
                <span className={cn("flex-none font-medium tabular-nums", MONO_META)}>{count}</span>
            ) : null}
            <span className="h-px min-w-3 flex-1 bg-edge-faint" />
            {aside != null ? <span className="flex-none">{aside}</span> : null}
        </div>
    );
}

export function RegionNote({ children }: { children: ReactNode }) {
    return <p className="m-0 px-[11px] py-1 text-[12.5px] text-muted">{children}</p>;
}

export function RegionAlert({ children, onRetry }: { children: ReactNode; onRetry: () => void }) {
    return (
        <div role="alert" className="flex items-center gap-2.5 px-[11px] py-1 text-[12.5px] text-ink-mid">
            <CircleAlert size={14} aria-hidden className="flex-none text-error" />
            <span className="min-w-0 flex-1 truncate">{children}</span>
            <button type="button" onClick={onRetry} className={cn("flex-none", SMALL_BTN)}>
                Retry
            </button>
        </div>
    );
}
