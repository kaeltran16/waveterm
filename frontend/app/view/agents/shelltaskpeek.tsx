// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A background shell task's output, or a Monitor's events and output, in a floating peek beside its tree row.
// Re-reads the output file while the task runs and follows the tail. Esc closes it through the keybinding
// registry (shelltask:back).

import { cardVariants, computeEntrances, initialEntranceState, viewFade } from "@/app/element/motiontokens";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import {
    autoUpdate,
    FloatingPortal,
    offset,
    shift,
    useDismiss,
    useFloating,
    useInteractions,
} from "@floating-ui/react";
import { useAtomValue } from "jotai";
import { Radio, Terminal, X } from "lucide-react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import {
    clockTime,
    monitorEventsSummary,
    monitorExpiresAt,
    monitorTimeLeft,
    OUTPUT_MAX_CHARS,
    type MonitorEvent,
    type ShellTask,
} from "./shelltasks";
import { readShellTaskOutput, shellTaskPeekAtom } from "./shelltasksstore";
import { JumpToLatestPill, useStickToBottom } from "./sticktobottom";

const OUTPUT_POLL_MS = 2000;
// from a tree row's right edge past the tree's own 8px padding, so the peek sits 8px beside the tree
const PEEK_GAP_PX = 16;
const NO_LINES: string[] = [];
const NO_EVENTS: MonitorEvent[] = [];
type MonitorView = "events" | "output";
const TAIL_LABEL = `last ${OUTPUT_MAX_CHARS / 1024} KB · live`;

// a running task's output is still growing, so it is re-read on a timer
function useTaskOutput(path: string | undefined): string[] | null {
    const [lines, setLines] = useState<string[] | null>(null);
    useEffect(() => {
        if (!path) {
            setLines([]);
            return;
        }
        let mounted = true;
        const read = () => void readShellTaskOutput(path).then((l) => mounted && setLines(l));
        read();
        const timer = setInterval(read, OUTPUT_POLL_MS);
        return () => {
            mounted = false;
            clearInterval(timer);
        };
    }, [path]);
    return lines;
}

const close = () => globalStore.set(shellTaskPeekAtom, null);

function OutputBody({ path }: { path: string | undefined }) {
    const lines = useTaskOutput(path);
    const { scrollRef, onScroll, atBottom, jumpToBottom } = useStickToBottom(lines ?? NO_LINES);
    return (
        <div className="relative border-t border-edge-mid bg-surface-code">
            <div
                ref={scrollRef}
                onScroll={onScroll}
                className="max-h-[360px] overflow-auto p-[10px] font-mono text-[11.5px] leading-[1.5]"
            >
                {lines != null && lines.length === 0 ? (
                    <div className="text-muted">No output yet.</div>
                ) : (
                    (lines ?? NO_LINES).map((line, i) => (
                        <div key={i} className="whitespace-pre-wrap break-words text-secondary">
                            {line}
                        </div>
                    ))
                )}
            </div>
            <JumpToLatestPill show={!atBottom} onClick={jumpToBottom} />
        </div>
    );
}

function EventsBody({ taskId, events }: { taskId: string; events: MonitorEvent[] }) {
    const { scrollRef, onScroll, atBottom, jumpToBottom } = useStickToBottom(events);
    // events only append, so an index is an event's id. One arriving while the peek is open enters as a card; keyed
    // on the task, so the events already there when the peek or the tab opens never cascade. Committed in a layout
    // effect: render can run twice
    const ids = events.map((_, i) => String(i));
    const entranceRef = useRef(initialEntranceState());
    const { animate: entering } = computeEntrances(entranceRef.current, taskId, ids);
    useLayoutEffect(() => {
        entranceRef.current = computeEntrances(entranceRef.current, taskId, ids).state;
    }, [events.length, taskId]);
    return (
        <div className="relative border-t border-edge-mid bg-surface-code">
            {events.length === 0 ? (
                <div className="p-[10px] font-mono text-[11.5px] leading-[1.5] text-muted">No events yet.</div>
            ) : (
                <div
                    ref={scrollRef}
                    onScroll={onScroll}
                    className="max-h-[360px] overflow-auto px-[10px] py-[4px] font-mono text-[11.5px] leading-[1.5]"
                >
                    {/* its own presence: rows mounted later under the view swap's would skip their entrance */}
                    <AnimatePresence initial={false}>
                        {events.map((e, i) => (
                            <motion.div
                                key={i}
                                variants={cardVariants}
                                initial={entering.has(String(i)) ? "initial" : false}
                                animate="animate"
                                data-monitor-event
                                className={cn("flex gap-[10px] py-[6px]", i > 0 && "border-t border-edge-faint")}
                            >
                                <span
                                    data-monitor-event-time
                                    className="w-[62px] flex-none pt-[1px] text-[10.5px] text-muted"
                                >
                                    {e.ts != null ? clockTime(e.ts) : ""}
                                </span>
                                <div className="min-w-0 flex-1">
                                    {e.lines.map((line, j) => (
                                        <div key={j} className="whitespace-pre-wrap break-words text-secondary">
                                            {line}
                                        </div>
                                    ))}
                                </div>
                            </motion.div>
                        ))}
                    </AnimatePresence>
                </div>
            )}
            <JumpToLatestPill show={!atBottom} onClick={jumpToBottom} />
        </div>
    );
}

function PeekFooter({
    left,
    leftTitle,
    children,
}: {
    left: string | undefined;
    leftTitle?: string;
    children?: ReactNode;
}) {
    return (
        <div
            data-peek-footer
            className="flex items-center gap-[8px] border-t border-edge-mid px-[10px] py-[6px] font-mono text-[10.5px] text-muted"
        >
            <span className="min-w-0 flex-1 truncate" title={leftTitle}>
                {left}
            </span>
            {children}
        </div>
    );
}

function MonitorTab({
    label,
    view,
    active,
    onSelect,
}: {
    label: string;
    view: MonitorView;
    active: boolean;
    onSelect: () => void;
}) {
    return (
        <button
            type="button"
            role="tab"
            data-peek-tab={view}
            aria-selected={active}
            onClick={onSelect}
            className={cn(
                "h-[20px] cursor-pointer rounded-[4px] px-[8px] font-mono text-[10.5px] font-semibold",
                active ? "bg-accentbg text-accent-soft" : "text-secondary hover:text-primary"
            )}
        >
            {label}
        </button>
    );
}

function MonitorPeekBody({ task, now }: { task: ShellTask; now: number }) {
    const [view, setView] = useState<MonitorView>("events");
    const events = task.events ?? NO_EVENTS;
    const expiresAt = monitorExpiresAt(task);
    const timeLeft = monitorTimeLeft(task, now)?.replace(/ left$/, "");
    return (
        <>
            {task.command ? (
                <div
                    data-monitor-command
                    title={task.command}
                    className="truncate px-[10px] pb-[8px] font-mono text-[10.5px] text-muted"
                >
                    {`$ ${task.command}`}
                </div>
            ) : null}
            <div className="px-[10px] pb-[8px]">
                <div
                    role="tablist"
                    aria-label="Monitor view"
                    className="inline-flex gap-[2px] rounded-[6px] border border-edge-mid bg-surface p-[2px]"
                >
                    <MonitorTab
                        label={`Events ${events.length}`}
                        view="events"
                        active={view === "events"}
                        onSelect={() => setView("events")}
                    />
                    <MonitorTab
                        label="Output"
                        view="output"
                        active={view === "output"}
                        onSelect={() => setView("output")}
                    />
                </div>
            </div>
            <AnimatePresence initial={false} mode="wait">
                <motion.div key={view} data-peek-view={view} variants={viewFade} initial="initial" animate="animate">
                    {view === "events" ? (
                        <>
                            <EventsBody taskId={task.id} events={events} />
                            <PeekFooter
                                left={
                                    monitorEventsSummary(task, now) ??
                                    (task.startedTs != null
                                        ? `watching since ${clockTime(task.startedTs)}`
                                        : "watching")
                                }
                            >
                                {task.persistent ? (
                                    <span className="flex-none">persistent</span>
                                ) : expiresAt != null && timeLeft != null ? (
                                    <span
                                        data-monitor-expires
                                        title={`expires ${clockTime(expiresAt)}`}
                                        className="flex-none"
                                    >
                                        {`expires in ${timeLeft}`}
                                    </span>
                                ) : null}
                            </PeekFooter>
                        </>
                    ) : (
                        <>
                            <OutputBody path={task.outputPath} />
                            <OutputFooter path={task.outputPath} />
                        </>
                    )}
                </motion.div>
            </AnimatePresence>
        </>
    );
}

function OutputFooter({ path }: { path: string | undefined }) {
    return (
        <PeekFooter left={path?.split(/[\\/]/).pop()} leftTitle={path}>
            <span className="flex-none">{TAIL_LABEL}</span>
        </PeekFooter>
    );
}

export function ShellTaskPeek({
    model,
    task,
    anchor,
}: {
    model: AgentsViewModel;
    task: ShellTask;
    anchor: HTMLElement;
}) {
    const now = useAtomValue(model.nowAtom);
    const monitor = task.kind === "monitor";
    const Mark = monitor ? Radio : Terminal;
    const { refs, floatingStyles, context } = useFloating({
        open: true,
        onOpenChange: (open) => !open && close(),
        elements: { reference: anchor },
        placement: "right-start",
        strategy: "fixed",
        middleware: [offset(PEEK_GAP_PX), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
    });
    // the anchor row counts as inside, so clicking it again toggles the peek instead of reopening it.
    // Esc is left to the registry, which would otherwise also run agent:back
    const { getFloatingProps } = useInteractions([useDismiss(context, { escapeKey: false })]);

    // the Agent surface stays mounted off-screen, and the portal would keep the peek over the next surface
    const surface = useAtomValue(model.surfaceAtom);
    useEffect(() => {
        if (surface !== "agent") {
            close();
        }
    }, [surface]);

    return (
        <FloatingPortal>
            {/* the portal leaves the surface's tree, so the peek carries its own reduced-motion config */}
            <MotionConfig reducedMotion="user">
                <div
                    ref={refs.setFloating}
                    style={floatingStyles}
                    {...getFloatingProps()}
                    data-shell-task-peek={task.id}
                    className="z-[60] w-[560px] overflow-hidden rounded-[9px] border border-edge-strong bg-surface-raised shadow-popover-lg"
                >
                    <div className="flex items-center gap-[8px] px-[10px] py-[8px]">
                        <Mark
                            size={12}
                            aria-hidden
                            data-peek-mark={monitor ? "monitor" : "shell"}
                            className="flex-none text-accent"
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-medium text-secondary">
                            {task.description}
                        </span>
                        <span
                            data-shell-task-state
                            className="flex-none font-mono text-[10.5px] font-semibold text-accent"
                        >
                            {monitor ? "watching" : "running"}
                        </span>
                        <button
                            type="button"
                            onClick={close}
                            aria-label="Close output"
                            className="flex h-[20px] w-[20px] flex-none cursor-pointer items-center justify-center text-muted hover:text-secondary"
                        >
                            <X size={13} aria-hidden />
                        </button>
                    </div>
                    {monitor ? (
                        <MonitorPeekBody task={task} now={now} />
                    ) : (
                        <>
                            <OutputBody path={task.outputPath} />
                            <OutputFooter path={task.outputPath} />
                        </>
                    )}
                </div>
            </MotionConfig>
        </FloatingPortal>
    );
}
