// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { pushToast } from "@/app/cockpit/notificationstore";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import type { SentPrompt } from "./queuedprompts";

// the person's last few box sends per block: claude queues a message typed during a compaction with no text, and the
// queued foot takes it from here
const SENT_KEPT = 10;
const sentAtoms = new Map<string, PrimitiveAtom<SentPrompt[]>>();

export function sentPromptsAtom(blockId: string): PrimitiveAtom<SentPrompt[]> {
    let sent = sentAtoms.get(blockId);
    if (sent == null) {
        sent = atom<SentPrompt[]>([]) as PrimitiveAtom<SentPrompt[]>;
        sentAtoms.set(blockId, sent);
    }
    return sent;
}

// free text goes through AgentPromptCommand, never one ControllerInputCommand write of text + "\r": the
// backend pastes it bracketed, pauses, then submits (or hands it to the mod's stream), so a long or
// multi-line message arrives whole and submits once
export async function sendAgentText(blockId: string, text: string): Promise<void> {
    return sendPrompt(blockId, text, false);
}

// text the person typed into an agent's box: typed into its terminal, so the harness reads it as the person's own and,
// mid-turn, queues it as its own box does; every other sender is Arc's own message
export async function sendTypedText(blockId: string, text: string): Promise<void> {
    const ts = Date.now();
    await sendPrompt(blockId, text, true);
    const sent = sentPromptsAtom(blockId);
    globalStore.set(sent, [...globalStore.get(sent), { text: text.trim(), ts }].slice(-SENT_KEPT));
}

async function sendPrompt(blockId: string, text: string, person: boolean): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "") {
        throw new Error(`send to block ${blockId}: empty text`);
    }
    try {
        await RpcApi.AgentPromptCommand(TabRpcClient, { blockid: blockId, text: trimmed, ...(person ? { person } : {}) });
    } catch (e) {
        throw new Error(`send to block ${blockId}: ${e instanceof Error ? e.message : String(e)}`);
    }
}

// a ! bash-mode command goes through AgentBashCommand, which types it into the pty: the prompt path would hand it to
// the model
export async function sendAgentBash(blockId: string, command: string): Promise<void> {
    const trimmed = command.trim();
    if (trimmed === "") {
        throw new Error(`run in block ${blockId}: empty command`);
    }
    try {
        await RpcApi.AgentBashCommand(TabRpcClient, { blockid: blockId, command: trimmed });
    } catch (e) {
        throw new Error(`run in block ${blockId}: ${e instanceof Error ? e.message : String(e)}`);
    }
}

// a send whose caller has no error line of its own reports through the cockpit toast, in the refusal's own words:
// a refused prompt reached no terminal, so the user must not read it as sent
export function toastSendFailure(title: string, e: unknown): void {
    console.error(title, e);
    pushToast({ title, message: e instanceof Error ? e.message : String(e), level: "error" });
}
