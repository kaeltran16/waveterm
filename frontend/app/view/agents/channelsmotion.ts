// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// No-cascade entrance guard for the Channels message stream. Switching channels swaps the entire
// message set, so a naive AnimatePresence would fire a full-list cascade. This tracks which message
// ids have already been seen for the active channel; only ids that arrive while a channel is settled
// animate. Channel switch and first mount present everything silently. Pure — the component holds the
// returned state in a ref. See docs/superpowers/specs/2026-07-04-channels-motion-design.md.

export interface EntranceState {
    channelId: string | undefined;
    seen: Set<string>;
}

export function initialEntranceState(): EntranceState {
    return { channelId: undefined, seen: new Set() };
}

export function computeEntrances(
    prev: EntranceState,
    channelId: string | undefined,
    messageIds: string[]
): { animate: Set<string>; state: EntranceState } {
    if (channelId !== prev.channelId) {
        // channel switch or first mount: present the existing set with no entrance
        return { animate: new Set(), state: { channelId, seen: new Set(messageIds) } };
    }
    const animate = new Set<string>();
    const seen = new Set(prev.seen);
    for (const id of messageIds) {
        if (!seen.has(id)) {
            animate.add(id);
            seen.add(id);
        }
    }
    return { animate, state: { channelId, seen } };
}
