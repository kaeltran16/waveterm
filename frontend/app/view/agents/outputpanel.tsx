// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { formatAge, type AgentVM } from "./agentsviewmodel";
import { liveEntriesByIdAtom, lastActivityByIdAtom } from "./livetranscript";
import { NarrationTimeline } from "./narrationtimeline";
import { projectNameFromTranscriptPath } from "./projectname";

function formatSince(ms: number): string {
    if (ms < 60_000) {
        return `${Math.max(1, Math.floor(ms / 1000))}s`;
    }
    return `${Math.floor(ms / 60_000)}m`;
}

export function WorkingPanel({ agent, now, onOpen }: { agent: AgentVM; now: number; onOpen: (id: string) => void }) {
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const lastActivity = useAtomValue(lastActivityByIdAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    const since = lastActivity[agent.id] != null ? formatSince(Math.max(0, now - lastActivity[agent.id])) : null;
    const project = projectNameFromTranscriptPath(agent.transcriptPath);

    const scrollRef = useRef<HTMLDivElement>(null);
    const stickRef = useRef(true);
    useEffect(() => {
        const el = scrollRef.current;
        if (el && stickRef.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [entries]);
    const onScroll = () => {
        const el = scrollRef.current;
        if (el) {
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }
    };

    return (
        <div className="flex min-h-[140px] flex-1 flex-col overflow-hidden rounded-[9px] border border-[#1c2230] bg-[#0b0e14]">
            <div className="flex shrink-0 items-center gap-2.5 border-b border-[#1c2230] px-[14px] py-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-[#3fb950]" />
                <b className="text-[13px] text-[#e6edf3]">{agent.name}</b>
                <span className="truncate text-[11.5px] text-[#6b7585]">
                    {project ? `${project} · ` : ""}
                    {agent.task}
                </span>
                <span className="ml-auto shrink-0 text-[11px] text-[#7d8896]">
                    {agent.model ? `${agent.model} · ` : ""}
                    {formatAge(agent.activeMs)}
                    {since ? ` · ⟳ ${since}` : ""}
                </span>
                <button
                    type="button"
                    onClick={() => onOpen(agent.id)}
                    className="shrink-0 cursor-pointer rounded-[5px] border border-[#2c3340] px-2.5 py-0.5 text-[10.5px] text-[#c9d1d9] hover:bg-white/[0.04]"
                >
                    Open terminal
                </button>
            </div>
            <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-[14px] py-[11px]">
                <NarrationTimeline entries={entries} accentLatest />
            </div>
        </div>
    );
}
