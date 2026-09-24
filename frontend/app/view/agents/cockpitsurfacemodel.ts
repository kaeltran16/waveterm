// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure glue for CockpitSurface: dismissal keying, the roster load phase, the recently-idle
// grace-window split, and a generic set toggle. Extracted so the surface's orchestration decisions
// are unit-testable without rendering the grid.

import { isRecentlyIdle, type AgentVM } from "./agentsviewmodel";
import type { LoadPhase } from "./loadphase";

// a just-finished agent's dismissal is keyed by idle episode (id:idleSince) so a later re-idle re-shows it.
export function dismissKey(agent: Pick<AgentVM, "id" | "idleSince">): string {
    return `${agent.id}:${agent.idleSince ?? ""}`;
}

// An empty roster is only "no agents" once it has been read; before that it is still loading. Agents that
// are already there always show, whatever the seed state.
export function rosterLoadPhase(seeded: boolean, agentCount: number): LoadPhase {
    if (agentCount > 0) {
        return "ready";
    }
    return seeded ? "empty" : "loading";
}

// within-grace idle agents keep their full row (recently); dismissed or aged-out ones park in the idle list.
export function splitRecentlyIdle(
    idle: AgentVM[],
    now: number,
    dismissed: Set<string>
): { recently: AgentVM[]; parked: AgentVM[] } {
    const recently = idle.filter((a) => isRecentlyIdle(a, now) && !dismissed.has(dismissKey(a)));
    const recentIds = new Set(recently.map((a) => a.id));
    const parked = idle.filter((a) => !recentIds.has(a.id));
    return { recently, parked };
}

export function toggleInSet(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) {
        next.delete(id);
    } else {
        next.add(id);
    }
    return next;
}
