// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { AgentEntry } from "./agentsviewmodel";
import { projectorFor } from "./transcriptregistry";

const DEFAULT_TAIL_LINES = 300;

export interface PreviousInfoResult {
    entries: AgentEntry[];
    title?: string; // the agent's ai-title (used as the task label)
}

// Fetch an agent's recent transcript once and project both previous-info entries and the ai-title.
// On any read failure returns empty entries (spec §7: render the question alone). Called when a
// needs-you card mounts, passing AgentStatusData.transcriptpath (carried since Plan 2).
export async function fetchPreviousInfo(transcriptPath: string, agent?: string, maxLines = DEFAULT_TAIL_LINES): Promise<PreviousInfoResult> {
    if (!transcriptPath) {
        return { entries: [] };
    }
    try {
        const rtn = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path: transcriptPath, maxlines: maxLines });
        const lines = rtn?.lines ?? [];
        const projector = projectorFor(agent, transcriptPath);
        return { entries: projector.project(lines), title: projector.extractTitle?.(lines) };
    } catch {
        return { entries: [] };
    }
}
