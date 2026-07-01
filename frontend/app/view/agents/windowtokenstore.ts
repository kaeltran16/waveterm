// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Real "used tokens" for the 5-hour / weekly rate-limit windows. The windows are
// Claude-only (rate_limits are Claude.ai-specific), so the backend sums Claude
// transcripts. Each window is anchored to its real reset (windowStart = reset - duration),
// falling back to now - duration when a reset is nil (API-key auth, or not yet reported).

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

export interface WindowTokens {
    fivehour: number;
    week: number;
}

export const windowTokensAtom = atom<WindowTokens | null>(null) as PrimitiveAtom<WindowTokens | null>;

let loading = false;

// reset args are epoch seconds (matches AgentUsage.fivehourreset/weekreset); undefined -> trailing now.
export async function loadWindowTokens(fivehourReset?: number, weekReset?: number): Promise<void> {
    if (loading) {
        return;
    }
    loading = true;
    const nowSec = Math.floor(Date.now() / 1000);
    const fivehourcutoff = (fivehourReset ?? nowSec + FIVE_HOUR_SECONDS) - FIVE_HOUR_SECONDS;
    const weekcutoff = (weekReset ?? nowSec + WEEK_SECONDS) - WEEK_SECONDS;
    try {
        const rtn = await RpcApi.GetWindowTokensCommand(TabRpcClient, { fivehourcutoff, weekcutoff });
        globalStore.set(windowTokensAtom, { fivehour: rtn.fivehourtokens ?? 0, week: rtn.weektokens ?? 0 });
    } catch {
        // keep the last-good value
    } finally {
        loading = false;
    }
}
