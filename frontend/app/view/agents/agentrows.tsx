// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentVM } from "./agentsviewmodel";

export function WorkingRow({ agent, onOpen }: { agent: AgentVM; onOpen: (id: string) => void }) {
    return (
        <div
            className="flex cursor-pointer items-center gap-2.5 border-b border-[#14181f] px-1 py-2.5 transition-colors hover:bg-[#ffffff]/[0.03]"
            onClick={() => onOpen(agent.id)}
        >
            <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#3fb950]" />
            <b className="text-[13px] text-[#e6edf3]">{agent.name}</b>
            <span className="text-[12.5px] text-[#6b7585]">{agent.task}</span>
            {agent.activity ? <span className="ml-auto font-mono text-[12px] text-[#7d8896]">⟳ {agent.activity}</span> : null}
        </div>
    );
}

export function IdleRow({ agent, onOpen }: { agent: AgentVM; onOpen: (id: string) => void }) {
    return (
        <div
            className="flex cursor-pointer items-center gap-2.5 px-1 py-2.5 opacity-60 transition-opacity hover:opacity-100"
            onClick={() => onOpen(agent.id)}
        >
            <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#4a5260]" />
            <b className="text-[13px] text-[#c9d1d9]">{agent.name}</b>
            <span className="text-[12.5px] text-[#6b7585]">{agent.activity ?? "idle"}</span>
        </div>
    );
}
