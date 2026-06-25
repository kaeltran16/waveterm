// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import type { AgentsViewModel } from "./agents";
import { buildAgentTree } from "./agenttreemodel";
import type { AgentVM } from "./agentsviewmodel";
import {
    getSubagentExpandAtom,
    getSubagentsAtom,
    toggleSubagentExpand,
} from "./session-models/agentstatusstore";
import { subagentExpanded, type SubagentState } from "./session-models/sessionviewmodel";
import { StatusDot } from "./statusdot";

const STATE_COLOR: Record<AgentVM["state"], string> = {
    asking: "var(--color-warning)",
    working: "var(--color-accent)",
    idle: "var(--color-muted)",
};
const STATE_LABEL: Record<AgentVM["state"], string> = { asking: "asking", working: "working", idle: "idle" };
const SUB_COLOR: Record<SubagentState, string> = {
    working: "var(--color-accent)",
    success: "var(--color-success)",
    failure: "var(--color-error)",
};

function ParentRow({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const focusId = useAtomValue(model.focusIdAtom);
    const oref = `block:${agent.blockId}`;
    const subs = useAtomValue(getSubagentsAtom(oref));
    const expandOverride = useAtomValue(getSubagentExpandAtom(oref));
    const expanded = subagentExpanded(subs, expandOverride);
    const selected = focusId === agent.id;

    const select = () => {
        globalStore.set(model.focusIdAtom, agent.id);
        globalStore.set(model.focusReplyAtom, false);
    };

    return (
        <>
            <div
                onClick={select}
                className={cn(
                    "relative flex cursor-pointer items-center gap-[9px] rounded-[9px] px-[11px] py-[10px] hover:bg-surface-hover",
                    selected && "bg-accentbg"
                )}
            >
                <StatusDot state={agent.state} className="!h-[7px] !w-[7px]" />
                <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[12px] font-semibold text-[#dfe4ea]">{agent.name}</div>
                    {/* PLACEHOLDER (1b): git branch has no data source — see spec §8 */}
                    <div className="truncate text-[10.5px] text-muted">main</div>
                </div>
                {subs.length > 0 ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            toggleSubagentExpand(oref, expanded);
                        }}
                        title="Toggle subagents"
                        className="flex items-center gap-[3px] rounded-[6px] border border-edge-mid bg-[#161b21] px-[6px] py-[2px] font-mono text-[9.5px] font-semibold text-muted hover:border-accent hover:text-accent-soft"
                    >
                        <span className="text-[8px] leading-none">{expanded ? "▾" : "▸"}</span>
                        {subs.length}
                    </button>
                ) : null}
                <span className="font-mono text-[10px] font-medium" style={{ color: STATE_COLOR[agent.state] }}>
                    {STATE_LABEL[agent.state]}
                </span>
            </div>
            {expanded
                ? subs.map((s) => (
                      <div
                          key={s.id}
                          className="relative flex items-center gap-[8px] rounded-[9px] py-[7px] pl-[28px] pr-[10px] hover:bg-surface-hover"
                      >
                          <span className="absolute left-[13px] top-1/2 -translate-y-1/2 font-mono text-[11px] font-semibold text-[#3c4450]">
                              ↳
                          </span>
                          <span
                              className="h-[5px] w-[5px] shrink-0 rounded-full"
                              style={{ background: SUB_COLOR[s.state] }}
                          />
                          <div className="min-w-0 flex-1">
                              <div className="truncate font-mono text-[11px] font-semibold text-[#bdc4cc]">
                                  {s.type || "subagent"}
                              </div>
                              <div className="truncate text-[9.5px] text-[#5f666f]">{s.model ?? ""}</div>
                          </div>
                          <span
                              className="whitespace-nowrap font-mono text-[9.5px] font-medium"
                              style={{ color: SUB_COLOR[s.state] }}
                          >
                              {s.state}
                          </span>
                      </div>
                  ))
                : null}
        </>
    );
}

export function AgentTree({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const order = useAtomValue(model.orderAtom);
    const rows = buildAgentTree(agents, order);
    return (
        <div className="flex w-[248px] shrink-0 flex-col border-r border-[#1a1f26] bg-surface">
            <div className="border-b border-[#181d23] px-[16px] pb-[12px] pt-[16px]">
                <div className="flex items-center justify-between">
                    <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[.1em] text-[#8b939d]">Agents</h3>
                    <span className="font-mono text-[11px] font-semibold text-muted">{agents.length}</span>
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-[8px]">
                {rows.map((r, i) =>
                    r.kind === "group" ? (
                        <div key={`g-${r.project}-${i}`} className="flex items-center gap-[8px] px-[11px] pb-[6px] pt-[14px]">
                            <span className="truncate font-mono text-[10px] font-semibold uppercase tracking-[.1em] text-muted">
                                {r.project}
                            </span>
                            <div className="h-px flex-1 bg-[#181d23]" />
                            {r.attn > 0 ? (
                                <span className="rounded-[5px] bg-warning/10 px-[6px] py-[1px] font-mono text-[9.5px] font-semibold text-warning">
                                    {r.attn}
                                </span>
                            ) : null}
                            <span className="font-mono text-[10px] font-semibold text-[#4d545d]">{r.count}</span>
                        </div>
                    ) : (
                        <ParentRow key={r.agent.id} model={model} agent={r.agent} />
                    )
                )}
            </div>
        </div>
    );
}
