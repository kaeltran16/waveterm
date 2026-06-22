// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useLayoutEffect, useRef, useState } from "react";
import { AnswerBar } from "./answerbar";
import { formatAge, isQuiet, latestMessageText, recentActions, type AgentVM } from "./agentsviewmodel";
import { lastActivityByIdAtom, liveEntriesByIdAtom } from "./livetranscript";
import { projectNameFromTranscriptPath } from "./projectname";
import { StatusDot } from "./statusdot";

const StepCount = 3;
const WorkingClampPx = 66; // ~3 lines at 13px / 1.6 line-height

export function AgentRow({
    agent,
    now,
    isCursor,
    selections,
    sent,
    onCursor,
    onOpen,
    onOpenTerminal,
    onToggleAnswer,
    onSubmitAnswer,
    onDismiss,
    onDragStart,
    onDropOn,
}: {
    agent: AgentVM;
    now: number;
    isCursor: boolean;
    selections: Record<number, Set<number>>;
    sent: boolean;
    onCursor: () => void;
    onOpen: () => void;
    onOpenTerminal: () => void;
    onToggleAnswer: (qi: number, oi: number) => void;
    onSubmitAnswer: () => void;
    onDismiss?: () => void;
    onDragStart: () => void;
    onDropOn: (before: boolean) => void;
}) {
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const lastActivity = useAtomValue(lastActivityByIdAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    const quiet = isQuiet(lastActivity[agent.id], now);
    const project = projectNameFromTranscriptPath(agent.transcriptPath);
    const asking = agent.state === "asking";
    const idle = agent.state === "idle";
    const idleMs = agent.idleSince != null ? Math.max(0, now - agent.idleSince) : undefined;
    const msg = latestMessageText(entries) ?? agent.activity ?? "";
    const steps = recentActions(entries, StepCount);

    const proseRef = useRef<HTMLDivElement>(null);
    const [clamped, setClamped] = useState(false);
    useLayoutEffect(() => {
        const el = proseRef.current;
        if (el) {
            setClamped(el.scrollHeight - el.clientHeight > 2);
        }
    }, [msg]);

    return (
        <div
            data-agent-id={agent.id}
            onClick={onCursor}
            onDoubleClick={onOpen}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                onDropOn(e.clientY < r.top + r.height / 2);
            }}
            className={cn(
                "group relative cursor-pointer border-b border-border px-[22px] py-3 transition-colors",
                asking ? "bg-warning/5" : "hover:bg-white/[0.02]",
                isCursor &&
                    (asking
                        ? "bg-warning/10 shadow-[inset_3px_0_0_var(--color-warning)]"
                        : "bg-accent/[0.06] shadow-[inset_3px_0_0_var(--color-accent)]")
            )}
        >
            <div className="flex items-center gap-2.5">
                <span
                    draggable
                    onDragStart={(e) => {
                        e.stopPropagation();
                        onDragStart();
                    }}
                    onClick={(e) => e.stopPropagation()}
                    title="Drag to reorder"
                    className="shrink-0 cursor-grab select-none text-[11px] text-muted opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
                >
                    ⠿
                </span>
                <StatusDot state={agent.state} quiet={quiet} />
                <b className={cn("shrink-0 text-primary", asking ? "text-[15px]" : "text-[14px]")}>{agent.name}</b>
                <span className="truncate text-[12px] text-muted">
                    {project ? `${project} · ` : ""}
                    {agent.task || agent.activity || ""}
                </span>
                {asking ? (
                    <span className="ml-auto shrink-0 rounded-[4px] border border-warning px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-warning">
                        needs you
                    </span>
                ) : (
                    <span className="ml-auto shrink-0 text-[12px] tabular-nums text-muted">
                        {agent.model ? `${agent.model} · ` : ""}
                        {idle ? `${formatAge(idleMs)} idle` : formatAge(agent.activeMs)}
                    </span>
                )}
                {onDismiss ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onDismiss();
                        }}
                        title="Move to Idle"
                        className="shrink-0 cursor-pointer rounded-[6px] border border-border p-1 text-secondary opacity-0 transition-opacity hover:bg-white/[0.04] group-hover:opacity-100"
                    >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                            <path d="M8 3v8M4 8l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </button>
                ) : null}
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onOpenTerminal();
                    }}
                    title="Open terminal tab"
                    className="shrink-0 cursor-pointer rounded-[6px] border border-border px-2 py-0.5 text-[11px] text-secondary opacity-0 transition-opacity hover:bg-white/[0.04] group-hover:opacity-100"
                >
                    ↗ terminal
                </button>
            </div>

            {asking ? (
                <AnswerBar
                    agent={agent}
                    selections={selections}
                    sent={sent}
                    numbered
                    onToggle={onToggleAnswer}
                    onSubmit={onSubmitAnswer}
                    className="ml-[26px]"
                />
            ) : (
                <div className="mt-2 ml-[26px] grid grid-cols-[minmax(0,1.7fr)_minmax(180px,0.85fr)] gap-6 max-[820px]:grid-cols-1 max-[820px]:gap-2">
                    <div className="relative" style={{ maxHeight: WorkingClampPx, overflow: "hidden" }}>
                        <div ref={proseRef} className="whitespace-pre-wrap text-[13px] leading-[1.6] text-secondary">
                            {msg}
                        </div>
                        {clamped ? (
                            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-background to-transparent" />
                        ) : null}
                    </div>
                    {steps.length > 0 ? (
                        <div className="border-l border-border pl-3.5 font-mono text-[12px] leading-[1.95] text-muted">
                            {steps.map((s, i) => (
                                <div key={i}>
                                    <span className="inline-block w-11 text-secondary/70">{s.verb}</span>
                                    {s.target}
                                    {s.outcome ? (
                                        <span className={cn("ml-1", s.outcome === "ok" ? "text-accent" : "text-error")}>
                                            {s.outcome === "ok" ? "✓" : "✗"}
                                        </span>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div />
                    )}
                </div>
            )}
        </div>
    );
}
