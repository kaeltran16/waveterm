// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure glue for CockpitSurface: dismissal keying, empty-state + chip filtering, the recently-idle
// grace-window split, and a generic set toggle. Extracted so the surface's orchestration decisions
// are unit-testable without rendering the grid.

import type { ChipFilter } from "./agents";
import { isRecentlyIdle, type AgentVM } from "./agentsviewmodel";

// a just-finished agent's dismissal is keyed by idle episode (id:idleSince) so a later re-idle re-shows it.
export function dismissKey(agent: Pick<AgentVM, "id" | "idleSince">): string {
    return `${agent.id}:${agent.idleSince ?? ""}`;
}

export function isCockpitEmpty(asking: AgentVM[], working: AgentVM[], idle: AgentVM[]): boolean {
    return asking.length === 0 && working.length === 0 && idle.length === 0;
}

// the status chip narrows what the grid renders; "all" shows everything.
export function shownForChip(agents: AgentVM[], chip: ChipFilter): AgentVM[] {
    return chip === "all" ? agents : agents.filter((a) => a.state === chip);
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
