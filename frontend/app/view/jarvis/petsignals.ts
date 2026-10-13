// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Every signal the avatar reads, gathered from the stores' current values. Pure, so the main window's
// avatar and the popup's show payload derive the face from one function: the poller mounts before PetView
// and emits on the attention list it was just handed, so a face read back from anything PetView wrote
// would be the one from before the item.

import { linkLostSince, type WsLink } from "@/app/store/wslink";
import { liveWindowAgents, providerPlanUsage, type AgentVM } from "@/app/view/agents/agentsviewmodel";
import { mergeRateLimitWindows, topProviderUsage, type SavedSnapshot } from "@/app/view/agents/ratelimitstore";
import { heldLandFrom, type PetSignals } from "./petcondition";

// pkg/jarvis/attention.go's three kinds. Named here rather than inlined so the mapping to the avatar's
// posture vocabulary is one line to check against the server.
const ATTENTION_GATE = "dag-gate";
const ATTENTION_ESCALATION = "escalation";
const ATTENTION_ASK = "ask";

export type PetSources = {
    agents: AgentVM[];
    savedRateLimits: Record<string, SavedSnapshot>;
    // epoch ms
    now: number;
    attention: AttentionItem[];
    link: WsLink;
};

function count(items: AttentionItem[], kind: string): number {
    return items.reduce((n, i) => (i.kind === kind ? n + 1 : n), 0);
}

export function petSignalsFrom({ agents, savedRateLimits, now, attention, link }: PetSources): PetSignals {
    const lostAt = linkLostSince(link, now);
    const donuts = mergeRateLimitWindows(providerPlanUsage(liveWindowAgents(agents)), savedRateLimits, now);
    const top = topProviderUsage(donuts);
    const rateLimit =
        top != null
            ? {
                  provider: top.provider,
                  pct: top.pct,
                  resetAt: donuts.find((d) => d.provider === top.provider)?.fivehour.reset,
              }
            : undefined;

    return {
        link: lostAt != null ? { lostAt } : undefined,
        heldLand: heldLandFrom(attention),
        rateLimit,
        attention: {
            reviewGates: count(attention, ATTENTION_GATE),
            escalations: count(attention, ATTENTION_ESCALATION),
            blockedWorkers: count(attention, ATTENTION_ASK),
        },
    };
}
