// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildRunTimeline } from "./runtimeline";

function ev(kind: string, ts: number, phaseIdx?: number): RunEvent {
    return { id: "e" + ts, runid: "run-1", channelid: "ch", ts, kind, phaseidx: phaseIdx, detail: undefined } as RunEvent;
}

const fakeRun = { id: "run-1", phases: [{ kind: "brainstorm" }, { kind: "plan" }, { kind: "execute" }] } as unknown as Run;

describe("buildRunTimeline", () => {
    it("groups phase events under their phase and cross-cutting events under RUN", () => {
        const events = [ev("run-created", 1), ev("phase-started", 2, 0), ev("triage", 3), ev("phase-complete", 4, 1)];
        const { groups } = buildRunTimeline(fakeRun, events);
        const runGroup = groups.find((g) => g.id === "run");
        const phase1 = groups.find((g) => g.id === "phase-1");
        const phase2 = groups.find((g) => g.id === "phase-2");
        expect(runGroup?.events.map((e) => e.kind)).toEqual(["triage", "run-created"]);
        expect(phase1?.events.map((e) => e.kind)).toEqual(["phase-started"]);
        expect(phase2?.events.map((e) => e.kind)).toEqual(["phase-complete"]);
    });

    it("preview is the last 3 events overall (newest first)", () => {
        const events = [ev("run-created", 1), ev("phase-started", 2, 0), ev("triage", 3), ev("phase-held", 4, 1)];
        const { preview } = buildRunTimeline(fakeRun, events);
        expect(preview.map((e) => e.kind)).toEqual(["phase-held", "triage", "phase-started"]);
    });

    it("returns empty groups when there are no events", () => {
        const { groups, preview } = buildRunTimeline(fakeRun, []);
        expect(groups).toEqual([]);
        expect(preview).toEqual([]);
    });
});