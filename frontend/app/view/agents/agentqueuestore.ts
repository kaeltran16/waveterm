// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The person's messages the arc mod holds for each agent block, from the agent:queue event wavesrv publishes on
// every mod report. Keyed by block oref ("block:<uuid>").

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import { nextModItems, type ModItem } from "./queuedprompts";

const queueAtoms = new Map<string, PrimitiveAtom<AgentQueueData | null>>();
const modItemAtoms = new Map<string, PrimitiveAtom<ModItem[]>>();

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
        },
    });
}
