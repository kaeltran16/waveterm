// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { motion, useMotionValue, useSpring, type MotionValue } from "motion/react";
import { cardVariants, composerReveal, resizeSpring } from "@/app/element/motiontokens";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AgentComposer, type AgentComposerHandle } from "./agentcomposer";
import {
    hasAnswerableAsk,
    isNearBottom,
    isQuiet,
    nextFullWidth,
    projectOf,
    taskProgress,
    type AgentVM,
    type CardTask,
} from "./agentsviewmodel";
import { AnswerBar } from "./answerbar";
import { diffStatsByIdAtom } from "./cardgitstore";
import { lastActivityByIdAtom, liveEntriesByIdAtom, tasksByIdAtom } from "./livetranscript";
import { NarrationTimeline } from "./narrationtimeline";
import { runtimeMeta } from "./runtimemeta";
import { StatusDot } from "./statusdot";

// uniform 25x23 control box (handoff header buttons)
const CTL_BOX =
    "flex h-[23px] w-[25px] shrink-0 cursor-pointer items-center justify-center rounded-[6px] border border-edge-mid text-secondary hover:border-edge-strong hover:bg-white/[0.04]";

function TaskChip({ done, total, onClick }: { done: number; total: number; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={(e) => {
                e.stopPropagation();
                onClick();
            }}
            title="Show task list"
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-[5px] border border-edge-mid bg-surface-raised px-1.5 py-0.5 font-mono text-[9.5px] text-secondary hover:border-edge-strong"
        >
            {done}/{total}
        </button>
    );
}

function TaskPopover({
    tasks,
    done,
    total,
    pct,
    onClose,
}: {
    tasks: CardTask[];
    done: number;
    total: number;
    pct: number;
    onClose: () => void;
}) {
    return (
        <div
            onClick={(e) => e.stopPropagation()}
            className="absolute right-2.5 top-[46px] z-30 max-h-[calc(100%-116px)] w-[min(282px,calc(100%-20px))] overflow-y-auto rounded-[11px] border border-edge-strong bg-surface-raised p-3 shadow-[0_18px_44px_rgba(0,0,0,0.55)]"
        >
            <div className="mb-2.5 flex items-center gap-2">
                <span className="font-mono text-[8.5px] font-bold uppercase tracking-[0.1em] text-muted">Task list</span>
                <span className="rounded-[5px] border border-edge-mid bg-surface px-1.5 py-px font-mono text-[9.5px] text-secondary">
                    {done}/{total}
                </span>
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={onClose}
                    title="Close"
                    className="cursor-pointer text-[12px] text-muted hover:text-secondary"
                >
                    ✕
                </button>
            </div>
            <div className="mb-3 h-[5px] overflow-hidden rounded-[3px] bg-edge-faint">
                <div className="h-full rounded-[3px] bg-success" style={{ width: `${pct}%` }} />
            </div>
            <div className="flex flex-col gap-px">
                {tasks.map((t, i) => (
                    <div key={i} className="flex items-start gap-2.5 py-1">
                        <span
                            className={cn(
                                "mt-px flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border font-mono text-[8px]",
                                t.done ? "border-success/40 bg-success/15 text-success" : "border-edge-mid bg-surface text-muted"
                            )}
                        >
                            {t.done ? "✓" : ""}
                        </span>
                        <span
                            className={cn(
                                "font-mono text-[11.5px] leading-[1.5]",
                                t.done ? "text-muted line-through" : "text-secondary"
                            )}
                        >
                            {t.text}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

export function AgentRow({
    agent,
    now,
    isCursor,
    selections,
    sent,
    activeQuestion,
    composerOpen,
    onCursor,
    onOpen,
    onOpenTerminal,
    onOpenDiff,
    onOpenComposer,
    onToggleAnswer,
    onSubmitAnswer,
    onSelectQuestion,
    onComposerEscape,
    onBackground,
    onDismiss,
    pulse,
    heightPx,
    heightMV,
    fullWidth,
    onResizeStart,
    onResizeHeight,
    onResizeEnd,
    onToggleFullWidth,
    resizing,
}: {
    agent: AgentVM;
    now: number;
    isCursor: boolean;
    selections: Record<number, Set<number>>;
    sent: boolean;
    activeQuestion?: number;
    composerOpen: boolean;
    onCursor: () => void;
    onOpen: () => void;
    onOpenTerminal: () => void;
    onOpenDiff: () => void;
    onOpenComposer: () => void;
    onToggleAnswer: (qi: number, oi: number) => void;
    onSubmitAnswer: () => void;
    onSelectQuestion?: (qi: number) => void;
    onComposerEscape?: () => void;
    onBackground?: () => void;
    onDismiss?: () => void;
    pulse?: boolean;
    heightPx?: number;
    heightMV?: MotionValue<number>; // bound to style.height so the corner drag writes DOM-only (no re-render)
    fullWidth?: boolean; // current full-width state — seeds the corner-drag hysteresis
    onResizeStart?: () => void; // corner pointer-down: snapshot the column's heights
    onResizeHeight?: (dyPx: number) => void; // corner vertical drag: absolute dy from pointer-down
    onResizeEnd?: () => void; // corner pointer-up: flush + re-enable the layout spring
    onToggleFullWidth?: () => void; // corner horizontal drag crossed the ± threshold
    resizing?: boolean; // a corner drag is live anywhere in the grid — suspend the layout spring
}) {
    const composerRef = useRef<AgentComposerHandle>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    // height eases toward the parent-driven target motion value (set instantly by the corner drag). The
    // spring is what the eye follows — smooth during drag, settles on release. jump() past the 0->first
    // -measure ease so cards don't grow in on load; structural re-layouts after that ease naturally.
    const fallbackMV = useMotionValue(heightPx ?? 0);
    const springHeight = useSpring(heightMV ?? fallbackMV, resizeSpring);
    const springSeeded = useRef(false);
    useLayoutEffect(() => {
        if (!springSeeded.current && (heightPx ?? 0) > 0) {
            springHeight.jump((heightMV ?? fallbackMV).get());
            springSeeded.current = true;
        }
    });
    const scrollRef = useRef<HTMLDivElement>(null);
    const stickRef = useRef(true);
    const [tasksOpen, setTasksOpen] = useState(false);
    const [atBottom, setAtBottom] = useState(true);

    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const lastActivity = useAtomValue(lastActivityByIdAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    const quiet = isQuiet(lastActivity[agent.id], now);
    const project = projectOf(agent);
    const rt = runtimeMeta(agent.agent);
    const asking = agent.state === "asking";
    const working = agent.state === "working";
    const idle = agent.state === "idle";
    const hasQuestions = hasAnswerableAsk(agent);
    const qs = agent.ask?.questions ?? [];
    const qIdx = Math.min(activeQuestion ?? 0, Math.max(0, qs.length - 1));
    const question = qs[qIdx]?.question;
    const diff = useAtomValue(diffStatsByIdAtom)[agent.id];
    const tasks = useAtomValue(tasksByIdAtom)[agent.id];
    const prog = tasks && tasks.length > 0 ? taskProgress(tasks) : undefined;
    const showComposer = composerOpen;
    const muteAction = idle ? onDismiss : onBackground;

    // in-row narration sticks to the latest line unless the user scrolls up to read history
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
        const near = isNearBottom(el);
        stickRef.current = near;
        setAtBottom(near);
    };
    const jumpToBottom = () => {
        const el = scrollRef.current;
        if (!el) {
            return;
        }
        el.scrollTop = el.scrollHeight;
        stickRef.current = true;
        setAtBottom(true);
    };

    // one-shot "settle" when this agent finishes (working -> idle); cleared after it plays
    const prevStateRef = useRef(agent.state);
    const [justFinished, setJustFinished] = useState(false);
    useEffect(() => {
        if (prevStateRef.current === "working" && agent.state === "idle") {
            setJustFinished(true);
            const t = setTimeout(() => setJustFinished(false), 520); // matches @keyframes settle .5s
            prevStateRef.current = agent.state;
            return () => clearTimeout(t);
        }
        prevStateRef.current = agent.state;
    }, [agent.state]);

    return (
        <motion.div
            layout={resizing ? false : "position"}
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            ref={cardRef}
            style={{
                // heightPx until the spring is seeded (avoids a mount flicker), springHeight thereafter
                height: heightPx && heightPx > 0 ? (springSeeded.current ? springHeight : heightPx) : undefined,
                flex: heightPx && heightPx > 0 ? undefined : "1 1 0",
                minHeight: 0,
            }}
            data-agent-id={agent.id}
            onClick={onCursor}
            onDoubleClick={onOpen}
            className={cn(
                // each card fills the height its column allotted (heightPx); overflow clipped
                "group relative flex cursor-pointer flex-col overflow-hidden rounded-[13px] border",
                asking
                    ? "border-warning/40 bg-lane-asking animate-[breatheGlow_2.4s_ease-in-out_infinite] motion-reduce:animate-none"
                    : "border-edge-mid bg-lane",
                isCursor &&
                    (asking ? "shadow-[0_0_0_1.5px_var(--color-warning)]" : "shadow-[0_0_0_1.5px_var(--color-accent)]"),
                pulse && "ring-2 ring-warning ring-inset",
                justFinished && "animate-[settle_0.5s_ease-out] motion-reduce:animate-none"
            )}
        >
            {/* header bar */}
            <div className="flex shrink-0 items-center gap-2 border-b border-edge-mid bg-surface px-3 py-1.5">
                <StatusDot state={agent.state} quiet={quiet} pulse={!idle && !quiet} className="!h-2 !w-2" />
                <span
                    title={rt.label}
                    className={cn("shrink-0 font-mono text-[10px] leading-none", rt.text)}
                >
                    {rt.glyph}
                </span>
                <b className="min-w-[30px] flex-1 truncate font-mono text-[13.5px] font-semibold text-primary">
                    {agent.name}
                </b>
                {project ? (
                    <span className="shrink-0 rounded-[5px] border border-edge-mid bg-surface-raised px-1.5 py-px font-mono text-[10px] text-muted">
                        {project}
                    </span>
                ) : null}
                {diff ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onOpenDiff();
                        }}
                        title="Review changes in Diff"
                        className="flex shrink-0 cursor-pointer items-center gap-1 rounded-[5px] border border-edge-mid px-1.5 py-0.5 font-mono text-[9.5px] font-bold hover:border-accent hover:bg-accent/10"
                    >
                        <span className="text-success">+{diff.adds}</span>
                        <span className="text-error">−{diff.dels}</span>
                    </button>
                ) : null}
                {asking ? (
                    <span className="shrink-0 rounded-[4px] bg-warning px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.05em] text-on-warning">
                        needs you
                    </span>
                ) : null}
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onOpenTerminal();
                    }}
                    title="Open terminal (T)"
                    className={cn(CTL_BOX, "font-mono text-[9px] font-bold")}
                >
                    {">_"}
                </button>
                {muteAction ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            muteAction();
                        }}
                        title={idle ? "Dismiss to Idle" : "Mute & background (M)"}
                        className={cn(CTL_BOX, "text-[11px]")}
                    >
                        ⤓
                    </button>
                ) : null}
            </div>

            {/* asking band */}
            {asking ? (
                <div className="shrink-0 border-b border-edge-mid px-3.5 py-2.5">
                    <div className="mb-1.5 flex items-center gap-2">
                        <span className="font-mono text-[8.5px] font-bold uppercase tracking-[0.1em] text-ask-label">
                            Waiting on you
                        </span>
                        <div className="flex-1" />
                        {prog ? <TaskChip done={prog.done} total={prog.total} onClick={() => setTasksOpen((v) => !v)} /> : null}
                    </div>
                    {question ? (
                        <p className="text-[14px] font-semibold leading-[1.5] text-ask-question">{question}</p>
                    ) : null}
                </div>
            ) : null}

            {/* task popover (placeholder) */}
            {tasksOpen && tasks && prog ? (
                <TaskPopover
                    tasks={tasks}
                    done={prog.done}
                    total={prog.total}
                    pct={prog.pct}
                    onClose={() => setTasksOpen(false)}
                />
            ) : null}

            {/* scrollable body: feed + answer + composer scroll together as one region, so nothing
                clips at small card heights and the whole card reads as vertically scrollable. The feed
                grows to keep the composer pinned to the bottom when content is short; the region scrolls
                when it overflows. Header + asking band stay pinned above. The relative wrapper anchors
                the jump-to-latest pill to the viewport bottom (it must not scroll with the feed). */}
            <div className="relative flex min-h-0 flex-1 flex-col">
            <div
                ref={scrollRef}
                onScroll={onNarrationScroll}
                className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden"
            >
                {/* feed */}
                <div className="shrink-0 grow px-3 py-1.5">
                    {working && agent.activity ? (
                        <div className="mb-1.5 flex items-center gap-2 border-b border-edge-mid pb-1.5">
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success animate-[pulseDot_1.6s_infinite] motion-reduce:animate-none" />
                            <span
                                title={agent.activity}
                                className="min-w-0 flex-1 truncate font-mono text-[12px] leading-[1.4] text-success-soft"
                            >
                                {agent.activity}
                            </span>
                            {prog ? (
                                <TaskChip done={prog.done} total={prog.total} onClick={() => setTasksOpen((v) => !v)} />
                            ) : null}
                        </div>
                    ) : null}
                    {entries.length > 0 ? <NarrationTimeline entries={entries} accentLatest active={!idle} /> : null}
                </div>

                {/* structured answer band */}
                {asking && hasQuestions ? (
                    <AnswerBar
                        agent={agent}
                        selections={selections}
                        sent={sent}
                        numbered
                        hideQuestion
                        activeQuestion={activeQuestion}
                        onToggle={onToggleAnswer}
                        onSubmit={onSubmitAnswer}
                        onSelectQuestion={onSelectQuestion}
                        className="shrink-0 border-t border-edge-mid px-3 py-2"
                    />
                ) : null}

                {/* footer: reply chips (asking, always visible) above the composer, which collapses
                    to a slim "+ message… R" row by default and expands on R / click */}
                <div className="shrink-0 border-t border-edge-mid">
                    {asking && agent.ask?.replySuggestions?.length ? (
                        <div className="flex flex-wrap gap-1.5 px-3 pt-2">
                            {agent.ask.replySuggestions.map((s, i) => (
                                <button
                                    key={i}
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (composerOpen) {
                                            composerRef.current?.fill(s);
                                        } else {
                                            onOpenComposer();
                                            requestAnimationFrame(() => composerRef.current?.fill(s));
                                        }
                                    }}
                                    className="cursor-pointer whitespace-nowrap rounded-[7px] border border-warning/30 bg-warning/10 px-2.5 py-1 text-[11px] text-warning hover:border-warning/55 hover:bg-warning/20"
                                >
                                    {s}
                                </button>
                            ))}
                        </div>
                    ) : null}
                    {showComposer ? (
                        <motion.div
                            variants={composerReveal}
                            initial="initial"
                            animate="animate"
                            className="flex flex-col gap-1.5 overflow-hidden px-3 py-2"
                            onClick={(e) => e.stopPropagation()}
                            onDoubleClick={(e) => e.stopPropagation()}
                        >
                            <AgentComposer
                                ref={composerRef}
                                blockId={agent.blockId}
                                placeholder={`message ${agent.name}…`}
                                onEscape={onComposerEscape}
                                className="border-t-0 px-0 py-0"
                            />
                        </motion.div>
                    ) : (
                        <div
                            onClick={(e) => {
                                e.stopPropagation();
                                onOpenComposer();
                            }}
                            className="flex cursor-text items-center gap-2 px-3 py-1.5 hover:bg-surface-hover"
                        >
                            <span className="flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[5px] border border-edge-mid text-[10px] leading-none text-muted">
                                +
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[12px] text-secondary">{`message ${agent.name}…`}</span>
                            <span className="shrink-0 rounded-[5px] border border-edge-mid px-1.5 py-0.5 font-mono text-[9.5px] text-muted">
                                R
                            </span>
                        </div>
                    )}
                </div>
            </div>
                {!atBottom ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            jumpToBottom();
                        }}
                        title="Jump to latest"
                        className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-edge-strong bg-surface-raised px-2.5 py-1 text-[11px] font-medium text-secondary shadow-[0_10px_28px_rgba(0,0,0,0.5)] hover:border-accent hover:text-primary"
                    >
                        <span className="text-[12px] leading-none">↓</span> Latest
                    </button>
                ) : null}
            </div>

            {/* bottom-right corner grip: drag down = taller, drag out (±48px) = full-width span */}
            {onResizeHeight || onToggleFullWidth ? (
                <div
                    onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const startX = e.clientX;
                        const startY = e.clientY;
                        let applied = !!fullWidth; // seed hysteresis with the current state
                        onResizeStart?.();
                        const move = (ev: PointerEvent) => {
                            onResizeHeight?.(ev.clientY - startY);
                            const target = nextFullWidth(applied, ev.clientX - startX);
                            if (target !== applied) {
                                applied = target;
                                onToggleFullWidth?.();
                            }
                        };
                        const up = () => {
                            window.removeEventListener("pointermove", move);
                            window.removeEventListener("pointerup", up);
                            onResizeEnd?.();
                        };
                        window.addEventListener("pointermove", move);
                        window.addEventListener("pointerup", up);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    title={fullWidth ? "Drag in to un-span · down to resize" : "Drag out to span · down to resize"}
                    className="group/grip absolute bottom-[2px] right-[2px] z-20 flex h-[18px] w-[18px] cursor-nwse-resize items-end justify-end p-[3px] opacity-0 transition-opacity group-hover:opacity-100"
                >
                    <div className="h-[8px] w-[8px] rounded-br-[3px] border-b-2 border-r-2 border-edge-strong group-hover/grip:border-accent" />
                </div>
            ) : null}
        </motion.div>
    );
}
