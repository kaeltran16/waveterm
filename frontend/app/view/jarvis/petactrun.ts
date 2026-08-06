// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// How an act runs. The impure half of the pair whose pure half is petacts.ts: that module decides what is
// offered, this one is the only place an act touches the network or a surface.
//
// Every failure lands on the act that caused it (design §9). Never a toast: a silently-failed button is
// worse than no button, because it also spends the attention the panel exists to earn.

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { confirmPruneAllSuperseded, memViewAtom, pendingMemoryFocusAtom } from "@/app/view/agents/memstore";
import { pendingSettingsSectionAtom, SETTINGS_SECTION_EMBEDDINGS } from "@/app/view/agents/settingsstore";
import { askAboutSource } from "./jarvissubjectstore";
import { openORef } from "./openref";
import type { PetAct, PetTarget } from "./petacts";
import { clearActState, petPeekOpenAtom, setActState } from "./petstore";

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

async function perform(act: PetAct & { verb: "do" }): Promise<void> {
    const op = act.op;
    if (op.kind === "clear-superseded") {
        // the confirm modal owns the outcome from here, and pruneAllSuperseded reloads the queue itself, so
        // this act keeps no state: a lingering "done" would outlive a cancelled confirmation
        confirmPruneAllSuperseded(op.count);
        clearActState(act.id);
        return;
    }
    throw new Error(`unwired operation: ${op.kind}`);
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
