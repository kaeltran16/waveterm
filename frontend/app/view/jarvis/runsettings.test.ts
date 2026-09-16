// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    draftIsDirty,
    draftSeedKey,
    effectiveRunConfig,
    engineDefaultsPatch,
    parallelismInvalid,
    runSettingsDraft,
    runSettingsPanelState,
    settingsPayload,
    sheetFace,
} from "./runsettings";

function engineRun(over: Partial<Run> = {}): Run {
    return {
        oid: "r1",
        version: 1,
        id: "r1",
        goal: "ship it",
        runtime: "pi",
        mode: "orchestrator",
        orchestration: "engine",
        status: "executing",
        phases: [],
        workspaceid: "ws",
        projectpath: "/repo",
        createdts: 1,
        meta: {},
        ...over,
    } as Run;
}

function submittedGroup(over: Partial<TaskGroup> = {}): TaskGroup {
    return {
        oid: "d1",
        version: 1,
        id: "d1",
        runid: "r1",
        channelid: "c1",
        parallelism: 2,
        tasks: [{ id: "t-1", state: "pending" }],
        status: "running",
        failures: 0,
        createdts: 1,
        updatedts: 1,
        ...over,
    } as TaskGroup;
}

describe("sheetFace", () => {
    it("states unavailability for a run that is gone", () => {
        expect(sheetFace(undefined).kind).toBe("missing");
        expect(sheetFace(null).kind).toBe("missing");
    });

    // a control that changes nothing is worse than its absence
    it("is read-only for terminal runs", () => {
        for (const status of ["done", "cancelled"]) {
            const face = sheetFace(engineRun({ status }));
            expect(face.kind).toBe("readonly");
        }
    });

    it("is read-only for a run with no engine scheduler", () => {
        expect(sheetFace(engineRun({ mode: "pipeline", orchestration: "" })).kind).toBe("readonly");
        expect(sheetFace(engineRun({ orchestration: "adaptive" })).kind).toBe("readonly");
    });

    it("is editable for a live engine run", () => {
        expect(sheetFace(engineRun())).toEqual({ kind: "editable" });
    });
});

describe("runSettingsDraft", () => {
    it("reads the run's own launch form before submission", () => {
        const route = { runtime: "pi" } as RoutePin;
        const run = engineRun({ parallelism: 4, workerroute: route });
        expect(runSettingsDraft(run, null)).toEqual({ parallelism: 4, workerRoute: route });
    });

    // the group, not the run, is what the scheduler will read
    it("prefers the group once a dag exists", () => {
        const route = { runtime: "claude" } as RoutePin;
        const run = engineRun({ parallelism: 4 });
        const group = submittedGroup({ parallelism: 2, workerroute: route });
        expect(runSettingsDraft(run, group)).toEqual({ parallelism: 2, workerRoute: route });
    });
});

describe("draftIsDirty", () => {
    it("compares the effective values", () => {
        const base = { parallelism: 2, workerRoute: null };
        expect(draftIsDirty(base, { parallelism: 2, workerRoute: null })).toBe(false);
        expect(draftIsDirty(base, { parallelism: 3, workerRoute: null })).toBe(true);
        expect(draftIsDirty(base, { parallelism: 2, workerRoute: { runtime: "pi" } as RoutePin })).toBe(true);
    });
});

describe("settingsPayload", () => {
    it("sends only the mutable settings, addressed to the run", () => {
        const draft = { parallelism: 3, workerRoute: { runtime: "pi" } as RoutePin };
        expect(settingsPayload("c1", "r1", draft)).toEqual({
            channelid: "c1",
            runid: "r1",
            parallelism: 3,
            workerroute: { runtime: "pi" },
        });
    });
});

describe("parallelismInvalid", () => {
    it("accepts 1 through the engine ceiling", () => {
        expect(parallelismInvalid(1)).toBe(false);
        expect(parallelismInvalid(8)).toBe(false);
    });

    it("rejects everything else, including a blank field", () => {
        expect(parallelismInvalid(0)).toBe(true);
        expect(parallelismInvalid(9)).toBe(true);
        expect(parallelismInvalid(2.5)).toBe(true);
        expect(parallelismInvalid(Number.NaN)).toBe(true);
    });
});

describe("runSettingsPanelState", () => {
    // a run that links a dag has mutable settings, but not from the launch snapshot: until the group
    // arrives the sheet cannot know what the scheduler is running at.
    it("waits while a linked group is being read", () => {
        expect(runSettingsPanelState(engineRun({ dagoref: "d1" }), null, "loading")).toEqual({ kind: "loading" });
    });

    // a failed read used to be classified as loading forever, which left the panel counting on a group
    // that would never arrive instead of saying so.
    it("states unavailability when the linked group could not be read", () => {
        expect(runSettingsPanelState(engineRun({ dagoref: "d1" }), null, "error")).toEqual({
            kind: "unavailable",
            reason: "error",
        });
    });

    it("states unavailability when the linked group is gone", () => {
        expect(runSettingsPanelState(engineRun({ dagoref: "d1" }), null, "missing")).toEqual({
            kind: "unavailable",
            reason: "missing",
        });
    });

    it("is editable once the linked group is here", () => {
        expect(runSettingsPanelState(engineRun({ dagoref: "d1" }), submittedGroup(), "ready")).toEqual({
            kind: "editable",
        });
    });

    it("treats a run with no dag as pre-submission, not as loading", () => {
        expect(runSettingsPanelState(engineRun(), null, "ready")).toEqual({ kind: "editable" });
    });

    it("still states unavailability for a missing run", () => {
        expect(runSettingsPanelState(null, null, "loading")).toEqual({ kind: "missing" });
    });
});

// The key the sheet re-seeds its draft on. It has to move for every mutable setting and stay put for
// everything else, or a live status tick wipes what the user typed.
describe("draftSeedKey", () => {
    it("changes on a route-only group update", () => {
        const linked = engineRun({ dagoref: "d1" });
        const before = draftSeedKey(linked, submittedGroup());
        const after = draftSeedKey(linked, submittedGroup({ workerroute: { runtime: "pi" } as RoutePin }));
        expect(after).not.toBe(before);
    });

    it("changes on a pre-dag width or worker route", () => {
        const base = draftSeedKey(engineRun(), null);
        expect(draftSeedKey(engineRun({ parallelism: 6 }), null)).not.toBe(base);
        expect(draftSeedKey(engineRun({ workerroute: { runtime: "pi" } as RoutePin }), null)).not.toBe(
            base
        );
    });

    it("ignores an update that leaves the effective settings alone", () => {
        const run = engineRun({ dagoref: "d1" });
        expect(draftSeedKey(run, submittedGroup({ status: "executing" }))).toBe(
            draftSeedKey(run, submittedGroup({ status: "done" }))
        );
    });
});

describe("effectiveRunConfig", () => {
    it("reads the launched facts from the run and the mutable dials from the draft", () => {
        const lead = { runtime: "claude", model: "opus" } as RoutePin;
        const worker = { runtime: "pi" } as RoutePin;
        const run = engineRun({ runtime: "claude", model: "opus", workerroute: lead });
        const got = effectiveRunConfig(run, { parallelism: 4, workerRoute: worker });
        expect(got).toEqual({
            shape: "orchestrator",
            parallelism: 4,
            leadRoute: { runtime: "claude", model: "opus" },
            workerRoute: worker,
        });
    });
});

describe("engineDefaultsPatch", () => {
    // save-as-project-defaults copies the whole effective configuration, or the "default" is a run the
    // user never had. It must not disturb the sections it does not own.
    it("copies every effective setting onto the existing override", () => {
        const existing = { principles: { disabled: ["p1"] } } as ProfileOverride;
        const config = {
            shape: "orchestrator",
            parallelism: 5,
            leadRoute: { runtime: "claude", model: "opus" } as RoutePin,
            workerRoute: { runtime: "pi" } as RoutePin,
        };
        expect(engineDefaultsPatch(existing, config)).toEqual({
            principles: { disabled: ["p1"] },
            defaultmode: "orchestrator",
            parallelism: 5,
            route: { runtime: "claude", model: "opus" },
            workerroute: { runtime: "pi" },
        });
    });

    it("clears the routes when the run inherits them", () => {
        const existing = { workerroute: { runtime: "pi" } } as ProfileOverride;
        const patched = engineDefaultsPatch(existing, {
            shape: "pipeline",
            parallelism: 2,
            leadRoute: null,
            workerRoute: null,
        });
        expect(patched.route).toBeUndefined();
        expect(patched.workerroute).toBeUndefined();
        expect(patched.defaultmode).toBe("pipeline");
    });
});
