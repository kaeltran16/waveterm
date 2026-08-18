// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { artifactsOf, buildRunTimeline, clickTargetFor, joinWorkspacePath, toneFor } from "./runtimeline";

function ev(kind: string, ts: number, phaseIdx?: number): RunEvent {
    return {
        id: "e" + ts,
        runid: "run-1",
        channelid: "ch",
        ts,
        kind,
        phaseidx: phaseIdx,
        detail: undefined,
    } as RunEvent;
}

const fakeRun = {
    id: "run-1",
    phases: [{ kind: "brainstorm" }, { kind: "plan" }, { kind: "execute" }],
} as unknown as Run;

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

describe("clickTargetFor", () => {
    it("maps phase-held to approve-gate and child events to select-child", () => {
        expect(clickTargetFor(ev("phase-held", 4, 1))).toEqual({ kind: "approve-gate", phaseIdx: 1 });
        const childEv = { ...ev("child-done", 5), detail: JSON.stringify({ childrunid: "run-9", goal: "t" }) };
        expect(clickTargetFor(childEv)).toEqual({ kind: "select-child", childRunId: "run-9" });
    });

    it("maps stalled/blocked to open-dag and evidence-sealed to open-diff", () => {
        const stalled = { ...ev("task-stalled", 6), detail: JSON.stringify({ taskid: "t-2" }) };
        expect(clickTargetFor(stalled)).toEqual({ kind: "open-dag", taskId: "t-2" });
        expect(clickTargetFor(ev("evidence-sealed", 7))).toEqual({ kind: "open-diff" });
    });

    it("returns none for unhandled kinds", () => {
        expect(clickTargetFor(ev("run-created", 1))).toEqual({ kind: "none" });
    });
});

describe("artifactsOf", () => {
    it("extracts the first artifact from detail", () => {
        const e = { ...ev("phase-complete", 4, 1), detail: JSON.stringify({ artifacts: ["deliverable.md"] }) };
        expect(artifactsOf(e)).toEqual(["deliverable.md"]);
    });

    it("is empty when detail has no artifacts", () => {
        expect(artifactsOf(ev("phase-complete", 4, 1))).toEqual([]);
    });
});

describe("toneFor", () => {
    it("stays within the existing tone utilities and falls back to muted", () => {
        expect(toneFor("phase-started")).toBe("text-success");
        expect(toneFor("task-stalled")).toBe("text-warning");
        expect(toneFor("unknown-kind")).toBe("text-muted");
    });
});

describe("joinWorkspacePath", () => {
    it("joins a workspace-relative path onto the project path and passes absolute paths through", () => {
        expect(joinWorkspacePath("/repo/a", "docs/x.md")).toBe("/repo/a/docs/x.md");
        expect(joinWorkspacePath("C:\\repo", "docs\\x.md")).toBe("C:\\repo\\docs\\x.md");
        expect(joinWorkspacePath("/repo", "/abs/x.md")).toBe("/abs/x.md");
        expect(joinWorkspacePath("/repo", "C:\\abs\\x.md")).toBe("C:\\abs\\x.md");
    });
});
