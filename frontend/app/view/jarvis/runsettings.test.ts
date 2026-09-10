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

function gatedGroup(over: Partial<TaskGroup> = {}): TaskGroup {
    return {
        oid: "d1",
        version: 1,
        id: "d1",
        runid: "r1",
        channelid: "c1",
        parallelism: 2,
        tasks: [{ id: "t-1", state: "pending" }],
        status: "awaiting-plan",
        failures: 0,
        createdts: 1,
        updatedts: 1,
        plangate: true,
        ...over,
    } as TaskGroup;
}

describe("sheetFace", () => {
    it("states unavailability for a run that is gone", () => {
        expect(sheetFace(undefined, null).kind).toBe("missing");
        expect(sheetFace(null, null).kind).toBe("missing");
    });

    // a control that changes nothing is worse than its absence
    it("is read-only for terminal runs", () => {
        for (const status of ["done", "cancelled"]) {
            const face = sheetFace(engineRun({ status }), null);
            expect(face.kind).toBe("readonly");
        }
    });

    it("is read-only for a run with no engine scheduler", () => {
        expect(sheetFace(engineRun({ mode: "pipeline", orchestration: "" }), null).kind).toBe("readonly");
        expect(sheetFace(engineRun({ orchestration: "adaptive" }), null).kind).toBe("readonly");
    });

    it("is editable while the plan gate is still ahead", () => {
        const face = sheetFace(engineRun(), gatedGroup());
        expect(face).toEqual({ kind: "editable", gateEditable: true });
    });

    // once work has crossed the gate, the width and route still change but the gate does not
    it("locks the gate once the plan was approved or work dispatched", () => {
        expect(sheetFace(engineRun(), gatedGroup({ planapprovedts: 5 }))).toEqual({
            kind: "editable",
            gateEditable: false,
        });
        const dispatched = gatedGroup({ tasks: [{ id: "t-1", state: "running", runid: "child-1" }] as TaskNode[] });
        expect(sheetFace(engineRun(), dispatched)).toEqual({ kind: "editable", gateEditable: false });
    });

    it("is editable with the gate unlocked before a dag exists", () => {
        expect(sheetFace(engineRun(), null)).toEqual({ kind: "editable", gateEditable: true });
    });
});

describe("runSettingsDraft", () => {
    it("reads the run's own launch form before submission", () => {
        const route = { runtime: "pi", tier: "capable" } as RoutePin;
        const run = engineRun({ parallelism: 4, workerroute: route });
        expect(runSettingsDraft(run, null)).toEqual({ parallelism: 4, workerRoute: route, planGate: true });
    });

    // the group, not the run, is what the scheduler will read
    it("prefers the group once a dag exists", () => {
        const route = { runtime: "claude", tier: "capable" } as RoutePin;
        const run = engineRun({ parallelism: 4 });
        const group = gatedGroup({ parallelism: 2, workerroute: route, plangate: false });
        expect(runSettingsDraft(run, group)).toEqual({ parallelism: 2, workerRoute: route, planGate: false });
    });

    it("honours a pending gate the human already chose", () => {
        expect(runSettingsDraft(engineRun({ plangatepending: false }), null).planGate).toBe(false);
    });

    it("defaults the gate off for a child plan, which is never gated", () => {
        expect(runSettingsDraft(engineRun({ parentleadoref: "tab:lead" }), null).planGate).toBe(false);
    });
});

describe("draftIsDirty", () => {
    it("compares the effective values", () => {
        const base = { parallelism: 2, workerRoute: null, planGate: true };
        expect(draftIsDirty(base, { parallelism: 2, workerRoute: null, planGate: true })).toBe(false);
        expect(draftIsDirty(base, { parallelism: 3, workerRoute: null, planGate: true })).toBe(true);
        expect(draftIsDirty(base, { parallelism: 2, workerRoute: null, planGate: false })).toBe(true);
        expect(
            draftIsDirty(base, {
                parallelism: 2,
                workerRoute: { runtime: "pi", tier: "capable" } as RoutePin,
                planGate: true,
            })
        ).toBe(true);
    });
});

describe("settingsPayload", () => {
    it("sends only the mutable settings, addressed to the run", () => {
        const draft = { parallelism: 3, workerRoute: { runtime: "pi", tier: "capable" } as RoutePin, planGate: false };
        expect(settingsPayload("c1", "r1", draft)).toEqual({
            channelid: "c1",
            runid: "r1",
            parallelism: 3,
            workerroute: { runtime: "pi", tier: "capable" },
            plangate: false,
        });
    });

    it("omits the gate when the sheet was not allowed to touch it", () => {
        const draft = { parallelism: 3, workerRoute: null, planGate: true };
        expect(settingsPayload("c1", "r1", draft, { includeGate: false })).toEqual({
            channelid: "c1",
            runid: "r1",
            parallelism: 3,
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
        expect(runSettingsPanelState(engineRun({ dagoref: "d1" }), gatedGroup(), "ready")).toEqual({
            kind: "editable",
            gateEditable: true,
        });
    });

    it("treats a run with no dag as pre-submission, not as loading", () => {
        expect(runSettingsPanelState(engineRun(), null, "ready")).toEqual({ kind: "editable", gateEditable: true });
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
        const before = draftSeedKey(linked, gatedGroup());
        const after = draftSeedKey(linked, gatedGroup({ workerroute: { runtime: "pi", tier: "capable" } as RoutePin }));
        expect(after).not.toBe(before);
    });

    it("changes on a pre-dag width or worker route", () => {
        const base = draftSeedKey(engineRun(), null);
        expect(draftSeedKey(engineRun({ parallelism: 6 }), null)).not.toBe(base);
        expect(draftSeedKey(engineRun({ workerroute: { runtime: "pi", tier: "capable" } as RoutePin }), null)).not.toBe(
            base
        );
    });

    it("moves with a pending gate a human set before submission", () => {
        expect(draftSeedKey(engineRun({ plangatepending: false }), null)).not.toBe(draftSeedKey(engineRun(), null));
    });

    it("ignores an update that leaves the effective settings alone", () => {
        const run = engineRun({ dagoref: "d1" });
        expect(draftSeedKey(run, gatedGroup({ status: "executing" }))).toBe(
            draftSeedKey(run, gatedGroup({ status: "done" }))
        );
    });
});

describe("effectiveRunConfig", () => {
    it("reads the launched facts from the run and the mutable dials from the draft", () => {
        const lead = { runtime: "claude", tier: "strong" } as RoutePin;
        const worker = { runtime: "pi", tier: "capable" } as RoutePin;
        const run = engineRun({ runtime: "claude", tier: "strong", workerroute: lead });
        const got = effectiveRunConfig(run, { parallelism: 4, workerRoute: worker, planGate: false });
        expect(got).toEqual({
            shape: "orchestrator",
            machine: "engine",
            parallelism: 4,
            leadRoute: { runtime: "claude", tier: "strong" },
            workerRoute: worker,
            planGate: false,
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
            machine: "engine",
            parallelism: 5,
            leadRoute: { runtime: "claude", tier: "strong" } as RoutePin,
            workerRoute: { runtime: "pi", tier: "capable" } as RoutePin,
            planGate: false,
        };
        expect(engineDefaultsPatch(existing, config)).toEqual({
            principles: { disabled: ["p1"] },
            defaultmode: "orchestrator",
            machine: "engine",
            parallelism: 5,
            route: { runtime: "claude", tier: "strong" },
            workerroute: { runtime: "pi", tier: "capable" },
            defaultplangate: false,
        });
    });

    it("clears the routes when the run inherits them", () => {
        const existing = { workerroute: { runtime: "pi", tier: "capable" } } as ProfileOverride;
        const patched = engineDefaultsPatch(existing, {
            shape: "pipeline",
            machine: "adaptive",
            parallelism: 2,
            leadRoute: null,
            workerRoute: null,
            planGate: true,
        });
        expect(patched.route).toBeUndefined();
        expect(patched.workerroute).toBeUndefined();
        expect(patched.defaultmode).toBe("pipeline");
        expect(patched.machine).toBe("adaptive");
        expect(patched.defaultplangate).toBe(true);
    });
});
