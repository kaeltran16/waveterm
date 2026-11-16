// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What a transcript's host knows about the agent it shows, handed to NarrationTimeline so wsh cards can link through
// the router and Arc's messages can tell a run's brief from a plain prompt.

import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import type { RunRole } from "./runlineage";

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
