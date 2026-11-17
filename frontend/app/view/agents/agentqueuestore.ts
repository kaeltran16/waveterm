// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The person's messages the arc mod holds for each agent block, from the agent:queue event wavesrv publishes on
// every mod report. Keyed by block oref ("block:<uuid>"). A message the mod lost is toasted once and kept here until
// the agent's Rendered box takes it back in.

import { pushToast } from "@/app/cockpit/notificationstore";
import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import { nextModItems, type ModItem } from "./queuedprompts";

const BLOCK_PREFIX = "block:";
const UNKNOWN_AGENT = "An agent";

const queueAtoms = new Map<string, PrimitiveAtom<AgentQueueData | null>>();
const modItemAtoms = new Map<string, PrimitiveAtom<ModItem[]>>();
const lostAtoms = new Map<string, PrimitiveAtom<QueuedPrompt[]>>();
// every lost id already toasted, so a persisted event delivered again on reconnect is neither toasted nor applied twice
const seenLost = new Map<string, Set<string>>();
let agentName: (blockId: string) => string = () => UNKNOWN_AGENT;

function queueAtom(oref: string): PrimitiveAtom<AgentQueueData | null> {
    let a = queueAtoms.get(oref);
    if (a == null) {
        a = atom(null) as PrimitiveAtom<AgentQueueData | null>;
        queueAtoms.set(oref, a);
    }
    return a;
}

function modAtom(oref: string): PrimitiveAtom<ModItem[]> {
    let a = modItemAtoms.get(oref);
    if (a == null) {
        a = atom<ModItem[]>([]);
        modItemAtoms.set(oref, a);
    }
    return a;
}

// the block's latest report; null before the first
export function getAgentQueueAtom(oref: string): Atom<AgentQueueData | null> {
    return queueAtom(oref);
}

// what the foot draws from the mod: the held items, and those that left until the transcript shows them read
export function getModItemsAtom(oref: string): Atom<ModItem[]> {
    return modAtom(oref);
}

// forgets items the foot no longer draws (read in the transcript, or taken back into the box)
export function dropModItems(oref: string, ids: string[]): void {
    const a = modAtom(oref);
    const cur = globalStore.get(a);
    const next = cur.filter((m) => !ids.includes(m.id));
    if (next.length !== cur.length) {
        globalStore.set(a, next);
    }
}

function lostAtom(oref: string): PrimitiveAtom<QueuedPrompt[]> {
    let a = lostAtoms.get(oref);
    if (a == null) {
        a = atom<QueuedPrompt[]>([]);
        lostAtoms.set(oref, a);
    }
    return a;
}

// the lost messages no box has taken back yet
export function getLostAtom(oref: string): Atom<QueuedPrompt[]> {
    return lostAtom(oref);
}

// the box takes the block's lost messages into its text; each is handed out once
export function takeLost(oref: string): QueuedPrompt[] {
    const a = lostAtom(oref);
    const lost = globalStore.get(a);
    if (lost.length > 0) {
        globalStore.set(a, []);
    }
    return lost;
}

// how the loss toast names a block's agent; the cockpit sets it from its roster
export function setQueueAgentNamer(fn: (blockId: string) => string): void {
    agentName = fn;
}

function keepLost(oref: string, lost: readonly QueuedPrompt[]): void {
    let seen = seenLost.get(oref);
    if (seen == null) {
        seen = new Set();
        seenLost.set(oref, seen);
    }
    const fresh = lost.filter((p) => !seen.has(p.id));
    if (fresh.length === 0) {
        return;
    }
    fresh.forEach((p) => seen.add(p.id));
    const a = lostAtom(oref);
    globalStore.set(a, [...globalStore.get(a), ...fresh]);
    const n = fresh.length;
    pushToast({
        title: `${n} queued message${n === 1 ? "" : "s"} did not reach ${agentName(oref.slice(BLOCK_PREFIX.length))}`,
        message: `${n === 1 ? "It is" : "They are"} back in the agent's box.`,
        level: "warn",
    });
}

// Takes back every message the block's mod still holds. wavesrv publishes the take-back report before the rpc
// returns, so the items have already left the held list and draw as if joined: drop them here so their bubbles go.
export async function takeBackQueued(blockId: string): Promise<QueuedPrompt[]> {
    const rtn = await RpcApi.AgentTakeBackCommand(TabRpcClient, { blockid: blockId });
    const items = rtn?.items ?? [];
    dropModItems(
        `${BLOCK_PREFIX}${blockId}`,
        items.map((i) => i.id)
    );
    return items;
}

let subscribed = false;
export function setupAgentQueueSubscription(): void {
    if (subscribed) {
        return;
    }
    subscribed = true;
    waveEventSubscribeSingle({
        eventType: "agent:queue",
        handler: (event) => {
            const data = event.data as AgentQueueData;
            if (data?.oref == null) {
                return;
            }
            const report = { ...data, held: data.held ?? [] };
            globalStore.set(queueAtom(data.oref), report);
            const items = modAtom(data.oref);
            globalStore.set(items, nextModItems(globalStore.get(items), report));
            keepLost(data.oref, data.lost ?? []);
        },
    });
}
