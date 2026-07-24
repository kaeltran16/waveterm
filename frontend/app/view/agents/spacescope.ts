// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure Presence-C scope filters. A Space's SpaceScope (from ResolveSpaceScopeCommand) lists the task's
// attributed run orefs, channel oids, and worker tab ids. These apply that scope to surface lists; kept
// jotai-free so they unit-test without a render/store harness.

import type { AgentVM } from "./agentsviewmodel";

// Keep only roster rows whose tabId (AgentVM.id) is in the Space. Null scope (Global) or a revealed
// surface (the "Show all" escape hatch) passes everything through unchanged.
export function filterBySpace(agents: AgentVM[], scope: SpaceScope | null, revealed: boolean): AgentVM[] {
    if (scope == null || revealed) {
        return agents;
    }
    const ids = new Set(scope.tabids);
    return agents.filter((a) => ids.has(a.id));
}

// Keep only channels whose oid is in the Space. Typed on { oid } so it works on the Channel wire type
// without importing it. Null channels / null scope / revealed pass through.
export function filterChannelsBySpace<T extends { oid: string }>(
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

// Escape-hatch banner copy for a scoped surface. Revealed => an un-focus hint; otherwise the focus line
// with the hidden count (or the empty-Space / nothing-hidden case).
export function spaceBannerText(objective: string, hidden: number, revealed: boolean): string {
    if (revealed) {
        return `Showing all · Focused: ${objective}`;
    }
    if (hidden <= 0) {
        return `Focused: ${objective}`;
    }
    return `Focused: ${objective} · ${hidden} hidden`;
}
