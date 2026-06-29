// frontend/app/view/agents/agentcwdresolve.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// RPC-backed cwd resolver shared by the Files surface and the Agent details rail. Two sources, in
// order: (1) the agent's terminal block meta `cmd:cwd` — set by buildLaunchMeta at launch, so a
// Wave-launched agent resolves immediately, before its transcript or reporter enrichment exist;
// (2) the transcript tail (agents Wave didn't launch, or `cd` drift). The pure parse lives in
// agentcwd.ts; this wrapper adds the WOS read + GetAgentTranscriptCommand so agentcwd.ts stays
// Wave-free + pure-tested.

import { RpcApi } from "@/app/store/wshclientapi";
import * as WOS from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { agentCwd } from "./agentcwd";

const CWD_TAIL_LINES = 200;

async function blockCwd(blockId: string | undefined): Promise<string | null> {
    if (!blockId) {
        return null;
    }
    try {
        const block = await WOS.loadAndPinWaveObject<Block>(WOS.makeORef("block", blockId));
        const cwd = block?.meta?.["cmd:cwd"];
        return typeof cwd === "string" && cwd ? cwd : null;
    } catch {
        return null;
    }
}

export async function resolveCwd(transcriptPath: string | undefined, blockId?: string): Promise<string | null> {
    const fromBlock = await blockCwd(blockId);
    if (fromBlock) {
        return fromBlock;
    }
    if (!transcriptPath) {
        return null;
    }
    try {
        const rtn = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, {
            path: transcriptPath,
            maxlines: CWD_TAIL_LINES,
        });
        return agentCwd(rtn?.lines ?? []);
    } catch {
        return null;
    }
}
