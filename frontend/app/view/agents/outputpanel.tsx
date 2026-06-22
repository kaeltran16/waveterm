// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { AgentComposer } from "./agentcomposer";
import { AnswerBar } from "./answerbar";
import { formatAge, formatTokens, isQuiet, usageLevel, type AgentVM } from "./agentsviewmodel";
import { liveEntriesByIdAtom, lastActivityByIdAtom } from "./livetranscript";
import { NarrationTimeline } from "./narrationtimeline";
import { projectNameFromTranscriptPath } from "./projectname";
import { StatusDot } from "./statusdot";

const USAGE_BAR: Record<"ok" | "warn" | "hot", string> = { ok: "bg-accent", warn: "bg-warning", hot: "bg-error" };

export function WorkingPanel({
    agent,
    now,
    onOpen,
    onDismiss,
    onAnswer,
}: {
    agent: AgentVM;
    now: number;
    onOpen: (id: string) => void;
    onDismiss?: () => void;
    onAnswer?: (oref: string, answers: AgentAnswerItem[]) => void;
}) {
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const lastActivity = useAtomValue(lastActivityByIdAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    const lastTs = lastActivity[agent.id];
    const quiet = isQuiet(lastTs, now);
    const project = projectNameFromTranscriptPath(agent.transcriptPath);
    const idle = agent.state === "idle";
    const asking = agent.state === "asking";
    const idleMs = agent.idleSince != null ? Math.max(0, now - agent.idleSince) : undefined;
    const usage = agent.usage;

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
        <div
            className={cn(
                "group relative flex h-full flex-col overflow-hidden rounded-[10px] bg-background",
                asking ? "border border-warning shadow-[0_0_0_1px_rgba(224,185,86,0.3),0_0_20px_rgba(224,185,86,0.12)]" : "border border-border"
            )}
        >
            <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-[14px] py-2">
                <StatusDot state={agent.state} quiet={quiet} />
                <b className="text-[13px] text-primary">{agent.name}</b>
                <span className="truncate text-[11px] text-muted">
                    {project ? `${project} · ` : ""}
                    {agent.task}
                </span>
                {asking ? (
                    <span className="ml-auto shrink-0 rounded-[4px] border border-warning px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-warning">
                        needs you
                    </span>
                ) : idle ? (
                    <span className="ml-auto flex shrink-0 items-center gap-1 tabular-nums text-[11px] text-muted">
                        {agent.model ? `${agent.model} · ` : ""}
                        {formatAge(idleMs)} idle
                    </span>
                ) : (
                    <span className="ml-auto flex shrink-0 items-center gap-1 tabular-nums text-[11px] text-muted">
                        {agent.model ? `${agent.model} · ` : ""}
                        {formatAge(agent.activeMs)}
                    </span>
                )}
                {onDismiss ? (
                    <button
                        type="button"
                        onClick={onDismiss}
                        title="Move to Idle"
                        className="shrink-0 cursor-pointer rounded-[6px] border border-border p-1 text-secondary opacity-0 transition-opacity hover:bg-white/[0.04] group-hover:opacity-100"
                    >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 3v8M4 8l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>
                ) : null}
                <button
                    type="button"
                    onClick={() => onOpen(agent.id)}
                    title="Open terminal"
                    className="shrink-0 cursor-pointer rounded-[6px] border border-border p-1 text-secondary opacity-0 transition-opacity hover:bg-white/[0.04] group-hover:opacity-100"
                >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 12L12 4M12 4H6M12 4v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
            </div>
            {usage?.contextpct != null ? (
                <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-[14px] py-1.5 text-[11px] tabular-nums text-muted">
                    <span className="text-[10px] uppercase tracking-wide">ctx</span>
                    <span className="h-1 w-[110px] overflow-hidden rounded-full bg-white/10">
                        <span
                            className={cn("block h-full rounded-full", USAGE_BAR[usageLevel(usage.contextpct)])}
                            style={{ width: `${Math.min(100, usage.contextpct)}%` }}
                        />
                    </span>
                    <span className="text-secondary">
                        {formatTokens(Math.round((usage.contextpct / 100) * (usage.contextmax || 200000)))}
                        <span className="text-muted">
                            {" "}
                            / {formatTokens(usage.contextmax || 200000)} · {Math.round(usage.contextpct)}%
                        </span>
                    </span>
                    {usage.costusd ? <span className="ml-auto">${usage.costusd.toFixed(2)}</span> : null}
                </div>
            ) : null}
            <div ref={scrollRef} onScroll={onScroll} className={cn("min-h-0 flex-1 overflow-y-auto px-[14px] py-[11px]", asking && "opacity-60")}>
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
            {asking ? <AnswerBar agent={agent} onAnswer={onAnswer} /> : null}
            <AgentComposer blockId={agent.blockId} placeholder={`message ${agent.name}…`} />
        </div>
    );
}
