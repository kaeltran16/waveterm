// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { motion } from "motion/react";
import type { AgentEntry } from "./agentsviewmodel";

// Reasoning (message) entries render as prose; action entries render as a dim
// monospace verb/target strip. tool_result content is never present here (the
// projection discards it). With accentLatest, the newest message is highlighted.
// Entries are append-only and keyed by index, so `initial` plays only for newly
// appended (newly mounted) entries — existing ones do not re-animate on each chunk.
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
                    <motion.div
                        key={i}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.22, ease: "easeOut" }}
                        className={cn(
                            "mt-2.5 text-[13px]",
                            i === lastMessageIdx ? "border-l-2 border-[#3fb950] pl-2 text-[#f0f6fc]" : "text-[#dde3ea]"
                        )}
                    >
                        {e.text}
                    </motion.div>
                ) : (
                    <motion.div
                        key={i}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.22, ease: "easeOut" }}
                        className="my-2.5 border-l-2 border-[#2a2f3a] pl-3.5 font-mono text-[12px] leading-7 text-[#7d8896]"
                    >
                        <span className="inline-block w-14 text-[#9aa4b2]">{e.verb}</span>
                        {e.target}
                        {e.note ? <span className="text-[#6b7585]"> ({e.note})</span> : null}
                        {e.outcome ? (
                            <motion.span
                                key={e.outcome}
                                initial={{ scale: 0, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                transition={{ type: "spring", stiffness: 500, damping: 18 }}
                                className={cn(
                                    "ml-1 inline-block",
                                    e.outcome === "ok" ? "text-[#3fb950]" : "text-[#f85149]"
                                )}
                            >
                                {e.outcome === "ok" ? "✓" : "✗"}
                            </motion.span>
                        ) : null}
                    </motion.div>
                )
            )}
        </div>
    );
}
