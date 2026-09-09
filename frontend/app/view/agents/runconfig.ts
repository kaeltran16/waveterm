// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What the run launcher draws, as data. The launcher replaced the composer footer's chip strip, where
// shape, engine/adaptive and the Lead->Workers pickers competed for one wrapping 10px row; the sections a
// given shape actually has are decided here so the view stays a renderer.

import type { RunShape } from "./composercommand";
import type { Orchestration } from "./orchestratorpicker";

// Mirrors of the two Go ceilings the launcher states in prose. They are consts, not wire types, so codegen
// does not carry them; runconfig.test.ts reads the Go source and fails if either drifts.
export const MAX_PARALLELISM = 8; // orchestrate.MaxParallelism (pkg/orchestrate/dag.go)
export const MAX_DAG_TASKS = 16; // jarvis.MaxDagTasks (pkg/jarvis/run.go)

export const DEFAULT_PARALLELISM = 3;

export interface ShapeCard {
    id: RunShape;
    desc: string;
}

// Ordered widest-to-narrowest commitment. The descriptions say what the machine does, not what the word
// means: "orchestrator" alone never told anyone that a lead plans first and workers come after.
export const SHAPE_CARDS: ShapeCard[] = [
    { id: "pipeline", desc: "Phases in order, one worker each, gate between." },
    { id: "orchestrator", desc: "A lead plans the work, then work fans out." },
    { id: "quick", desc: "One worker, no phases, no plan gate." },
];

export function clampParallelism(n: number): number {
    if (!Number.isFinite(n)) {
        return DEFAULT_PARALLELISM;
    }
    return Math.min(MAX_PARALLELISM, Math.max(1, Math.round(n)));
}

// Which machine fans the work out. Stated in full because it is the most consequential choice in the
// flow and the least visible: engine and adaptive share a shape name and produce different systems.
export function machineNote(orchestration: Orchestration): string {
    return orchestration === "engine"
        ? `A DAG the engine schedules into managed worktrees, up to ${MAX_DAG_TASKS} tasks.`
        : "The lead dispatches its own subagents as it goes.";
}

export interface RunLauncherFace {
    showMachine: boolean;
    showParallelism: boolean;
    showWorkerRoute: boolean;
}

// Parallelism and the worker route are engine-only: WorkerRoute is read solely when the engine spawns
// DAG children, and an adaptive lead's subagents never occupy a scheduler slot. Offering either for an
// adaptive lead would promise a control that does nothing (see orchestratorPickerState, same rule).
export function runLauncherFace(shape: RunShape, orchestration: Orchestration): RunLauncherFace {
    const orchestrator = shape === "orchestrator";
    const engine = orchestrator && orchestration === "engine";
    return { showMachine: orchestrator, showParallelism: engine, showWorkerRoute: engine };
}
