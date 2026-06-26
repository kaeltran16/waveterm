// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Usage surface store: the aggregated UsageStats atom + the impure loader. Mirrors activitystore —
// discover sessions (newest-first), read each transcript, parse usage, aggregate. Reads newest-first
// up to a file cap; SessionDescriptor.modtime is unit-agnostic, so the 7-day cutoff is enforced on
// parsed message ts inside aggregateUsage, not on modtime.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { discoverSessions } from "./activitydiscovery";
import { aggregateUsage, extractCodexUsage, extractUsage, type UsageRecord, type UsageStats } from "./usagestats";

const SESSION_READ_CAP = 150; // newest-first files to scan (bounds work without trusting modtime units)
const USAGE_READ_MAXLINES = 20000; // ~whole file; the backend reads the full file then tails to this

const EMPTY: UsageStats = {
    totals: { tokensToday: 0, tokensWeek: 0, spendTodayUsd: 0, spendWeekUsd: 0 },
    providers: [],
};

export const usageStatsAtom = atom<UsageStats>(EMPTY) as PrimitiveAtom<UsageStats>;

let loading = false;

export async function loadUsage(): Promise<void> {
    if (loading) {
        return;
    }
    loading = true;
    try {
        const sessions = (await discoverSessions()).slice(0, SESSION_READ_CAP);
        const records: UsageRecord[] = [];
        for (const s of sessions) {
            let lines: string[];
            try {
                const rtn = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, {
                    path: s.path,
                    maxlines: USAGE_READ_MAXLINES,
                });
                lines = rtn.lines ?? [];
            } catch {
                continue;
            }
            records.push(...(s.agent === "codex" ? extractCodexUsage(lines) : extractUsage(lines, s.agent)));
        }
        globalStore.set(usageStatsAtom, aggregateUsage(records, Date.now()));
    } finally {
        loading = false;
    }
}
