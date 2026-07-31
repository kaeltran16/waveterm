// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit-wide "needs you" list, computed server-side (pkg/jarvis/attention.go) and polled. This
// replaced a frontend derivation over channelsAtom, which is a snapshot refetched only on channel
// create/delete/rename/archive — so a run parked at a review gate in any non-active channel was
// invisible to every badge.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

export const attentionAtom = atom<AttentionItem[]>([]) as PrimitiveAtom<AttentionItem[]>;

// splitAttention keeps the two nav-rail badges disjoint by construction rather than by two derivations
// agreeing: an item either names a channel or it does not.
export function splitAttention(items: AttentionItem[]): {
    channel: AttentionItem[];
    standalone: AttentionItem[];
} {
    const channel: AttentionItem[] = [];
    const standalone: AttentionItem[] = [];
    for (const i of items ?? []) {
        (i.channelid ? channel : standalone).push(i);
    }
    return { channel, standalone };
}

// A failed poll leaves the last good list in place. Blanking the badge on one dropped request would
// read as "nothing needs you", which is the exact lie this whole change exists to remove.
export async function loadAttention(): Promise<void> {
    try {
        const rtn = await RpcApi.GetAttentionCommand(TabRpcClient);
        globalStore.set(attentionAtom, rtn.items ?? []);
    } catch {
        // keep the previous value
    }
}
