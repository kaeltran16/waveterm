// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { AgentEntry } from "./agentsviewmodel";
import { projectTranscript } from "./transcriptprojection";

const DEFAULT_TAIL_LINES = 300;

// Fetch + project an agent's recent transcript into previous-info entries. On any read failure
// returns [] (spec §7: render the question alone). Plan 3 calls this when an asking card renders,
// passing AgentStatusData.transcriptpath (carried since Task 1).
export async function fetchPreviousInfo(transcriptPath: string, maxLines = DEFAULT_TAIL_LINES): Promise<AgentEntry[]> {
    if (!transcriptPath) {
        return [];
    }
    try {
        const rtn = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path: transcriptPath, maxlines: maxLines });
        return projectTranscript(rtn?.lines ?? []);
    } catch {
        return [];
    }
}
