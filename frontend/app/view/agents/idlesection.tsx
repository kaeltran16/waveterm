// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AgentComposer } from "./agentcomposer";
import { formatAge, type AgentVM } from "./agentsviewmodel";

export function IdleSection({ agents, onOpen }: { agents: AgentVM[]; onOpen: (id: string) => void }) {
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
                <span className="uppercase tracking-wide">Idle</span>
                <span className="ml-auto tabular-nums opacity-70">{agents.length}</span>
            </div>
            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18, ease: "easeOut" }}
                        className="flex flex-col gap-1 overflow-hidden"
                    >
                        {agents.map((a) => (
                            <div key={a.id} className="flex flex-col rounded-[6px] hover:bg-white/[0.04]">
                                <div
                                    onClick={() => onOpen(a.id)}
                                    className="flex cursor-pointer items-center gap-2.5 px-2 py-1.5"
                                >
                                    <span className="h-2 w-2 shrink-0 rounded-full bg-muted" />
                                    <b className="shrink-0 text-[12px] text-secondary">{a.name}</b>
                                    <span className="truncate text-[12px] text-muted">{a.activity}</span>
                                    <span className="ml-auto shrink-0 text-[10px] text-muted">{formatAge(a.activeMs)} idle</span>
                                </div>
                                <AgentComposer blockId={a.blockId} placeholder={`message ${a.name}…`} />
                            </div>
                        ))}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
