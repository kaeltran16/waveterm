// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentEntry } from "./agentsviewmodel";
import type { RunInfo } from "./runlineage";
import { STRIP_MAX } from "./runstrip";
import {
    answeredAsks,
    finalRow,
    headStrip,
    latestSteps,
    leadAskView,
    planReviewRow,
    runHead,
    runTabCounts,
    spendLine,
    taskBody,
    taskDots,
    taskRows,
} from "./workspaceruntabmodel";

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
const ASKING_DIGEST_FOR = (taskid: string) =>
    ({ tasks: [{ taskid, waitreason: "ask", mergestate: "", cleanupstate: "" }] }) as DagStatusDigest;

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
    it("lists each task's answered questions by task; a task-forwarded between ask and answer makes it yours", () => {
        const events = [
            event("e1", "child-ask", NOW - 9 * MIN, { taskid: "t-2", question: "Count untagged bookmarks?" }),
            event("e2", "child-answered", NOW - 8 * MIN, { taskid: "t-2" }),
            event("e3", "child-ask", NOW - 4 * MIN, { taskid: "t-1", question: "Keep the notes?" }),
            event("e4", "task-forwarded", NOW - 3.5 * MIN, { taskid: "t-1", askid: "a-1", note: "taken over" }),
            event("e5", "child-answered", NOW - 3 * MIN, { taskid: "t-1" }),
        ];
        expect(answeredAsks(events)).toEqual({
            "t-1": [{ key: "e3", question: "Keep the notes?", answeredTs: NOW - 3 * MIN, by: "you" }],
            "t-2": [{ key: "e1", question: "Count untagged bookmarks?", answeredTs: NOW - 8 * MIN, by: "the lead" }],
        });
    });

    it("a task asked twice lists both, newest last; a forward on another task or before the ask does not count", () => {
        const events = [
            event("e0", "task-forwarded", NOW - 10 * MIN, { taskid: "t-1" }),
            event("e1", "child-ask", NOW - 9 * MIN, { taskid: "t-1", question: "First?" }),
            event("e2", "task-forwarded", NOW - 8.5 * MIN, { taskid: "t-2" }),
            event("e3", "child-answered", NOW - 8 * MIN, { taskid: "t-1" }),
            event("e4", "child-ask", NOW - 4 * MIN, { taskid: "t-1", question: "Second?" }),
            event("e5", "task-forwarded", NOW - 3.5 * MIN, { taskid: "t-1" }),
            event("e6", "child-answered", NOW - 3 * MIN, { taskid: "t-1" }),
        ];
        expect(answeredAsks(events)["t-1"]).toEqual([
            { key: "e1", question: "First?", answeredTs: NOW - 8 * MIN, by: "the lead" },
            { key: "e4", question: "Second?", answeredTs: NOW - 3 * MIN, by: "you" },
        ]);
    });

    it("an open question is not listed as answered, even after a forward", () => {
        const events = [
            event("e1", "child-ask", NOW - 2 * MIN, { taskid: "t-3", question: "Trailing slash?" }),
            event("e2", "task-forwarded", NOW - MIN, { taskid: "t-3" }),
        ];
        expect(answeredAsks(events)).toEqual({});
    });
});

describe("leadAskView", () => {
    const ask = (extra: Partial<DagAskItem> = {}): DagAskItem =>
        ({
            taskid: "t-3",
            askid: "a-3",
            owner: "lead",
            questions: [
                {
                    question: "Trailing slash?",
                    header: "Duplicates",
                    options: [{ label: "Yes, the same URL" }, { label: "No, different URLs" }],
                },
            ],
            ts: NOW - 4 * MIN,
            ...extra,
        }) as DagAskItem;

    it("counts down to the ask's deadline in the head and the take-over line", () => {
        const v = leadAskView(ask({ deadline: NOW + 2 * MIN + 20_000 }), NOW);
        expect(v.who).toBe("t-3 asked the lead");
        expect(v.when).toBe("lead is answering · 2m left");
        expect(v.until).toBe("the lead answers in 2m unless you take over");
        expect(v.questions).toEqual([
            { header: "Duplicates", question: "Trailing slash?", options: "Yes, the same URL · No, different URLs" },
        ]);
    });

    it("no deadline, no countdown", () => {
        const v = leadAskView(ask(), NOW);
        expect(v.when).not.toMatch(/left/);
        expect(v.until).not.toMatch(/\d/);
    });
});

describe("latestSteps", () => {
    const read = (target: string): AgentEntry => ({ kind: "action", verb: "read", target, outcome: "ok" });
    const ran = (command: string, pending = false): AgentEntry =>
        pending
            ? { kind: "action", verb: "ran", target: command, command, pending: true, startedTs: NOW }
            : { kind: "action", verb: "ran", target: command, command, outcome: "ok", durationMs: 200 };

    it("the worker's last steps, oldest first, the running one included", () => {
        const entries: AgentEntry[] = [
            { kind: "user", text: "Build the stats command." },
            read("internal/stats/a.go"),
            read("internal/stats/counters.go"),
            { kind: "message", text: "Now the command." },
            read("cmd/linkshelf/stats.go"),
            ran("go build ./...", true),
        ];
        expect(latestSteps(entries, 3).map((s) => [s.action.target, s.status])).toEqual([
            ["internal/stats/counters.go", "ok"],
            ["cmd/linkshelf/stats.go", "ok"],
            ["go build ./...", "running"],
        ]);
    });

    it("no steps, none", () => {
        expect(latestSteps([{ kind: "user", text: "hi" }], 3)).toEqual([]);
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

const evidence = (files: [string, number, number][], summary = ""): RunEvidence =>
    ({
        capturedts: NOW,
        hash: "h",
        summary,
        files: files.map(([path, add, del]) => ({ path, stat: "M", add, del })),
        addtotal: files.reduce((n, f) => n + f[1], 0),
        deltotal: files.reduce((n, f) => n + f[2], 0),
    }) as RunEvidence;

const T1_EVIDENCE = evidence(
    [
        ["internal/stats/counters.go", 120, 4],
        ["internal/stats/counters_test.go", 64, 8],
    ],
    "## Summary\n\nAdded per-host counters and a `linkshelf stats` backend, with 9 tests."
);

describe("taskRows", () => {
    it("the Main board: each row's dot, its state word (none on merged and plainly running rows), time and diffs", () => {
        const dag = dagOf(
            MAIN.tasks.map((t) =>
                t.id === "t-2"
                    ? { ...t, verifystartedts: NOW - 40_000 }
                    : t.id === "t-4"
                      ? { ...t, spawnedts: NOW - 100_000 }
                      : t
            )
        );
        const digest = {
            ...MAIN_DIGEST,
            durations: {
                elapsedms: 0,
                tasks: [
                    { taskid: "t-1", runms: 2 * MIN },
                    { taskid: "t-2", runms: 3 * MIN },
                    { taskid: "t-6", runms: 2 * MIN },
                ],
            },
        } as DagStatusDigest;
        const rows = taskRows(dag, digest, NOW, { "t-1": T1_EVIDENCE });
        expect(rows.map((r) => [r.id, r.dot, r.state, r.time, r.adds, r.dels])).toEqual([
            ["t-1", "merged", "", "2m", 184, 12],
            ["t-2", "working", "verifying 40s", "3m", undefined, undefined],
            ["t-3", "asked", "asked the lead", "—", undefined, undefined],
            ["t-4", "working", "", "1m", undefined, undefined],
            ["t-5", "working", "reviewing", "—", undefined, undefined],
            ["t-6", "failed", "failed", "2m", undefined, undefined],
            ["t-7", "waits", "waits on t-3, t-4", "", undefined, undefined],
            ["t-8", "waits", "queued", "", undefined, undefined],
        ]);
    });

    it("a question with you, a done task awaiting merge, and a label-less task named by its id", () => {
        const dag = dagOf([
            task("t-1", "a", "running", { spawnedts: NOW - 5 * MIN }),
            task("t-2", "b", "done"),
            task("t-3", "", "ready"),
        ]);
        expect(taskRows(dag, ASKING_DIGEST_FOR("t-1"), NOW).map((r) => [r.name, r.sub, r.dot, r.state])).toEqual([
            ["a", "t-1", "asked", "asking you"],
            ["b", "t-2", "working", "done"],
            ["t-3", "", "waits", "queued"],
        ]);
    });

    it("a dep done but not merged still counts as met; one with no evidence change shows no diff", () => {
        const dag = dagOf([task("t-1", "a", "done"), task("t-2", "b", "pending", { deps: ["t-1"] })]);
        const rows = taskRows(dag, undefined, NOW, { "t-1": evidence([]) });
        expect(rows.map((r) => [r.state, r.adds])).toEqual([
            ["done", undefined],
            ["queued", undefined],
        ]);
    });

    it("no dag, no rows", () => {
        expect(taskRows(undefined, undefined, NOW)).toEqual([]);
    });
});

describe("stage rows", () => {
    it("Plan review reads the dag's plan review: passed, reviewing, failed; none with no plan review", () => {
        expect(planReviewRow(MAIN, [], NOW)).toBeNull();
        const at = (state: string) => planReviewRow({ ...MAIN, planreview: { state, round: 1 } }, [], NOW);
        expect(at("passed")).toMatchObject({ label: "Plan review", dot: "merged", word: "passed" });
        expect(at("reviewing")).toMatchObject({ dot: "working", word: "reviewing" });
        expect(at("failed")).toMatchObject({ dot: "failed", word: "failed" });
    });

    it("Plan review times the stage from its first reviewer to its last verdict, or to now while reviewing", () => {
        const started = (ts: number, role = "plan-reviewer") => event(`s-${ts}`, "stage-session-started", ts, { role });
        const reviewed = (ts: number, state: string) => event(`r-${ts}`, "plan-reviewed", ts, { state });
        const at = (state: string, events: RunEvent[]) =>
            planReviewRow({ ...MAIN, planreview: { state, round: 2 } }, events, NOW)?.time;
        const twoRounds = [
            started(NOW - 9 * MIN),
            reviewed(NOW - 8 * MIN, "failed"),
            started(NOW - 6 * MIN),
            reviewed(NOW - 5 * MIN, "passed"),
        ];
        expect(at("passed", twoRounds)).toBe("4m");
        expect(at("reviewing", [started(NOW - 2 * MIN)])).toBe("2m");
        expect(at("passed", [started(NOW - 30 * MIN, "verifier"), reviewed(NOW - MIN, "passed")])).toBe("");
        expect(at("passed", [])).toBe("");
    });

    it("Final verification waits for every task until the stage starts", () => {
        expect(finalRow(MAIN, [], NOW)).toMatchObject({
            label: "Final verification",
            dot: "waits",
            word: "waits for every task",
        });
    });

    it("passed reads its scenarios from the stage's shots, or just passed with none", () => {
        const shots = Array.from({ length: 6 }, (_, i) => ({ name: `s-${i}`, files: [] }));
        const passed = (final: FinalStage) => finalRow({ ...MAIN, final }, [], NOW);
        expect(passed({ state: "passed", round: 1, shots })).toMatchObject({
            dot: "merged",
            word: "passed · 6 scenarios",
        });
        expect(passed({ state: "passed", round: 1 })).toMatchObject({ dot: "merged", word: "passed" });
        expect(passed({ state: "failed", round: 1 })).toMatchObject({ dot: "failed", word: "failed" });
    });

    it("a running stage names its running step: final.state verifying is the verifier session", () => {
        const row = finalRow({ ...MAIN, final: { state: "verifying", round: 1, startedts: NOW - MIN } }, [], NOW);
        expect(row.dot).toBe("working");
        expect(row.word).toBe("Verifier");
    });

    it("no tasks, no Final verification row", () => {
        expect(finalRow(dagOf([]), [], NOW)).toBeNull();
        expect(finalRow(undefined, [], NOW)).toBeNull();
    });
});

describe("taskBody", () => {
    // 16:19 and 16:20 local, so the clock reads the same in any zone
    const ANSWERED_AT = new Date(2026, 10, 17, 16, 19).getTime();
    const MERGED_AT = new Date(2026, 10, 17, 16, 20).getTime();
    const EVENTS = [
        event("e1", "child-ask", ANSWERED_AT - MIN, { taskid: "t-1", question: "Untagged?" }),
        event("e2", "child-answered", ANSWERED_AT, { taskid: "t-1" }),
        event("e3", "task-review-passed", MERGED_AT - 10_000, { taskid: "t-1" }),
        event("e4", "task-merged", MERGED_AT, { taskid: "t-1" }),
        event("e5", "task-merged", MERGED_AT, { taskid: "t-2" }),
    ];
    const ctx = (extra: Partial<Parameters<typeof taskBody>[1]> = {}) => ({
        dag: { ...MAIN, verify: "go test ./..." },
        digest: MAIN_DIGEST,
        evidence: {},
        events: EVENTS,
        now: NOW,
        live: true,
        ...extra,
    });
    const byId = (id: string, extra: Partial<TaskNode> = {}) => ({ ...MAIN.tasks.find((t) => t.id === id), ...extra });

    it("a merged task: its report's headline, its files, review passed and merged at, Open changes on its first file", () => {
        const body = taskBody(byId("t-1", { runid: "r-1" }), ctx({ evidence: { "t-1": T1_EVIDENCE } }));
        expect(body.lead).toBe("Added per-host counters and a linkshelf stats backend, with 9 tests.");
        expect(body.files.map((f) => [f.path, f.add, f.del])).toEqual([
            ["internal/stats/counters.go", 120, 4],
            ["internal/stats/counters_test.go", 64, 8],
        ]);
        expect(body.merged).toBe("review passed · merged 16:20");
        expect(body.changes).toBe("internal/stats/counters.go");
        expect(body.ran).toBeUndefined();
        expect(body.failure).toBe("");
    });

    it("a task's answered questions: who answered and when, with the question; a task never asked has none", () => {
        const body = taskBody(byId("t-1"), ctx());
        expect(body.asked).toEqual([{ key: "e1", line: "asked · answered by the lead 16:19", question: "Untagged?" }]);
        const forwarded = [...EVENTS, event("f1", "task-forwarded", ANSWERED_AT - 30_000, { taskid: "t-1" })];
        expect(taskBody(byId("t-1"), ctx({ events: forwarded })).asked[0].line).toBe("asked · answered by you 16:19");
        expect(taskBody(byId("t-2"), ctx()).asked).toEqual([]);
    });

    it("a merged task with no report reads Merged., and one merged with no review event reads only merged at", () => {
        const body = taskBody(byId("t-1", { id: "t-9" }), ctx());
        expect(body.lead).toBe("Merged.");
        expect(body.merged).toBe("");
        expect(body.changes).toBeNull();
        const t2 = taskBody(byId("t-2", { state: "done" }), ctx());
        expect(t2.merged).toBe("merged 16:20");
    });

    it("a merged task verifying: the Verify sentence and its running Ran step, timed from verifystartedts", () => {
        const digest = {
            tasks: [
                {
                    taskid: "t-2",
                    waitreason: "",
                    verifylastline: "ok  linkshelf/internal/importer",
                    mergestate: "",
                    cleanupstate: "",
                },
            ],
        } as DagStatusDigest;
        const body = taskBody(byId("t-2", { verifystartedts: NOW - 40_000 }), ctx({ digest }));
        expect(body.lead).toBe("Merged. The plan's Verify is running in the project checkout.");
        expect(body.ran).toEqual({
            command: "go test ./...",
            time: "40s",
            lastLine: "ok  linkshelf/internal/importer",
        });
        expect(body.merged).toBe("");
    });

    it("a reviewing task: the reviewer sentence, its files, and how long ago the reviewer started", () => {
        const body = taskBody(
            byId("t-5", { reviewspawnedts: NOW - 30_000 }),
            ctx({ evidence: { "t-5": evidence([["web/List.tsx", 148, 22]], "# Report\n\nAdded the list view.") } })
        );
        expect(body.lead).toBe("Finished with a commit. A reviewer is judging it against the task and the spec.");
        expect(body.files.map((f) => f.path)).toEqual(["web/List.tsx"]);
        expect(body.reviewer).toBe("reviewer started 30s ago");
    });

    it("a failed task: its verify output, and the lead deciding while the run is live", () => {
        const out = "--- FAIL: TestPocketImport/tags\nFAIL";
        const t6 = byId("t-6", { verifyerror: "go test failed", verifyoutput: out });
        expect(taskBody(t6, ctx())).toMatchObject({ failure: out, deciding: true, lead: "" });
        expect(taskBody(t6, ctx({ live: false })).deciding).toBe(false);
        expect(taskBody(byId("t-6", { verifyerror: "exit 1" }), ctx()).failure).toBe("exit 1");
    });

    it("a waiting task: its description's first line and what it depends on", () => {
        const t7 = byId("t-7", {
            description: "Runs go test ./... and go vet ./... on the merged tree.\nThen reports.",
        });
        expect(taskBody(t7, ctx())).toMatchObject({
            lead: "Runs go test ./... and go vet ./... on the merged tree.",
            depends: "depends on t-3, t-4",
        });
    });

    it("a running task leads with its description's first line", () => {
        const t4 = byId("t-4", { description: "Groups bookmarks by normalized URL.\nThen dedupes." });
        expect(taskBody(t4, ctx()).lead).toBe("Groups bookmarks by normalized URL.");
    });

    it("waiting for a free worker adds to its depends line; a queued task with no deps and no reason has none", () => {
        const t8 = byId("t-8", { description: "Documents linkshelf stats and its flags." });
        expect(taskBody(t8, ctx()).depends).toBe("depends on t-1 · waits for a free worker");
        const lone = { id: "t-9", state: "ready" } as TaskNode;
        const parallel = {
            tasks: [{ taskid: "t-9", waitreason: "parallelism", mergestate: "", cleanupstate: "" }],
        } as DagStatusDigest;
        expect(taskBody(lone, ctx({ digest: parallel }))).toMatchObject({
            lead: "",
            depends: "waits for a free worker",
        });
        expect(taskBody(lone, ctx()).depends).toBe("");
    });
});
