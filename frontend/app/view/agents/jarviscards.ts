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

export interface AutonomyExplainer {
    blurb: string;
    checklist: { label: string; active: boolean }[];
}

const TIER_RANK: Record<JarvisTier, number> = { concierge: 0, gatekeeper: 1, delegator: 2 };
const CAP_LABELS = ["Observe the fleet", "Answer routine questions", "Dispatch & steer workers"] as const;
const TIER_BLURB: Record<JarvisTier, string> = {
    concierge: "Observes the fleet and summarizes on request. It never answers or acts on its own.",
    gatekeeper: "Answers routine worker questions itself; escalates real forks to you.",
    delegator: "Spawns and steers workers toward a goal; still escalates real forks to you.",
};

// autonomyExplainer returns the per-tier blurb + a 3-item capability checklist, cumulative by rank.
export function autonomyExplainer(tier: JarvisTier): AutonomyExplainer {
    const rank = TIER_RANK[tier];
    return {
        blurb: TIER_BLURB[tier],
        checklist: CAP_LABELS.map((label, i) => ({ label, active: i <= rank })),
    };
}

export function tierChip(tier: JarvisTier): "C" | "G" | "D" {
    return tier === "delegator" ? "D" : tier === "gatekeeper" ? "G" : "C";
}
