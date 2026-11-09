// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Whether Claude Code is on the saved API key. It feeds mergeRateLimitWindows, so the app-bar meters, the
// Usage surface and the pet read "API key" instead of a subscription quota while it is true.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom } from "jotai";

export const claudeApiKeyActiveAtom = atom(false);

export function syncClaudeApiKeyActive(data: ClaudeAccountsRtnData | null): void {
    if (data == null) {
        return;
    }
    globalStore.set(claudeApiKeyActiveAtom, data.apikey?.active === true);
}

export async function loadClaudeApiKeyActive(): Promise<void> {
    try {
        syncClaudeApiKeyActive(await RpcApi.ClaudeAccountsCommand(TabRpcClient));
    } catch (e) {
        console.error("loading the Claude API key state failed:", e);
    }
}
