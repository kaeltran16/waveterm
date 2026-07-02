// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure helpers for the Channels Jarvis surface: parse the ChannelMessage.data payload into the rich
// Gatekeeper card model, derive unread counts, the per-tier autonomy explainer, fleet counts, and the
// rail tier chip. No React, no jotai — unit-tested in jarviscards.test.ts.

import type { JarvisTier } from "./channelmessages";

export const READ_TS_META = "read:ts";

export interface JarvisCardOption {
    label: string;
    sub?: string;
}

export interface JarvisCardData {
    askORef: string;
    workerORef: string;
    question: string;
    options: JarvisCardOption[];
    choice?: number;
    reason?: string;
}

// parseCardData reads the structured payload off a jarvis-answered/-escalation message. Returns null
// for legacy messages (no data), malformed JSON, or a payload missing required fields — callers then
// fall back to the flat msg.text.
export function parseCardData(msg: ChannelMessage): JarvisCardData | null {
    if (!msg.data) {
        return null;
    }
    try {
        const p = JSON.parse(msg.data) as Partial<JarvisCardData>;
        if (typeof p.question !== "string" || !Array.isArray(p.options) || typeof p.askORef !== "string") {
            return null;
        }
        return {
            askORef: p.askORef,
            workerORef: typeof p.workerORef === "string" ? p.workerORef : "",
            question: p.question,
            options: p.options,
            choice: typeof p.choice === "number" ? p.choice : undefined,
            reason: typeof p.reason === "string" ? p.reason : undefined,
        };
    } catch {
        return null;
    }
}

// unreadCount = channel messages strictly after lastReadTs, excluding the human's own posts.
export function unreadCount(messages: ChannelMessage[] | undefined, lastReadTs: number | undefined): number {
    const since = lastReadTs ?? 0;
    return (messages ?? []).filter((m) => m.ts > since && m.author !== "you").length;
}
