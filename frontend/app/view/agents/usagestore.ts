// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Usage surface store: the aggregated UsageStats atom + the impure loader. The scan now runs in
// the Go backend (GetUsageStatsCommand walks every in-window transcript, no file cap); this just
// asks for buckets and folds them into the view model. On RPC failure the last-good stats are
// kept (a transient websocket drop must not blank the surface) and usageErrorAtom is set.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { aggregateBuckets, type UsageStats } from "./usagestats";

const DEFAULT_WINDOW_DAYS = 7;

const EMPTY: UsageStats = {
    totals: {
        tokensToday: 0,
        tokensWeek: 0,
        spendTodayUsd: 0,
        spendWeekUsd: 0,
        tokensWindow: 0,
        spendWindowUsd: 0,
        claudeTokensWindow: 0,
        codexTokensWindow: 0,
        activeDays: 0,
        busiestDay: null,
        busiestTokens: 0,
    },
    split: [
        { cls: "cacheRead", label: "Cache read", tokens: 0, spendUsd: 0 },
        { cls: "output", label: "Output", tokens: 0, spendUsd: 0 },
        { cls: "cacheWrite", label: "Cache write", tokens: 0, spendUsd: 0 },
        { cls: "input", label: "Input", tokens: 0, spendUsd: 0 },
    ],
    daily: [],
    dailyTruncated: false,
    providers: [],
};

export const usageStatsAtom = atom<UsageStats>(EMPTY) as PrimitiveAtom<UsageStats>;
export const usageErrorAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
export const usageLoadedAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

// Monotonic request id: the latest loadUsage wins. Replaces a single `loading` bool that silently
// dropped a window switch fired while a prior load was in flight (and let a slow prior-window response
// land after the switch and clobber the new window's data). Now a switch always issues a fresh request
// and any older, still-in-flight response is ignored on resolve.
let loadSeq = 0;

export async function loadUsage(windowDays = DEFAULT_WINDOW_DAYS): Promise<void> {
    const seq = ++loadSeq;
    try {
        const rtn = await RpcApi.GetUsageStatsCommand(TabRpcClient, { windowdays: windowDays });
        if (seq !== loadSeq) {
            return; // a newer load superseded this one — ignore its result
        }
        globalStore.set(usageStatsAtom, aggregateBuckets(rtn.buckets ?? [], Date.now()));
        globalStore.set(usageErrorAtom, false);
    } catch {
        if (seq !== loadSeq) {
            return;
        }
        // keep the last-good stats; surface a subtle "couldn't refresh" instead of blanking
        globalStore.set(usageErrorAtom, true);
    } finally {
        if (seq === loadSeq) {
            globalStore.set(usageLoadedAtom, true);
        }
    }
}
