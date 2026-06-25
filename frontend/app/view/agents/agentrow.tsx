// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { Reorder, useDragControls } from "motion/react";
import { useEffect, useRef } from "react";
import { AgentComposer, type AgentComposerHandle } from "./agentcomposer";
import { AnswerBar } from "./answerbar";
import { cardSpanStyle, formatAge, hasAnswerableAsk, isQuiet, type AgentVM } from "./agentsviewmodel";
import { lastActivityByIdAtom, liveEntriesByIdAtom } from "./livetranscript";
import { NarrationTimeline } from "./narrationtimeline";
import { projectNameFromTranscriptPath } from "./projectname";
import { StatusDot } from "./statusdot";

export function AgentRow({
    agent,
    now,
    isCursor,
    selections,
    sent,
    activeQuestion,
    onCursor,
    onOpen,
    onOpenTerminal,
    onToggleAnswer,
    onSubmitAnswer,
    onSelectQuestion,
    onComposerEscape,
    onBackground,
    onDismiss,
    pulse,
    wide,
    height,
    onToggleWide,
    onResize,
}: {
    agent: AgentVM;
    now: number;
    isCursor: boolean;
    selections: Record<number, Set<number>>;
    sent: boolean;
    activeQuestion?: number;
    onCursor: () => void;
    onOpen: () => void;
    onOpenTerminal: () => void;
    onToggleAnswer: (qi: number, oi: number) => void;
    onSubmitAnswer: () => void;
    onSelectQuestion?: (qi: number) => void;
    onComposerEscape?: () => void;
    onBackground?: () => void;
    onDismiss?: () => void;
    pulse?: boolean;
    wide?: boolean;
    height?: number;
    onToggleWide: () => void;
    onResize: (height: number) => void;
}) {
    const controls = useDragControls();
    const composerRef = useRef<AgentComposerHandle>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const onResizeStart = (e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const startY = e.clientY;
        const startH = height ?? cardRef.current?.offsetHeight ?? 0;
        const move = (ev: PointerEvent) => onResize(Math.max(140, startH + (ev.clientY - startY)));
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const lastActivity = useAtomValue(lastActivityByIdAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    const quiet = isQuiet(lastActivity[agent.id], now);
    const project = projectNameFromTranscriptPath(agent.transcriptPath);
    const asking = agent.state === "asking";
    const idle = agent.state === "idle";
    const idleMs = agent.idleSince != null ? Math.max(0, now - agent.idleSince) : undefined;
    const hasQuestions = hasAnswerableAsk(agent);

    // in-row narration sticks to the latest line unless the user scrolls up to read history
    const scrollRef = useRef<HTMLDivElement>(null);
    const stickRef = useRef(true);
    useEffect(() => {
        const el = scrollRef.current;
        if (el && stickRef.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [entries]);
    const onNarrationScroll = () => {
        const el = scrollRef.current;
        if (!el) {
            return;
        }
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    };

    return (
        <Reorder.Item
            as="div"
            value={agent.id}
            dragListener={false}
            dragControls={controls}
            dragMomentum={false}
            dragTransition={{ bounceStiffness: 600, bounceDamping: 30 }}
            layout
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ layout: { type: "spring", stiffness: 650, damping: 32 }, opacity: { duration: 0.15 } }}
            ref={cardRef}
            style={cardSpanStyle({ wide, height })}
            data-agent-id={agent.id}
            onClick={onCursor}
            onDoubleClick={onOpen}
            className={cn(
                "group relative flex cursor-pointer flex-col overflow-hidden rounded-[13px] border border-border bg-panel px-4 py-3 transition-colors",
                asking ? "bg-warning/5" : "hover:bg-white/[0.02]",
                isCursor &&
                    (asking
                        ? "bg-warning/10 shadow-[inset_3px_0_0_var(--color-warning)]"
                        : "bg-accent/[0.06] shadow-[inset_3px_0_0_var(--color-accent)]"),
                pulse && "ring-2 ring-warning ring-inset"
            )}
        >
            <div className="flex shrink-0 items-center gap-2.5">
                <span
                    onPointerDown={(e) => controls.start(e)}
                    onClick={(e) => e.stopPropagation()}
                    title="Drag to reorder"
                    className="shrink-0 cursor-grab touch-none select-none text-[11px] text-muted opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
                >
                    ⠿
                </span>
                <StatusDot state={agent.state} quiet={quiet} />
                <b className={cn("shrink-0 text-primary", asking ? "text-[15px]" : "text-[14px]")}>{agent.name}</b>
                <span className="truncate text-[12px] text-muted">
                    {project ? `${project} · ` : ""}
                    {idle ? agent.activity ?? "" : agent.task}
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
                {onBackground ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onBackground();
                        }}
                        title="Background (b) — collapse, keep running"
                        className="shrink-0 cursor-pointer rounded-[6px] border border-border p-1 text-secondary opacity-0 transition-opacity hover:bg-white/[0.04] group-hover:opacity-100"
                    >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                            <path d="M3 8h10M3 11h10M3 5h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                        </svg>
                    </button>
                ) : null}
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
                        onToggleWide();
                    }}
                    title={wide ? "Narrow" : "Widen"}
                    className="shrink-0 cursor-pointer rounded-[6px] border border-border px-1.5 py-0.5 text-[11px] text-secondary opacity-0 transition-opacity hover:bg-white/[0.04] group-hover:opacity-100"
                >
                    {wide ? "⤡" : "⤢"}
                </button>
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
                <div className="mt-2 ml-[26px] font-mono text-[8.5px] font-bold uppercase tracking-[0.1em] text-warning/80">
                    Waiting on you
                </div>
            ) : agent.state === "working" && agent.activity ? (
                <div className="mt-2 ml-[26px] flex items-start gap-2">
                    <span
                        className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-success"
                        style={{ animation: "pulseDot 1.4s infinite" }}
                    />
                    <span className="font-mono text-[12.5px] leading-[1.5] text-success">{agent.activity}</span>
                </div>
            ) : null}

            {entries.length > 0 ? (
                <div ref={scrollRef} onScroll={onNarrationScroll} className="mt-2 ml-[26px] max-h-56 min-h-[64px] overflow-y-auto">
                    <NarrationTimeline entries={entries} accentLatest active={agent.state !== "idle"} />
                </div>
            ) : null}

            {asking && hasQuestions ? (
                <AnswerBar
                    agent={agent}
                    selections={selections}
                    sent={sent}
                    numbered
                    activeQuestion={activeQuestion}
                    onToggle={onToggleAnswer}
                    onSubmit={onSubmitAnswer}
                    onSelectQuestion={onSelectQuestion}
                    className="mt-2 ml-[26px] shrink-0"
                />
            ) : null}

            <div
                className="mt-2 ml-[26px] flex shrink-0 flex-col gap-2 pb-2"
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
            >
                {asking && agent.ask?.replySuggestions?.length ? (
                    <div className="flex flex-wrap gap-1.5">
                        {agent.ask.replySuggestions.map((s, i) => (
                            <button
                                key={i}
                                type="button"
                                onClick={() => composerRef.current?.fill(s)}
                                className="cursor-pointer whitespace-nowrap rounded-[7px] border border-warning/30 bg-warning/10 px-2.5 py-1 text-[11px] text-warning hover:border-warning/55 hover:bg-warning/20"
                            >
                                {s}
                            </button>
                        ))}
                    </div>
                ) : null}
                <AgentComposer
                    ref={composerRef}
                    blockId={agent.blockId}
                    placeholder={`message ${agent.name}…`}
                    onEscape={onComposerEscape}
                    className="border-t-0 px-0 py-0"
                />
            </div>
            <div
                onPointerDown={onResizeStart}
                title="Drag to resize"
                className="absolute inset-x-0 bottom-0 flex h-[9px] cursor-ns-resize items-center justify-center"
            >
                <div className="h-[3px] w-[34px] rounded-[3px] bg-edge-strong" />
            </div>
        </Reorder.Item>
    );
}
