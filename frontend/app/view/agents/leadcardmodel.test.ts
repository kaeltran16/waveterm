// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { isLeadDown, leadMark, runAdjustable } from "./leadcardmodel";
import type { RunInfo } from "./runlineage";

function task(id: string, state: string, over: Partial<TaskNode> = {}): TaskNode {
    return { id, label: `Task ${id}`, state, ...over } as TaskNode;
}

function runInfo(tasks: TaskNode[], digest?: Partial<DagStatusDigest>): RunInfo {
    return {
        runId: "R",
        channelId: "C",
        title: "Session auth",
        project: "arc",
        dag: {
            oid: "D",
            runid: "R",
            parallelism: 3,
            status: "running",
            tasks,
            workerroute: { runtime: "claude", model: "claude-sonnet-4" },
        } as TaskGroup,
        digest: digest as DagStatusDigest | undefined,
    };
}

function ev(kind: string, ts: number, detail?: object): RunEvent {
    return {
        id: `${kind}-${ts}`,
        runid: "R",
        channelid: "C",
        ts,
        kind,
        detail: detail ? JSON.stringify(detail) : undefined,
    };
}

describe("isLeadDown", () => {
    it("is down after a wake failure until a lead launches again", () => {
        expect(isLeadDown([])).toBe(false);
        expect(isLeadDown([ev("lead-wake-failed", 10)])).toBe(true);
        expect(isLeadDown([ev("lead-wake-failed", 10), ev("lead-launched", 20)])).toBe(false);
        expect(isLeadDown([ev("lead-launched", 5), ev("lead-wake-failed", 10)])).toBe(true);
    });
    it("goes by the newest wake failure, whatever order the events arrive in", () => {
        expect(isLeadDown([ev("lead-wake-failed", 10), ev("lead-launched", 15), ev("lead-wake-failed", 20)])).toBe(
            true
        );
        expect(isLeadDown([ev("lead-wake-failed", 20), ev("lead-launched", 15), ev("lead-wake-failed", 10)])).toBe(
            true
        );
    });
    it("is not thrown off by a newer event of another kind", () => {
        expect(isLeadDown([ev("lead-launched", 5), ev("lead-wake-failed", 10), ev("task-done", 30)])).toBe(true);
    });
});

describe("leadMark", () => {
    const leadOf = (over: Partial<AgentVM> = {}) => ({ id: "l", name: "lead", state: "working", ...over }) as AgentVM;
    // runmodel.test.ts builds runComplete's cases the same way: run status + land + dag status
    const ended = (status: string, dagStatus: string, land?: RunLand): RunInfo => {
        const r = runInfo([task("t-1", "done")]);
        return { ...r, status, land, dag: { ...r.dag!, status: dagStatus } };
    };
    const MUTED = { tone: "muted", pulse: false };
    it("is green and still only when the run is complete", () => {
        expect(leadMark(ended("done", "done", { state: "landed" } as RunLand), leadOf({ state: "idle" }))).toEqual({
            tone: "success",
            pulse: false,
        });
        expect(leadMark(ended("done", "done"), leadOf({ state: "working" }))).toEqual({
            tone: "success",
            pulse: false,
        });
    });
    it("is green for a run its lead finished without a dag", () => {
        const dagless: RunInfo = { runId: "R", channelId: "C", title: "t", project: "arc", status: "done" };
        expect(leadMark({ ...dagless, land: { state: "landed" } as RunLand }, leadOf({ state: "idle" }))).toEqual({
            tone: "success",
            pulse: false,
        });
    });
    it("is not green for a cancelled run, a lead wrapping up, or a held land", () => {
        expect(leadMark(ended("cancelled", "cancelled"), leadOf({ state: "idle" }))).toEqual(MUTED);
        expect(leadMark(ended("finalizing", "done"), leadOf({ state: "working" }))).toEqual({
            tone: "accent",
            pulse: true,
        });
        expect(leadMark(ended("done", "done", { state: "held" } as RunLand), leadOf({ state: "idle" }))).toEqual(MUTED);
    });
    it("is accent and still while the engine works without its lead", () => {
        const STILL_ACCENT = { tone: "accent", pulse: false };
        expect(leadMark(runInfo([task("t-1", "running")]), undefined)).toEqual(STILL_ACCENT);
        expect(leadMark(runInfo([task("t-1", "reviewing")]), leadOf({ atPrompt: true }))).toEqual(STILL_ACCENT);
    });
    it("is muted when neither the lead nor the engine works", () => {
        expect(leadMark(runInfo([task("t-1", "pending")]), undefined)).toEqual(MUTED);
        expect(leadMark(runInfo([task("t-1", "failed")]), leadOf({ atPrompt: true }))).toEqual(MUTED);
    });
    it("pulses accent while working and warning while asking", () => {
        const run = runInfo([task("t-1", "running")]);
        expect(leadMark(run, leadOf({ state: "working" }))).toEqual({ tone: "accent", pulse: true });
        expect(leadMark(run, leadOf({ state: "asking" }))).toEqual({ tone: "warning", pulse: true });
        expect(leadMark(run, leadOf({ state: "idle" }))).toEqual(MUTED);
    });
    it("is error and still for a lead that failed to start, unless the run is complete", () => {
        const failed = leadOf({ state: "working", startError: "error getting block: not found" });
        expect(leadMark(runInfo([task("t-1", "running")]), failed)).toEqual({ tone: "error", pulse: false });
        expect(leadMark(ended("done", "done", { state: "landed" } as RunLand), failed)).toEqual({
            tone: "success",
            pulse: false,
        });
        expect(leadMark(runInfo([task("t-1", "running")]), leadOf({ state: "working" }))).toEqual({
            tone: "accent",
            pulse: true,
        });
    });
});

describe("runAdjustable", () => {
    it("adjusts an engine run until it finishes", () => {
        expect(runAdjustable(runInfo([]))).toBe(true);
        expect(runAdjustable({ ...runInfo([]), dag: { ...runInfo([]).dag, status: "done" } })).toBe(false);
        expect(runAdjustable({ ...runInfo([]), dag: undefined })).toBe(false);
    });
});
