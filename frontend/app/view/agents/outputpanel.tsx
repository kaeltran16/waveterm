// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { formatAge, isQuiet, type AgentVM } from "./agentsviewmodel";
import { liveEntriesByIdAtom, lastActivityByIdAtom } from "./livetranscript";
import { NarrationTimeline } from "./narrationtimeline";
import { projectNameFromTranscriptPath } from "./projectname";
import { StatusDot } from "./statusdot";

function formatSince(ms: number): string {
    if (ms < 60_000) {
        return `${Math.max(1, Math.floor(ms / 1000))}s`;
    }
    return `${Math.floor(ms / 60_000)}m`;
}

export function WorkingPanel({ agent, now, onOpen }: { agent: AgentVM; now: number; onOpen: (id: string) => void }) {
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const lastActivity = useAtomValue(lastActivityByIdAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    const lastTs = lastActivity[agent.id];
    const since = lastTs != null ? formatSince(Math.max(0, now - lastTs)) : null;
    const quiet = isQuiet(lastTs, now);
    const project = projectNameFromTranscriptPath(agent.transcriptPath);

    const scrollRef = useRef<HTMLDivElement>(null);
    const stickRef = useRef(true);
    const prevLenRef = useRef(entries.length);
    const [newCount, setNewCount] = useState(0);

    useEffect(() => {
        const added = entries.length - prevLenRef.current;
        prevLenRef.current = entries.length;
        const el = scrollRef.current;
        if (el && stickRef.current) {
            el.scrollTop = el.scrollHeight;
            setNewCount(0);
        } else if (added > 0) {
            setNewCount((n) => n + added);
        }
    }, [entries]);

    const onScroll = () => {
        const el = scrollRef.current;
        if (!el) {
            return;
        }
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        if (stickRef.current) {
            setNewCount(0);
        }
    };

    const jumpToLatest = () => {
        const el = scrollRef.current;
        if (!el) {
            return;
        }
        el.scrollTop = el.scrollHeight;
        stickRef.current = true;
        setNewCount(0);
    };

    return (
        <div className="relative flex h-full flex-col overflow-hidden rounded-[9px] border border-border bg-background">
            <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-[14px] py-2">
                <StatusDot state="working" quiet={quiet} />
                <b className="text-[13px] text-primary">{agent.name}</b>
                <span className="truncate text-[11.5px] text-muted">
                    {project ? `${project} · ` : ""}
                    {agent.task}
                </span>
                <span className={cn("ml-auto flex shrink-0 items-center gap-1 tabular-nums text-[11px]", quiet ? "text-warning" : "text-muted")}>
                    {agent.model ? `${agent.model} · ` : ""}
                    {formatAge(agent.activeMs)}
                    {since ? (
                        <>
                            <span>·</span>
                            <motion.span
                                className="inline-block"
                                animate={quiet ? { rotate: 0 } : { rotate: 360 }}
                                transition={quiet ? { duration: 0 } : { duration: 2, repeat: Infinity, ease: "linear" }}
                            >
                                ⟳
                            </motion.span>
                            <span className="inline-block w-7 text-right">{since}</span>
                        </>
                    ) : null}
                    {quiet ? <span>· quiet</span> : null}
                </span>
                <button
                    type="button"
                    onClick={() => onOpen(agent.id)}
                    className="shrink-0 cursor-pointer rounded-[5px] border border-border px-2.5 py-0.5 text-[10.5px] text-secondary hover:bg-white/[0.04]"
                >
                    Open terminal
                </button>
            </div>
            <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-[14px] py-[11px]">
                <NarrationTimeline entries={entries} accentLatest />
            </div>
            <AnimatePresence>
                {newCount > 0 ? (
                    <motion.button
                        key="newpill"
                        type="button"
                        onClick={jumpToLatest}
                        initial={{ opacity: 0, y: 8, scale: 0.9 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 8, scale: 0.9 }}
                        transition={{ type: "spring", stiffness: 500, damping: 26 }}
                        className="absolute bottom-3 left-1/2 -translate-x-1/2 cursor-pointer rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-white shadow-lg"
                    >
                        ↓ {newCount} new
                    </motion.button>
                ) : null}
            </AnimatePresence>
        </div>
    );
}
