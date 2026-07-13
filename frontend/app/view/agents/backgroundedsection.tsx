// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { formatAge, type AgentVM } from "./agentsviewmodel";
import { cardVariants } from "@/app/element/motiontokens";

// Collapsed lane for still-running agents the user has muted with `b`. Distinct from Idle (finished):
// clicking a row un-backgrounds it (returns it to the working region) via onRestore.
export function BackgroundedSection({ agents, onRestore }: { agents: AgentVM[]; onRestore: (id: string) => void }) {
    const [open, setOpen] = useState(false);
    if (agents.length === 0) {
        return null;
    }
    return (
        <div className="shrink-0">
            <div
                className="flex cursor-pointer items-center gap-2 py-1.5 text-[11px] text-muted"
                onClick={() => setOpen((v) => !v)}
            >
                <span className="text-[9px]">{open ? "▾" : "▸"}</span>
                <span className="uppercase tracking-wide">Backgrounded</span>
                <span className="text-muted/60">· still running</span>
                <span className="ml-auto tabular-nums opacity-70">{agents.length}</span>
            </div>
            {open ? (
                <div className="flex flex-col gap-1">
                    <AnimatePresence initial={false}>
                        {agents.map((a) => (
                            <motion.div
                                key={a.id}
                                layout
                                variants={cardVariants}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                                onClick={() => onRestore(a.id)}
                                title="Restore to working"
                                className="flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 hover:bg-white/[0.04]"
                            >
                                <span className="h-2 w-2 shrink-0 rounded-full bg-accent/50" />
                                <b className="shrink-0 text-[12px] text-secondary">{a.name}</b>
                                <span className="truncate text-[12px] text-muted">{a.task || a.activity || ""}</span>
                                <span className="ml-auto shrink-0 text-[10px] text-muted">{formatAge(a.activeMs)}</span>
                            </motion.div>
                        ))}
                    </AnimatePresence>
                </div>
            ) : null}
        </div>
    );
}
