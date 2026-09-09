// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief header's fleet line: the live agent roster -> how many workers are running and what they
// have cost. Count and spend both come off the one roster argument, so the two halves of the line can
// never disagree — the version this replaces derived its count and hardcoded its spend.

import { liveWindowAgents, type AgentVM } from "@/app/view/agents/agentsviewmodel";

export interface BriefFleet {
    liveCount: number;
    spendUsd: number;
    line: string;
}

// the fleet's absence, said out loud: "0 sessions live · $0.00" asserts a fleet that is not there
export const NO_FLEET_LINE = "nothing running";

function formatUsd(n: number): string {
    return `$${n.toFixed(2)}`;
}

// Per-agent reported cost, not the Usage surface's totalSpendUsd: that is a client-side price estimate
// over historical transcripts and it stops refreshing once its surface unmounts, while this line is
// header chrome that has to stay current. Idle agents still count — their frozen last reading is spend
// the fleet already accrued.
function rosterSpendUsd(agents: AgentVM[]): number {
    let total = 0;
    for (const a of agents) {
        const cost = a.usage?.costusd;
        // one malformed reading would poison the whole line
        if (typeof cost === "number" && Number.isFinite(cost)) {
            total += cost;
        }
    }
    return total;
}

/** Pure: roster -> live count, roster spend, and the header line. "Live" is liveWindowAgents so the
 *  count matches every other live reading in the cockpit. Parts are omitted rather than zeroed. */
export function briefFleet(agents: AgentVM[]): BriefFleet {
    const roster = agents ?? [];
    const liveCount = liveWindowAgents(roster).length;
    const spendUsd = rosterSpendUsd(roster);
    if (liveCount === 0) {
        return { liveCount, spendUsd, line: NO_FLEET_LINE };
    }
    const parts = [`${liveCount} session${liveCount === 1 ? "" : "s"} live`];
    if (spendUsd > 0) {
        parts.push(formatUsd(spendUsd));
    }
    return { liveCount, spendUsd, line: parts.join(" · ") };
}
