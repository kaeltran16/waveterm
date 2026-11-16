// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Placeholder for a narration timeline that has not arrived yet, in the shape the timeline will take: a prompt
// bubble, a line of prose, a step box, then a reply (the Loading board).

import { cn } from "@/util/util";

const BLOCK = "animate-pulse bg-surface-raised motion-reduce:animate-none";
const REPLY_WIDTHS = ["w-[92%]", "w-[84%]", "w-[61%]"];

export function TranscriptSkeleton({ className }: { className?: string }) {
    return (
        <div role="status" aria-label="Loading the transcript" className={cn("h-full overflow-hidden", className)}>
            <div aria-hidden="true" className="mx-auto flex max-w-[736px] flex-col gap-2.5">
                <div className={cn(BLOCK, "mb-3.5 h-[62px] w-[58%] self-end rounded-[12px]")} />
                <div className={cn(BLOCK, "h-3.5 w-[46%] rounded-[4px]")} />
                <div className="mb-2 h-[124px] animate-pulse rounded-[10px] border border-edge-faint motion-reduce:animate-none" />
                {REPLY_WIDTHS.map((w) => (
                    <div key={w} className={cn(BLOCK, "h-3 rounded-[4px]", w)} />
                ))}
            </div>
        </div>
    );
}
