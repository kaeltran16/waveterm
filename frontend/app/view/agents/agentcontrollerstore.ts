// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { atom, type PrimitiveAtom } from "jotai";

// keyed by bare block id (BlockControllerRuntimeStatus.blockid, not an oref); undefined = no output seen yet
const lastOutputAtoms = new Map<string, PrimitiveAtom<number | undefined>>();

export function getLastOutputAtom(blockId: string): PrimitiveAtom<number | undefined> {
    let outputAtom = lastOutputAtoms.get(blockId);
    if (!outputAtom) {
        outputAtom = atom(undefined) as PrimitiveAtom<number | undefined>;
        lastOutputAtoms.set(blockId, outputAtom);
    }
    return outputAtom;
}

let subscribed = false;
export function setupControllerStatusSubscription() {
    if (subscribed) {
        return;
    }
    subscribed = true;
    waveEventSubscribeSingle({
        eventType: "controllerstatus",
        handler: (event) => {
            const data = event.data;
            if (!data?.blockid || !data.lastoutputts) {
                return;
            }
            globalStore.set(getLastOutputAtom(data.blockid), data.lastoutputts);
        },
    });
}
