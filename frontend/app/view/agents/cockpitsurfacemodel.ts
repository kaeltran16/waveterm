// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure glue for CockpitSurface: dismissal keying, the roster load phase, the recently-idle
// grace-window split, the toolbar counts, the empty-grid notice, the backgrounded set's pruning, the card order's
// ids, where an Events row click goes, and a generic set toggle. Extracted so the surface's orchestration decisions
// are unit-testable without rendering the grid.

import { isRecentlyIdle, matchesProjectFilter, projectsFromAgents, type AgentVM } from "./agentsviewmodel";
import type { LoadPhase } from "./loadphase";
import type { Lineage } from "./runlineage";
import { isStandingBy, type ShellTask } from "./shelltasks";

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
// an agent standing by has not finished, so it keeps its row whatever its idle age.
export function splitRecentlyIdle(
    idle: AgentVM[],
    now: number,
    dismissed: Set<string>,
    shellTasks: Record<string, ShellTask[]> = {}
): { recently: AgentVM[]; parked: AgentVM[] } {
    const recently = idle.filter(
        (a) =>
            (isRecentlyIdle(a, now) || isStandingBy(a.state, shellTasks[a.id] ?? [])) && !dismissed.has(dismissKey(a))
    );
    const recentIds = new Set(recently.map((a) => a.id));
    const parked = idle.filter((a) => !recentIds.has(a.id));
    return { recently, parked };
}

// a card body shows the narration feed, an ask, or a working activity line. an agent with none of them (just
// launched and not yet prompted, or idle without ever writing a transcript entry) has nothing to show yet.
export function cardHasContent(agent: AgentVM, hasEntries: boolean): boolean {
    return (
        hasEntries ||
        (agent.previousInfo?.length ?? 0) > 0 ||
        agent.state === "asking" ||
        (agent.state === "working" && !!agent.activity)
    );
}

// what a card body shows: the feed, or a "waiting in its terminal" notice for an agent with nothing to show yet
// (a booting launch, or one stopped at a trust prompt).
export function cardBody(agent: AgentVM, hasEntries: boolean): "feed" | "waiting" {
    return agent.booting || !cardHasContent(agent, hasEntries) ? "waiting" : "feed";
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

export interface GridNotice {
    kind: "loading" | "empty-roster" | "empty-scope" | "nothing-live" | "none";
    idle?: number;
    backgrounded?: number;
    project?: string;
}

// what covers an empty grid: the full empty state only for an empty roster; a scope with no agents, or a roster
// that is all parked or backgrounded, gets a smaller notice that points at the sections below.
export function gridNotice(input: {
    seeded: boolean;
    rosterCount: number;
    scopedCount: number;
    shownCards: number;
    parked: number;
    backgrounded: number;
    projectFilter: string;
}): GridNotice {
    if (input.shownCards > 0) {
        return { kind: "none" };
    }
    if (input.rosterCount === 0) {
        return { kind: input.seeded ? "empty-roster" : "loading" };
    }
    if (input.scopedCount === 0 && input.projectFilter !== "all") {
        return { kind: "empty-scope", project: input.projectFilter };
    }
    if (input.parked + input.backgrounded > 0) {
        return { kind: "nothing-live", idle: input.parked, backgrounded: input.backgrounded };
    }
    return { kind: "none" };
}

export function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// only a working agent stays backgrounded, so the section's "still running" holds: a plain agent's id goes once it
// asks, finishes or leaves the roster, and never stays while it is still booting. a run member's id stays, since a lead idles between wakes and its card
// already resurfaces on needs-you (isBackgroundedRun).
export function prunedBackgrounded(ids: Set<string>, agents: AgentVM[], lineage: Lineage): Set<string> {
    const byId = new Map(agents.map((a) => [a.id, a]));
    const keep = (id: string) => {
        const a = byId.get(id);
        return lineage.roles[id] != null || (a?.state === "working" && !a.booting);
    };
    if ([...ids].every(keep)) {
        return ids;
    }
    return new Set([...ids].filter(keep));
}

export type RailSelectTarget = "grid" | "restore" | "terminal" | "agent";

// where an Events row click goes: a card on the grid is cursored, a backgrounded agent restored, a parked idle
// agent's terminal opened (as its Idle row does), and anything else opens in the Agent surface.
export function railSelectTarget(
    id: string,
    where: { onGrid: Set<string>; backgrounded: Set<string>; parked: Set<string> }
): RailSelectTarget {
    if (where.onGrid.has(id)) {
        return "grid";
    }
    if (where.backgrounded.has(id)) {
        return "restore";
    }
    return where.parked.has(id) ? "terminal" : "agent";
}

// the ids the card order is merged over: backgrounded ones keep their slot, so a restored card returns to it
export function orderIds(active: AgentVM[], backgrounded: AgentVM[]): string[] {
    return [...active, ...backgrounded].map((a) => a.id);
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
