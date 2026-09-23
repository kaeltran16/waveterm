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
import { openAddress } from "./openref";
import type { PetAct } from "./petacts";
import { petErrandAtom, petPeekOpenAtom, setActState } from "./petstore";

// The same budget the Channels surface gives a consult (CONSULT_RPC_TIMEOUT_MS in channelactions.ts): the
// backend's consultTimeout is 120s and the rpc layer's 5s default would kill the stream long before a reply
// lands. Duplicated rather than imported so the errand does not pull the whole channel-actions module in.
const ERRAND_TIMEOUT_MS = 130_000;

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// An escort closes the peek only once the landing succeeds: an overlay anchored to the creature, left open over
// a surface it just navigated away from, is stranded — but a landing that cannot open leaves the user where
// they were, and its failure is set on the act, which only an open peek shows.
async function escort(model: AgentsViewModel, act: PetAct): Promise<void> {
    const target = act.target;
    const result = await openAddress(model, target.ref, { anchor: target.anchor }, (r) => {
        if ("reason" in r) {
            setActState(act.id, { status: "error", text: r.message });
        }
    });
    if (result.ok) {
        globalStore.set(petPeekOpenAtom, false);
    }
}

export async function runAct(model: AgentsViewModel, act: PetAct): Promise<void> {
    await escort(model, act);
}

// The errand reuses the Channels surface's consult path exactly (channelactions.ts): post the question as a
// channel message, then stream the runtime's reply. Two consequences that make it the right seam — the
// question and its answer persist as channel messages, so closing the panel loses nothing; and it is not
// tier-gated, because the identical gesture is ungated on that surface and a panel stricter than the
// surface it mirrors would be incoherent.
//
// It needs a channel because CommandConsultData does, and a creature in window chrome has none of its own —
// the same per-channel hole the pet design named. The caller supplies the active channel.
export async function sendErrand(channelId: string, runtime: string, prompt: string): Promise<void> {
    const consultId = crypto.randomUUID();
    globalStore.set(petErrandAtom, { prompt, runtime, text: "", status: "streaming" });
    let acc = "";
    try {
        await RpcApi.PostChannelMessageCommand(TabRpcClient, {
            channelid: channelId,
            kind: "consult",
            author: "you",
            text: prompt,
            reforef: `consult:${consultId}`,
        });
        const gen = RpcApi.ConsultCommand(
            TabRpcClient,
            { channelid: channelId, runtime, prompt, consultid: consultId },
            { timeout: ERRAND_TIMEOUT_MS }
        );
        for await (const chunk of gen) {
            acc += chunk?.text ?? "";
            globalStore.set(petErrandAtom, { prompt, runtime, text: acc, status: "streaming" });
        }
        globalStore.set(petErrandAtom, { prompt, runtime, text: acc, status: "done" });
    } catch (e) {
        // the backend still posts a consult-reply carrying the error, so the channel keeps the full record
        globalStore.set(petErrandAtom, { prompt, runtime, text: acc || errText(e), status: "error" });
    }
}
