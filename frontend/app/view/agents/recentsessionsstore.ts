// frontend/app/view/agents/recentsessionsstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Recent resumable Claude sessions from the backend transcript scan (GetRecentSessions). Powers the
// Agent-tab "No terminal running" hero. `SessionInfo` is the generated wire type (global ambient).

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

// null = not loaded yet; [] = loaded-empty.
export const recentSessionsAtom = atom<SessionInfo[] | null>(null) as PrimitiveAtom<SessionInfo[] | null>;

let loading = false;

export async function loadRecentSessions(): Promise<void> {
    if (loading) {
        return;
    }
    loading = true;
    try {
        const rtn = await RpcApi.GetRecentSessionsCommand(TabRpcClient, { windowdays: 14, limit: 5 });
        globalStore.set(recentSessionsAtom, rtn.sessions ?? []);
    } catch {
        globalStore.set(recentSessionsAtom, []); // scan failure -> empty list, never breaks the hero
    } finally {
        loading = false;
    }
}
