// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { modelFace } from "./route";

export type Orchestration = "engine" | "adaptive";

export const ORCHESTRATION_OPTIONS: Orchestration[] = ["engine", "adaptive"];

// The Lead → Workers row is engine-only: WorkerRoute is read solely when the engine spawns DAG
// children, so offering it for an adaptive lead would promise a routing that never happens.
export function orchestratorPickerState(input: {
    shape: string;
    mode: string;
    pending: boolean;
    hasWorkerCallback: boolean;
    orchestration: Orchestration;
}): { showTightRow: boolean; showWorkerPicker: boolean } {
    const show =
        input.shape === "orchestrator" &&
        input.mode !== "ask" &&
        !input.pending &&
        input.hasWorkerCallback &&
        input.orchestration === "engine";
    return { showTightRow: show, showWorkerPicker: show };
}

export function workerPickerFace(workerRoute: RoutePin | null): string {
    if (workerRoute == null) {
        return "Same as lead";
    }
    return modelFace(workerRoute);
}

// Footer copy for the orchestrator shape. Which machine runs is the thing worth echoing back: engine
// publishes a TaskGroup the backend schedules into managed worktrees, adaptive leaves fan-out to the
// lead's own subagents.
export function orchestratorBehaviorFace(input: {
    orchestration: Orchestration;
    leadFace: string;
    workerFace: string | null;
}): string {
    if (input.orchestration === "adaptive") {
        return `→ adaptive subagents · lead ${input.leadFace}`;
    }
    return `→ engine DAG · lead ${input.leadFace} · workers ${input.workerFace ?? "same as lead"}`;
}
