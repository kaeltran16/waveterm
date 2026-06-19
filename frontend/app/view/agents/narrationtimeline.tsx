// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import type { AgentEntry } from "./agentsviewmodel";

// Reasoning (message) entries render as prose; action entries render as a dim
// monospace verb/target strip. tool_result content is never present here (the
// projection discards it). With accentLatest, the newest message is highlighted.
export function NarrationTimeline({
    entries,
    accentLatest,
    className,
}: {
    entries: AgentEntry[];
    accentLatest?: boolean;
    className?: string;
}) {
    let lastMessageIdx = -1;
    if (accentLatest) {
        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].kind === "message") {
                lastMessageIdx = i;
                break;
            }
        }
    }
    return (
        <div className={cn("leading-relaxed", className)}>
            {entries.map((e, i) =>
                e.kind === "message" ? (
                    <div
                        key={i}
                        className={cn(
                            "mt-2.5 text-[13px]",
                            i === lastMessageIdx ? "border-l-2 border-[#3fb950] pl-2 text-[#f0f6fc]" : "text-[#dde3ea]"
                        )}
                    >
                        {e.text}
                    </div>
                ) : (
                    <div
                        key={i}
                        className="my-2.5 border-l-2 border-[#2a2f3a] pl-3.5 font-mono text-[12px] leading-7 text-[#7d8896]"
                    >
                        <span className="inline-block w-14 text-[#9aa4b2]">{e.verb}</span>
                        {e.target}
                        {e.note ? <span className="text-[#6b7585]"> ({e.note})</span> : null}
                        {e.outcome === "ok" ? <span className="text-[#3fb950]"> ✓</span> : null}
                        {e.outcome === "fail" ? <span className="text-[#f85149]"> ✗</span> : null}
                    </div>
                )
            )}
        </div>
    );
}
