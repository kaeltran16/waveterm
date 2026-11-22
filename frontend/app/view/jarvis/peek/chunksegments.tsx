// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { barFillClass } from "@/app/element/motiontokens";
import { cn } from "@/util/util";
import type { ChunkTone } from "../effortmodel";

export const SEGMENT_FILL: Record<ChunkTone, string> = {
    done: "bg-success",
    active: "bg-accent",
    blocked: "bg-warning",
    deferred: "bg-ink-faint",
    skipped: "bg-edge-mid",
    pending: "bg-edge-mid",
};

// tones drawn as the bare track: a chunk leaving one fills its segment instead of changing color in place
const UNFILLED: ReadonlySet<ChunkTone> = new Set(["pending", "skipped"]);

// an initiative's progress bar: one segment per chunk, in plan order
export function ChunkSegments({ segments }: { segments: ChunkTone[] }) {
    if (segments.length === 0) {
        return null;
    }
    return (
        <div
            aria-hidden="true"
            data-chunk-segments
            className="grid gap-[3px]"
            style={{ gridTemplateColumns: `repeat(${segments.length}, minmax(0, 1fr))` }}
        >
            {segments.map((tone, i) => (
                <span key={i} className="h-1 overflow-hidden rounded-[2px] bg-edge-mid">
                    <span
                        className={cn("block h-full origin-left", SEGMENT_FILL[tone], barFillClass)}
                        style={{ transform: `scaleX(${UNFILLED.has(tone) ? 0 : 1})` }}
                    />
                </span>
            ))}
        </div>
    );
}
