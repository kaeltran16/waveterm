// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { atom, type PrimitiveAtom } from "jotai";

// keyed by block ORef string ("block:<uuid>"); null = no pending ask
const agentAskAtoms = new Map<string, PrimitiveAtom<AgentAskData>>();

export function getAgentAskAtom(oref: string): PrimitiveAtom<AgentAskData> {
    let askAtom = agentAskAtoms.get(oref);
    if (!askAtom) {
        askAtom = atom(null) as PrimitiveAtom<AgentAskData>;
        agentAskAtoms.set(oref, askAtom);
    }
    return askAtom;
}

let subscribed = false;
export function setupAgentAskSubscription() {
    if (subscribed) {
        return;
    }
    subscribed = true;
    waveEventSubscribeSingle({
        eventType: "agent:ask",
        handler: (event) => {
            const data = event.data as AgentAskData;
            if (data?.oref == null) {
                return;
            }
            globalStore.set(getAgentAskAtom(data.oref), data.cleared ? null : data);
        },
    });
}
