// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure derivations for the Channels surface: a deterministic per-author avatar color, and whether a
// channel currently has a dispatched worker waiting on you (drives the rail's attention dot).

import type { AgentVM } from "./agentsviewmodel";

// identity palette tokens (defined in tailwindsetup.css @theme). "you" is pinned to the accent.
const AVATAR_TOKENS = [
    "var(--color-avatar-1)",
    "var(--color-avatar-2)",
    "var(--color-avatar-3)",
    "var(--color-avatar-4)",
    "var(--color-avatar-5)",
    "var(--color-avatar-6)",
];

export function avatarColor(name: string): string {
    if (name.toLowerCase() === "you") {
        return "var(--color-accent)";
    }
    let h = 0;
    for (let i = 0; i < name.length; i++) {
        h = (h * 31 + name.charCodeAt(i)) >>> 0;
    }
    return AVATAR_TOKENS[h % AVATAR_TOKENS.length];
}

// A channel is "waiting on you" when any worker it dispatched (or steered) is currently asking.
// GetChannels returns each channel's messages, so resolve dispatch/directive refORefs ("tab:<id>")
// against the live roster. Presence of any asking agent short-circuits the message scan.
export function channelHasAsk(channel: Channel, agents: AgentVM[]): boolean {
    const askingIds = new Set(agents.filter((a) => a.state === "asking").map((a) => a.id));
    if (askingIds.size === 0) {
        return false;
    }
    for (const m of channel.messages ?? []) {
        if ((m.kind === "dispatch" || m.kind === "directive") && m.reforef?.startsWith("tab:")) {
            if (askingIds.has(m.reforef.slice(4))) {
                return true;
            }
        }
    }
    return false;
}
