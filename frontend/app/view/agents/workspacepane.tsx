// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Rendered view's workspace pane: what the conversation referenced, opened beside the transcript as tabs. A
// resizable split, not a rail: it opens at the stored width, drags from its left edge, expands over the center and
// collapses to a 44px strip. The surface renders it only while the agent has tabs (workspacestore.ts holds them).

import { cardVariants, indicatorSlide, MOTION, popoverReveal } from "@/app/element/motiontokens";
import { TickNumber } from "@/app/element/ticknumber";
import { ViewSwap } from "@/app/element/viewswap";
import { cn } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import {
    ChevronLeft,
    ChevronRight,
    Code,
    File,
    LayoutDashboard,
    Lightbulb,
    Maximize2,
    Minimize2,
    PanelRight,
    Workflow,
    X,
    type LucideIcon,
} from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { BrainstormPane } from "./brainstormpane";
import { brainstormAtom, brainstormWaitOf } from "./brainstormstore";
import { CanvasPane } from "./canvaspane";
import { canvasStateAtom } from "./canvasstore";
import { childAsksAtom } from "./childaskstore";
import { useRunInfo } from "./runlineagestore";
import { useRunAsks } from "./runrailsections";
import { ChangesTab } from "./workspacechangestab";
import { FileTab } from "./workspacefiletab";
import {
    DEFAULT_PANE_PX,
    paneShape,
    paneWidth,
    STRIP_PX,
    tabKey,
    tabLabel,
    tabWaiting,
    waitingOnYou,
    type WaitInput,
    type WorkspaceState,
    type WorkspaceTab,
} from "./workspacemodel";
import { RunTab } from "./workspaceruntab";
import {
    activateWorkspaceTab,
    closeWorkspaceTab,
    setWorkspaceCollapsed,
    setWorkspaceExpanded,
    workspaceWidthAtom,
} from "./workspacestore";

const TAB_ICON: Record<WorkspaceTab["kind"], LucideIcon> = {
    run: Workflow,
    changes: File,
    file: Code,
    brainstorm: Lightbulb,
    canvas: LayoutDashboard,
};

const MIDDLE_BUTTON = 1;

// 6b on the horizontal axis: paneReveal's opacity and timing, with width in place of height
const REVEAL = { duration: MOTION.durMacro, ease: MOTION.easeFluid };
const LEAVE = { duration: MOTION.durExit, ease: MOTION.easeFluid };
// a drag follows the pointer 1:1, never eased
const UNEASED = { duration: 0 };

// ws comes from the surface rather than the atom, so a pane leaving keeps drawing what it held while it animates out
export function WorkspacePane({
    model,
    agent,
    ws,
    availablePx,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    ws: WorkspaceState;
    availablePx: number | null;
}) {
    const [stored, setStored] = useAtom(workspaceWidthAtom);
    const [dragPx, setDragPx] = useState<number | null>(null);
    const room = availablePx ?? Number.POSITIVE_INFINITY;
    const shape = paneShape(ws);
    const openPx = dragPx ?? paneWidth(stored, room);
    const target = shape === "strip" ? STRIP_PX : shape === "expanded" && availablePx != null ? availablePx : openPx;
    const waits = useWaitInput(agent);
    return (
        <motion.aside
            aria-label="Workspace"
            data-workspace-pane={shape}
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: target, opacity: 1 }}
            exit={{ width: 0, opacity: 0, transition: LEAVE }}
            transition={dragPx != null ? UNEASED : REVEAL}
            className="relative flex h-full shrink-0 flex-col overflow-hidden border-l border-border bg-surface"
        >
            {ws.tabs.map((t) => (t.kind === "run" ? <RunAsksBinder key={tabKey(t)} runId={t.runId} /> : null))}
            <AnimatePresence initial={false}>
                {shape === "strip" ? (
                    <motion.div
                        key="strip"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1, transition: REVEAL }}
                        exit={{ opacity: 0, transition: UNEASED }}
                        className="flex flex-col items-center pt-3"
                    >
                        <PaneStrip agentId={agent.id} tabs={ws.tabs.length} needs={waitingOnYou(ws.tabs, waits)} />
                    </motion.div>
                ) : (
                    <motion.div
                        key="pane"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1, transition: REVEAL }}
                        exit={{ opacity: 0, transition: UNEASED }}
                        className="flex min-h-0 flex-1 flex-col"
                    >
                        {shape === "open" ? (
                            <ResizeHandle
                                widthPx={openPx}
                                availablePx={room}
                                onDrag={setDragPx}
                                onCommit={(px) => {
                                    setStored(px);
                                    setDragPx(null);
                                }}
                                onReset={() => setStored(DEFAULT_PANE_PX)}
                            />
                        ) : null}
                        <TabStrip agentId={agent.id} ws={ws} waits={waits} />
                        <TabBody model={model} agent={agent} ws={ws} />
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.aside>
    );
}

// the run's asks load while its tab is open, so its dot and the strip's badge count them even before the tab is shown
function RunAsksBinder({ runId }: { runId: string }) {
    useRunAsks(useRunInfo(runId).run);
    return null;
}

function useWaitInput(agent: AgentVM): WaitInput {
    const runAsks = useAtomValue(childAsksAtom);
    const brainstorm = useAtomValue(brainstormAtom(agent.id));
    // the header's rule: the brainstorm asks while the agent waits on a question or press its file holds
    const brainstormAsking = agent.state === "asking" && brainstormWaitOf(brainstorm, agent) != null;
    return { runAsks, brainstormAsking };
}

function ResizeHandle({
    widthPx,
    availablePx,
    onDrag,
    onCommit,
    onReset,
}: {
    widthPx: number;
    availablePx: number;
    onDrag: (px: number | null) => void;
    onCommit: (px: number) => void;
    onReset: () => void;
}) {
    const start = useRef<{ x: number; px: number; last: number } | null>(null);
    const down = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) {
            return;
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, px: widthPx, last: widthPx };
    };
    const move = (e: ReactPointerEvent<HTMLDivElement>) => {
        const s = start.current;
        if (s == null) {
            return;
        }
        // the pane grows leftward, so a drag to the left widens it
        s.last = paneWidth(s.px + s.x - e.clientX, availablePx);
        onDrag(s.last);
    };
    const up = () => {
        const s = start.current;
        start.current = null;
        if (s != null && s.last !== s.px) {
            onCommit(s.last);
        } else if (s != null) {
            onDrag(null);
        }
    };
    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the workspace pane"
            aria-valuenow={Math.round(widthPx)}
            title="Drag to resize · double-click resets to 600px"
            data-workspace-resize
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onDoubleClick={onReset}
            className="group absolute bottom-0 left-0 top-0 z-[2] flex w-[8px] cursor-col-resize items-center justify-center"
        >
            <span className="h-[34px] w-[3px] rounded-[2px] bg-edge-mid group-hover:bg-edge-strong" aria-hidden />
        </div>
    );
}

function TabStrip({ agentId, ws, waits }: { agentId: string; ws: WorkspaceState; waits: WaitInput }) {
    const expanded = ws.expanded;
    const expandLabel = expanded ? "Restore the transcript beside it" : "Expand to full width";
    return (
        <div className="flex h-[44px] flex-none items-center gap-[2px] border-b border-border px-2">
            <div role="tablist" aria-label="Workspace tabs" className="flex min-w-0 flex-1 items-center gap-[2px]">
                <LayoutGroup id={`workspace-tabs:${agentId}`}>
                    <AnimatePresence initial={false} mode="popLayout">
                        {ws.tabs.map((t) => (
                            <TabButton
                                key={tabKey(t)}
                                agentId={agentId}
                                tab={t}
                                active={ws.active === tabKey(t)}
                                waiting={tabWaiting(t, waits) > 0}
                            />
                        ))}
                    </AnimatePresence>
                </LayoutGroup>
            </div>
            <button
                type="button"
                onClick={() => setWorkspaceExpanded(agentId, !expanded)}
                aria-label={expandLabel}
                aria-pressed={expanded}
                title={expandLabel}
                data-workspace-expand
                className="flex h-[28px] w-[28px] flex-none cursor-pointer items-center justify-center rounded-[7px] text-muted hover:bg-surface-hover hover:text-secondary"
            >
                {expanded ? <Minimize2 size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}
            </button>
            <button
                type="button"
                onClick={() => setWorkspaceCollapsed(agentId, true)}
                aria-label="Collapse pane"
                title="Collapse (d)"
                data-workspace-collapse
                className="flex h-[28px] w-[28px] flex-none cursor-pointer items-center justify-center rounded-[7px] text-muted hover:bg-surface-hover hover:text-secondary"
            >
                <ChevronRight size={16} aria-hidden />
            </button>
        </div>
    );
}

function TabButton({
    agentId,
    tab,
    active,
    waiting,
}: {
    agentId: string;
    tab: WorkspaceTab;
    active: boolean;
    waiting: boolean;
}) {
    const key = tabKey(tab);
    const label = tabLabel(tab, useTabName(agentId, tab));
    const Icon = TAB_ICON[tab.kind];
    const close = () => closeWorkspaceTab(agentId, key);
    return (
        <motion.div
            layout="position"
            role="presentation"
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            data-workspace-tab={key}
            // middle-click closes, as a browser tab does; mousedown's default would start autoscroll
            onMouseDown={(e) => e.button === MIDDLE_BUTTON && e.preventDefault()}
            onAuxClick={(e) => {
                if (e.button === MIDDLE_BUTTON) {
                    close();
                }
            }}
            className="group relative flex h-[30px] min-w-0 items-center rounded-[7px]"
        >
            {active ? (
                <motion.span
                    layoutId="workspace-tab-indicator"
                    data-workspace-tab-indicator
                    aria-hidden
                    transition={indicatorSlide}
                    className="absolute inset-0 rounded-[7px] bg-surface-selected"
                />
            ) : null}
            <button
                type="button"
                role="tab"
                aria-selected={active}
                title={label}
                onClick={() => activateWorkspaceTab(agentId, key)}
                className={cn(
                    "relative flex h-full min-w-0 cursor-pointer items-center gap-[7px] pl-[10px] pr-[4px] text-[12.5px] font-semibold",
                    active ? "text-primary" : "text-muted hover:text-secondary"
                )}
            >
                <Icon size={13} className="flex-none" aria-hidden />
                <span className="min-w-0 max-w-[200px] truncate">{label}</span>
                {waiting ? (
                    <span
                        role="img"
                        aria-label="waiting on you"
                        data-workspace-tab-waiting
                        className="h-[6px] w-[6px] flex-none rounded-full bg-asking"
                    />
                ) : null}
            </button>
            <button
                type="button"
                aria-label={`Close ${label}`}
                title="Close tab"
                onClick={close}
                data-workspace-tab-close
                className={cn(
                    "relative mr-[6px] flex h-[18px] w-[18px] flex-none cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-surface-hover hover:text-secondary",
                    !active && "opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                )}
            >
                <X size={12} aria-hidden />
            </button>
        </motion.div>
    );
}

// what a tab's label names beyond its kind: the run's title, or the brainstorm's or canvas's topic
function useTabName(agentId: string, tab: WorkspaceTab): string | undefined {
    const run = useRunInfo(tab.kind === "run" ? tab.runId : null).run;
    const brainstorm = useAtomValue(brainstormAtom(agentId));
    const canvas = useAtomValue(canvasStateAtom(agentId));
    switch (tab.kind) {
        case "run":
            return run?.title;
        case "brainstorm":
            return brainstorm?.topic;
        case "canvas":
            return canvas?.topic;
        default:
            return undefined;
    }
}

function TabBody({ model, agent, ws }: { model: AgentsViewModel; agent: AgentVM; ws: WorkspaceState }) {
    const tab = ws.tabs.find((t) => tabKey(t) === ws.active);
    if (tab == null) {
        return null;
    }
    return (
        <ViewSwap swapKey={tabKey(tab)} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {tab.kind === "run" ? (
                <RunTab model={model} agent={agent} tab={tab} />
            ) : tab.kind === "changes" ? (
                <ChangesTab model={model} agent={agent} tab={tab} />
            ) : tab.kind === "file" ? (
                <FileTab model={model} agent={agent} tab={tab} />
            ) : tab.kind === "brainstorm" ? (
                <BrainstormPane model={model} agent={agent} />
            ) : (
                <CanvasPane model={model} agent={agent} />
            )}
        </ViewSwap>
    );
}

// the Closed board: the reopen control, what waits on you across the tabs, and how many are open
function PaneStrip({ agentId, tabs, needs }: { agentId: string; tabs: number; needs: number }) {
    const title = ["Workspace", `${tabs} ${tabs === 1 ? "tab" : "tabs"}`, needs > 0 ? `${needs} waiting on you` : ""]
        .filter(Boolean)
        .join(" · ");
    return (
        <button
            type="button"
            onClick={() => setWorkspaceCollapsed(agentId, false)}
            aria-label="Open the workspace pane"
            title={`${title} (d)`}
            data-workspace-strip
            className="flex w-[34px] cursor-pointer flex-col items-center gap-[10px] rounded-[8px] pb-[8px] pt-[7px] text-muted hover:bg-surface-hover hover:text-secondary"
        >
            <span className="relative block h-[18px] w-[18px]">
                <ChevronLeft size={18} aria-hidden />
                <AnimatePresence initial={false}>
                    {needs > 0 ? (
                        <motion.span
                            key="needs"
                            variants={popoverReveal}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            data-workspace-strip-needs
                            className="absolute -right-[8px] -top-[6px] flex h-[16px] min-w-[16px] items-center justify-center rounded-[8px] border-2 border-surface bg-warning px-[3px] font-mono text-[10.5px] font-bold leading-none text-on-warning"
                        >
                            <TickNumber value={needs} />
                        </motion.span>
                    ) : null}
                </AnimatePresence>
            </span>
            <span className="flex flex-col items-center gap-[3px]">
                <PanelRight size={16} aria-hidden />
                <span data-workspace-strip-count className="font-mono text-[10.5px] font-semibold">
                    <TickNumber value={tabs} />
                </span>
            </span>
        </button>
    );
}
