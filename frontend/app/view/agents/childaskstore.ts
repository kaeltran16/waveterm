// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pending child asks of the selected run's dag. Children block on one ask at a time and their own
// session cards are invisible to the human, so the parent-run surface mirrors them here — the engine
// publishes dag:child-ask (scoped to the dag + owning run) when a child raises an ask, and this store
// refreshes the list from the asks RPC on that event and on mount.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom } from "jotai";

export const childAsksAtom = atom<DagAskItem[]>([]);

let subscribed = false;
export function setupChildAskSubscription() {
    if (subscribed) {
        return;
    }
    subscribed = true;
    waveEventSubscribeSingle({
        eventType: "dag:child-ask",
        handler: () => {
            // any child ask (or clear) may concern the visible run — the refresh is cheap and the
            // component re-reads the current run's asks; a stale list clears itself on the next refresh
            const cur = globalStore.get(childAsksAtom);
            if (cur.length === 0) {
                return;
            }
            refreshChildAsksFromAtom();
        },
    });
}

// refreshChildAsks reloads the pending asks for the run's dag. Errors (dag gone, server restart) leave
// the current list — the next event or mount refreshes it again.
export function refreshChildAsks(channelId: string, runId: string) {
    if (!channelId || !runId) {
        return;
    }
    fireAndForget(async () => {
        try {
            const rtn = await RpcApi.DagAsksCommand(TabRpcClient, { channelid: channelId, runid: runId });
            globalStore.set(childAsksAtom, rtn?.asks ?? []);
        } catch {
            // dag may be gone; keep the current list
        }
    });
}

// refreshChildAsksFromAtom re-queries using the last run ids seen (stored alongside the list).
let lastCtx: { channelId: string; runId: string } | null = null;
export function refreshChildAsksFromAtom() {
    if (lastCtx) {
        refreshChildAsks(lastCtx.channelId, lastCtx.runId);
    }
}

// bindChildAsks remembers the run whose asks the surface shows and loads them once.
export function bindChildAsks(channelId: string, runId: string) {
    if (lastCtx?.channelId === channelId && lastCtx?.runId === runId && globalStore.get(childAsksAtom).length > 0) {
        return;
    }
    lastCtx = { channelId, runId };
    refreshChildAsks(channelId, runId);
}

// answerChildAsk delivers an answer to a child's pending ask and refreshes the list.
export function answerChildAsk(
    channelId: string,
    runId: string,
    taskId: string,
    answers: { selectedindexes?: number[]; text?: string }[]
) {
    fireAndForget(async () => {
        try {
            await RpcApi.DagAnswerCommand(TabRpcClient, {
                channelid: channelId,
                runid: runId,
                taskid: taskId,
                answers,
            });
        } catch {
            // the ask may already be gone (answered elsewhere)
        }
        refreshChildAsks(channelId, runId);
    });
}
