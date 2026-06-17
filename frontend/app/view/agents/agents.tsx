// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { setActiveTab } from "@/app/store/global";
import type { TabModel } from "@/app/store/tab-model";
import { atom, useAtomValue, type PrimitiveAtom } from "jotai";
import { AskCard } from "./askcard";
import { IdleRow, WorkingRow } from "./agentrows";
import { MockAgentsDataSource } from "./agentsmockdata";
import { askingCount, groupAgents, type AgentVM } from "./agentsviewmodel";
import type { AgentsDataSource } from "./agentsdatasource";

function SectionLabel({ children }: { children: React.ReactNode }) {
    return <div className="mb-3 mt-6 px-0.5 text-[11px] uppercase tracking-[0.06em] text-[#6b7585] first:mt-0">{children}</div>;
}

function AgentsView({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const sections = groupAgents(agents);
    const asking = askingCount(agents);
    const answer = (id: string, ans: string) => model.dataSource.answer(id, ans);
    const open = (id: string) => setActiveTab(id);
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
                    {sections.asking.length > 0 && <SectionLabel>needs you</SectionLabel>}
                    {sections.asking.map((a) => (
                        <AskCard key={a.id} agent={a} onAnswer={answer} onOpen={open} />
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
    dataSource: AgentsDataSource = new MockAgentsDataSource();
    agentsAtom: PrimitiveAtom<AgentVM[]>;

    constructor({ blockId, nodeModel, tabModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.viewType = "agents";
        this.agentsAtom = atom(this.dataSource.getAgents()) as PrimitiveAtom<AgentVM[]>;
    }

    get viewComponent(): ViewComponent {
        return AgentsView;
    }
}
