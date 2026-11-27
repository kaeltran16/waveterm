// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { taskTabView, type TaskTabInput } from "./workspacetaskmodel";

// local clock times, so a time reads the same in any zone
const at = (h: number, m: number) => new Date(2026, 10, 27, h, m).getTime();
const NOW = at(15, 30);
const MIN = 60_000;

const event = (id: string, kind: string, ts: number, detail: Record<string, unknown>): RunEvent =>
    ({ id, runid: "run-1", channelid: "ch-1", kind, ts, detail: JSON.stringify(detail) }) as RunEvent;

const T4: TaskNode = {
    id: "t-4",
    label: "cmd/linkshelf stats command",
    description: "Add a `linkshelf stats` subcommand.",
    deps: ["t-1"],
    state: "done",
    merged: true,
    runid: "child-t-4",
    attempts: 2,
};

const DAG = {
    oid: "dag-1",
    id: "dag-1",
    runid: "run-1",
    channelid: "ch-1",
    parallelism: 4,
    status: "done",
    failures: 0,
    createdts: NOW - 30 * MIN,
    updatedts: NOW,
    verify: "go test ./...",
    tasks: [
        { id: "t-1", label: "internal/stats counters", state: "done", merged: true },
        T4,
        { id: "t-7", label: "go test and go vet", deps: ["t-3", "t-4"], state: "done", merged: true },
    ],
} as TaskGroup;

const CHILD = {
    otype: "run",
    oid: "child-t-4",
    id: "child-t-4",
    model: "claude-opus-5-5",
    endcommit: "9d2e4b1c0ffee",
    evidence: {
        files: [
            { path: "cmd/linkshelf/stats.go", stat: "M", add: 39, del: 1 },
            { path: "cmd/linkshelf/stats_test.go", stat: "A", add: 25, del: 0 },
        ],
        addtotal: 64,
        deltotal: 1,
        runtimems: 9 * MIN,
    },
} as unknown as Run;

const DIGEST = { durations: { tasks: [{ taskid: "t-4", runms: 6 * MIN + 12_000 }] } } as DagStatusDigest;

// 400k tokens of opus on t-4, and a row of another task's that must not count
const USAGE: UsageRow[] = [
    {
        role: "worker",
        taskid: "t-4",
        model: "claude-opus-5-5",
        input: 100_000,
        output: 20_000,
        cacheread: 270_000,
        cachewrite: 10_000,
        cachewrite1h: 0,
        msgs: 9,
    },
    {
        role: "worker",
        taskid: "t-1",
        model: "claude-opus-5-5",
        input: 900_000,
        output: 0,
        cacheread: 0,
        cachewrite: 0,
        cachewrite1h: 0,
        msgs: 1,
    },
];

const input = (extra: Partial<TaskTabInput> = {}): TaskTabInput => ({
    task: T4,
    dag: DAG,
    digest: DIGEST,
    child: CHILD,
    usage: USAGE,
    events: [],
    ...extra,
});

describe("taskTabView header", () => {
    it("names the task, says Merged, and lists id, attempts, run time, model, tokens, cost and the merge commit", () => {
        const v = taskTabView(input());
        expect(v.title).toBe("cmd/linkshelf stats command");
        expect(v.state.word).toBe("Merged");
        const parts = v.meta.split(" · ");
        expect(parts.slice(0, 5)).toEqual(["t-4", "2 attempts", "6m 12s", "Opus 5.5", "400k tokens"]);
        expect(parts[5]).toMatch(/^~\$\d+\.\d\d$/);
        expect(parts[6]).toBe("9d2e4b1");
        expect(parts).toHaveLength(7);
    });

    it("leaves out each part it does not know", () => {
        const bare: TaskNode = { id: "t-4", state: "done", merged: true };
        const v = taskTabView(input({ task: bare, digest: undefined, child: undefined, usage: undefined }));
        expect(v.title).toBe("t-4");
        expect(v.meta).toBe("t-4");
    });
});

describe("taskTabView brief", () => {
    it.each([
        ["deps and dependents", T4, "waits on t-1 · then t-7"],
        ["no deps", { ...T4, deps: undefined }, "then t-7"],
        ["neither", { ...T4, id: "t-7", deps: undefined }, ""],
    ])("%s", (_, task, links) => {
        const v = taskTabView(input({ task: task as TaskNode }));
        expect(v.brief.links).toBe(links);
    });

    it("keeps the description whole, for markdown", () => {
        expect(taskTabView(input()).brief.text).toBe("Add a `linkshelf stats` subcommand.");
    });
});

describe("taskTabView asked", () => {
    it("pairs each of the task's questions with its answer by askid; an unanswered one has no answer", () => {
        const events = [
            event("e1", "child-ask", at(14, 40), { taskid: "t-4", askid: "a-1", question: "Count archived?" }),
            event("e2", "child-ask", at(14, 41), { taskid: "t-4", askid: "a-2", question: "Sort by count?" }),
            event("e3", "child-ask", at(14, 42), { taskid: "t-1", askid: "a-3", question: "Not t-4's" }),
            event("e4", "child-answered", at(14, 47), { taskid: "t-4", askid: "a-1", answer: "No, only active ones." }),
        ];
        expect(taskTabView(input({ events })).asked).toEqual([
            { key: "e1", question: "Count archived?", answer: "No, only active ones.", meta: "lead 14:47" },
            { key: "e2", question: "Sort by count?", answer: null, meta: "" },
        ]);
    });

    it("an answer after a forward of the task is yours", () => {
        const events = [
            event("e1", "child-ask", at(14, 40), { taskid: "t-4", askid: "a-1", question: "Count archived?" }),
            event("e2", "task-forwarded", at(14, 41), { taskid: "t-4", askid: "a-1" }),
            event("e3", "child-answered", at(14, 47), { taskid: "t-4", askid: "a-1", answer: "No." }),
        ];
        expect(taskTabView(input({ events })).asked[0].meta).toBe("you 14:47");
    });

    it("is empty when the task asked nothing", () => {
        expect(taskTabView(input()).asked).toEqual([]);
    });
});

describe("taskTabView review", () => {
    it("one card per round, newest first; a passed round is one more than the failed rounds before it", () => {
        const events = [
            event("e1", "task-review-failed", at(14, 52), { taskid: "t-4", note: "Divides by zero.", round: 1 }),
            event("e2", "task-review-failed", at(14, 53), { taskid: "t-1", note: "Not t-4's", round: 1 }),
            event("e3", "task-review-passed", at(14, 58), { taskid: "t-4", note: "Matches the brief." }),
        ];
        expect(taskTabView(input({ events })).review).toEqual([
            { key: "e3", round: 2, passed: true, time: "14:58", note: "Matches the brief." },
            { key: "e1", round: 1, passed: false, time: "14:52", note: "Divides by zero." },
        ]);
    });

    it.each([
        ["a pass after one failed round", { reviewverdict: "pass", reviewround: 1, reviewnote: "Good." }, 2, true],
        ["a fail on the second round", { reviewverdict: "fail", reviewround: 2, reviewnote: "Still wrong." }, 2, false],
    ])("with no review events, one card from the task's verdict: %s", (_, extra, round, passed) => {
        const v = taskTabView(input({ task: { ...T4, ...extra } }));
        expect(v.review).toEqual([{ key: "verdict", round, passed, time: "", note: extra.reviewnote }]);
    });

    it("is empty with neither events nor a verdict", () => {
        expect(taskTabView(input()).review).toEqual([]);
    });
});

describe("taskTabView verify", () => {
    it("the newest result naming the task in taskid or batch", () => {
        const events = [
            event("e1", "task-verify-failed", at(14, 50), { taskid: "t-4", reason: "tests failed" }),
            event("e2", "task-verify-started", at(14, 59), { taskid: "t-1" }),
            event("e3", "task-verify-passed", at(15, 0), { taskid: "t-1", batch: ["t-1", "t-4"], ms: 410 }),
            event("e4", "task-verify-passed", at(15, 1), { taskid: "t-7", ms: 900 }),
        ];
        expect(taskTabView(input({ events })).verify).toEqual({
            command: "go test ./...",
            result: { ok: true, text: "ok · 0.4s" },
        });
    });

    it("a failure gives its reason", () => {
        const events = [event("e1", "task-verify-failed", at(14, 50), { taskid: "t-4", reason: "tests failed" })];
        expect(taskTabView(input({ events })).verify?.result).toEqual({ ok: false, text: "tests failed" });
    });

    it("with no result for the task, none; with no plan Verify, no section", () => {
        expect(taskTabView(input()).verify).toEqual({ command: "go test ./...", result: null });
        expect(taskTabView(input({ dag: { ...DAG, verify: undefined } })).verify).toBeNull();
    });
});

describe("taskTabView changes", () => {
    it("counts the task's own sealed files and their totals; none without evidence", () => {
        expect(taskTabView(input()).changes).toEqual({ files: "2 files", adds: 64, dels: 1 });
        expect(taskTabView(input({ child: undefined })).changes).toBeNull();
    });
});
