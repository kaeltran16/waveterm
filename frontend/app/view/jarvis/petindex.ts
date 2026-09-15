// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The embedding index lifecycle shared by the always-mounted source and the peek's manual action. Status
// reads remain local-only; provider work starts only after a read proves the configured index is stale.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { RECALL_CATCHUP_ACT_ID } from "./petacts";
import { clearActState, petIndexAtom, pushPetEvent, setActState } from "./petstore";

// The ambient poll is deliberately slow because status walks the vault. Once work starts, this bounded
// burst makes completion visible without putting the expensive read on a permanent fast cadence.
const CATCHUP_POLL_MS = 30_000;
const CATCHUP_WINDOW_MS = 12 * 60_000;

let catchUpTimer: ReturnType<typeof setInterval> | null = null;
let readySeq = 0;

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export async function loadIndexStatus(): Promise<boolean> {
    try {
        const status = await RpcApi.GetEmbedIndexStatusCommand(TabRpcClient);
        globalStore.set(petIndexAtom, status);
        return true;
    } catch {
        return false; // keep the previous value; unknown must never be presented as healthy
    }
}

function stopCatchUpWatch(actId: string): void {
    if (catchUpTimer != null) {
        clearInterval(catchUpTimer);
        catchUpTimer = null;
    }
    clearActState(actId);
}

function announceRecallReady(): void {
    const at = Date.now();
    pushPetEvent({
        id: `recall-ready:${at}:${++readySeq}`,
        at,
        kind: "recall-ready",
        text: "Recall is caught up — I can use your latest vault changes.",
    });
}

function watchCatchUp(actId: string): void {
    if (catchUpTimer != null) {
        clearInterval(catchUpTimer);
    }
    const deadline = Date.now() + CATCHUP_WINDOW_MS;
    catchUpTimer = setInterval(() => {
        void loadIndexStatus().then((landed) => {
            if (!landed) {
                return;
            }
            const state = globalStore.get(petIndexAtom)?.state;
            if (state === "ok") {
                stopCatchUpWatch(actId);
                announceRecallReady();
                return;
            }
            if (state !== "stale" || Date.now() > deadline) {
                // An off state carries the provider/index failure through the normal condition and Retry
                // action. Re-dispatching automatically would hammer a failing paid boundary.
                stopCatchUpWatch(actId);
            }
        });
    }, CATCHUP_POLL_MS);
}

export async function startIndexCatchUp(actId: string): Promise<void> {
    await RpcApi.EmbedReconcileCommand(TabRpcClient);
    // The RPC returning means detached work started, not that it finished.
    setActState(actId, { status: "running", text: "catching up" });
    watchCatchUp(actId);
}

// Used only by the launch/ambient source. A successful status read stays successful even if dispatch fails:
// boot retries are for a backend that did not answer, not for repeatedly charging a failing provider.
export async function loadAndCatchUpIndex(): Promise<boolean> {
    const landed = await loadIndexStatus();
    if (!landed || globalStore.get(petIndexAtom)?.state !== "stale") {
        return landed;
    }
    setActState(RECALL_CATCHUP_ACT_ID, { status: "running" });
    try {
        await startIndexCatchUp(RECALL_CATCHUP_ACT_ID);
    } catch (e) {
        setActState(RECALL_CATCHUP_ACT_ID, { status: "error", text: errText(e) });
    }
    return true;
}
