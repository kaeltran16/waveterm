// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Focused-agent cumulative token total: a thin whole-file scan of the agent's transcript
// via GetTranscriptTokensCommand (reuses the Usage surface's deduped accounting). Mirrors
// railstore.ts's stale-load guard so a slow load for a previous focus can't overwrite a newer one.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

export const agentTokensAtom = atom<number | null>(null) as PrimitiveAtom<number | null>;

const current = { id: "" };

export async function loadTokensForAgent(id: string, transcriptPath: string | undefined): Promise<void> {
    current.id = id;
    globalStore.set(agentTokensAtom, null);
    if (!transcriptPath) {
        return;
    }
    try {
        const rtn = await RpcApi.GetTranscriptTokensCommand(TabRpcClient, { path: transcriptPath });
        if (current.id === id) {
            globalStore.set(agentTokensAtom, rtn.tokens ?? 0);
        }
    } catch {
        if (current.id === id) {
            globalStore.set(agentTokensAtom, null);
        }
    }
}
