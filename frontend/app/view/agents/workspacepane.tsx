// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Rendered view's workspace pane: what the conversation referenced, opened beside the transcript as tabs. A
// resizable split, not a rail: it opens at the stored width, drags from its left edge, expands over the center and
// collapses to a 44px strip. The surface renders it only while the agent has tabs (workspacestore.ts holds them).

import { cardVariants, indicatorSlide, MOTION, popoverReveal, SHEET_SLIDE_PX } from "@/app/element/motiontokens";
import { TickNumber } from "@/app/element/ticknumber";
import { ViewSwap } from "@/app/element/viewswap";
import { cn } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import {
    ChevronLeft,
    ChevronRight,
    Code,
    File,
    FileText,
    Flag,
    LayoutDashboard,
    Lightbulb,
    Maximize2,
    Minimize2,
    PanelRight,
    Shapes,
    Workflow,
    X,
    type LucideIcon,
} from "lucide-react";
import { AnimatePresence, LayoutGroup, motion, useIsPresent } from "motion/react";
import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useBoardInfo } from "../boards/boardview";
import { effortDetailAtom } from "../jarvis/effortstore";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { dismissWorkspaceTab } from "./autoopen";
import { BrainstormPane } from "./brainstormpane";
import { brainstormAtom, brainstormWaitOf } from "./brainstormstore";
import { canvasStateAtom } from "./canvasstore";
import { childAsksAtom } from "./childaskstore";
import { useRunInfo } from "./runlineagestore";
import { useRunAsks } from "./runrailsections";
import { WorkspaceBoardTab } from "./workspaceboardtab";
import { WorkspaceCanvasTab } from "./workspacecanvastab";
import { ChangesTab } from "./workspacechangestab";
import { DocsTab } from "./workspacedocstab";
import { FileTab } from "./workspacefiletab";
import { InitiativeTab } from "./workspaceinitiativetab";
import {
    boardPaneWidth,
    DEFAULT_PANE_PX,
    iconOnlyTabs,
    paneShape,
    paneWidth,
    STRIP_PX,
    TAB_GAP_PX,
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
    setWorkspaceCollapsed,
    setWorkspaceExpanded,
    workspaceBoardWidthAtom,
    workspaceWidthAtom,
} from "./workspacestore";

const TAB_ICON: Record<WorkspaceTab["kind"], LucideIcon> = {
    run: Workflow,
    changes: File,
    file: Code,
    docs: FileText,
    initiative: Flag,
    brainstorm: Lightbulb,
    canvas: LayoutDashboard,
    board: Shapes,
};

const MIDDLE_BUTTON = 1;

const RESET_TITLE = `Drag to resize · double-click resets to ${DEFAULT_PANE_PX}px`;
const BOARD_RESET_TITLE = "Drag to resize · double-click resets to full width";

// a tab's box, shared by the tab and its hidden full-label copy so the measured width is the one it would draw
const TAB_FACE = "flex items-center gap-[7px] pl-[10px] pr-[4px] text-[12.5px] font-semibold";
const TAB_LABEL = "min-w-0 max-w-[200px] truncate";
const TAB_CLOSE_BOX = "mr-[6px] h-[18px] w-[18px] flex-none";
const DOT_INLINE = "h-[6px] w-[6px] flex-none rounded-full";
const DOT_CORNER = "absolute left-[20px] top-[6px] box-content h-[6px] w-[6px] rounded-full border-2 border-surface";
// amber is something waiting on you; the accent is a tab that joined behind the shown one and has not been seen
const DOT_TONE = { waiting: "bg-asking", unseen: "bg-accent" } as const;
const DOT_LABEL = { waiting: "waiting on you", unseen: "new since you looked" } as const;

// paneReveal's opacity and timing. The pane arrives and leaves at its full width, sliding like a sheet: growing its
// width would narrow the transcript beside it every frame, rewrapping the whole feed. A change of shape (strip,
// expanded) still tweens the width, since you asked for it. Leaving, it drops out of the flow at once, so the center
// widens in the same frame the transcript starts gliding over (agentsurface.tsx useColumnGlide)
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
    const [boardStored, setBoardStored] = useAtom(workspaceBoardWidthAtom);
    const [dragPx, setDragPx] = useState<number | null>(null);
    const room = availablePx ?? Number.POSITIVE_INFINITY;
    const shape = paneShape(ws);
    const onBoard = ws.tabs.find((t) => tabKey(t) === ws.active)?.kind === "board";
    const openPx = dragPx ?? (onBoard ? boardPaneWidth(boardStored, room) : paneWidth(stored, room));
    const target = shape === "strip" ? STRIP_PX : shape === "expanded" && availablePx != null ? availablePx : openPx;
    const waits = useWaitInput(agent);
    const present = useIsPresent();
    return (
        <motion.aside
            aria-label="Workspace"
            data-workspace-pane={shape}
            initial={{ width: target, opacity: 0, x: SHEET_SLIDE_PX }}
            animate={{ width: target, opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: SHEET_SLIDE_PX, transition: LEAVE }}
            transition={dragPx != null ? UNEASED : REVEAL}
            className={cn(
                "flex h-full shrink-0 flex-col overflow-hidden border-l border-border bg-surface",
                present ? "relative" : "pointer-events-none absolute inset-y-0 right-0"
            )}
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
                        <PaneStrip
                            agentId={agent.id}
                            tabs={ws.tabs.length}
                            needs={waitingOnYou(ws.tabs, waits)}
                            unseen={ws.unseen.length}
                        />
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
                                resetTitle={onBoard ? BOARD_RESET_TITLE : RESET_TITLE}
                                onDrag={setDragPx}
                                onCommit={(px) => {
                                    (onBoard ? setBoardStored : setStored)(px);
                                    setDragPx(null);
                                }}
                                onReset={() => (onBoard ? setBoardStored(null) : setStored(DEFAULT_PANE_PX))}
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
    resetTitle,
    onDrag,
    onCommit,
    onReset,
}: {
    widthPx: number;
    availablePx: number;
    resetTitle: string;
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
            title={resetTitle}
            data-workspace-resize
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onDoubleClick={onReset}
            className="group absolute bottom-0 left-0 top-0 z-10 flex w-[8px] cursor-col-resize items-center justify-center"
        >
            <span className="h-[34px] w-[3px] rounded-[2px] bg-edge-mid group-hover:bg-edge-strong" aria-hidden />
        </div>
    );
}

type StripFit = { room: number; widths: Record<string, number> };

// the strip's room and every tab's full width, read from the hidden measure row the tabs portal into
function useStripFit(tablist: HTMLDivElement | null, measureRow: HTMLDivElement | null): StripFit {
    const [fit, setFit] = useState<StripFit>({ room: Number.POSITIVE_INFINITY, widths: {} });
    useLayoutEffect(() => {
        if (tablist == null || measureRow == null) {
            return;
        }
        const read = () => {
            const widths: Record<string, number> = {};
            for (const el of measureRow.querySelectorAll<HTMLElement>("[data-workspace-tab-measure]")) {
                widths[el.dataset.workspaceTabMeasure] = el.getBoundingClientRect().width;
            }
            const room = tablist.clientWidth;
            setFit((prev) => (prev.room === room && shallowEqual(prev.widths, widths) ? prev : { room, widths }));
        };
        read();
        const ro = new ResizeObserver(read);
        ro.observe(tablist);
        ro.observe(measureRow);
        return () => ro.disconnect();
    }, [tablist, measureRow]);
    return fit;
}

function shallowEqual(a: Record<string, number>, b: Record<string, number>): boolean {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

function TabStrip({ agentId, ws, waits }: { agentId: string; ws: WorkspaceState; waits: WaitInput }) {
    const expanded = ws.expanded;
    const expandLabel = expanded ? "Restore the transcript beside it" : "Expand to full width";
    const [tablist, setTablist] = useState<HTMLDivElement | null>(null);
    const [measureRow, setMeasureRow] = useState<HTMLDivElement | null>(null);
    const fit = useStripFit(tablist, measureRow);
    const iconOnly = iconOnlyTabs(
        ws.tabs.map((t) => fit.widths[tabKey(t)] ?? 0),
        fit.room,
        ws.tabs.findIndex((t) => tabKey(t) === ws.active)
    );
    return (
        <div className="relative flex h-[44px] flex-none items-center gap-[2px] border-b border-border px-2">
            {/* every tab at its full label, out of sight: the rule reads these widths, never the compacted ones */}
            <div aria-hidden className="pointer-events-none invisible absolute left-0 top-0 h-0 w-0 overflow-hidden">
                <div ref={setMeasureRow} className="flex w-max" />
            </div>
            <div
                ref={setTablist}
                role="tablist"
                aria-label="Workspace tabs"
                className="flex min-w-0 flex-1 items-center"
                style={{ gap: TAB_GAP_PX }}
            >
                <LayoutGroup id={`workspace-tabs:${agentId}`}>
                    <AnimatePresence initial={false} mode="popLayout">
                        {ws.tabs.map((t, i) => (
                            <TabButton
                                key={tabKey(t)}
                                agentId={agentId}
                                tab={t}
                                active={ws.active === tabKey(t)}
                                dot={
                                    tabWaiting(t, waits) > 0
                                        ? "waiting"
                                        : ws.unseen.includes(tabKey(t))
                                          ? "unseen"
                                          : null
                                }
                                iconOnly={iconOnly[i]}
                                measureRow={measureRow}
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
    dot,
    iconOnly,
    measureRow,
}: {
    agentId: string;
    tab: WorkspaceTab;
    active: boolean;
    dot: keyof typeof DOT_TONE | null;
    iconOnly: boolean;
    measureRow: HTMLDivElement | null;
}) {
    const key = tabKey(tab);
    const label = tabLabel(tab, useTabName(agentId, tab));
    const Icon = TAB_ICON[tab.kind];
    const close = () => dismissWorkspaceTab(agentId, tab);
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
            // an icon-only tab holds its size, so the shown tab is the one that shrinks when room is still short
            className={cn(
                "group relative flex h-[30px] items-center rounded-[7px]",
                iconOnly ? "flex-none" : "min-w-0"
            )}
        >
            {measureRow != null
                ? createPortal(
                      <div data-workspace-tab-measure={key} className="flex flex-none items-center">
                          <span className={TAB_FACE}>
                              <Icon size={13} className="flex-none" />
                              <span className={TAB_LABEL}>{label}</span>
                              {dot ? <span className={DOT_INLINE} /> : null}
                          </span>
                          <span className={TAB_CLOSE_BOX} />
                      </div>,
                      measureRow
                  )
                : null}
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
                aria-label={label}
                title={label}
                onClick={() => activateWorkspaceTab(agentId, key)}
                className={cn(
                    "relative h-full min-w-0 cursor-pointer",
                    TAB_FACE,
                    active ? "text-primary" : "text-muted hover:text-secondary"
                )}
            >
                <Icon size={13} className="flex-none" aria-hidden />
                {iconOnly ? null : <span className={TAB_LABEL}>{label}</span>}
                {dot ? (
                    <span
                        role="img"
                        aria-label={DOT_LABEL[dot]}
                        data-workspace-tab-waiting={dot === "waiting" ? true : undefined}
                        data-workspace-tab-unseen={dot === "unseen" ? true : undefined}
                        // icon-only, the dot sits on the icon's top-right corner, ringed in the strip's background
                        className={cn(iconOnly ? DOT_CORNER : DOT_INLINE, DOT_TONE[dot])}
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
                    "relative flex cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-surface-hover hover:text-secondary",
                    TAB_CLOSE_BOX,
                    !active && "opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                )}
            >
                <X size={12} aria-hidden />
            </button>
        </motion.div>
    );
}

// what a tab's label names beyond its kind: the run's title, the brainstorm's or canvas's topic, the board's name or the
// initiative's title
function useTabName(agentId: string, tab: WorkspaceTab): string | undefined {
    const run = useRunInfo(tab.kind === "run" ? tab.runId : null).run;
    const brainstorm = useAtomValue(brainstormAtom(agentId));
    const canvas = useAtomValue(canvasStateAtom(agentId));
    const board = useBoardInfo(
        tab.kind === "board" ? tab.channelId : null,
        tab.kind === "board" ? tab.boardId : null
    ).board;
    const effort = useAtomValue(effortDetailAtom).get(tab.kind === "initiative" ? `effort:${tab.effortId}` : "");
    switch (tab.kind) {
        case "initiative":
            return effort?.title;
        case "run":
            return run?.title;
        case "brainstorm":
            return brainstorm?.topic;
        case "canvas":
            return canvas?.topic;
        case "board":
            return board?.name;
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
            ) : tab.kind === "docs" ? (
                <DocsTab model={model} agent={agent} tab={tab} />
            ) : tab.kind === "initiative" ? (
                <InitiativeTab model={model} agent={agent} tab={tab} />
            ) : tab.kind === "brainstorm" ? (
                <BrainstormPane model={model} agent={agent} inTab />
            ) : tab.kind === "board" ? (
                <WorkspaceBoardTab model={model} agent={agent} tab={tab} expanded={ws.expanded} />
            ) : (
                <WorkspaceCanvasTab model={model} agent={agent} />
            )}
        </ViewSwap>
    );
}

// the Closed board: the reopen control, what waits on you across the tabs, and how many are open
function PaneStrip({ agentId, tabs, needs, unseen }: { agentId: string; tabs: number; needs: number; unseen: number }) {
    const title = [
        "Workspace",
        `${tabs} ${tabs === 1 ? "tab" : "tabs"}`,
        needs > 0 ? `${needs} waiting on you` : "",
        unseen > 0 ? `${unseen} new` : "",
    ]
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
                <span className="relative block h-[16px] w-[16px]">
                    <PanelRight size={16} aria-hidden />
                    {unseen > 0 ? (
                        <span
                            data-workspace-strip-unseen
                            aria-hidden
                            className="absolute -right-[4px] -top-[4px] box-content h-[6px] w-[6px] rounded-full border-2 border-surface bg-accent"
                        />
                    ) : null}
                </span>
                <span data-workspace-strip-count className="font-mono text-[10.5px] font-semibold">
                    <TickNumber value={tabs} />
                </span>
            </span>
        </button>
    );
}
