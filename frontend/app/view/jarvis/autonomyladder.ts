// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The autonomy ladder's shape. The tiers are nested, not alternatives (pkg/jarvis/resolve.go): delegator
// implies gatekeeper implies concierge. Rendering it as accumulation is the whole point — three separate
// buttons would misrepresent the backend.

import type { JarvisTier } from "@/app/view/agents/channelmessages";
import { atom } from "jotai";

// The panel's open state, global because the keybinding layer has to see it: Escape on a deep surface is
// bound to "back to Cockpit" (bindings.ts surface:back-home), and the app's dispatcher runs on window
// CAPTURE — so floating-ui's own Escape handling can never pre-empt it. Without this guard, dismissing the
// panel also throws you out of Jarvis. Same shape and same reason as graphPeekOpenAtom.
export const autonomyPanelOpenAtom = atom(false);

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

// One source for the bar heights, because two draw them: the header chip's glyph and the popover's rows.
// A rung that is taller in one place than the other stops reading as the same ladder.
export const RUNG_BAR_PX: readonly number[] = [3, 5, 7];

// The chip's face. The mode is a free string off channel meta and only means anything at delegator, so
// below that tier — or when it is unset — the chip is the tier alone, with no dangling separator.
export function chipParts(tier: JarvisTier, mode: string | undefined): { label: string; mode: string | null } {
    const label = LADDER.find((r) => r.tier === tier)?.label ?? tier;
    return { label, mode: showsDispatchMode(tier) && mode ? mode : null };
}
