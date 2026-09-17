// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A done task's worker in the Agent surface's center: its session has ended, so it is read back as narration
// from the transcript its session wrote, the way a subagent's is. The transcript is found by the session id
// the engine launched the worker under, so it still reads after the worker's tab is gone.

import { useAtomValue } from "jotai";
import { useEffect } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { startTranscriptStream, stopTranscriptStream } from "./livetranscript";
import { entriesAtomFor } from "./livetranscriptatoms";
import { NarrationTimeline } from "./narrationtimeline";
import { loadRunTranscriptPath, runTranscriptPathsAtom } from "./runlineagestore";
import { endedLine } from "./runrail";
import { JumpToLatestPill, useStickToBottom } from "./sticktobottom";

export function EndedTranscript({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const lineage = useAtomValue(model.lineageAtom);
    const paths = useAtomValue(runTranscriptPathsAtom);
    const entries = useAtomValue(entriesAtomFor(agent.id));
    const { scrollRef, onScroll, atBottom, jumpToBottom } = useStickToBottom(entries);
    const role = lineage.roles[agent.id];
    const run = role?.kind === "worker" ? lineage.runs[role.leadRunId] : undefined;
    const task = role?.kind === "worker" ? run?.dag?.tasks?.find((t) => t.id === role.taskId) : undefined;
    const childRunId = agent.runId;
    const channelId = run?.channelId;

    useEffect(() => {
        if (channelId && childRunId) {
            loadRunTranscriptPath(channelId, childRunId);
        }
    }, [channelId, childRunId]);

    useEffect(() => {
        if (!agent.transcriptPath) {
            return;
        }
        startTranscriptStream(agent.id, agent.transcriptPath, agent.agent);
        return () => stopTranscriptStream(agent.id);
    }, [agent.id, agent.transcriptPath, agent.agent]);

    const missing = childRunId == null || paths[childRunId] === "";
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="mx-[22px] mt-[12px] flex flex-none items-center gap-[10px] rounded-[6px] border border-edge-mid bg-surface-raised px-[12px] py-[8px] font-mono text-[11px] text-muted">
                <span>●</span>
                <span className="min-w-0 truncate">
                    {task ? endedLine(task, run?.digest) : "Session ended · read-only transcript"}
                </span>
            </div>
            <div className="relative min-h-0 flex-1">
                <div
                    ref={scrollRef}
                    onScroll={onScroll}
                    className="h-full overflow-y-auto px-[22px] py-[12px] opacity-80"
                >
                    {entries.length > 0 ? (
                        <NarrationTimeline entries={entries} active={false} />
                    ) : (
                        <div className="flex h-full items-center justify-center text-[12px] text-muted">
                            {missing ? "No transcript found for this session." : "Loading transcript…"}
                        </div>
                    )}
                </div>
                {!atBottom ? <JumpToLatestPill onClick={jumpToBottom} /> : null}
            </div>
        </div>
    );
}
