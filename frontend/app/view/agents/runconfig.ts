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

// Who writes the DAG. A lead planning turn is a whole model turn spent transcribing a goal into tasks,
// and it is the single largest cost in an engine run when the decomposition is already settled: the
// measured run spent 45m19s there with no intervening events. `human` defers the start so the run holds
// its spec and waits for a DAG instead of spawning a lead to invent one. The engine has supported this
// since DeferStart landed; until now nothing in the app could ask for it.
export type Planner = "lead" | "human";
export const PLANNER_OPTIONS: Planner[] = ["lead", "human"];
export const DEFAULT_PLANNER: Planner = "lead";

// Said in full because choosing `human` leaves the run deliberately idle, and a user who is not told
// how to hand it a plan reads that as a broken launch.
export function plannerNote(planner: Planner): string {
    return planner === "lead"
        ? "A lead reads the goal and drafts the DAG, then you approve it at the plan gate."
        : "The run waits with no lead and no workers. Write the DAG yourself, then `wsh jarvis dag submit --file <path> --channel <id> --runid <id>` — a run with no dag cannot be resolved from a terminal block, so both ids are required.";
}

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

// What a channel's saved profile says about the launcher. Every field is nullable because a profile that is
// silent about one must leave the launcher's own default standing rather than silently replacing it — the
// same "no opinion" rule the lead route already follows.
export interface ProfileRunDefaults {
    shape: RunShape | null;
    orchestration: Orchestration | null;
    parallelism: number | null;
    workerRoute: RoutePin | null;
}

export function profileRunDefaults(profile: JarvisProfile | null | undefined): ProfileRunDefaults {
    const mode = profile?.defaultmode ?? "";
    const machine = profile?.machine ?? "";
    const width = profile?.parallelism ?? 0;
    return {
        shape: mode === "quick" || mode === "pipeline" || mode === "orchestrator" ? mode : null,
        orchestration: machine === "engine" || machine === "adaptive" ? machine : null,
        // a width only counts when it is a width; anything else is the profile saying nothing
        parallelism: width > 0 ? clampParallelism(width) : null,
        workerRoute: profile?.workerroute ?? null,
    };
}

export interface RunLauncherFace {
    showMachine: boolean;
    showPlanner: boolean;
    showParallelism: boolean;
    showWorkerRoute: boolean;
}

// Parallelism and the worker route are engine-only: WorkerRoute is read solely when the engine spawns
// DAG children, and an adaptive lead's subagents never occupy a scheduler slot. Offering either for an
// adaptive lead would promise a control that does nothing (see orchestratorPickerState, same rule).
export function runLauncherFace(shape: RunShape, orchestration: Orchestration): RunLauncherFace {
    const orchestrator = shape === "orchestrator";
    const engine = orchestrator && orchestration === "engine";
    // engine-only for the same reason as the dials: `wsh jarvis dag submit` hands a DAG to the engine
    // scheduler, and an adaptive lead has no DAG for a human-written plan to replace.
    return { showMachine: orchestrator, showPlanner: engine, showParallelism: engine, showWorkerRoute: engine };
}
