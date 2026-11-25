// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The change set the per-agent views count (the card pill, the rail, the message box's changes row, the Changes
// tab). A Claude agent counts only its own edits, rebuilt from its transcript, so other writers in a shared checkout
// stay out; any other agent counts its checkout since the session started.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { editsApply } from "./diffscope";
import { HISTORY_RPC_TIMEOUT_MS } from "./historyquery";

export interface AgentChanges {
    ch: CommandGitChangesRtnData;
    // the list is the agent's own edits, ch.ref..end ("" end: none yet)
    edits: boolean;
    end: string;
    // the folder the list was read in: the agent's cwd, or the other checkout its edits went to
    cwd: string;
}

export async function readAgentChanges(
    cwd: string,
    agent: { transcriptPath?: string; runtime?: string },
    startTs: number | null
): Promise<AgentChanges> {
    if (!editsApply(agent.runtime)) {
        const ch = await RpcApi.GitChangesCommand(TabRpcClient, { cwd, sessionstartts: startTs ?? undefined });
        return { ch, edits: false, end: "", cwd };
    }
    const r = await RpcApi.GitAgentEditsCommand(
        TabRpcClient,
        { cwd, transcriptpath: agent.transcriptPath ?? "" },
        { timeout: HISTORY_RPC_TIMEOUT_MS }
    );
    if (!r.base) {
        // no edits of its own yet: the plain read only supplies the branch and whether this is a repository
        const ch = await RpcApi.GitChangesCommand(TabRpcClient, { cwd });
        return { ch: { ...ch, statusz: "", numstat: "", numstaterror: undefined }, edits: true, end: "", cwd };
    }
    const at = r.cwd || cwd;
    const ch = await RpcApi.GitChangesCommand(TabRpcClient, { cwd: at, ref: r.base, end: r.end });
    return { ch, edits: true, end: r.end, cwd: at };
}
