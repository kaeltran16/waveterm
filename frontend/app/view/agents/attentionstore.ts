// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit-wide "needs you" list, computed server-side (pkg/jarvis/attention.go) and polled. This
// replaced a frontend derivation over channelsAtom, which is a snapshot refetched only on channel
// create/delete/rename/archive — so a run waiting on the human in any non-active channel was invisible to
// every badge.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { newAttention } from "@/app/view/agents/attentionpopup";
import { atom, type PrimitiveAtom } from "jotai";

export { newAttention };

export const attentionAtom = atom<AttentionItem[]>([]) as PrimitiveAtom<AttentionItem[]>;

// loadAttention is now fired by events (ask cleared, block closed) as well as the poll, so two loads
// can be in flight at once. Only the newest one may write: an in-flight poll that started before the
// ask was answered would otherwise land after it and restore the count that was just cleared.
let latestAttentionLoad = 0;

// splitAttention keeps the nav-rail badges disjoint by construction rather than by derivations agreeing.
export function splitAttention(items: AttentionItem[]): { channel: AttentionItem[]; standalone: AttentionItem[] } {
    const channel: AttentionItem[] = [];
    const standalone: AttentionItem[] = [];
    for (const i of items ?? []) {
        (i.channelid ? channel : standalone).push(i);
    }
    return { channel, standalone };
}

// taskbarSignal decides what a new attention list does to the taskbar button. Only an item that was not
// there before flashes it, so an unanswered ask does not flash again every poll; an emptied list
// clears it, because a button still flashing after the last item was answered elsewhere would lie.
export function taskbarSignal(
    prev: AttentionItem[],
    next: AttentionItem[],
    focused: boolean
): "flash" | "clear" | null {
    if (next.length === 0) {
        return prev.length > 0 ? "clear" : null;
    }
    if (focused) {
        return null;
    }
    return newAttention(prev, next).length > 0 ? "flash" : null;
}

// DEV-only seam for the attention-popup CDP scenario, which raises items one poll at a time: a JSON array of
// AttentionItem under this key is appended to every poll's server list. The server can raise only one item per
// dag or run, too few to step the popup through. import.meta.env.DEV is false in production, so it never reads
// the key there; a malformed value adds nothing.
const DEV_ATTENTION_ITEMS_KEY = "wave:dev-attention-items";

function devAttentionItems(): AttentionItem[] {
    if (!import.meta.env.DEV || typeof localStorage === "undefined") return [];
    try {
        const value = JSON.parse(localStorage.getItem(DEV_ATTENTION_ITEMS_KEY) ?? "null");
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}

// A failed poll leaves the last good list in place. Blanking the badge on one dropped request would
// read as "nothing needs you", which is the exact lie this whole change exists to remove.
export async function loadAttention(): Promise<void> {
    const loadId = ++latestAttentionLoad;
    try {
        const rtn = await RpcApi.GetAttentionCommand(TabRpcClient);
        if (loadId === latestAttentionLoad) {
            globalStore.set(attentionAtom, [...(rtn.items ?? []), ...devAttentionItems()]);
        }
    } catch {
        // keep the previous value
    }
}
