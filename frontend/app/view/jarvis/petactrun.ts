// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// How an act runs. The impure half of the pair whose pure half is petacts.ts: that module decides what is
// offered, this one is the only place an act touches the network or a surface.
//
// Every failure lands on the act that caused it (design §9). Never a toast: a silently-failed button is
// worse than no button, because it also spends the attention the panel exists to earn.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { confirmPruneAllSuperseded, memViewAtom, pendingMemoryFocusAtom } from "@/app/view/agents/memstore";
import { pendingSettingsSectionAtom, SETTINGS_SECTION_EMBEDDINGS } from "@/app/view/agents/settingsstore";
import { askAboutSource } from "./jarvissubjectstore";
import { openORef } from "./openref";
import type { PetAct, PetOp, PetTarget } from "./petacts";
import { loadIndexStatus } from "./petsources";
import { clearActState, petIndexAtom, petPeekOpenAtom, setActState } from "./petstore";

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// The peek closes before every escort: an overlay anchored to the creature, left open over a surface it just
// navigated away from, is stranded (the same reasoning petpeek.tsx already applies to its Open buttons).
async function escort(model: AgentsViewModel, target: PetTarget): Promise<void> {
    if (target.kind === "oref") {
        await openORef(model, target.ref, target.anchor);
        return;
    }
    if (target.kind === "memory-upkeep") {
        // list view, not merely the memory surface: CleanupQueue is not mounted in graph view, so a bare
        // switch can land on a page where the queue does not exist
        globalStore.set(memViewAtom, "list");
        globalStore.set(pendingMemoryFocusAtom, "upkeep");
        globalStore.set(model.surfaceAtom, "memory");
        return;
    }
    globalStore.set(pendingSettingsSectionAtom, SETTINGS_SECTION_EMBEDDINGS);
    globalStore.set(model.surfaceAtom, "settings");
}

// The ambient index poll is every 15 minutes because the backend parses the whole vault to count drift —
// right for ambient polling, and far too slow the moment the user presses a button. This re-reads on a
// tight cadence for long enough to cover a real build (a 373-note vault measured 5m17s) and then stops,
// clearing the act so the row goes back to speaking for itself.
const CATCHUP_POLL_MS = 30_000;
const CATCHUP_WINDOW_MS = 12 * 60_000;

function watchCatchUp(actId: string): void {
    const deadline = Date.now() + CATCHUP_WINDOW_MS;
    const timer = setInterval(() => {
        void loadIndexStatus().then(() => {
            const caughtUp = globalStore.get(petIndexAtom)?.state === "ok";
            if (caughtUp || Date.now() > deadline) {
                clearInterval(timer);
                clearActState(actId);
            }
        });
    }, CATCHUP_POLL_MS);
}

async function perform(act: PetAct & { verb: "do" }): Promise<void> {
    const op = act.op;
    if (op.kind === "reconcile-index") {
        await RpcApi.EmbedReconcileCommand(TabRpcClient);
        // stays "running": the rpc returning means the work STARTED, and claiming done here would be the
        // panel's own version of the lie this whole change removes
        setActState(act.id, { status: "running", text: "catching up" });
        watchCatchUp(act.id);
        return;
    }
    if (op.kind === "clear-superseded") {
        // the confirm modal owns the outcome from here, and pruneAllSuperseded reloads the queue itself, so
        // this act keeps no state: a lingering "done" would outlive a cancelled confirmation
        confirmPruneAllSuperseded(op.count);
        clearActState(act.id);
        return;
    }
    // Exhaustiveness backstop. Every PetOp is handled above, so `op` is `never` here and the cast is what
    // keeps the line compiling: adding a fourth operation without wiring it should be a visible error on the
    // row that offered it, not a button that silently does nothing.
    throw new Error(`unwired operation: ${(op as PetOp).kind}`);
}

export async function runAct(model: AgentsViewModel, act: PetAct): Promise<void> {
    if (act.verb === "open") {
        globalStore.set(petPeekOpenAtom, false);
        await escort(model, act.target);
        return;
    }
    if (act.verb === "ask") {
        globalStore.set(petPeekOpenAtom, false);
        askAboutSource(act.seed.ref, act.seed.sourceType, act.seed.title, act.seed.prompt);
        globalStore.set(model.surfaceAtom, "jarvis");
        return;
    }
    setActState(act.id, { status: "running" });
    try {
        await perform(act);
    } catch (e) {
        setActState(act.id, { status: "error", text: errText(e) });
    }
}
