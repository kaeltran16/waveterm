// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";

// free text goes through AgentPromptCommand, never one ControllerInputCommand write of text + "\r": the
// backend pastes it bracketed, pauses, then submits (or hands it to the mod's stream), so a long or
// multi-line message arrives whole and submits once
export async function sendAgentText(blockId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "") {
        throw new Error(`send to block ${blockId}: empty text`);
    }
    try {
        await RpcApi.AgentPromptCommand(TabRpcClient, { blockid: blockId, text: trimmed });
    } catch (e) {
        throw new Error(`send to block ${blockId}: ${e instanceof Error ? e.message : String(e)}`);
    }
}
