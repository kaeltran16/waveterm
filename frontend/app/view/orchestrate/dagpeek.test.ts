// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { TaskBrief } from "./dagdigest";
import { taskPeek } from "./dagpeek";

const NOW = 10_000_000;
const MIN = 60_000;

function task(over: Partial<TaskNode>): TaskNode {
    return { id: "t1", state: "pending", ...over };
}

function digest(over: Partial<DagTaskDigest>): DagTaskDigest {
    return { taskid: "t1", waitreason: "none", mergestate: "not-required", cleanupstate: "clear", ...over };
}

const briefs = new Map<string, TaskBrief>([
    ["t0", { label: "Add the schema", state: "running" }],
    ["t2", { label: "Wire the RPC", state: "running" }],
]);

describe("taskPeek", () => {
    it("titles the peek with the label, falling back to the id, and carries the trimmed description", () => {
        expect(
            taskPeek(task({ label: "Build it", description: "  pin the API shape\n" }), undefined, briefs, NOW)
        ).toMatchObject({
            title: "Build it",
            description: "pin the API shape",
        });
        expect(taskPeek(task({}), undefined, briefs, NOW)).toMatchObject({ title: "t1", description: "" });
    });

    it("names what a pending task is waiting on by label", () => {
        const peek = taskPeek(
            task({}),
            digest({ waitreason: "dependency", blockingtaskids: ["t0", "t2"] }),
            briefs,
            NOW
        );
        expect(peek.rows).toEqual([{ text: "waiting on Add the schema, Wire the RPC", tone: "muted" }]);
    });

    it("says a pending task is waiting for a slot, and makes no claim without a digest", () => {
        expect(taskPeek(task({}), digest({ waitreason: "parallelism" }), briefs, NOW).rows).toEqual([
            { text: "waiting for a worker slot", tone: "muted" },
        ]);
        expect(taskPeek(task({}), undefined, briefs, NOW).rows).toEqual([
            { text: "not dispatched yet", tone: "muted" },
        ]);
    });

    it("dates a running task's first and latest transcript activity", () => {
        const peek = taskPeek(
            task({ state: "running", firstactivity: NOW - 12 * MIN, lastactivity: NOW - 40_000 }),
            undefined,
            briefs,
            NOW
        );
        expect(peek.rows).toEqual([{ text: "first activity 12m ago · last 40s ago", tone: "muted" }]);
    });

    it("says no activity was observed for a running task with no stamps, rather than dating nothing", () => {
        expect(taskPeek(task({ state: "running" }), undefined, briefs, NOW).rows).toEqual([
            { text: "no activity observed", tone: "muted" },
        ]);
        expect(taskPeek(task({ state: "done" }), undefined, briefs, NOW).rows).toEqual([]);
    });

    it("tells an ask for the human apart from one the lead holds", () => {
        const mine = taskPeek(
            task({ state: "running" }),
            digest({ waitreason: "ask", asksummary: "Which port?" }),
            briefs,
            NOW
        );
        expect(mine.rows[0]).toEqual({ text: "asked you: Which port?", tone: "warning" });
        const lead = taskPeek(
            task({ state: "running" }),
            digest({ waitreason: "lead-ask", asksummary: "Which port?" }),
            briefs,
            NOW
        );
        expect(lead.rows[0]).toEqual({ text: "asked the lead: Which port?", tone: "warning" });
    });

    it("reports the failure kind with the attempt count once it has repeated", () => {
        expect(taskPeek(task({ state: "failed", lastfailurekind: "exit" }), undefined, briefs, NOW).rows).toEqual([
            { text: "last failure: exit", tone: "warning" },
        ]);
        expect(
            taskPeek(task({ state: "failed", lastfailurekind: "exit", attempts: 3 }), undefined, briefs, NOW).rows
        ).toEqual([{ text: "last failure: exit · attempt 3", tone: "warning" }]);
    });

    it("shows only the first line of a verify, merge or cleanup error", () => {
        const peek = taskPeek(
            task({ state: "verify-failed", verifyerror: "go test failed\n--- FAIL: TestX" }),
            undefined,
            briefs,
            NOW
        );
        expect(peek.rows).toEqual([{ text: "go test failed", tone: "warning" }]);
        expect(
            taskPeek(
                task({ state: "blocked-merge", mergeerror: "conflict in a.go", cleanuperror: "worktree locked" }),
                undefined,
                briefs,
                NOW
            ).rows
        ).toEqual([
            { text: "conflict in a.go", tone: "warning" },
            { text: "worktree locked", tone: "warning" },
        ]);
    });
});
