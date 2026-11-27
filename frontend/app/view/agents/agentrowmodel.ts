// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure glue for a session's transcript: the entry fallback a thumbnail reads, and the finish (working -> idle)
// settle trigger.

import type { AgentState } from "./agentsviewmodel";

export function entriesToShow<T>(liveEntries: T[], previousInfo: T[] | undefined): T[] {
    return liveEntries.length > 0 ? liveEntries : (previousInfo ?? []);
}

// one-shot settle animation fires when an agent finishes: idle and not standing by, after working or after standing
// by (its last shell task ended while it stayed idle). The Stop that begins standing by is not a finish.
export function isFinishTransition(
    prev: AgentState,
    next: AgentState,
    prevStandingBy = false,
    nextStandingBy = false
): boolean {
    if (next !== "idle" || nextStandingBy) {
        return false;
    }
    return prev === "working" || (prev === "idle" && prevStandingBy);
}
