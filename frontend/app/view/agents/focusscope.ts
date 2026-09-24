// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure Presence-C scope filters. A focus's SpaceScope (from ResolveFocusScopeCommand) lists the target's
// attributed run orefs, channel oids, and worker tab ids. These apply that scope to surface lists; kept
// jotai-free so they unit-test without a render/store harness.

import type { AgentVM } from "./agentsviewmodel";

// Keep only roster rows whose tabId (AgentVM.id) is in the focus. Null scope (Global) or a revealed
// surface (the "Show all" escape hatch) passes everything through unchanged.
export function filterByFocus(agents: AgentVM[], scope: SpaceScope | null, revealed: boolean): AgentVM[] {
    if (scope == null || revealed) {
        return agents;
    }
    const ids = new Set(scope.tabids);
    return agents.filter((a) => ids.has(a.id));
}

// Keep only channels whose oid is in the focus. Typed on { oid } so it works on the Channel wire type
// without importing it. Null channels / null scope / revealed pass through.
export function filterChannelsByFocus<T extends { oid: string }>(
    channels: T[] | null,
    scope: SpaceScope | null,
    revealed: boolean
): T[] | null {
    if (channels == null || scope == null || revealed) {
        return channels;
    }
    const ids = new Set(scope.channeloids);
    return channels.filter((c) => ids.has(c.oid));
}

// Keep only sessions whose live tab id is in the focus. An ended session has no tab id, so no attribution
// places it in a focus and it is hidden while one is focused. Null scope / revealed pass through.
export function filterSessionsByFocus<T extends { liveId?: string }>(
    sessions: T[],
    scope: SpaceScope | null,
    revealed: boolean
): T[] {
    if (scope == null || revealed) {
        return sessions;
    }
    const ids = new Set(scope.tabids);
    return sessions.filter((session) => session.liveId != null && ids.has(session.liveId));
}

// The banner line splits around the focus label so the label can render emphasized. toggle is the
// Show all / Hide button's text, null when the focus hides nothing and the button would be a no-op.
export interface FocusBannerCopy {
    lead: string;
    label: string;
    trail: string;
    toggle: string | null;
}

// inScope and total are counts with the focus applied and without it, both before any reveal; noun
// is the plural the surface lists ("agents", "sessions").
export function focusBannerCopy(
    label: string,
    inScope: number,
    total: number,
    revealed: boolean,
    noun: string
): FocusBannerCopy {
    const hidden = total - inScope;
    if (revealed) {
        return {
            lead: `Showing all ${total} · ${inScope} in `,
            label,
            trail: "",
            toggle: hidden > 0 ? `Hide the other ${hidden}` : null,
        };
    }
    if (inScope === 0) {
        return {
            lead: "Focused on ",
            label,
            trail: ` · none of its ${noun} are live`,
            toggle: total > 0 ? `Show all ${total}` : null,
        };
    }
    if (hidden <= 0) {
        return { lead: "Focused on ", label, trail: "", toggle: null };
    }
    return {
        lead: "Focused on ",
        label,
        trail: ` · showing ${inScope} of ${total} ${noun}`,
        toggle: `Show all ${total}`,
    };
}
