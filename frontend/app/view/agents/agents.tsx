// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { setActiveTab } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { TabModel } from "@/app/store/tab-model";
import { atom, useAtomValue, type Atom } from "jotai";
import { fireAndForget } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { AskCard } from "./askcard";
import { formatAge, groupAgents, resolveFocusedAskId, type AgentVM } from "./agentsviewmodel";
import { ensurePreviousInfo, liveAgentsAtom } from "./liveagents";
import { startTranscriptStream, stopTranscriptStream } from "./livetranscript";
import { WorkingPanel } from "./outputpanel";

function QueueRow({ agent, onFocus }: { agent: AgentVM; onFocus: (id: string) => void }) {
    const question = agent.ask?.questions?.[0]?.question ?? "";
    return (
        <div
            onClick={() => onFocus(agent.id)}
            className="flex cursor-pointer items-center gap-2.5 rounded-[7px] border border-[#d29922]/60 bg-[#d29922]/[0.05] px-3 py-2 hover:bg-[#d29922]/10"
        >
            <span className="h-2 w-2 shrink-0 rounded-full bg-[#d29922]" />
            <b className="shrink-0 text-[12.5px] text-[#e6edf3]">{agent.name}</b>
            <span className="truncate text-[12px] text-[#8b949e]">{question}</span>
            <span className="ml-auto shrink-0 text-[10.5px] text-[#d29922]">{formatAge(agent.blockedMs)} · answer →</span>
        </div>
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
                <span className="text-[12px] text-[#6b7585]">
                    <span className="text-[#d29922]">{asking.length} asking</span> · {working.length} working
                </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden p-[18px]">
                {empty && (
                    <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
                        <div className="text-[22px] opacity-50">🤖</div>
                        <div className="text-[13px] font-semibold text-[#c9d1d9]">No active agents</div>
                        <div className="text-[11.5px] text-[#6b7585]">
                            Agents appear here the moment one starts working or asks a question.
                        </div>
                    </div>
                )}
                {focused && (
                    <div className="max-h-[55%] shrink-0 overflow-y-auto">
                        <AskCard key={focused.ask?.askId ?? focused.id} agent={focused} onAnswer={answer} onOpen={open} />
                    </div>
                )}
                {queue.length > 0 && (
                    <div className="flex shrink-0 flex-col gap-1.5">
                        <div className="text-[10.5px] uppercase tracking-wide text-[#9aa4b2]">
                            {queue.length} more waiting
                        </div>
                        <div className="flex max-h-[180px] flex-col gap-1.5 overflow-y-auto">
                            {queue.map((a) => (
                                <QueueRow key={a.id} agent={a} onFocus={setFocusedAskId} />
                            ))}
                        </div>
                    </div>
                )}
                {working.length > 0 && (
                    <div className="grid min-h-0 flex-1 auto-rows-[260px] grid-cols-[repeat(auto-fit,minmax(360px,1fr))] gap-2.5 overflow-y-auto">
                        {working.map((a) => (
                            <WorkingPanel key={a.id} agent={a} now={now} onOpen={open} />
                        ))}
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
