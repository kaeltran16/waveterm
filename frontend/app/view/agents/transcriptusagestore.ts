// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Focused-agent per-session usage: buckets for the agent's own transcript (GetTranscriptUsageCommand)
// folded via aggregateSessionUsage. Mirrors tokenstore.ts's stale-load guard so a slow load for a
// previous focus can't overwrite a newer one. A silent reload (the rail's refresh tick) keeps the
// last-good value instead of blanking to the skeleton.
//
// null is loading and nothing else: an agent with no transcript, or a load that failed, is "unavailable",
// so the section can say so instead of showing its skeleton forever.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { aggregateSessionUsage, type SessionUsage } from "./sessionusage";

export const UsageUnavailable = "unavailable";
export type SessionUsageState = SessionUsage | typeof UsageUnavailable | null;

export const sessionUsageAtom = atom<SessionUsageState>(null) as PrimitiveAtom<SessionUsageState>;

const current = { id: "" };

export async function loadSessionUsage(
    id: string,
    transcriptPath: string | undefined,
    opts?: { silent?: boolean }
): Promise<void> {
    current.id = id;
    if (!transcriptPath) {
        globalStore.set(sessionUsageAtom, UsageUnavailable);
        return;
    }
    if (!opts?.silent) {
        globalStore.set(sessionUsageAtom, null);
    }
    try {
        const rtn = await RpcApi.GetTranscriptUsageCommand(TabRpcClient, { path: transcriptPath });
        if (current.id === id) {
            globalStore.set(sessionUsageAtom, aggregateSessionUsage(rtn.buckets ?? []));
        }
    } catch (e) {
        console.warn("session usage load failed", transcriptPath, e);
        if (current.id === id && !opts?.silent) {
            globalStore.set(sessionUsageAtom, UsageUnavailable);
        }
    }
}
