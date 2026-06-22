// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { setActiveTab } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { TabModel } from "@/app/store/tab-model";
import { atom, useAtomValue, type Atom } from "jotai";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { AskCard } from "./askcard";
import {
    formatAge,
    groupAgents,
    reorderList,
    resolveFocusedAskId,
    snapToPreset,
    PANEL_PRESETS,
    DEFAULT_PANEL_PRESET,
    type AgentVM,
    type PanelPreset,
} from "./agentsviewmodel";
import { ensurePreviousInfo, liveAgentsAtom } from "./liveagents";
import { startTranscriptStream, stopTranscriptStream } from "./livetranscript";
import { WorkingPanel } from "./outputpanel";
import { IdleSection } from "./idlesection";

const PanelGap = 10; // matches the working grid's gap-2.5 (0.625rem)
const PanelMinW = 160;
const PanelMinH = 140;

function QueueRow({ agent, onFocus }: { agent: AgentVM; onFocus: (id: string) => void }) {
    const question = agent.ask?.questions?.[0]?.question ?? "";
    return (
        <motion.div
            layout
            layoutId={agent.id}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            onClick={() => onFocus(agent.id)}
            className="flex cursor-pointer items-center gap-2.5 rounded-[7px] border border-warning/60 bg-warning/5 px-3 py-2 hover:bg-warning/10"
        >
            <span className="h-2 w-2 shrink-0 rounded-full bg-warning" />
            <b className="shrink-0 text-[12.5px] text-primary">{agent.name}</b>
            <span className="truncate text-[12px] text-muted">{question}</span>
            <span className="ml-auto shrink-0 text-[10.5px] text-warning">{formatAge(agent.blockedMs)} · answer →</span>
        </motion.div>
    );
}

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
    curW: number;
    curH: number;
}

function DraggablePanel({
    id,
    preset,
    onResize,
    onDragStart,
    onDropOn,
    children,
}: {
    id: string;
    preset: PanelPreset;
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
        onResize(id, snapToPreset(d.curW, d.curH, d.oneColW, d.twoColW));
    };

    const { cols, height } = PANEL_PRESETS[preset];
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
            className={cn("relative min-w-0", cols === 2 ? "col-span-2" : "col-span-1")}
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

    const [focusedAskId, setFocusedAskId] = useState<string>();
    const focusedId = resolveFocusedAskId(asking, focusedAskId);
    const focused = asking.find((a) => a.id === focusedId);
    const queue = asking.filter((a) => a.id !== focusedId);

    // 1s tick so the liveness cue (⟳ since / quiet) stays current without a global ticker
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);

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
    useEffect(() => {
        const ids = working.map((w) => w.id);
        setOrder((prev) => {
            const kept = prev.filter((id) => ids.includes(id));
            const added = ids.filter((id) => !kept.includes(id));
            return [...kept, ...added];
        });
    }, [working.map((w) => w.id).join(",")]);
    const orderedWorking = order.map((id) => working.find((w) => w.id === id)).filter(Boolean) as AgentVM[];

    const empty = asking.length === 0 && working.length === 0 && idle.length === 0;

    return (
        <div className="flex h-full w-full flex-col text-secondary">
            <div className="flex shrink-0 items-center justify-between border-b border-border px-[18px] py-3">
                <b className="text-[15px] text-primary">Agents</b>
                <span className="flex items-center gap-1 text-[12px] text-muted">
                    <RollingCount value={asking.length} className="text-warning" />
                    <span className="text-warning">asking</span>
                    <span>·</span>
                    <RollingCount value={working.length} />
                    <span>working</span>
                </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden p-[18px]">
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
                            <div className="text-[22px] opacity-50">🤖</div>
                            <div className="text-[13px] font-semibold text-secondary">No active agents</div>
                            <div className="text-[11.5px] text-muted">
                                Agents appear here the moment one starts working or asks a question.
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
                <AnimatePresence mode="popLayout">
                    {focused && (
                        <motion.div
                            key={focused.id}
                            layout
                            layoutId={focused.id}
                            initial={{ opacity: 0, scale: 0.98 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.98 }}
                            transition={{ duration: 0.2, ease: "easeOut" }}
                            className="max-h-[55%] shrink-0 overflow-y-auto"
                        >
                            <AskCard
                                key={focused.ask?.askId ?? focused.id}
                                agent={focused}
                                onAnswer={answer}
                                onOpen={open}
                            />
                        </motion.div>
                    )}
                </AnimatePresence>
                {queue.length > 0 && (
                    <motion.div layout className="flex shrink-0 flex-col gap-1.5">
                        <div className="text-[10.5px] uppercase tracking-wide text-secondary">
                            {queue.length} more waiting
                        </div>
                        <div className="flex max-h-[180px] flex-col gap-1.5 overflow-y-auto">
                            <AnimatePresence mode="popLayout">
                                {queue.map((a) => (
                                    <QueueRow key={a.id} agent={a} onFocus={setFocusedAskId} />
                                ))}
                            </AnimatePresence>
                        </div>
                    </motion.div>
                )}
                {working.length > 0 && (
                    <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2.5 overflow-y-auto">
                        <AnimatePresence mode="popLayout">
                            {orderedWorking.map((a) => (
                                <DraggablePanel
                                    key={a.id}
                                    id={a.id}
                                    preset={presetById[a.id] ?? DEFAULT_PANEL_PRESET}
                                    onResize={resizePanel}
                                    onDragStart={() => setDragId(a.id)}
                                    onDropOn={(targetId, before) => {
                                        if (dragId) {
                                            setOrder((o) => reorderList(o, dragId, targetId, before));
                                        }
                                        setDragId(undefined);
                                    }}
                                >
                                    <WorkingPanel agent={a} now={now} onOpen={open} />
                                </DraggablePanel>
                            ))}
                        </AnimatePresence>
                    </div>
                )}
                <IdleSection agents={idle} onOpen={open} />
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
    agentsAtom: Atom<AgentVM[]> = liveAgentsAtom;

    constructor({ blockId, nodeModel, tabModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.viewType = "agents";
    }

    get viewComponent(): ViewComponent {
        return AgentsView;
    }
}
