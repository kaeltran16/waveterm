// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Focused-agent prompt-cache-expiry status: a thin whole-file scan of the agent's transcript via
// GetCacheStatusCommand (reuses the Historical scan's cache-write parsing). Mirrors tokenstore.ts's
// stale-load guard so a slow load for a previous focus can't overwrite a newer one.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

export interface CacheStatus {
    lastWriteTs: number; // epoch seconds
    oneHour: boolean;
}

export const agentCacheStatusAtom = atom<CacheStatus | null>(null) as PrimitiveAtom<CacheStatus | null>;

const current = { id: "" };

export async function loadCacheStatusForAgent(id: string, transcriptPath: string | undefined): Promise<void> {
    current.id = id;
    globalStore.set(agentCacheStatusAtom, null);
    if (!transcriptPath) {
        return;
    }
    try {
        const rtn = await RpcApi.GetCacheStatusCommand(TabRpcClient, { path: transcriptPath });
        if (current.id !== id) {
            return;
        }
        globalStore.set(agentCacheStatusAtom, rtn.lastwritets ? { lastWriteTs: rtn.lastwritets, oneHour: !!rtn.onehour } : null);
    } catch {
        if (current.id === id) {
            globalStore.set(agentCacheStatusAtom, null);
        }
    }
}

// Pure: ttl = 3600s (extended bucket) or 300s (default bucket) minus elapsed time since the last
// cache write. null -> "—" (no cache activity yet); <=0 remaining -> "expired".
export function formatCacheCountdown(status: CacheStatus | null, nowMs: number): string {
    if (status == null) {
        return "—";
    }
    const ttlSec = status.oneHour ? 3600 : 300;
    const remainingSec = ttlSec - (nowMs / 1000 - status.lastWriteTs);
    if (remainingSec <= 0) {
        return "expired";
    }
    const mins = Math.floor(remainingSec / 60);
    return mins < 1 ? "<1m left" : `${mins}m left`;
}
