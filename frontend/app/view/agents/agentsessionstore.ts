// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Session-start anchor cache for the cockpit's live git diff. A session's start time is fixed, so
// each transcript is read once (from its head) and memoized. Shared by the card pill, the agent rail,
// and the Diff tab so they all anchor on the same commit — the pill and the tab can never disagree.
// Only successful resolutions are cached; a not-yet-written transcript resolves to null and is retried
// on the next call.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { sessionStartTs } from "./agentsessionstart";

const HEAD_LINES = 200; // session_meta / first record is at the head

const cache = new Map<string, number>(); // transcriptPath -> unix seconds
const inflight = new Map<string, Promise<number | null>>();

export async function ensureSessionStart(transcriptPath: string | undefined): Promise<number | null> {
    if (!transcriptPath) {
        return null;
    }
    const hit = cache.get(transcriptPath);
    if (hit != null) {
        return hit;
    }
    const existing = inflight.get(transcriptPath);
    if (existing) {
        return existing;
    }
    const p = (async () => {
        try {
            const head = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, {
                path: transcriptPath,
                maxlines: HEAD_LINES,
                fromstart: true,
            });
            const ts = sessionStartTs(head?.lines ?? []);
            if (ts != null) {
                cache.set(transcriptPath, ts);
            }
            return ts;
        } catch {
            return null;
        } finally {
            inflight.delete(transcriptPath);
        }
    })();
    inflight.set(transcriptPath, p);
    return p;
}
