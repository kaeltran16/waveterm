// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The one progress bar primitive: a clamped pct fill inside a hairline track.

import { cn } from "@/util/util";

export function ProgressBar({ pct, className }: { pct: number; className?: string }) {
    return (
        <div className={cn("h-[5px] overflow-hidden rounded-full bg-border", className)}>
            <div
                className="h-full rounded-full bg-gradient-to-r from-accent-600 to-accent transition-[width] duration-[300ms]"
                style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
            />
        </div>
    );
}
