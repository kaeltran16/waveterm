// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ContextMenuModel } from "@/app/store/contextmenu";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { motion, useReducedMotion, useSpring, type MotionValue } from "motion/react";
import { Copy, GitCompare, Minimize2, PanelRight, Scaling, SquareTerminal, X } from "lucide-react";
import { cardVariants, composerReveal, resizeSpring } from "@/app/element/motiontokens";
import { PopoverReveal } from "@/app/element/popoverreveal";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { confirmCloseAgent } from "./agentactions";
import { AgentComposer, type AgentComposerHandle } from "./agentcomposer";
import {
    formatAge,
    hasAnswerableAsk,
    isQuiet,
    nextFullWidth,
    projectOf,
    taskProgress,
    type AgentVM,
    type CardRect,
    type CardTask,
} from "./agentsviewmodel";
import { AttentionBanner, BannerChip } from "./attentioncard";
import { AnswerBar } from "./answerbar";
import { diffStatsByIdAtom } from "./cardgitstore";
import { lastActivityByIdAtom, liveEntriesByIdAtom, tasksByIdAtom } from "./livetranscript";
import { NarrationTimeline } from "./narrationtimeline";
import { runtimeMeta } from "./runtimemeta";
import { StatusDot } from "./statusdot";
import { JumpToLatestPill, useStickToBottom } from "./sticktobottom";
import { subagentsByIdAtom } from "./subagentsstore";
import type { SubagentState, SubagentVM } from "./session-models/sessionviewmodel";

// uniform 25x23 control box (handoff header buttons)
const CTL_BOX =
    "flex h-[23px] w-[25px] shrink-0 cursor-pointer items-center justify-center rounded-sm border border-edge-mid text-secondary hover:border-edge-strong hover:bg-white/[0.04]";

const SUB_COLOR: Record<SubagentState, string> = {
    working: "var(--color-accent)",
    success: "var(--color-success)",
    failure: "var(--color-error)",
    done: "var(--color-muted)",
};

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
        <div onClick={(e) => e.stopPropagation()}>
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

// A ⑃ N fan-out badge for the cockpit card: count of the agent's subagents, with a hover peek listing
// each child's type + state dot. Read-only; clicking opens the focused view (where the tree/interior live).
function FanoutBadge({ subs, onOpen }: { subs: SubagentVM[]; onOpen: () => void }) {
    const [peek, setPeek] = useState(false);
    return (
        <div className="relative shrink-0" onMouseEnter={() => setPeek(true)} onMouseLeave={() => setPeek(false)}>
            <button
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    onOpen();
                }}
                title={`${subs.length} subagent${subs.length === 1 ? "" : "s"}`}
                className="flex cursor-pointer items-center gap-1 rounded-[5px] border border-edge-mid px-1.5 py-0.5 font-mono text-[9.5px] font-bold text-muted hover:border-accent hover:text-accent-soft"
            >
                <span className="text-[10px] leading-none">⑃</span>
                {subs.length}
            </button>
            <PopoverReveal
                open={peek}
                origin="top right"
                className="absolute right-0 top-[24px] z-30 w-[212px] rounded-[9px] border border-edge-strong bg-surface-raised p-2 shadow-[0_14px_36px_rgba(0,0,0,0.5)]"
            >
                <div className="flex flex-col gap-1">
                    {subs.map((s) => (
                        <div key={s.id} className="flex items-center gap-2">
                            <span className="h-[5px] w-[5px] shrink-0 rounded-full" style={{ background: SUB_COLOR[s.state] }} />
                            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-secondary">{s.type || "subagent"}</span>
                            <span className="font-mono text-[9px] text-muted">{s.state}</span>
                        </div>
                    ))}
                </div>
            </PopoverReveal>
        </div>
    );
}

export function AgentRow({
    agent,
    now,
    isCursor,
    selections,
    texts,
    sent,
    activeQuestion,
    composerOpen,
    onCursor,
    onOpen,
    onOpenTerminal,
    onOpenDiff,
    onOpenComposer,
    onToggleAnswer,
    onAnswerText,
    onSubmitAnswer,
    onSelectQuestion,
    onComposerEscape,
    onBackground,
    onDismiss,
    pulse,
    rect,
    xMV,
    yMV,
    wMV,
    hMV,
    fullWidth,
    elevated,
    onResizeStart,
    onResizeMove,
    onResizeEnd,
    onToggleFullWidth,
}: {
    agent: AgentVM;
    now: number;
    isCursor: boolean;
    selections: Record<number, Set<number>>;
    texts: Record<number, string>;
    sent: boolean;
    activeQuestion?: number;
    composerOpen: boolean;
    onCursor: () => void;
    onOpen: () => void;
    onOpenTerminal: () => void;
    onOpenDiff: () => void;
    onOpenComposer: () => void;
    onToggleAnswer: (qi: number, oi: number) => void;
    onAnswerText: (qi: number, value: string) => void;
    onSubmitAnswer: () => void;
    onSelectQuestion?: (qi: number) => void;
    onComposerEscape?: () => void;
    onBackground?: () => void;
    onDismiss?: () => void;
    pulse?: boolean;
    rect: CardRect; // current target geometry — seeds the springs and is the pre-measure fallback
    xMV: MotionValue<number>; // parent-held; springs below ease toward these on layout change
    yMV: MotionValue<number>;
    wMV: MotionValue<number>;
    hMV: MotionValue<number>; // the corner drag writes this directly (DOM-only, no re-render)
    fullWidth?: boolean; // current full-width state — seeds the corner-drag hysteresis
    elevated?: boolean; // render above siblings (mid-drag the card grows in place over its neighbours)
    onResizeStart?: () => void; // corner pointer-down: snapshot the column's heights
    onResizeMove?: (dxPx: number, dyPx: number, pendingFull: boolean) => void; // corner drag: dx/dy + pending full-width
    onResizeEnd?: (full: boolean) => void; // corner pointer-up: commit height + the pending full-width state
    onToggleFullWidth?: () => void; // flips this card's full-width pref
}) {
    const composerRef = useRef<AgentComposerHandle>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    // Geometry eases toward parent-driven target motion values (the corner drag writes hMV directly).
    // Springs run off React (no per-frame re-render). Under reduced motion the raw MV drives style so
    // nothing animates. jump() past the 0->first-measure ease so cards don't fly in from the origin on
    // load; structural re-layouts after that ease naturally.
    const reduce = useReducedMotion();
    const springX = useSpring(xMV, resizeSpring);
    const springY = useSpring(yMV, resizeSpring);
    const springW = useSpring(wMV, resizeSpring);
    const springH = useSpring(hMV, resizeSpring);
    const x = reduce ? xMV : springX;
    const y = reduce ? yMV : springY;
    const w = reduce ? wMV : springW;
    const h = reduce ? hMV : springH;
    const springSeeded = useRef(false);
    useLayoutEffect(() => {
        if (!springSeeded.current && rect.w > 0) {
            springX.jump(xMV.get());
            springY.jump(yMV.get());
            springW.jump(wMV.get());
            springH.jump(hMV.get());
            springSeeded.current = true;
        }
    });
    const [tasksOpen, setTasksOpen] = useState(false);

    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const lastActivity = useAtomValue(lastActivityByIdAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    const { scrollRef, onScroll, atBottom, jumpToBottom } = useStickToBottom(entries);
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
    const subs = useAtomValue(subagentsByIdAtom)[agent.id] ?? [];
    const tasks = useAtomValue(tasksByIdAtom)[agent.id];
    const prog = tasks && tasks.length > 0 ? taskProgress(tasks) : undefined;
    const showComposer = composerOpen;
    const muteAction = idle ? onDismiss : onBackground;
    const onContextMenu = (e: React.MouseEvent) => {
        const items: ContextMenuItem[] = [
            { label: "Open", icon: <PanelRight size={15} />, click: onOpen },
            { label: "Open terminal", icon: <SquareTerminal size={15} />, click: onOpenTerminal },
        ];
        if (diff) {
            items.push({ label: "Review changes", icon: <GitCompare size={15} />, click: onOpenDiff });
        }
        if (onToggleFullWidth) {
            items.push({
                label: fullWidth ? "Exit full width" : "Full width",
                icon: <Scaling size={15} />,
                click: onToggleFullWidth,
            });
        }
        if (muteAction) {
            items.push({ label: "Move to background", icon: <Minimize2 size={15} />, click: muteAction });
        }
        items.push({
            label: "Copy name",
            icon: <Copy size={15} />,
            click: () => void navigator.clipboard.writeText(agent.name),
        });
        items.push({ type: "separator" });
        items.push({
            label: "Close agent",
            icon: <X size={15} />,
            danger: true,
            click: () => confirmCloseAgent(agent.id, agent.name),
        });
        ContextMenuModel.getInstance().showContextMenu(items, e);
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
            // All cards are absolute siblings in one container; x/y/w/h are spring-driven motion values
            // (real dimensions, never transform:scale), so width/height/position change without any
            // content distortion and a move never remounts (no crossfade). variants animate opacity+scale
            // for genuine mount/unmount only.
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            ref={cardRef}
            style={{
                position: "absolute",
                left: 0,
                top: 0,
                x,
                y,
                width: w,
                height: h,
                minHeight: 0,
                // full-width cards sit above the columns; a card mid-resize grows in place over its
                // neighbours and must stay on top through the drag and the settle that follows
                zIndex: fullWidth || elevated ? 30 : undefined,
            }}
            data-agent-id={agent.id}
            onClick={onCursor}
            onContextMenu={onContextMenu}
            className={cn(
                // card fills its spring-driven height (h); overflow clipped
                "group relative flex cursor-pointer flex-col overflow-hidden rounded-[13px] border",
                asking
                    ? "border-warning/40 bg-lane animate-[breatheGlow_2.4s_ease-in-out_infinite] motion-reduce:animate-none"
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
                {subs.length > 0 ? <FanoutBadge subs={subs} onOpen={onOpen} /> : null}
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
                        title={idle ? "Move to background" : "Move to background (B)"}
                        className={CTL_BOX}
                    >
                        {/* down-chevron into a tray line: collapse this card into the background lane */}
                        <svg
                            viewBox="0 0 16 16"
                            width="12"
                            height="12"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.6}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M4 5 L8 9 L12 5" />
                            <path d="M4 11.5 H12" />
                        </svg>
                    </button>
                ) : null}
            </div>

            {/* streaming flow bar — a subtle accent sweep under the header while the agent works */}
            {working ? (
                <div className="h-[2px] shrink-0 overflow-hidden bg-lane">
                    <div className="h-full w-[26%] bg-gradient-to-r from-transparent via-accent to-transparent animate-[flowBar_1.9s_linear_infinite] motion-reduce:animate-none" />
                </div>
            ) : null}

            {/* asking banner (4b) — amber strip carries the "your turn" signal; question reads neutral */}
            {asking ? (
                <>
                    <AttentionBanner
                        glyph="diamond"
                        label="Waiting on you"
                        meta={formatAge(agent.activeMs)}
                        right={
                            prog ? (
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setTasksOpen((v) => !v);
                                    }}
                                    title="Show task list"
                                    className="cursor-pointer"
                                >
                                    <BannerChip>
                                        {prog.done}/{prog.total}
                                    </BannerChip>
                                </button>
                            ) : null
                        }
                    />
                    {question ? (
                        <p className="shrink-0 border-b border-edge-mid px-3.5 py-2.5 text-[14px] font-semibold leading-[1.5] text-primary">
                            {question}
                        </p>
                    ) : null}
                </>
            ) : null}

            {/* task popover */}
            <PopoverReveal
                open={tasksOpen && !!tasks && !!prog}
                origin="top right"
                className="absolute right-2.5 top-[46px] z-30 max-h-[calc(100%-116px)] w-[min(282px,calc(100%-20px))] overflow-y-auto rounded-[11px] border border-edge-strong bg-surface-raised p-3 shadow-[0_18px_44px_rgba(0,0,0,0.55)]"
            >
                {tasks && prog ? (
                    <TaskPopover
                        tasks={tasks}
                        done={prog.done}
                        total={prog.total}
                        pct={prog.pct}
                        onClose={() => setTasksOpen(false)}
                    />
                ) : null}
            </PopoverReveal>

            {/* scrollable body: feed + answer + composer scroll together as one region, so nothing
                clips at small card heights and the whole card reads as vertically scrollable. The feed
                grows to keep the composer pinned to the bottom when content is short; the region scrolls
                when it overflows. Header + asking band stay pinned above. The relative wrapper anchors
                the jump-to-latest pill to the viewport bottom (it must not scroll with the feed). */}
            <div className="relative flex min-h-0 flex-1 flex-col">
            <div
                ref={scrollRef}
                onScroll={onScroll}
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
                        texts={texts}
                        sent={sent}
                        numbered
                        hideQuestion
                        activeQuestion={activeQuestion}
                        onToggle={onToggleAnswer}
                        onText={onAnswerText}
                        onSubmit={onSubmitAnswer}
                        onSelectQuestion={onSelectQuestion}
                        className="shrink-0 border-t border-edge-mid px-3 py-2"
                    />
                ) : null}

                {/* footer: the composer collapses to a slim "+ message… R" row by default and expands
                    on R / click. The structured AnswerBar above is the single suggestion affordance —
                    the free-form reply chips were removed so an ask never shows two suggestion rows. */}
                <div className="shrink-0 border-t border-edge-mid">
                    {showComposer ? (
                        <motion.div
                            variants={composerReveal}
                            initial="initial"
                            animate="animate"
                            className="flex flex-col gap-1.5 overflow-hidden px-3 py-2"
                            onClick={(e) => e.stopPropagation()}
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
                {!atBottom ? <JumpToLatestPill onClick={jumpToBottom} /> : null}
            </div>

            {/* bottom-right corner grip: drag down = taller, drag out (±48px) = full-width span */}
            {onResizeMove ? (
                <div
                    onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const startX = e.clientX;
                        const startY = e.clientY;
                        // pending full-width via hysteresis; committed on release, not mid-drag — the card
                        // grows in place during the drag and snaps to its slot only on pointer-up
                        let pendingFull = !!fullWidth;
                        onResizeStart?.();
                        const move = (ev: PointerEvent) => {
                            const dx = ev.clientX - startX;
                            pendingFull = nextFullWidth(pendingFull, dx);
                            onResizeMove?.(dx, ev.clientY - startY, pendingFull);
                        };
                        const up = () => {
                            window.removeEventListener("pointermove", move);
                            window.removeEventListener("pointerup", up);
                            onResizeEnd?.(pendingFull);
                        };
                        window.addEventListener("pointermove", move);
                        window.addEventListener("pointerup", up);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    title={fullWidth ? "Drag in to un-span · down to resize" : "Drag out to span · down to resize"}
                    className="group/grip absolute bottom-[2px] right-[2px] z-20 flex h-[20px] w-[20px] cursor-nwse-resize items-center justify-center rounded-[5px] text-muted opacity-60 transition-opacity group-hover:opacity-100 hover:bg-surface-raised group-hover/grip:text-accent"
                >
                    {/* lucide scaling glyph: reads as "resize / drag out to span" more clearly than bare corner lines */}
                    <Scaling size={14} strokeWidth={1.8} />
                </div>
            ) : null}
        </motion.div>
    );
}

