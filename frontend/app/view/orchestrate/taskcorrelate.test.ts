// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { resolveTaskWorker, workerActivityText, type TaskWorkerView } from "./taskcorrelate";
import type { AgentVM } from "../agents/agentsviewmodel";

function agent(id: string): AgentVM {
    return { id, name: id, task: "", state: "working" };
}

function run(runId: string, workerorefs: string[]): Run {
    return {
        oid: runId,
        id: runId,
        version: 1,
        goal: "g",
        status: "executing",
        createdts: 1,
        phases: [{ kind: "execute", state: "running", workerorefs }],
        meta: {},
    } as Run;
}

describe("resolveTaskWorker", () => {
    it("resolves a dispatched task with its tab and agent", () => {
        const view = resolveTaskWorker({ id: "t-0", runid: "r1" }, run("r1", ["tab:t1"]), [agent("t1")]);
        expect(view).toEqual<TaskWorkerView>({ state: "dispatched", tabId: "t1", runId: "r1", agent: agent("t1") });
    });

    it("reports pending for a task with no child run yet", () => {
        const view = resolveTaskWorker({ id: "t-0" }, undefined, [agent("t1")]);
        expect(view.state).toBe("pending");
        expect(view.tabId).toBeUndefined();
    });

    it("reports unavailable when the child run has no worker oref", () => {
        const view = resolveTaskWorker({ id: "t-0", runid: "r1" }, run("r1", []), [agent("t1")]);
        expect(view).toEqual<TaskWorkerView>({ state: "unavailable", runId: "r1" });
    });

    it("reports unavailable when the worker session is closed (no roster row)", () => {
        const view = resolveTaskWorker({ id: "t-0", runid: "r1" }, run("r1", ["tab:gone"]), [agent("t1")]);
        expect(view.state).toBe("unavailable");
        expect(view.runId).toBe("r1");
        expect(view.agent).toBeUndefined();
    });

    it("never resolves a worker for a run that did not load", () => {
        const view = resolveTaskWorker({ id: "t-0", runid: "r_missing" }, undefined, [agent("t1")]);
        expect(view.state).toBe("unavailable");
        expect(view.runId).toBe("r_missing");
    });
});

describe("workerActivityText", () => {
    it("defers to the agent's own activity when a worker session is reachable", () => {
        expect(workerActivityText({ state: "dispatched", tabId: "t1", agent: agent("t1") })).toBeNull();
    });

    it("says the activity is unavailable rather than showing a fabricated idle state", () => {
        expect(workerActivityText({ state: "pending" })).toBe("Not dispatched yet");
        expect(workerActivityText({ state: "unavailable", runId: "r-1" })).toBe("Activity unavailable");
    });
});
