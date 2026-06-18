// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { setActiveTab } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { TabModel } from "@/app/store/tab-model";
import { atom, useAtomValue, type Atom } from "jotai";
import { fireAndForget } from "@/util/util";
import { useEffect } from "react";
import { IdleRow, WorkingRow } from "./agentrows";
import { AskCard } from "./askcard";
import { askingCount, groupAgents, type AgentVM } from "./agentsviewmodel";
import { ensurePreviousInfo, liveAgentsAtom } from "./liveagents";

function SectionLabel({ children }: { children: React.ReactNode }) {
    return <div className="mb-3 mt-6 px-0.5 text-[11px] uppercase tracking-[0.06em] text-[#6b7585] first:mt-0">{children}</div>;
}

function AgentsView({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const sections = groupAgents(agents);
    const asking = askingCount(agents);
    const open = (id: string) => setActiveTab(id);
    const answer = (oref: string, answers: AgentAnswerItem[]) => {
        if (!oref) {
            return;
        }
        fireAndForget(() => RpcApi.AnswerAgentCommand(TabRpcClient, { oref, answers }));
    };

    // fetch previous-info + task for needs-you agents on demand (spec §10.3)
    useEffect(() => {
        for (const a of agents) {
            if (a.state === "asking" && a.transcriptPath) {
                void ensurePreviousInfo(a.id, a.transcriptPath);
            }
        }
    }, [agents]);

    return (
        <div className="flex h-full w-full flex-col bg-[#0b0e14] text-[#c9d1d9]">
            <div className="flex shrink-0 items-center justify-between border-b border-[#1c2230] px-[18px] py-3">
                <b className="text-[15px] text-[#e6edf3]">Agents</b>
                <span className="text-[12px] text-[#6b7585]">
                    <span className="text-[#d29922]">{asking} asking</span> · {sections.working.length} working · {sections.idle.length} idle
                </span>
            </div>
            <div className="flex-1 overflow-auto p-[18px]">
                <div className="w-full">
                    {agents.length === 0 && (
                        <div className="px-0.5 py-6 text-[13px] text-[#6b7585]">No agents running</div>
                    )}
                    {sections.asking.length > 0 && <SectionLabel>needs you</SectionLabel>}
                    {sections.asking.map((a) => (
                        // keying by askId forces a fresh card (resetting per-question selection state) when the same
                        // agent raises a new ask — otherwise a batched clear+new-ask render would reuse the stale instance.
                        <AskCard key={a.ask?.askId ?? a.id} agent={a} onAnswer={answer} onOpen={open} />
                    ))}
                    {sections.working.length > 0 && <SectionLabel>working</SectionLabel>}
                    {sections.working.map((a) => (
                        <WorkingRow key={a.id} agent={a} onOpen={open} />
                    ))}
                    {sections.idle.length > 0 && <SectionLabel>idle</SectionLabel>}
                    {sections.idle.map((a) => (
                        <IdleRow key={a.id} agent={a} onOpen={open} />
                    ))}
                </div>
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
