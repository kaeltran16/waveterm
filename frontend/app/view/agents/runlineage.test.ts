// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    formatLeft,
    laneLabel,
    leadAgentOf,
    runProgress,
    runRoleOf,
    runTitle,
    workerAsk,
    workerSubtext,
} from "./runlineage";

const dag = {
    oid: "dag-1",
    runid: "lead-run",
    title: "",
    tasks: [{ id: "t-1", runid: "child-run", state: "running" }],
} as TaskGroup;

describe("runRoleOf", () => {
    it("reads the dag's owning run as the lead", () => {
        const run = { oid: "lead-run", dagoref: "dag:dag-1", mode: "orchestrator" } as Run;
        expect(runRoleOf(run, dag)).toEqual({ kind: "lead", runId: "lead-run" });
    });

    it("reads a task's child run as a worker of the lead run", () => {
        const run = { oid: "child-run", dagoref: "dag:dag-1", mode: "quick" } as Run;
        expect(runRoleOf(run, dag)).toEqual({ kind: "worker", leadRunId: "lead-run", taskId: "t-1" });
    });

    it("drops a child run no task points at any more", () => {
        expect(runRoleOf({ oid: "old-attempt", dagoref: "dag:dag-1", mode: "quick" } as Run, dag)).toBeNull();
    });

    it("reads an orchestrator run with no dag yet as a lead, and a Quick run as nothing", () => {
        expect(runRoleOf({ oid: "planning", mode: "orchestrator" } as Run, undefined)).toEqual({
            kind: "lead",
            runId: "planning",
        });
        expect(runRoleOf({ oid: "quick", mode: "quick" } as Run, undefined)).toBeNull();
        expect(runRoleOf(undefined, undefined)).toBeNull();
    });
});

describe("run facts", () => {
    it("titles a run by its plan, else its goal's first line", () => {
        expect(runTitle({ goal: "ignored" } as Run, { title: "Resource linking" } as TaskGroup)).toBe(
            "Resource linking"
        );
        expect(runTitle({ goal: "Link resources\nacross surfaces" } as Run, undefined)).toBe("Link resources");
        expect(runTitle(undefined, undefined)).toBe("Orchestrator run");
    });

    it("letters lanes in plan order", () => {
        const digest = { lanes: [["t-1", "t-3"], ["t-2"]] } as DagStatusDigest;
        expect(laneLabel(digest, "t-3")).toBe("A");
        expect(laneLabel(digest, "t-2")).toBe("B");
        expect(laneLabel(digest, "t-9")).toBeUndefined();
        expect(laneLabel(undefined, "t-1")).toBeUndefined();
    });

    it("says who holds a task's question", () => {
        const digest = {
            tasks: [
                { taskid: "t-1", waitreason: "lead-ask", askdeadline: 5000 },
                { taskid: "t-2", waitreason: "ask" },
                { taskid: "t-3", waitreason: "none" },
            ],
        } as DagStatusDigest;
        expect(workerAsk(digest, "t-1")).toEqual({ owner: "lead", deadline: 5000 });
        expect(workerAsk(digest, "t-2")).toEqual({ owner: "you" });
        expect(workerAsk(digest, "t-3")).toBeUndefined();
    });

    it("writes a worker's second line from its question, else its lane and age", () => {
        expect(workerSubtext({ owner: "lead", deadline: 481_000 }, "A", "4m", 1_000)).toBe(
            "lead is answering · 8m left"
        );
        expect(workerSubtext({ owner: "lead" }, "A", "4m", 0)).toBe("lead is answering");
        expect(workerSubtext({ owner: "you" }, "A", "4m", 0)).toBe("waiting on you");
        expect(workerSubtext(undefined, "B", "6m", 0)).toBe("lane B · 6m");
        expect(workerSubtext(undefined, undefined, "6m", 0)).toBe("6m");
        expect(formatLeft(59_000)).toBe("<1m left");
    });

    it("finds the roster agent leading a run", () => {
        const lineage = {
            roles: { w: { kind: "worker", leadRunId: "r1", taskId: "t-1" }, l: { kind: "lead", runId: "r1" } },
            runs: {},
        } as const;
        const agents = [{ id: "w" }, { id: "l" }];
        expect(leadAgentOf(lineage, agents, "r1")).toEqual({ id: "l" });
        expect(leadAgentOf(lineage, agents, "r2")).toBeUndefined();
    });

    it("counts done and skipped tasks as finished", () => {
        const tasks = [{ state: "done" }, { state: "skipped" }, { state: "running" }] as TaskNode[];
        expect(runProgress({ tasks } as TaskGroup)).toEqual({ done: 2, total: 3 });
        expect(runProgress(undefined)).toEqual({ done: 0, total: 0 });
    });
});
