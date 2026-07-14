// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Focused-agent per-session usage: buckets for the agent's own transcript (GetTranscriptUsageCommand)
// folded via aggregateSessionUsage. Mirrors tokenstore.ts's stale-load guard so a slow load for a
// previous focus can't overwrite a newer one. A silent reload (the rail's refresh tick) keeps the
// last-good value instead of blanking to the skeleton.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { aggregateSessionUsage, type SessionUsage } from "./sessionusage";

export const sessionUsageAtom = atom<SessionUsage | null>(null) as PrimitiveAtom<SessionUsage | null>;

const current = { id: "" };

export async function loadSessionUsage(
    id: string,
    transcriptPath: string | undefined,
    opts?: { silent?: boolean }
): Promise<void> {
    current.id = id;
    if (!opts?.silent) {
        globalStore.set(sessionUsageAtom, null);
    }
    if (!transcriptPath) {
        return;
    }
    try {
        const rtn = await RpcApi.GetTranscriptUsageCommand(TabRpcClient, { path: transcriptPath });
        if (current.id === id) {
            globalStore.set(sessionUsageAtom, aggregateSessionUsage(rtn.buckets ?? []));
        }
    } catch {
        if (current.id === id && !opts?.silent) {
            globalStore.set(sessionUsageAtom, null);
        }
    }
}
