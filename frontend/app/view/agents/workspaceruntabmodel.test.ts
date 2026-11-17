// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { RunInfo } from "./runlineage";
import { answeredAsks, runHead, runTabCounts, taskRows } from "./workspaceruntabmodel";

const NOW = Date.UTC(2026, 10, 17, 14, 31, 0);
const MIN = 60_000;
const RUN_ID = "7f3a91c2-0b4d-4e6f-8a1b-2c3d4e5f6a7b";
const PLAN = "docs/superpowers/plans/2026-11-17-stats-dedupe.md";

const task = (id: string, label: string, state: string, extra: Partial<TaskNode> = {}): TaskNode => ({
    id,
    label,
    state,
    ...extra,
});

const dagOf = (tasks: TaskNode[], extra: Partial<TaskGroup> = {}): TaskGroup =>
    ({
        oid: "dag-1",
        id: "dag-1",
        runid: RUN_ID,
        channelid: "ch-1",
        parallelism: 2,
        tasks,
        status: "running",
        failures: 0,
        createdts: NOW - 6 * MIN - 29_000,
        updatedts: NOW,
        planpath: PLAN,
        ...extra,
    }) as TaskGroup;

const runOf = (dag: TaskGroup | undefined, extra: Partial<RunInfo> = {}): RunInfo => ({
    runId: RUN_ID,
    channelId: "ch-1",
    title: "stats and dedupe packages",
    project: "linkshelf",
    status: dag ? "executing" : "planning",
    dag,
    ...extra,
});

const ask = (taskid: string, owner: string): DagAskItem =>
    ({ taskid, askid: `${taskid}-ask`, owner, questions: [], blockoref: "", ts: NOW - MIN }) as DagAskItem;

const event = (id: string, kind: string, ts: number, detail: object): RunEvent =>
    ({ id, runid: RUN_ID, channelid: "ch-1", kind, ts, detail: JSON.stringify(detail) }) as RunEvent;

// the RunTasks board's run: plan review passed, stats merged, dedupe asking you, verify and final not started
const RUNNING = dagOf([
    task("t-1", "plan review", "done", { merged: true }),
    task("t-2", "internal/stats counters", "done", { merged: true }),
    task("t-3", "internal/dedupe groups", "running", { spawnedts: NOW - 3 * MIN, deps: ["t-1"] }),
    task("t-4", "go test and go vet", "pending", { deps: ["t-2", "t-3"] }),
    task("t-5", "final verification", "pending", { deps: ["t-4"] }),
]);
const ASKING_DIGEST = {
    tasks: [{ taskid: "t-3", waitreason: "ask", mergestate: "", cleanupstate: "" }],
} as DagStatusDigest;

describe("runHead", () => {
    it("running with a user ask: Live, the progress line with its plan, and Needs you then the next task", () => {
        const head = runHead(runOf(RUNNING, { digest: ASKING_DIGEST }), [ask("t-3", "user")], NOW);
        expect(head.title).toBe("stats and dedupe packages");
        expect(head.state).toEqual({ text: "Live", tone: "live" });
        expect(head.line).toBe("2/5 tasks · 6m · 7f3a91c2 · plan 2026-11-17-stats-dedupe.md");
        expect(head.needsYou).toEqual({ then: "t-4 · go test and go vet" });
    });

    it("a question the lead holds is not one waiting on you", () => {
        expect(runHead(runOf(RUNNING), [ask("t-3", "lead")], NOW).needsYou).toBeNull();
    });

    it("all merged while the final stage runs: every task counted, still live, nothing waiting", () => {
        const dag = dagOf(
            RUNNING.tasks.map((t) => ({ ...t, state: "done", merged: true })),
            { status: "finalizing" }
        );
        const head = runHead(runOf(dag), [], NOW);
        expect(head.state).toEqual({ text: "Live", tone: "live" });
        expect(head.line).toBe("5/5 tasks · 6m · 7f3a91c2 · plan 2026-11-17-stats-dedupe.md");
        expect(head.needsYou).toBeNull();
    });

    it("no dag yet: the run's own status, its id, and that no plan was submitted", () => {
        const head = runHead(runOf(undefined), [], NOW);
        expect(head.state).toEqual({ text: "Planning", tone: "muted" });
        expect(head.line).toBe("7f3a91c2 · no plan submitted");
        expect(head.needsYou).toBeNull();
    });

    it("done: the settled elapsed time, not the clock since it started", () => {
        const dag = dagOf(
            RUNNING.tasks.map((t) => ({ ...t, state: "done", merged: true })),
            { status: "done", createdts: NOW - 90 * MIN }
        );
        const digest = { next: { kind: "terminal" }, durations: { elapsedms: 12 * MIN } } as DagStatusDigest;
        const head = runHead(runOf(dag, { status: "done", digest }), [], NOW);
        expect(head.state).toEqual({ text: "Done", tone: "done" });
        expect(head.line).toBe("5/5 tasks · 12m · 7f3a91c2 · plan 2026-11-17-stats-dedupe.md");
        expect(head.needsYou).toBeNull();
    });

    it("a cancelled run reads Cancelled, and a dag with no plan file leaves the plan out", () => {
        const dag = dagOf(RUNNING.tasks, { status: "cancelled", planpath: undefined });
        const head = runHead(runOf(dag), [], NOW);
        expect(head.state).toEqual({ text: "Cancelled", tone: "muted" });
        expect(head.line).toBe("2/5 tasks · 6m · 7f3a91c2");
    });
});

describe("answeredAsks", () => {
    it("pairs each question with the answer that followed it, newest answer first", () => {
        const events = [
            event("e1", "child-ask", NOW - 9 * MIN, { taskid: "t-2", question: "Count untagged bookmarks?" }),
            event("e2", "child-answered", NOW - 8 * MIN, { taskid: "t-2" }),
            event("e3", "child-ask", NOW - 4 * MIN, { taskid: "t-1", question: "Keep the notes?" }),
            event("e4", "child-answered", NOW - 3 * MIN, { taskid: "t-1" }),
            event("e5", "child-ask", NOW - MIN, { taskid: "t-3", question: "Trailing slash?" }),
        ];
        expect(answeredAsks(events)).toEqual([
            { key: "e3", taskId: "t-1", question: "Keep the notes?", answeredTs: NOW - 3 * MIN },
            { key: "e1", taskId: "t-2", question: "Count untagged bookmarks?", answeredTs: NOW - 8 * MIN },
        ]);
    });
});

describe("runTabCounts", () => {
    it("counts the tasks, the open and answered questions, and the run's events", () => {
        const events = [
            event("e1", "child-ask", NOW - 9 * MIN, { taskid: "t-2", question: "Count untagged?" }),
            event("e2", "child-answered", NOW - 8 * MIN, { taskid: "t-2" }),
            event("e3", "task-merged", NOW - 7 * MIN, { taskid: "t-2" }),
        ];
        expect(runTabCounts(runOf(RUNNING), [ask("t-3", "user"), ask("t-4", "lead")], events)).toEqual({
            tasks: 5,
            asks: 3,
            activity: 3,
        });
    });

    it("a run with no dag has no tasks", () => {
        expect(runTabCounts(runOf(undefined), [], []).tasks).toBe(0);
    });
});

describe("taskRows", () => {
    it("one row per task in plan order: its state, tone and time", () => {
        const digest = {
            ...ASKING_DIGEST,
            durations: { elapsedms: 0, tasks: [{ taskid: "t-2", runms: 2 * MIN + 51_000 }] },
        } as DagStatusDigest;
        const rows = taskRows(RUNNING, digest, NOW);
        expect(rows.map((r) => [r.id, r.name, r.state, r.tone, r.time])).toEqual([
            ["t-1", "plan review", "merged", "done", "—"],
            ["t-2", "internal/stats counters", "merged", "done", "2m"],
            ["t-3", "internal/dedupe groups", "asking you", "asking", "3m"],
            ["t-4", "go test and go vet", "waits on t-3", "pending", "—"],
            ["t-5", "final verification", "waits on t-4", "pending", "—"],
        ]);
    });

    it("a task the lead answers, a working one, a failed one and a queued one", () => {
        const dag = dagOf([
            task("t-1", "a", "running", { spawnedts: NOW - 5 * MIN }),
            task("t-2", "b", "running", { spawnedts: NOW - MIN }),
            task("t-3", "c", "failed"),
            task("t-4", "", "ready"),
        ]);
        const digest = {
            tasks: [{ taskid: "t-1", waitreason: "lead-ask", mergestate: "", cleanupstate: "" }],
        } as DagStatusDigest;
        expect(taskRows(dag, digest, NOW).map((r) => [r.name, r.sub, r.state, r.tone])).toEqual([
            ["a", "t-1", "asked the lead", "working"],
            ["b", "t-2", "working", "working"],
            ["c", "t-3", "failed", "failed"],
            ["t-4", "", "queued", "pending"],
        ]);
    });

    it("no dag, no rows", () => {
        expect(taskRows(undefined, undefined, NOW)).toEqual([]);
    });
});
