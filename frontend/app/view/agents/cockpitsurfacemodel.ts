// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure glue shared across surfaces: the roster load phase, the project switcher's counts, and a plural.

import { matchesProjectFilter, projectsFromAgents, type AgentVM } from "./agentsviewmodel";
import type { LoadPhase } from "./loadphase";

// An empty roster is only "no agents" once it has been read; before that it is still loading. Agents that
// are already there always show, whatever the seed state.
export function rosterLoadPhase(seeded: boolean, agentCount: number): LoadPhase {
    if (agentCount > 0) {
        return "ready";
    }
    return seeded ? "empty" : "loading";
}

// the toolbar's facts over the scoped roster: every agent counts, whatever its card shows
export function cockpitCounts(
    agents: AgentVM[],
    projectFilter: string,
    needsYou: (a: AgentVM) => boolean
): { agents: number; projects: number; needsYou: number } {
    const scoped = agents.filter((a) => matchesProjectFilter(a, projectFilter));
    return {
        agents: scoped.length,
        projects: projectsFromAgents(scoped).length,
        needsYou: scoped.filter(needsYou).length,
    };
}

export function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}
