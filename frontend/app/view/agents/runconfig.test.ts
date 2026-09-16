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
    launchBlocker,
    profileRunDefaults,
    runLauncherFace,
    startNote,
    type LaunchBlockerInput,
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
    it("offers the two shapes a launch can start, once", () => {
        expect(SHAPE_CARDS.map((s) => s.id)).toEqual(["orchestrator", "quick"]);
    });

    it("describes the machine rather than restating the name", () => {
        for (const card of SHAPE_CARDS) {
            expect(card.desc.toLowerCase()).not.toBe(card.id);
            expect(card.desc.length).toBeGreaterThan(20);
        }
    });
});

describe("runLauncherFace", () => {
    it("gives the orchestrator its start, its width and its worker route", () => {
        expect(runLauncherFace("orchestrator")).toEqual({
            showStart: true,
            showParallelism: true,
            showWorkerRoute: true,
        });
    });

    // a quick run has no plan to start from and no dag children to route or widen
    it("gives quick none of them", () => {
        expect(runLauncherFace("quick")).toEqual({ showStart: false, showParallelism: false, showWorkerRoute: false });
    });
});

describe("startNote", () => {
    // a plan start runs with no lead, and a user not told when one appears reads that as a broken launch
    it("tells a plan start when a lead appears", () => {
        expect(startNote("plan")).toMatch(/judgment/);
        expect(startNote("goal")).toMatch(/lead/);
    });
});

describe("launchBlocker", () => {
    const ready = { title: "Coupons", shape: { tasks: 2, lanes: 1, longestchain: 2 } } as CommandDagPlanPreviewRtnData;
    const input = (over: Partial<LaunchBlockerInput>): LaunchBlockerInput => ({
        shape: "orchestrator",
        start: "goal",
        goal: "",
        planPath: "",
        preview: null,
        ...over,
    });

    it("needs a goal to start from a goal", () => {
        expect(launchBlocker(input({}))).toBe("Write the goal");
        expect(launchBlocker(input({ goal: "ship coupons" }))).toBeNull();
    });

    it("needs no goal to start from a plan it has read", () => {
        expect(
            launchBlocker(input({ start: "plan", planPath: "/p.md", preview: { path: "/p.md", result: ready } }))
        ).toBeNull();
    });

    it("holds a plan start until the preview has read this exact path", () => {
        expect(launchBlocker(input({ start: "plan", planPath: "  " }))).toBe("Give the plan's absolute path");
        expect(launchBlocker(input({ start: "plan", planPath: "/p.md" }))).toBe("Reading the plan…");
        expect(
            launchBlocker(input({ start: "plan", planPath: "/new.md", preview: { path: "/p.md", result: ready } }))
        ).toBe("Reading the plan…");
    });

    it("blocks on the parser's message", () => {
        expect(
            launchBlocker(
                input({ start: "plan", planPath: "/p.md", preview: { path: "/p.md", error: "plan has no tasks" } })
            )
        ).toBe("plan has no tasks");
    });

    it("ignores a plan start left over on quick, which has no plan", () => {
        expect(launchBlocker(input({ shape: "quick", start: "plan", goal: "fix the flake" }))).toBeNull();
    });
});

// The launcher is hydrating from a channel profile, not deciding for it: every field the profile does not
// state comes back as "no opinion" so the launcher's own default stands rather than being silently replaced.
describe("profileRunDefaults", () => {
    it("maps a saved profile onto the launcher's controls", () => {
        const route = { runtime: "pi" } as RoutePin;
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

    // + Run no longer offers pipeline, so a stored pipeline default has no card to land on
    it("leaves a pipeline default to the launcher's baseline, and still maps the machine", () => {
        const got = profileRunDefaults({ playbook: [], defaultmode: "pipeline", machine: "adaptive" } as JarvisProfile);
        expect(got.shape).toBeNull();
        expect(got.orchestration).toBe("adaptive");
    });

    it("ignores a nonsensical stored width rather than clamping it into a dispatch", () => {
        expect(profileRunDefaults({ playbook: [], parallelism: 0 } as JarvisProfile).parallelism).toBeNull();
    });
});
