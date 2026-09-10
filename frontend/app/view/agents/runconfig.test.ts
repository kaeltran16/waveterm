// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    DEFAULT_PARALLELISM,
    MAX_DAG_TASKS,
    MAX_PARALLELISM,
    SHAPE_CARDS,
    clampParallelism,
    machineNote,
    profileRunDefaults,
    runLauncherFace,
} from "./runconfig";

// The two ceilings are Go consts the launcher states in prose ("up to 16 tasks", the stepper's bound). Nothing
// generates them, so this reads the source: a raised cap that only lands in Go would leave the launcher
// promising a limit the engine no longer enforces.
describe("go constant mirrors", () => {
    const goSource = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf-8");

    it("MAX_PARALLELISM tracks orchestrate.MaxParallelism", () => {
        const src = goSource("../../../../pkg/orchestrate/dag.go");
        const m = src.match(/const MaxParallelism = (\d+)/);
        expect(m, "MaxParallelism declaration not found in pkg/orchestrate/dag.go").not.toBeNull();
        expect(Number(m![1])).toBe(MAX_PARALLELISM);
    });

    it("MAX_DAG_TASKS tracks jarvis.MaxDagTasks", () => {
        const src = goSource("../../../../pkg/jarvis/run.go");
        const m = src.match(/const MaxDagTasks = (\d+)/);
        expect(m, "MaxDagTasks declaration not found in pkg/jarvis/run.go").not.toBeNull();
        expect(Number(m![1])).toBe(MAX_DAG_TASKS);
    });
});

describe("clampParallelism", () => {
    it("holds the engine's 1..MaxParallelism band", () => {
        expect(clampParallelism(0)).toBe(1);
        expect(clampParallelism(-4)).toBe(1);
        expect(clampParallelism(1)).toBe(1);
        expect(clampParallelism(4)).toBe(4);
        expect(clampParallelism(MAX_PARALLELISM)).toBe(MAX_PARALLELISM);
        expect(clampParallelism(MAX_PARALLELISM + 1)).toBe(MAX_PARALLELISM);
    });

    it("rounds a fractional width rather than sending it to the wire", () => {
        expect(clampParallelism(2.4)).toBe(2);
        expect(clampParallelism(2.6)).toBe(3);
    });

    it("falls back to the default rather than emitting NaN", () => {
        expect(clampParallelism(Number.NaN)).toBe(DEFAULT_PARALLELISM);
        expect(clampParallelism(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PARALLELISM);
    });
});

describe("shape cards", () => {
    it("covers every shape the composer can dispatch, once", () => {
        expect(SHAPE_CARDS.map((s) => s.id)).toEqual(["pipeline", "orchestrator", "quick"]);
    });

    it("describes the machine rather than restating the name", () => {
        for (const card of SHAPE_CARDS) {
            expect(card.desc.toLowerCase()).not.toBe(card.id);
            expect(card.desc.length).toBeGreaterThan(20);
        }
    });
});

describe("machineNote", () => {
    it("names the task ceiling the engine actually enforces", () => {
        expect(machineNote("engine")).toContain(String(MAX_DAG_TASKS));
    });

    it("says the adaptive lead owns its own fan-out", () => {
        expect(machineNote("adaptive")).not.toContain(String(MAX_DAG_TASKS));
        expect(machineNote("adaptive")).toMatch(/subagents/);
    });
});

describe("runLauncherFace", () => {
    it("shows the machine choice only for an orchestrator", () => {
        expect(runLauncherFace("orchestrator", "engine").showMachine).toBe(true);
        expect(runLauncherFace("pipeline", "engine").showMachine).toBe(false);
        expect(runLauncherFace("quick", "engine").showMachine).toBe(false);
    });

    it("gates parallelism and the worker route on the engine", () => {
        const engine = runLauncherFace("orchestrator", "engine");
        expect(engine.showParallelism).toBe(true);
        expect(engine.showWorkerRoute).toBe(true);

        // adaptive subagents never occupy a scheduler slot and never read WorkerRoute
        const adaptive = runLauncherFace("orchestrator", "adaptive");
        expect(adaptive.showParallelism).toBe(false);
        expect(adaptive.showWorkerRoute).toBe(false);
    });

    it("never offers engine controls off the orchestrator shape", () => {
        for (const shape of ["pipeline", "quick"] as const) {
            const face = runLauncherFace(shape, "engine");
            expect(face.showParallelism).toBe(false);
            expect(face.showWorkerRoute).toBe(false);
        }
    });
});

// The launcher is hydrating from a channel profile, not deciding for it: every field the profile does not
// state comes back as "no opinion" so the launcher's own default stands rather than being silently replaced.
describe("profileRunDefaults", () => {
    it("maps a saved profile onto the launcher's controls", () => {
        const route = { runtime: "pi", tier: "capable" } as RoutePin;
        const got = profileRunDefaults({
            playbook: [],
            defaultmode: "orchestrator",
            machine: "engine",
            parallelism: 5,
            workerroute: route,
        } as JarvisProfile);
        expect(got).toEqual({ shape: "orchestrator", orchestration: "engine", parallelism: 5, workerRoute: route });
    });

    it("has no opinion where the profile is silent", () => {
        expect(profileRunDefaults({ playbook: [] } as JarvisProfile)).toEqual({
            shape: null,
            orchestration: null,
            parallelism: null,
            workerRoute: null,
        });
        expect(profileRunDefaults(null)).toEqual({
            shape: null,
            orchestration: null,
            parallelism: null,
            workerRoute: null,
        });
    });

    it("maps the pipeline default and the adaptive machine", () => {
        const got = profileRunDefaults({ playbook: [], defaultmode: "pipeline", machine: "adaptive" } as JarvisProfile);
        expect(got.shape).toBe("pipeline");
        expect(got.orchestration).toBe("adaptive");
    });

    it("ignores a nonsensical stored width rather than clamping it into a dispatch", () => {
        expect(profileRunDefaults({ playbook: [], parallelism: 0 } as JarvisProfile).parallelism).toBeNull();
    });
});
