// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure reads of a correlated subagent (SubagentVM) that the transcript's Agent step, the subagent view and the
// parent's now line share: its outcome as one word, its elapsed time, and which background ones still run.

import type { SubagentVM } from "./session-models/sessionviewmodel";

export type SubagentOutcome = "running" | "done" | "failed" | "stopped";

const OUTCOME: Record<SubagentVM["state"], SubagentOutcome> = {
    working: "running",
    success: "done",
    done: "done",
    failure: "failed",
    stopped: "stopped",
};

export function subagentOutcome(sub: SubagentVM): SubagentOutcome {
    return OUTCOME[sub.state];
}

/** Start to now while it runs, start to end once it finished; undefined when either end is unknown. */
export function subagentElapsedMs(sub: SubagentVM, now: number): number | undefined {
    if (sub.startedAtMs == null) {
        return undefined;
    }
    const end = sub.state === "working" ? now : sub.endedAtMs;
    return end == null ? undefined : Math.max(0, end - sub.startedAtMs);
}

/** The background subagents still working, most recently started first. */
export function runningBackground(subs: SubagentVM[]): SubagentVM[] {
    return subs
        .filter((s) => s.background === true && s.state === "working")
        .sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0));
}
