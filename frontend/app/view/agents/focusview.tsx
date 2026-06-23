// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AgentComposer } from "./agentcomposer";
import { AnswerBar } from "./answerbar";
import { formatAge, formatTokens, usageLevel, type AgentVM } from "./agentsviewmodel";
import { liveEntriesByIdAtom } from "./livetranscript";
import { NarrationTimeline } from "./narrationtimeline";
import { projectNameFromTranscriptPath } from "./projectname";
import { StatusDot } from "./statusdot";

const USAGE_BAR: Record<"ok" | "warn" | "hot", string> = { ok: "bg-accent", warn: "bg-warning", hot: "bg-error" };
const DefaultContextMax = 200000; // fallback context-window size when the reporter omits contextmax

export function FocusView({
    agent,
    now,
    autofocusComposer,
    hasPrev,
    hasNext,
    selections,
    sent,
    activeQuestion,
    onBack,
    onPrev,
    onNext,
    onOpenTerminal,
    onToggleAnswer,
    onSubmitAnswer,
    onSelectQuestion,
}: {
    agent: AgentVM;
    now: number;
    autofocusComposer: boolean;
    hasPrev: boolean;
    hasNext: boolean;
    selections: Record<number, Set<number>>;
    sent: boolean;
    activeQuestion?: number;
    onBack: () => void;
    onPrev: () => void;
    onNext: () => void;
    onOpenTerminal: () => void;
    onToggleAnswer: (qi: number, oi: number) => void;
    onSubmitAnswer: () => void;
    onSelectQuestion?: (qi: number) => void;
}) {
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    const project = projectNameFromTranscriptPath(agent.transcriptPath);
    const asking = agent.state === "asking";
    const idle = agent.state === "idle";
    const idleMs = agent.idleSince != null ? Math.max(0, now - agent.idleSince) : undefined;
    const usage = agent.usage;

    const scrollRef = useRef<HTMLDivElement>(null);
    const stickRef = useRef(true);
    const prevLenRef = useRef(entries.length);
    const [newCount, setNewCount] = useState(0);
    const composerWrapRef = useRef<HTMLDivElement>(null);

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

    useEffect(() => {
        if (autofocusComposer) {
            composerWrapRef.current?.querySelector("textarea")?.focus();
        }
    }, [autofocusComposer, agent.id]);

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
        <div className="flex h-full w-full flex-col bg-background">
            <div className="flex shrink-0 items-center gap-3 border-b border-border px-[18px] py-3">
                <button type="button" onClick={onBack} title="Back (Esc)" className="cursor-pointer text-[18px] leading-none text-muted hover:text-secondary">
                    ←
                </button>
                <StatusDot state={agent.state} />
                <b className="text-[17px] text-primary">{agent.name}</b>
                <span className="truncate text-[13px] text-muted">
                    {project ? `${project} · ` : ""}
                    {agent.task}
                </span>
                <span className="ml-auto shrink-0 text-[12px] tabular-nums text-muted">
                    {agent.model ? `${agent.model} · ` : ""}
                    {idle ? `${formatAge(idleMs)} idle` : formatAge(agent.activeMs)}
                </span>
                <button
                    type="button"
                    onClick={onOpenTerminal}
                    title="Open terminal"
                    className="shrink-0 cursor-pointer rounded-[6px] border border-border px-2 py-1 text-[12px] text-secondary hover:bg-white/[0.04]"
                >
                    ↗ terminal
                </button>
                <span className="flex shrink-0 items-center text-[15px] text-muted">
                    <button type="button" disabled={!hasPrev} onClick={onPrev} title="Previous agent" className="cursor-pointer px-1 hover:text-secondary disabled:opacity-30">
                        ‹
                    </button>
                    <button type="button" disabled={!hasNext} onClick={onNext} title="Next agent" className="cursor-pointer px-1 hover:text-secondary disabled:opacity-30">
                        ›
                    </button>
                </span>
            </div>

            {usage?.contextpct != null ? (
                <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-[18px] py-1.5 text-[11px] tabular-nums text-muted">
                    <span className="text-[10px] uppercase tracking-wide">ctx</span>
                    <span className="h-1 w-[110px] overflow-hidden rounded-full bg-white/10">
                        <span
                            className={cn("block h-full rounded-full", USAGE_BAR[usageLevel(usage.contextpct)])}
                            style={{ width: `${Math.min(100, usage.contextpct)}%` }}
                        />
                    </span>
                    <span className="text-secondary">
                        {formatTokens(Math.round((usage.contextpct / 100) * (usage.contextmax || DefaultContextMax)))}
                        <span className="text-muted">
                            {" "}
                            / {formatTokens(usage.contextmax || DefaultContextMax)} · {Math.round(usage.contextpct)}%
                        </span>
                    </span>
                    {usage.costusd ? <span className="ml-auto">${usage.costusd.toFixed(2)}</span> : null}
                </div>
            ) : null}

            <div ref={scrollRef} onScroll={onScroll} className={cn("relative min-h-0 flex-1 overflow-y-auto px-[22px] py-[16px]", asking && "opacity-90")}>
                <NarrationTimeline entries={entries} accentLatest large />
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
                            className="sticky bottom-3 left-1/2 ml-[-40px] cursor-pointer rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-white shadow-lg"
                        >
                            ↓ {newCount} new
                        </motion.button>
                    ) : null}
                </AnimatePresence>
            </div>

            {asking ? (
                <AnswerBar
                    agent={agent}
                    selections={selections}
                    sent={sent}
                    numbered
                    activeQuestion={activeQuestion}
                    onToggle={onToggleAnswer}
                    onSubmit={onSubmitAnswer}
                    onSelectQuestion={onSelectQuestion}
                    className="shrink-0 border-t border-warning bg-warning/5 px-[18px] py-3"
                />
            ) : null}
            <div ref={composerWrapRef}>
                <AgentComposer blockId={agent.blockId} placeholder={`message ${agent.name}…`} />
            </div>
        </div>
    );
}
