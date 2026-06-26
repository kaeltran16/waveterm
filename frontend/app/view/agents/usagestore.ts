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
    totals: { tokensToday: 0, tokensWeek: 0, spendTodayUsd: 0, spendWeekUsd: 0 },
    providers: [],
};

export const usageStatsAtom = atom<UsageStats>(EMPTY) as PrimitiveAtom<UsageStats>;
export const usageErrorAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

let loading = false;

export async function loadUsage(windowDays = DEFAULT_WINDOW_DAYS): Promise<void> {
    if (loading) {
        return;
    }
    loading = true;
    try {
        const rtn = await RpcApi.GetUsageStatsCommand(TabRpcClient, { windowdays: windowDays });
        globalStore.set(usageStatsAtom, aggregateBuckets(rtn.buckets ?? [], Date.now()));
        globalStore.set(usageErrorAtom, false);
    } catch {
        // keep the last-good stats; surface a subtle "couldn't refresh" instead of blanking
        globalStore.set(usageErrorAtom, true);
    } finally {
        loading = false;
    }
}
