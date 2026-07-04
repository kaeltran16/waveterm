// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Impure Run lifecycle: thin wrappers over the Piece 1 RPCs. CreateRun sources the active workspace id
// from the boot-resolved global atom (mirrors agentactions.ts). Approve/send-back drive the review gate;
// cancel stops the run. Phase *completion* is reported by the external ~/.claude hook, not from here.

import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";

export async function createRun(channelId: string, goal: string, playbookId?: string): Promise<Run> {
    const workspaceId = globalStore.get(atoms.workspaceId);
    const rtn = await RpcApi.CreateRunCommand(TabRpcClient, {
        channelid: channelId,
        workspaceid: workspaceId,
        goal,
        playbookid: playbookId,
    });
    return rtn.run;
}

export async function approveGate(channelId: string, runId: string, gateIdx: number): Promise<void> {
    await RpcApi.AdvanceRunCommand(TabRpcClient, {
        channelid: channelId,
        runid: runId,
        phaseidx: gateIdx,
        action: "approve",
    });
}

export async function sendBackGate(channelId: string, runId: string, gateIdx: number): Promise<void> {
    await RpcApi.AdvanceRunCommand(TabRpcClient, {
        channelid: channelId,
        runid: runId,
        phaseidx: gateIdx,
        action: "sendback",
    });
}

export async function cancelRun(channelId: string, runId: string): Promise<void> {
    await RpcApi.CancelRunCommand(TabRpcClient, { channelid: channelId, runid: runId });
}
