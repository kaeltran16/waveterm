// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { focusForAgent, focusForRecord, focusForRun } from "./focusfor";
import type { FocusRowVM } from "./focusswitchermodel";

describe("focusForRun", () => {
    it("is null when the focus switcher has no row for the run", () => {
        expect(focusForRun(undefined)).toBeNull();
    });

    it("takes the label and project from the switcher's row", () => {
        const row: FocusRowVM = {
            key: "run:r1",
            kind: "run",
            id: "r1",
            label: "Ship auth",
            detail: "2 agents",
            meta: "arc",
            project: "arc",
        };
        expect(focusForRun(row)).toEqual({ ref: { kind: "run", id: "r1" }, label: "Ship auth", project: "arc" });
    });
});

describe("focusForAgent", () => {
    it("uses the agent's name and project", () => {
        const agent = { id: "tab1", name: "loom", task: "", state: "working", project: "arc" } as AgentVM;
        expect(focusForAgent(agent)).toEqual({ ref: { kind: "agent", id: "tab1" }, label: "loom", project: "arc" });
    });

    it("falls back to the project in the transcript path", () => {
        const agent = {
            id: "tab1",
            name: "loom",
            task: "",
            state: "working",
            transcriptPath: "C:\\Users\\me\\.claude\\projects\\C--src-arc\\s.jsonl",
        } as AgentVM;
        expect(focusForAgent(agent).project).not.toBe("");
    });
});

describe("focusForRecord", () => {
    it("is null for a status the focus drill does not offer", () => {
        expect(focusForRecord({ id: "d1", objective: "ship it", status: "completed" })).toBeNull();
        expect(focusForRecord({ id: "d1", objective: "ship it", status: "archived" })).toBeNull();
    });

    it("focuses an active or paused record as a task, leaving the project alone", () => {
        const want = { ref: { kind: "task", id: "d1" }, label: "ship it", project: "" };
        expect(focusForRecord({ id: "d1", objective: "ship it", status: "active" })).toEqual(want);
        expect(focusForRecord({ id: "d1", objective: "ship it", status: "paused" })).toEqual(want);
    });
});
