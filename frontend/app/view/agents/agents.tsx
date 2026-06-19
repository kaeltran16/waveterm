// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { setActiveTab } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { TabModel } from "@/app/store/tab-model";
import { atom, useAtomValue, type Atom } from "jotai";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { AskCard } from "./askcard";
import { formatAge, groupAgents, resolveFocusedAskId, type AgentVM } from "./agentsviewmodel";
import { ensurePreviousInfo, liveAgentsAtom } from "./liveagents";
import { startTranscriptStream, stopTranscriptStream } from "./livetranscript";
import { WorkingPanel } from "./outputpanel";

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
            className="flex cursor-pointer items-center gap-2.5 rounded-[7px] border border-[#d29922]/60 bg-[#d29922]/[0.05] px-3 py-2 hover:bg-[#d29922]/10"
        >
            <span className="h-2 w-2 shrink-0 rounded-full bg-[#d29922]" />
            <b className="shrink-0 text-[12.5px] text-[#e6edf3]">{agent.name}</b>
            <span className="truncate text-[12px] text-[#8b949e]">{question}</span>
            <span className="ml-auto shrink-0 text-[10.5px] text-[#d29922]">{formatAge(agent.blockedMs)} · answer →</span>
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

function AgentsView({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const { asking, working } = groupAgents(agents);
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

    const empty = asking.length === 0 && working.length === 0;

    return (
        <div className="flex h-full w-full flex-col bg-[#0b0e14] text-[#c9d1d9]">
            <div className="flex shrink-0 items-center justify-between border-b border-[#1c2230] px-[18px] py-3">
                <b className="text-[15px] text-[#e6edf3]">Agents</b>
                <span className="flex items-center gap-1 text-[12px] text-[#6b7585]">
                    <RollingCount value={asking.length} className="text-[#d29922]" />
                    <span className="text-[#d29922]">asking</span>
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
                            <div className="text-[13px] font-semibold text-[#c9d1d9]">No active agents</div>
                            <div className="text-[11.5px] text-[#6b7585]">
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
                        <div className="text-[10.5px] uppercase tracking-wide text-[#9aa4b2]">
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
                    // cap at 2 columns: each min track is the larger of 360px or ~half the row,
                    // so a 3rd column never fits, while it still reflows to 1 when narrower than 2×360
                    <div
                        className="grid min-h-0 flex-1 auto-rows-[260px] gap-2.5 overflow-y-auto"
                        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(max(360px, calc(50% - 5px)), 1fr))" }}
                    >
                        <AnimatePresence mode="popLayout">
                            {working.map((a) => (
                                <motion.div
                                    key={a.id}
                                    layout
                                    layoutId={a.id}
                                    initial={{ opacity: 0, scale: 0.96 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.96 }}
                                    transition={{ duration: 0.2, ease: "easeOut" }}
                                    className="min-h-0"
                                >
                                    <WorkingPanel agent={a} now={now} onOpen={open} />
                                </motion.div>
                            ))}
                        </AnimatePresence>
                    </div>
                )}
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
