// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useState } from "react";
import { formatAge, type AgentEntry, type AgentVM } from "./agentsviewmodel";

function PreviousInfo({ entries }: { entries: AgentEntry[] }) {
    return (
        <div className="mt-2.5 max-w-[80ch] leading-relaxed">
            {entries.map((e, i) =>
                e.kind === "message" ? (
                    <div key={i} className="mt-2.5 text-[13px] text-[#dde3ea]">
                        {e.text}
                    </div>
                ) : (
                    <div key={i} className="my-2.5 border-l-2 border-[#2a2f3a] pl-3.5 font-mono text-[12px] leading-7 text-[#7d8896]">
                        <span className="inline-block w-14 text-[#9aa4b2]">{e.verb}</span>
                        {e.target}
                        {e.note ? <span className="text-[#6b7585]"> ({e.note})</span> : null}
                        {e.outcome === "ok" ? <span className="text-[#3fb950]"> ✓</span> : null}
                        {e.outcome === "fail" ? <span className="text-[#f85149]"> ✗</span> : null}
                    </div>
                )
            )}
        </div>
    );
}

export function AskCard({
    agent,
    onAnswer,
    onOpen,
}: {
    agent: AgentVM;
    onAnswer?: (id: string, answer: string) => void;
    onOpen: (id: string) => void;
}) {
    const [reply, setReply] = useState("");
    const options = agent.ask?.options ?? ["Yes", "No"];
    const submitReply = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== "Enter" || reply.trim().length === 0) {
            return;
        }
        onAnswer?.(agent.id, reply.trim());
        setReply("");
    };
    return (
        <div className="mb-3.5 rounded-[10px] border border-[#d29922] bg-[#d29922]/[0.05] px-[18px] py-4">
            <div className="flex items-center justify-between">
                <div className="flex cursor-pointer items-center gap-2.5 hover:[&_b]:underline" onClick={() => onOpen(agent.id)}>
                    <span className="h-2 w-2 shrink-0 rounded-full bg-[#d29922]" />
                    <b className="text-[14px] text-[#e6edf3]">{agent.name}</b>
                    {agent.task ? <span className="text-[12.5px] text-[#6b7585]">· {agent.task}</span> : null}
                </div>
                <span className="text-[11.5px] text-[#d29922]">asking · {formatAge(agent.blockedMs)}</span>
            </div>

            {agent.previousInfo?.length ? <PreviousInfo entries={agent.previousInfo} /> : null}

            {agent.ask ? (
                <div className="mt-3.5 border-t border-[#2a2f3a] pt-3.5">
                    <div className="text-[14px] font-semibold text-[#e6edf3]">{agent.ask.question}</div>
                    {agent.ask.recommendation ? (
                        <div className="mt-1 text-[11.5px] text-[#6b7585]">its take: {agent.ask.recommendation}</div>
                    ) : null}
                    <div className="mt-3 flex items-center gap-2.5">
                        {options.map((opt, i) => (
                            <button
                                key={opt}
                                type="button"
                                onClick={() => onAnswer?.(agent.id, opt)}
                                className={cn(
                                    "cursor-pointer rounded-[7px] px-[18px] py-1.5 text-[12.5px]",
                                    i === 0 && (options[0] === "Yes" || options.length > 2)
                                        ? "bg-[#238636] font-semibold text-white"
                                        : "border border-[#2c3340] text-[#c9d1d9]"
                                )}
                            >
                                {opt}
                            </button>
                        ))}
                        <input
                            value={reply}
                            onChange={(e) => setReply(e.target.value)}
                            onKeyDown={submitReply}
                            placeholder="or type a reply…"
                            className="flex-1 rounded-[7px] border border-[#1c2230] bg-[#0b0e14] px-3 py-1.5 text-[12px] text-[#8b949e]"
                        />
                    </div>
                </div>
            ) : (
                <div className="mt-3.5 border-t border-[#2a2f3a] pt-3.5">
                    <button
                        type="button"
                        onClick={() => onOpen(agent.id)}
                        className="cursor-pointer rounded-[7px] bg-[#238636] px-[18px] py-1.5 text-[12.5px] font-semibold text-white"
                    >
                        Open session to answer
                    </button>
                </div>
            )}
        </div>
    );
}
