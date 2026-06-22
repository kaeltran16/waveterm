// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { getApi, setActiveTab } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { TabModel } from "@/app/store/tab-model";
import { atom, useAtomValue, type Atom } from "jotai";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import {
    groupAgents,
    isRecentlyIdle,
    mergeOrder,
    nextAskId,
    reorderList,
    resolveHeight,
    snapToPreset,
    PANEL_PRESETS,
    DEFAULT_PANEL_PRESET,
    type AgentVM,
    type PanelPreset,
} from "./agentsviewmodel";
import { useDimensionsWithCallbackRef } from "@/app/hook/useDimensions";
import { ensurePreviousInfo, liveAgentsAtom } from "./liveagents";
import { mockAgentsAtom, USE_MOCK_AGENTS } from "./mockagents";
import { startTranscriptStream, stopTranscriptStream } from "./livetranscript";
import { WorkingPanel } from "./outputpanel";
import { IdleSection } from "./idlesection";

const PanelGap = 10; // matches the working grid's gap-2.5 (0.625rem)
const PanelMinW = 160;
const PanelMinH = 140;
const PanelFillFallback = 360; // before the viewport is measured, "fill" renders at the l-preset height

// Rolls a changing integer: the old value slides up and out while the new one slides in.
function RollingCount({ value, className }: { value: number; className?: string }) {
    return (
        <span className={cn("relative inline-flex overflow-hidden align-baseline", className)}>
            <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                    key={value}
                    initial={{ y: "-100%", opacity: 0 }}
                    animate={{ y: "0%", opacity: 1 }}
                    exit={{ y: "100%", opacity: 0 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    className="tabular-nums"
                >
                    {value}
                </motion.span>
            </AnimatePresence>
        </span>
    );
}

interface ResizeDrag {
    x: number;
    y: number;
    w: number;
    h: number;
    left: number;
    top: number;
    oneColW: number;
    twoColW: number;
    fillPx: number;
    curW: number;
    curH: number;
}

function DraggablePanel({
    id,
    preset,
    fillPx,
    pulse,
    onResize,
    onDragStart,
    onDropOn,
    children,
}: {
    id: string;
    preset: PanelPreset;
    fillPx: number;
    pulse?: boolean;
    onResize: (id: string, preset: PanelPreset) => void;
    onDragStart: () => void;
    onDropOn: (targetId: string, before: boolean) => void;
    children: ReactNode;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const dragRef = useRef<ResizeDrag>(null);
    // ghost is a free-floating preview rendered over the page during the drag; the panel itself only
    // changes once we snap on release, so the grid never reflows mid-drag.
    const [ghost, setGhost] = useState<{ left: number; top: number; w: number; h: number }>(null);

    const onResizeDown = (e: React.PointerEvent) => {
        const panel = ref.current;
        if (!panel) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        const rect = panel.getBoundingClientRect();
        const containerW = panel.parentElement?.clientWidth ?? rect.width;
        dragRef.current = {
            x: e.clientX,
            y: e.clientY,
            w: rect.width,
            h: rect.height,
            left: rect.left,
            top: rect.top,
            oneColW: (containerW - PanelGap) / 2,
            twoColW: containerW,
            fillPx,
            curW: rect.width,
            curH: rect.height,
        };
        setGhost({ left: rect.left, top: rect.top, w: rect.width, h: rect.height });
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onResizeMove = (e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d) {
            return;
        }
        d.curW = Math.max(PanelMinW, d.w + (e.clientX - d.x));
        d.curH = Math.max(PanelMinH, d.h + (e.clientY - d.y));
        setGhost({ left: d.left, top: d.top, w: d.curW, h: d.curH });
    };
    const onResizeUp = (e: React.PointerEvent) => {
        const d = dragRef.current;
        dragRef.current = null;
        setGhost(null);
        if (!d) {
            return;
        }
        e.currentTarget.releasePointerCapture(e.pointerId);
        onResize(id, snapToPreset(d.curW, d.curH, d.oneColW, d.twoColW, d.fillPx));
    };

    const { cols } = PANEL_PRESETS[preset];
    const height = resolveHeight(preset, fillPx);
    return (
        // No motion `layout`/`layoutId` here: the panel re-renders on the 1s liveness tick, and per-render
        // layout projection jitters against the grid. Drag-reorder still works; panels snap instead of sliding.
        <motion.div
            ref={ref}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                onDropOn(id, e.clientX < rect.left + rect.width / 2);
            }}
            style={{ height, overflow: "hidden" }}
            className={cn(
                "relative min-w-0",
                cols === 2 ? "col-span-2" : "col-span-1",
                pulse && "rounded-[10px] ring-2 ring-warning ring-offset-2 ring-offset-background transition-shadow"
            )}
            data-agent-id={id}
        >
            <div
                draggable
                onDragStart={onDragStart}
                className="absolute right-2 top-2 z-10 cursor-grab select-none text-[12px] text-muted active:cursor-grabbing"
                title="Drag to reorder"
            >
                ⠿
            </div>
            {children}
            <div
                onPointerDown={onResizeDown}
                onPointerMove={onResizeMove}
                onPointerUp={onResizeUp}
                title="Drag to resize (snaps to S / M / L)"
                className="absolute bottom-0 right-0 z-20 flex h-4 w-4 cursor-se-resize items-end justify-end p-0.5 text-muted hover:text-secondary"
            >
                <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                    <path d="M8 2 L2 8 M8 5.5 L5.5 8" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                </svg>
            </div>
            {ghost &&
                createPortal(
                    <div
                        style={{
                            position: "fixed",
                            left: ghost.left,
                            top: ghost.top,
                            width: ghost.w,
                            height: ghost.h,
                            zIndex: 1000,
                            pointerEvents: "none",
                        }}
                        className="rounded-[9px] border-2 border-dashed border-accent bg-accent/10"
                    />,
                    document.body
                )}
        </motion.div>
    );
}

function AgentsView({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const { asking, working, idle } = groupAgents(agents);
    const open = (id: string) => setActiveTab(id);
    const answer = (oref: string, answers: AgentAnswerItem[]) => {
        if (!oref) {
            return;
        }
        fireAndForget(() => RpcApi.AnswerAgentCommand(TabRpcClient, { oref, answers }));
    };

    // 1s tick so the liveness cue (⟳ since / quiet) stays current without a global ticker
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);

    // A just-finished agent keeps its full panel (so you can reply) for IDLE_GRACE_MS, then collapses
    // into the Idle list. Dismissals are keyed by idle episode (id:idleSince) so a fresh idle episode
    // gets a fresh panel without any cleanup — the old key simply stops matching.
    const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
    const dismissKey = (a: AgentVM) => `${a.id}:${a.idleSince ?? ""}`;
    const recentlyIdle = idle.filter((a) => isRecentlyIdle(a, now) && !dismissed.has(dismissKey(a)));
    const recentIds = new Set(recentlyIdle.map((a) => a.id));
    const parkedIdle = idle.filter((a) => !recentIds.has(a.id));
    const gridAgents = [...asking, ...working, ...recentlyIdle];

    // one-shot previous-info for asking agents (seeds first paint; the live stream supersedes it once a chunk arrives)
    useEffect(() => {
        for (const a of asking) {
            if (a.transcriptPath) {
                void ensurePreviousInfo(a.id, a.transcriptPath);
            }
        }
    }, [asking]);

    // open a live transcript stream per visible asking/working agent; stop streams that left the set
    const streamedRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const wantedById = new Map<string, string>();
        for (const a of [...asking, ...working]) {
            if (a.transcriptPath) {
                wantedById.set(a.id, a.transcriptPath);
            }
        }
        for (const [id, path] of wantedById) {
            if (!streamedRef.current.has(id)) {
                startTranscriptStream(id, path);
                streamedRef.current.add(id);
            }
        }
        for (const id of [...streamedRef.current]) {
            if (!wantedById.has(id)) {
                stopTranscriptStream(id);
                streamedRef.current.delete(id);
            }
        }
    }, [asking, working]);

    useEffect(() => {
        return () => {
            for (const id of streamedRef.current) {
                stopTranscriptStream(id);
            }
            streamedRef.current.clear();
        };
    }, []);

    const [order, setOrder] = useState<string[]>([]);
    const [dragId, setDragId] = useState<string>();
    const [presetById, setPresetById] = useState<Record<string, PanelPreset>>({});
    const resizePanel = (id: string, preset: PanelPreset) => setPresetById((m) => ({ ...m, [id]: preset }));
    const [pulseId, setPulseId] = useState<string>();
    const lastJumpRef = useRef<string>();
    const jumpToNextAsk = () => {
        const target = nextAskId(asking.map((a) => a.id), lastJumpRef.current);
        if (!target) {
            return;
        }
        lastJumpRef.current = target;
        document.querySelector(`[data-agent-id="${target}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        setPulseId(target);
        setTimeout(() => setPulseId((p) => (p === target ? undefined : p)), 1200);
    };

    // measures the scroll viewport so a "full" panel fills the visible area and re-fills on block/window resize
    const [scrollRef, , scrollRect] = useDimensionsWithCallbackRef<HTMLDivElement>(100);
    const fillPx = scrollRect?.height ?? PanelFillFallback;
    useEffect(() => {
        const ids = gridAgents.map((w) => w.id);
        setOrder((prev) => mergeOrder(prev, ids));
    }, [gridAgents.map((w) => w.id).join(",")]);
    const orderedGrid = order.map((id) => gridAgents.find((w) => w.id === id)).filter(Boolean) as AgentVM[];

    const empty = asking.length === 0 && working.length === 0 && idle.length === 0;

    return (
        <div className="flex h-full w-full flex-col text-secondary">
            <div className="flex shrink-0 items-center justify-between border-b border-border px-[18px] py-3">
                <b className="text-[14px] font-semibold text-primary">Agents</b>
                <span className="flex items-center gap-2 text-[12px] text-muted">
                    {asking.length > 0 ? (
                        <button
                            type="button"
                            onClick={jumpToNextAsk}
                            className="flex cursor-pointer items-center gap-1.5 rounded-[6px] border border-warning bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning hover:bg-warning/15"
                        >
                            <span className="h-2 w-2 rounded-full bg-warning" />
                            <RollingCount value={asking.length} /> needs you
                            <span className="font-normal text-muted">· jump →</span>
                        </button>
                    ) : null}
                    <span className="flex items-center gap-1">
                        <RollingCount value={working.length} />
                        <span>working</span>
                    </span>
                </span>
            </div>
            <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-[18px]">
                <AnimatePresence>
                    {empty && (
                        <motion.div
                            key="empty"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.25 }}
                            className="flex flex-1 flex-col items-center justify-center gap-1 text-center"
                        >
                            <div className="text-[18px] opacity-40">🤖</div>
                            <div className="text-[13px] font-semibold text-secondary">No active agents</div>
                            <div className="text-[11px] text-muted">
                                Agents appear here the moment one starts working or asks a question.
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
                {gridAgents.length > 0 && (
                    <div className="grid grid-cols-2 content-start gap-2.5">
                        <AnimatePresence mode="popLayout">
                            {orderedGrid.map((a) => (
                                <DraggablePanel
                                    key={a.id}
                                    id={a.id}
                                    preset={presetById[a.id] ?? DEFAULT_PANEL_PRESET}
                                    fillPx={fillPx}
                                    pulse={pulseId === a.id}
                                    onResize={resizePanel}
                                    onDragStart={() => setDragId(a.id)}
                                    onDropOn={(targetId, before) => {
                                        if (dragId) {
                                            setOrder((o) => reorderList(o, dragId, targetId, before));
                                        }
                                        setDragId(undefined);
                                    }}
                                >
                                    <WorkingPanel
                                        agent={a}
                                        now={now}
                                        onOpen={open}
                                        onAnswer={answer}
                                        onDismiss={
                                            a.state === "idle"
                                                ? () => setDismissed((prev) => new Set(prev).add(dismissKey(a)))
                                                : undefined
                                        }
                                    />
                                </DraggablePanel>
                            ))}
                        </AnimatePresence>
                    </div>
                )}
                <IdleSection agents={parkedIdle} onOpen={open} />
            </div>
        </div>
    );
}

export class AgentsViewModel implements ViewModel {
    viewType: string;
    blockId: string;
    nodeModel: BlockNodeModel;
    tabModel: TabModel;
    viewIcon = atom<string>("robot");
    viewName = atom<string>("Agents");
    noPadding = atom(true);
    agentsAtom: Atom<AgentVM[]>;

    constructor({ blockId, nodeModel, tabModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.viewType = "agents";
        // DEV-only: swap in the throwaway mock roster (see mockagents.ts). Never active in a prod build.
        this.agentsAtom = USE_MOCK_AGENTS && getApi().getIsDev() ? mockAgentsAtom : liveAgentsAtom;
    }

    get viewComponent(): ViewComponent {
        return AgentsView;
    }
}
