// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { atom, type PrimitiveAtom } from "jotai";
import { loadAttention } from "./attentionstore";

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
            const askAtom = getAgentAskAtom(data.oref);
            if (!data.cleared) {
                globalStore.set(askAtom, data);
                return;
            }
            // clear only the ask the event names. A clear for an ask this block has already replaced
            // (a late duplicate, a persisted event redelivered on reconnect) must not blank the
            // question currently on screen.
            if (globalStore.get(askAtom)?.askid === data.askid) {
                globalStore.set(askAtom, null);
            }
            // the nav-rail badges are a server-computed list on a 10s poll: without this an answered
            // question kept a "needs you" count for up to ten seconds after its card was gone.
            void loadAttention();
        },
    });
    // closing an agent's terminal retires its pending ask, but that happens server-side inside the
    // attention gather (pkg/jarvis/attention.go) — so ask for a recount instead of waiting out the poll.
    waveEventSubscribeSingle({
        eventType: "blockclose",
        handler: () => void loadAttention(),
    });
}
