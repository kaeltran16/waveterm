// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { RunInfo } from "./runlineage";
import { STRIP_MAX } from "./runstrip";
import { answeredAsks, headStrip, runHead, runTabCounts, spendLine, taskDots, taskRows } from "./workspaceruntabmodel";

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

// the Main board's run: t-1 merged, t-2 merged and verifying, t-3 asking the lead, t-4 working, t-5 reviewing, t-6
// failed, t-7 waiting on t-3 and t-4, t-8 waiting for a free worker
const MAIN = dagOf(
    [
        task("t-1", "internal/stats counters", "done", { merged: true }),
        task("t-2", "internal/importer URL normalizing", "verifying", { merged: true }),
        task("t-3", "internal/dedupe groups", "running", { deps: ["t-1"] }),
        task("t-4", "cmd/linkshelf stats command", "running", { deps: ["t-1"] }),
        task("t-5", "web bookmarks list view", "reviewing"),
        task("t-6", "importer: Pocket export", "failed"),
        task("t-7", "go test and go vet", "pending", { deps: ["t-3", "t-4"] }),
        task("t-8", "docs/cli.md stats section", "ready", { deps: ["t-1"] }),
    ],
    { createdts: NOW - 9 * MIN - 10_000 }
);
const MAIN_DIGEST = {
    tasks: [
        { taskid: "t-3", waitreason: "lead-ask", askdeadline: NOW + 2 * MIN, mergestate: "", cleanupstate: "" },
        { taskid: "t-8", waitreason: "parallelism", mergestate: "", cleanupstate: "" },
    ],
} as DagStatusDigest;
const LAND_COMMIT = "4c1e9a2b7d0e5f3a9c8b6d4e2f1a0b9c8d7e6f5a";

describe("runHead", () => {
    it("the Main board: Live, merged tasks counted (t-2 merged and verifying is one), elapsed, id and plan", () => {
        const head = runHead(runOf(MAIN, { digest: MAIN_DIGEST }), NOW);
        expect(head).toEqual({
            title: "stats and dedupe packages",
            state: { text: "Live", tone: "live" },
            line: "2/8 tasks · 9m · 7f3a91c2 · plan 2026-11-17-stats-dedupe.md",
        });
    });

    it("a task done but not merged yet is not counted", () => {
        const dag = dagOf([task("t-1", "a", "done"), task("t-2", "b", "done", { merged: true })], { planpath: "" });
        expect(runHead(runOf(dag), NOW).line).toBe("1/2 tasks · 6m · 7f3a91c2");
    });

    it("all merged while the final stage runs: every task counted, still live, nothing landed yet", () => {
        const dag = dagOf(
            RUNNING.tasks.map((t) => ({ ...t, state: "done", merged: true })),
            { status: "finalizing" }
        );
        const head = runHead(runOf(dag, { land: { state: "pending", commit: LAND_COMMIT } }), NOW);
        expect(head.state).toEqual({ text: "Live", tone: "live" });
        expect(head.line).toBe("5/5 tasks · 6m · 7f3a91c2 · plan 2026-11-17-stats-dedupe.md");
    });

    it("no dag yet: the run's own status, its id, and that no plan was submitted", () => {
        const head = runHead(runOf(undefined), NOW);
        expect(head.state).toEqual({ text: "Planning", tone: "muted" });
        expect(head.line).toBe("7f3a91c2 · no plan submitted");
    });

    it("done and landed: the settled elapsed time, then the landed commit's short form", () => {
        const dag = dagOf(
            MAIN.tasks.map((t) => ({ ...t, state: "done", merged: true })),
            { status: "done", createdts: NOW - 90 * MIN }
        );
        const digest = { next: { kind: "terminal" }, durations: { elapsedms: 31 * MIN } } as DagStatusDigest;
        const head = runHead(
            runOf(dag, { status: "done", digest, land: { state: "landed", commit: LAND_COMMIT } }),
            NOW
        );
        expect(head.state).toEqual({ text: "Done", tone: "done" });
        expect(head.line).toBe("8/8 tasks · 31m · 7f3a91c2 · plan 2026-11-17-stats-dedupe.md · landed 4c1e9a2");
    });

    it("done with no landed commit names none", () => {
        const dag = dagOf(
            RUNNING.tasks.map((t) => ({ ...t, state: "done", merged: true })),
            { status: "done" }
        );
        const digest = { next: { kind: "terminal" }, durations: { elapsedms: 12 * MIN } } as DagStatusDigest;
        expect(runHead(runOf(dag, { status: "done", digest }), NOW).line).toBe(
            "5/5 tasks · 12m · 7f3a91c2 · plan 2026-11-17-stats-dedupe.md"
        );
    });

    it("a cancelled run reads Cancelled, and a dag with no plan file leaves the plan out", () => {
        const dag = dagOf(RUNNING.tasks, { status: "cancelled", planpath: undefined });
        const head = runHead(runOf(dag), NOW);
        expect(head.state).toEqual({ text: "Cancelled", tone: "muted" });
        expect(head.line).toBe("2/5 tasks · 6m · 7f3a91c2");
    });
});

const usageRow = (model: string, extra: Partial<UsageRow> = {}): UsageRow => ({
    role: "worker",
    model,
    input: 0,
    output: 0,
    cacheread: 0,
    cachewrite: 0,
    cachewrite1h: 0,
    msgs: 1,
    ...extra,
});

describe("spendLine", () => {
    it("joins spend, tokens and worker time when all are known", () => {
        // opus 5.5 per 1M: input $4, output $20, 5m cache write $5, cache read $0.20 -> 0.80 + 1.00 + 0.25 + 0.18
        const rows = [
            usageRow("claude-opus-5-5", { input: 200_000, output: 50_000, cachewrite: 50_000, cacheread: 900_000 }),
        ];
        expect(spendLine(rows, 14 * MIN + 20_000)).toBe("Spent ~$2.23 · Tokens 1.2M · Worker time 14m");
    });

    it("leaves out what is not known: no price, no spend; no worker time reported, none", () => {
        expect(spendLine([usageRow("unpriced-model", { input: 40_000 })], undefined)).toBe("Tokens 40k");
        expect(spendLine(undefined, 3 * MIN)).toBe("Worker time 3m");
    });

    it("null with nothing known", () => {
        expect(spendLine(undefined, undefined)).toBeNull();
        expect(spendLine([], 0)).toBeNull();
    });
});

describe("taskDots", () => {
    it("the Main board: merged, verifying-after-merge working, the lead's question asked, failed, waits", () => {
        expect(taskDots(MAIN, MAIN_DIGEST)).toEqual({
            "t-1": "merged",
            "t-2": "working",
            "t-3": "asked",
            "t-4": "working",
            "t-5": "working",
            "t-6": "failed",
            "t-7": "waits",
            "t-8": "waits",
        });
    });

    it("a question with you is asked too, and a done task awaiting its merge is working", () => {
        const dag = dagOf([task("t-1", "a", "running"), task("t-2", "b", "done")]);
        const digest = {
            tasks: [{ taskid: "t-1", waitreason: "ask", mergestate: "", cleanupstate: "" }],
        } as DagStatusDigest;
        expect(taskDots(dag, digest)).toEqual({ "t-1": "asked", "t-2": "working" });
    });

    it("every failing state is failed; not started, skipped and cancelled wait", () => {
        const dag = dagOf([
            task("t-1", "", "verify-failed"),
            task("t-2", "", "review-failed"),
            task("t-3", "", "blocked-merge"),
            task("t-4", "", "pending"),
            task("t-5", "", "ready"),
            task("t-6", "", "skipped"),
            task("t-7", "", "cancelled"),
        ]);
        expect(Object.values(taskDots(dag, undefined))).toEqual([
            "failed",
            "failed",
            "failed",
            "waits",
            "waits",
            "waits",
            "waits",
        ]);
    });

    it("no dag, no dots", () => {
        expect(taskDots(undefined, undefined)).toEqual({});
    });
});

describe("headStrip", () => {
    it("one segment per task in plan order, from the dots: t-3 is amber as on the Main board", () => {
        expect(headStrip(MAIN, MAIN_DIGEST)).toEqual({
            kind: "segments",
            dots: ["merged", "working", "asked", "working", "working", "failed", "waits", "waits"],
        });
    });

    it("past the strip's limit one bar of merged tasks against the total", () => {
        const tasks = Array.from({ length: STRIP_MAX + 1 }, (_, i) =>
            task(`t-${i + 1}`, "", i < 3 ? "done" : "pending", { merged: i < 3 })
        );
        expect(headStrip(dagOf(tasks), undefined)).toEqual({ kind: "bar", done: 3, total: STRIP_MAX + 1 });
    });

    it("no tasks, no strip", () => {
        expect(headStrip(undefined, undefined)).toBeUndefined();
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
    it("counts the tasks and the run's events, and no questions", () => {
        const events = [
            event("e1", "child-ask", NOW - 9 * MIN, { taskid: "t-2", question: "Count untagged?" }),
            event("e2", "child-answered", NOW - 8 * MIN, { taskid: "t-2" }),
            event("e3", "task-merged", NOW - 7 * MIN, { taskid: "t-2" }),
        ];
        expect(runTabCounts(runOf(RUNNING), events)).toEqual({ tasks: 5, activity: 3 });
    });

    it("a run with no dag has no tasks", () => {
        expect(runTabCounts(runOf(undefined), []).tasks).toBe(0);
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
