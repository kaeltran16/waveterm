// frontend/app/view/agents/agentcwdresolve.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// RPC-backed cwd resolver shared by the Files surface and the Agent details rail. Three sources, in
// order: (1) the agent's terminal block meta `cmd:cwd` — set by buildLaunchMeta at launch, so a
// Wave-launched agent resolves immediately, before its transcript or reporter enrichment exist;
// (2) the transcript tail (agents Wave didn't launch, or `cd` drift); (3) the transcript head as a
// fallback — Codex records its cwd only on the first-line session_meta, so a long Codex session
// scrolls it off the tail. The head read is agent-agnostic: it only fires when the tail yields no
// cwd, so Claude keeps its cd-drift-correct tail resolution. The pure parse lives in agentcwd.ts;
// this wrapper adds the WOS read + GetAgentTranscriptCommand so agentcwd.ts stays Wave-free + pure-tested.

import { RpcApi } from "@/app/store/wshclientapi";
import * as WOS from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { agentCwd } from "./agentcwd";

const CWD_TAIL_LINES = 200;
const CWD_HEAD_LINES = 200;

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
        const tail = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, {
            path: transcriptPath,
            maxlines: CWD_TAIL_LINES,
        });
        const fromTail = agentCwd(tail?.lines ?? []);
        if (fromTail) {
            return fromTail;
        }
        // tail missed it — read the head (Codex's session_meta cwd is on line 1)
        const head = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, {
            path: transcriptPath,
            maxlines: CWD_HEAD_LINES,
            fromstart: true,
        });
        return agentCwd(head?.lines ?? []);
    } catch {
        return null;
    }
}
