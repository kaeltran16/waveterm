// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { focusCardView } from "./workspacerunfocuscardmodel";

const task = (state: string, extra: Partial<TaskNode> = {}): TaskNode => ({
    id: "t-4",
    label: "stats",
    state,
    ...extra,
});

const evidence = (paths: string[]): RunEvidence =>
    ({
        files: paths.map((path) => ({ path, add: 32, del: 0 })),
        addtotal: 64,
        deltotal: 1,
    }) as RunEvidence;

const ask: DagAskItem = {
    taskid: "t-3",
    owner: "lead",
    questions: [{ question: "Should a trailing slash count as a duplicate?" }, { question: "And the scheme?" }],
} as DagAskItem;

const base = { waitsOn: [], finished: false };

describe("focusCardView", () => {
    it("running with a worker run: its step and Open agent, no changes without evidence", () => {
        const v = focusCardView({ ...base, task: task("running", { runid: "run-4" }) });
        expect(v.step).toBe(true);
        expect(v.actions).toEqual({ changes: null, diff: null });
        expect(v.question).toBeNull();
        expect(v.starts).toBeNull();
        expect(v.asked).toBe(false);
    });

    it("reviewing with evidence of 2 files: Open changes on the first file and the diff stat", () => {
        const v = focusCardView({
            ...base,
            task: task("reviewing", { runid: "run-5" }),
            evidence: evidence(["web/list.tsx", "web/list.css"]),
        });
        expect(v.step).toBe(false);
        expect(v.actions).toEqual({ changes: "web/list.tsx", diff: { files: "2 files", adds: 64, dels: 1 } });
    });

    it("one changed file reads 1 file", () => {
        const v = focusCardView({ ...base, task: task("merged", { runid: "r" }), evidence: evidence(["a.go"]) });
        expect(v.actions?.diff?.files).toBe("1 file");
    });

    it("asked: the ask's first question and Open agent, no step, the warning border", () => {
        const v = focusCardView({ ...base, task: task("running", { id: "t-3", runid: "run-3" }), ask });
        expect(v.question).toBe("Should a trailing slash count as a duplicate?");
        expect(v.step).toBe(false);
        expect(v.asked).toBe(true);
        expect(v.actions).toEqual({ changes: null, diff: null });
    });

    it.each([
        { name: "two unmet deps", waitsOn: ["t-3", "t-4"], finished: false, starts: "Starts once t-3 and t-4 merge." },
        { name: "one unmet dep", waitsOn: ["t-3"], finished: false, starts: "Starts once t-3 merges." },
        {
            name: "three unmet deps",
            waitsOn: ["t-1", "t-3", "t-4"],
            finished: false,
            starts: "Starts once t-1, t-3 and t-4 merge.",
        },
        { name: "none unmet", waitsOn: [], finished: false, starts: "Starts once a worker is free." },
        { name: "a finished run", waitsOn: ["t-3"], finished: true, starts: "Never started." },
    ])("waits, $name: $starts and no actions", ({ waitsOn, finished, starts }) => {
        const v = focusCardView({ task: task("pending"), waitsOn, finished });
        expect(v.starts).toBe(starts);
        expect(v.actions).toBeNull();
        expect(v.step).toBe(false);
    });

    it("failed with a worker run and evidence: Open agent and Open changes, no step", () => {
        const v = focusCardView({ ...base, task: task("failed", { runid: "run-6" }), evidence: evidence(["a.go"]) });
        expect(v.step).toBe(false);
        expect(v.actions?.changes).toBe("a.go");
    });
});
