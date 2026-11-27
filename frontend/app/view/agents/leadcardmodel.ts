// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A run lead's mark on its agent tree row, a task row's cursor key, and the run palette's conditions on a run's
// dials and its lead. Pure: no React, no Wave runtime.

import { relaunchLeadAction } from "../orchestrate/relaunchlead";
import type { AgentVM } from "./agentsviewmodel";
import { leadStandingBy, runEngineBusy, runFinished, type RunInfo } from "./runlineage";
import { runComplete } from "./runmodel";

const ROW_KEY_PREFIX = "row:";

export function rowKey(cardId: string, taskId: string): string {
    return `${ROW_KEY_PREFIX}${cardId}:${taskId}`;
}

type LeadMarkTone = "success" | "accent" | "warning" | "muted" | "error";

export const LEAD_MARK_CLASS: Record<LeadMarkTone, string> = {
    success: "text-success",
    accent: "text-accent",
    warning: "text-warning",
    muted: "text-muted",
    error: "text-error",
};

/** Pure: a run's Workflow mark on its agent tree row: green only when the run is complete. The
 *  pulse is the lead's own work; a lead that is down or standing by while the engine works leaves the mark accent
 *  and still, so the run does not read as stopped. A lead that failed to start keeps the mark, in the error tone. */
export function leadMark(run: RunInfo, lead: AgentVM | undefined): { tone: LeadMarkTone; pulse: boolean } {
    if (runComplete(run)) {
        return { tone: "success", pulse: false };
    }
    if (lead?.startError != null) {
        return { tone: "error", pulse: false };
    }
    if (lead == null || leadStandingBy(lead, run)) {
        return { tone: runEngineBusy(run) ? "accent" : "muted", pulse: false };
    }
    if (lead.state === "working") {
        return { tone: "accent", pulse: true };
    }
    if (lead.state === "asking") {
        return { tone: "warning", pulse: true };
    }
    return { tone: "muted", pulse: false };
}

/** Pure: an engine run's dials (worker parallelism) can change until it finishes. */
export function runAdjustable(run: Pick<RunInfo, "dag" | "status">): boolean {
    return run.dag != null && !runFinished(run);
}

/** Pure: the lead cannot take wakes. The newest wake failure stands until a lead is launched after it. */
export function isLeadDown(events: RunEvent[]): boolean {
    const failed = events.filter((e) => e.kind === "lead-wake-failed").sort((a, b) => b.ts - a.ts)[0];
    return failed != null && relaunchLeadAction(failed, events, false) != null;
}
