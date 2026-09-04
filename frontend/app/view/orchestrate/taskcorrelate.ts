// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentVM } from "../agents/agentsviewmodel";
import type { AgentsViewModel } from "../agents/agents";
import { jumpToAgent } from "../agents/channelsprimitives";
import { pendingRunFocusAtom } from "../agents/runactions";

// A dag task's worker correlation, resolved purely from the child run + roster. Explicit degradation
// states match spec 6.2: a pending task (no child run yet) is "pending"; a run with no reachable
// worker session is "unavailable" with its runId kept for the child-run fallback.
export type TaskWorkerView = {
    state: "dispatched" | "pending" | "unavailable";
    tabId?: string;
    runId?: string;
    agent?: AgentVM;
};

export type TaskWorkerTask = {
    id: string;
    runid?: string;
};

// resolveTaskWorker correlates a task to its worker: the child run's first recorded tab oref matched
// against the live roster. A run that exists but whose worker session is gone (no tab oref, or the tab
// no longer has a roster row) resolves unavailable — never fabricated.
export function resolveTaskWorker(task: TaskWorkerTask, childRun: Run | undefined, roster: AgentVM[]): TaskWorkerView {
    if (!task.runid) {
        return { state: "pending" };
    }
    const runId = task.runid;
    if (!childRun) {
        return { state: "unavailable", runId };
    }
    for (const phase of childRun.phases ?? []) {
        for (const oref of phase.workerorefs ?? []) {
            if (!oref.startsWith("tab:")) {
                continue;
            }
            const tabId = oref.slice(4);
            const agent = roster.find((a) => a.id === tabId);
            if (agent) {
                return { state: "dispatched", tabId, runId, agent };
            }
        }
    }
    return { state: "unavailable", runId };
}

// workerActivityText says what a row shows in place of live activity, or null when the worker is
// reachable and its own activity line should render. An unreachable worker gets an explicit
// "unavailable" — rendering it as idle would be a fabricated claim about a session nobody can see.
export function workerActivityText(view: TaskWorkerView): string | null {
    if (view.state === "dispatched" && view.agent) {
        return null;
    }
    return view.state === "pending" ? "Not dispatched yet" : "Activity unavailable";
}

// openTaskWorker routes a resolved worker view: dispatched jumps to the agent tab; unavailable falls
// back to the child run (pending has no navigable target and does nothing).
export function openTaskWorker(view: TaskWorkerView, model: AgentsViewModel, channelId: string): void {
    if (view.state === "dispatched" && view.tabId) {
        jumpToAgent(model, view.tabId);
        return;
    }
    if (view.state === "unavailable" && view.runId) {
        globalStore.set(pendingRunFocusAtom, { channelId, runId: view.runId });
    }
}