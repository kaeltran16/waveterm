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
import { askingCount, outputPanelOrder, type AgentVM } from "./agentsviewmodel";
import { ensurePreviousInfo, liveAgentsAtom } from "./liveagents";
import { startTranscriptStream, stopTranscriptStream } from "./livetranscript";
import { WorkingPanel } from "./outputpanel";

function AgentsView({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const ordered = outputPanelOrder(agents);
    const asking = askingCount(agents);
    const working = ordered.filter((a) => a.state === "working").length;
    const open = (id: string) => setActiveTab(id);
    const answer = (oref: string, answers: AgentAnswerItem[]) => {
        if (!oref) {
            return;
        }
        fireAndForget(() => RpcApi.AnswerAgentCommand(TabRpcClient, { oref, answers }));
    };

    // 1s tick so the liveness cue (⟳ since) stays current without a global ticker
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);

    // one-shot previous-info for asking agents (unchanged, spec §3)
    useEffect(() => {
        for (const a of agents) {
            if (a.state === "asking" && a.transcriptPath) {
                void ensurePreviousInfo(a.id, a.transcriptPath);
            }
        }
    }, [agents]);

    // open a live transcript stream per visible working agent; stop streams that left the set
    const streamedRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const wantedById = new Map<string, string>();
        for (const a of ordered) {
            if (a.state === "working" && a.transcriptPath) {
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
    }, [ordered]);

    useEffect(() => {
        return () => {
            for (const id of streamedRef.current) {
                stopTranscriptStream(id);
            }
            streamedRef.current.clear();
        };
    }, []);

    return (
        <div className="flex h-full w-full flex-col bg-[#0b0e14] text-[#c9d1d9]">
            <div className="flex shrink-0 items-center justify-between border-b border-[#1c2230] px-[18px] py-3">
                <b className="text-[15px] text-[#e6edf3]">Agents</b>
                <span className="text-[12px] text-[#6b7585]">
                    <span className="text-[#d29922]">{asking} asking</span> · {working} working
                </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-[18px]">
                {ordered.length === 0 && (
                    <div className="px-0.5 py-6 text-[13px] text-[#6b7585]">No active agents</div>
                )}
                {ordered.map((a) =>
                    a.state === "asking" ? (
                        // keying by askId forces a fresh card (resetting per-question selection state) when the same
                        // agent raises a new ask — otherwise a batched clear+new-ask render would reuse the stale instance.
                        <div key={a.ask?.askId ?? a.id} className="shrink-0">
                            <AskCard agent={a} onAnswer={answer} onOpen={open} />
                        </div>
                    ) : (
                        <WorkingPanel key={a.id} agent={a} now={now} onOpen={open} />
                    )
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
