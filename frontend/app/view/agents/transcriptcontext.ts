// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What a transcript's host knows about the agent it shows, handed to NarrationTimeline so wsh cards can link through
// the router and Arc's messages can tell a run's brief from a plain prompt.

import { useAtomValue } from "jotai";
import { useMemo } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { roleRunId, type RunRole } from "./runlineage";

export interface TranscriptContext {
    model?: AgentsViewModel;
    agentId?: string;
    role?: RunRole;
    channelId?: string;
    effortId?: string;
    brainstormFile?: string;
}

export function transcriptContextFor(input: {
    model?: AgentsViewModel;
    agent?: AgentVM;
    role?: RunRole;
    channelId?: string;
}): TranscriptContext {
    return {
        model: input.model,
        agentId: input.agent?.id,
        role: input.role,
        channelId: input.channelId,
        effortId: input.agent?.effortId,
        brainstormFile: input.agent?.brainstormFile,
    };
}

/** A host's context for an agent: its role and channel from the run lineage. Memoised on values, since the lineage
 *  and the AgentVM are rebuilt on every agent:status and a new ctx would re-render the memoised timeline. */
export function useTranscriptContext(model: AgentsViewModel, agent: AgentVM): TranscriptContext {
    const lineage = useAtomValue(model.lineageAtom);
    const role = lineage.roles[agent.id];
    const channelId = role ? lineage.runs[roleRunId(role)]?.channelId : undefined;
    const roleKey = role ? JSON.stringify(role) : "";
    // only the fields transcriptContextFor copies are deps
    return useMemo(
        () => transcriptContextFor({ model, agent, role, channelId }),
        [model, agent.id, agent.effortId, agent.brainstormFile, roleKey, channelId]
    );
}
