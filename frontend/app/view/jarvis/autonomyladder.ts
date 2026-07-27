// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The autonomy ladder's shape. The tiers are nested, not alternatives (pkg/jarvis/resolve.go): delegator
// implies gatekeeper implies concierge. Rendering it as accumulation is the whole point — three separate
// buttons would misrepresent the backend.

import type { JarvisTier } from "@/app/view/agents/channelmessages";

export const LADDER: { tier: JarvisTier; label: string; blurb: string }[] = [
    {
        tier: "concierge",
        label: "Concierge",
        blurb: "Jarvis watches and narrates. Every ask reaches you.",
    },
    {
        tier: "gatekeeper",
        label: "Gatekeeper",
        blurb: "implies Concierge, and answers routine asks itself. Real forks still escalate.",
    },
    {
        tier: "delegator",
        label: "Delegator",
        blurb: "implies Gatekeeper, and dispatches follow-up work without asking first.",
    },
];

const RANK: Record<JarvisTier, number> = { concierge: 0, gatekeeper: 1, delegator: 2 };

export function rungState(tier: JarvisTier, rung: JarvisTier): "active" | "implied" | "off" {
    if (rung === tier) return "active";
    return RANK[rung] < RANK[tier] ? "implied" : "off";
}

export const DISPATCH_MODES = ["report", "manage", "fanout"] as const;

// the dispatch mode only governs how a delegator fans work out; below that tier it has nothing to act on.
export function showsDispatchMode(tier: JarvisTier): boolean {
    return tier === "delegator";
}
