// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    completeModel,
    dagRunId,
    dagStatusModel,
    finalArgs,
    finalModel,
    fmtElapsed,
    longestChain,
    planReviewModel,
    reviewModel,
    shortSha,
    submitModel,
} from "./dagcards";
import type { TranscriptContext } from "./transcriptcontext";
import { firstWshCall, type WshCall } from "./wshcall";

const callOf = (cmd: string): WshCall => firstWshCall(cmd)!.call;

const task = (id: string, extra: Partial<TaskNode> = {}): TaskNode => ({
    id,
    label: `${id} label`,
    state: "pending",
    ...extra,
});

const group = (tasks: TaskNode[], extra: Partial<TaskGroup> = {}): TaskGroup =>
    ({
        otype: "dag",
        oid: "dag-1",
        version: 1,
        meta: {},
        id: "dag-1",
        runid: "run-1",
        channelid: "ch-1",
        parallelism: 3,
        tasks,
        status: "running",
        failures: 0,
        createdts: 0,
        updatedts: 0,
        ...extra,
    }) as TaskGroup;

const LEAD: TranscriptContext = { role: { kind: "lead", runId: "run-1" } };
const WORKER: TranscriptContext = { role: { kind: "worker", leadRunId: "run-1", taskId: "t-2" } };

const SHA = "720eb1a9c0ffee1234567890abcdef1234567890";

describe("submitModel", () => {
    // t-1 -> t-3 is one lane; t-2 and t-4 (joining t-2 and t-3) are lanes of their own
    const plan = [task("t-1"), task("t-2"), task("t-3", { deps: ["t-1"] }), task("t-4", { deps: ["t-2", "t-3"] })];

    it("lays the plan out by lane with its after edges", () => {
        const m = submitModel(callOf("wsh jarvis dag submit --plan plan.md"), group(plan));
        expect(m.kind).toBe("plan");
        if (m.kind !== "plan") return;
        expect(m.grid.map((row) => row.map((c) => c.id))).toEqual([["t-1", "t-3"], ["t-2"], ["t-4"]]);
        expect(m.grid[0][1].after).toEqual(["t-1"]);
        expect(m.grid[2][0].after).toEqual(["t-2", "t-3"]);
        expect(m.grid[0][0].label).toBe("t-1 label");
        expect([m.tasks, m.lanes, m.longestChain, m.columns]).toEqual([4, 3, 3, 2]);
    });

    it("leaves fix-round tasks out of the plan and carries the plan review", () => {
        const fix = task("t-5", { description: "Fix round 2: this is task 1 of the fix plan at fix.md; re-read it" });
        const m = submitModel(
            callOf("wsh jarvis dag submit --plan plan.md"),
            group([...plan, fix], {
                planreview: {
                    state: "reviewing",
                    round: 1,
                    reviewers: [
                        { lens: "full", state: "reviewing" },
                        { lens: "second", state: "passed" },
                    ],
                },
            })
        );
        if (m.kind !== "plan") throw new Error("not a plan");
        expect(m.tasks).toBe(4);
        expect(m.review?.state).toBe("reviewing");
        expect(m.review?.round).toBe(1);
        expect(m.review?.readers).toHaveLength(1);
    });

    it("is the bare title without the dag", () => {
        const m = submitModel(callOf("wsh jarvis dag submit --plan plan.md"), undefined);
        expect(m).toEqual({ kind: "plan", grid: [], columns: 0 });
    });

    it("with --round takes the newest fix round's tasks and says whether it is the last", () => {
        const fixes = [
            task("t-5", { description: "Fix round 2: this is task 1 of the fix plan at a.md" }),
            task("t-6", { description: "Fix round 3: this is task 1 of the fix plan at b.md" }),
            task("t-7", { description: "Fix round 3: this is task 2 of the fix plan at b.md" }),
        ];
        const m = submitModel(
            callOf("wsh jarvis dag submit --round --plan fix.md"),
            group([...plan, ...fixes], { maxfinalrounds: 3 })
        );
        expect(m).toEqual({
            kind: "round",
            round: 3,
            last: true,
            tasks: [
                { id: "t-6", label: "t-6 label" },
                { id: "t-7", label: "t-7 label" },
            ],
        });
        const earlier = submitModel(
            callOf("wsh jarvis dag submit --round --plan fix.md"),
            group([...plan, fixes[0]], { maxfinalrounds: 3 })
        );
        expect(earlier.kind === "round" && earlier.round).toBe(2);
        expect(earlier.kind === "round" && earlier.last).toBe(false);
    });

    it("a fix round on a dag without the limit is never the last", () => {
        const fix = task("t-6", { description: "Fix round 3: this is task 1 of the fix plan at b.md" });
        const m = submitModel(callOf("wsh jarvis dag submit --round --plan fix.md"), group([...plan, fix]));
        expect(m.kind === "round" && m.round).toBe(3);
        expect(m.kind === "round" && m.last).toBe(false);
    });
});

describe("longestChain", () => {
    it("counts the tasks on the longest path", () => {
        expect(longestChain([task("a"), task("b", { deps: ["a"] }), task("c", { deps: ["b"] }), task("d")])).toBe(3);
        expect(longestChain([])).toBe(0);
    });
});

describe("reviewModel", () => {
    it("takes the verdict and note from argv and the task from the reviewer's role", () => {
        const m = reviewModel(callOf(`wsh jarvis dag review pass "matches the plan"`), WORKER, undefined);
        expect(m).toEqual({
            taskId: "t-2",
            passed: true,
            round: undefined,
            total: undefined,
            note: "matches the plan",
        });
    });

    it("a send-back reads its round from the task and its total from the dag", () => {
        const g = group([task("t-2", { reviewround: 1 })], { maxreviewrounds: 2 });
        const m = reviewModel(callOf(`wsh jarvis dag review fail "fix the guard"`), WORKER, g);
        expect(m.passed).toBe(false);
        expect([m.round, m.total]).toEqual([1, 2]);
        expect(m.note).toBe("fix the guard");
    });

    it("has no total on a dag without the limit", () => {
        const g = group([task("t-2", { reviewround: 1 })]);
        const m = reviewModel(callOf(`wsh jarvis dag review fail "fix the guard"`), WORKER, g);
        expect([m.round, m.total]).toEqual([1, undefined]);
    });

    it("has no task without a role", () => {
        expect(reviewModel(callOf("wsh jarvis dag review fail x"), {}, undefined).taskId).toBeUndefined();
    });
});

describe("planReviewModel", () => {
    it("maps each verdict", () => {
        expect(planReviewModel(callOf(`wsh jarvis dag planreview pass "ok"`))).toEqual({
            verdict: "passed",
            tone: "pass",
            text: "ok",
        });
        expect(planReviewModel(callOf(`wsh jarvis dag planreview fail "two gaps"`)).tone).toBe("fail");
        expect(planReviewModel(callOf(`wsh jarvis dag planreview accept "human said go"`)).verdict).toBe("accepted");
    });
});

describe("finalModel", () => {
    const stages = {
        pastfinals: [{ state: "failed", round: 1, commit: "3a7f1c2aaaa", detail: "arrow lags" }],
        final: {
            state: "passed",
            round: 2,
            commit: "59c03d0bbbb",
            detail: "all good",
            unverified: ["verifier: no Windows box"],
        },
    };

    it("reads the verdict and text from argv", () => {
        expect(finalArgs(callOf(`wsh jarvis dag final pass "all good"`))).toEqual({ passed: true, text: "all good" });
        expect(finalArgs(callOf(`wsh jarvis dag final fail "two defects"`)).passed).toBe(false);
    });

    it("finds the stage it judged by its text, its total from the dag", () => {
        const g = group([], { ...stages, maxfinalrounds: 3 });
        const m = finalModel({ passed: false, text: "arrow lags" }, g, (_g, r) => r === 1);
        expect([m.round, m.total, m.sha, m.hasShots]).toEqual([1, 3, "3a7f1c2", true]);
        expect(m.unverified).toEqual([]);
    });

    it("has no total on a dag without the limit", () => {
        const m = finalModel({ passed: false, text: "arrow lags" }, group([], stages));
        expect([m.round, m.total]).toEqual([1, undefined]);
    });

    it("falls back to the current stage and carries its unverified lines", () => {
        const m = finalModel({ passed: true, text: "reworded" }, group([], stages));
        expect([m.round, m.sha, m.hasShots]).toEqual([2, "59c03d0", false]);
        expect(m.unverified).toEqual(["verifier: no Windows box"]);
    });

    it("keeps what the caller passed, and is argv alone without the dag", () => {
        expect(
            finalModel({ passed: true, round: 4, sha: "abc1234", text: "x" }, group([], stages)).total
        ).toBeUndefined();
        const bare = finalModel({ passed: true, text: "x" }, undefined);
        expect(bare).toEqual({
            passed: true,
            round: undefined,
            total: undefined,
            sha: undefined,
            text: "x",
            unverified: [],
            hasShots: false,
        });
    });
});

describe("completeModel", () => {
    const status = (g: TaskGroup, extra: Partial<DagStatusDigest> = {}): CommandDagStatusRtnData => ({
        group: g,
        digest: {
            dagversion: 1,
            health: "done",
            counts: { total: 4, done: 4 } as DagStatusCounts,
            next: { kind: "terminal" },
            tasks: [],
            durations: { elapsedms: 2_378_000 },
            report: {
                workerms: 0,
                commits: [
                    { taskid: "t-1", commit: SHA },
                    { taskid: "t-2", commit: SHA },
                ],
                answered: 0,
                forwarded: 1,
            },
            ...extra,
        },
    });
    const run = (extra: Partial<Run>): Run => ({ otype: "run", oid: "run-1", id: "run-1", ...extra }) as Run;

    it("is a worker's task from its role, with the literal --commit", () => {
        const m = completeModel(
            callOf(`wsh jarvis complete --commit ${SHA} --report r.md`),
            WORKER,
            undefined,
            undefined
        );
        expect(m).toEqual({ kind: "task", taskId: "t-2", sha: "720eb1a", dagId: undefined });
    });

    it("a worker's unexpanded --commit falls back to the task's commit, and links the dag", () => {
        const g = group([task("t-2", { reviewcommit: "abcdef0123" })]);
        const m = completeModel(
            callOf(`wsh jarvis complete --commit $(git rev-parse HEAD)`),
            WORKER,
            undefined,
            status(g)
        );
        expect(m).toEqual({ kind: "task", taskId: "t-2", sha: "abcdef0", dagId: "dag-1" });
    });

    it("is the lead's run, landed, with its stats", () => {
        const g = group([task("t-1"), task("t-2"), task("t-3"), task("t-4")], { failures: 1 });
        const m = completeModel(
            callOf("wsh jarvis complete --report r.md"),
            LEAD,
            run({ land: { state: "landed", commit: "c72b9fa1234" }, basebranch: "main" }),
            status(g)
        );
        expect(m).toEqual({
            kind: "run",
            runId: "run-1",
            land: "landed",
            sha: "c72b9fa",
            base: "main",
            stats: { tasks: 4, failures: 1, elapsedMs: 2_378_000, commits: 2, questions: 1 },
        });
    });

    it("is held from the run's land state, forcing only past a failed Final", () => {
        const failedFinal = group([], { final: { state: "failed", round: 3 } });
        const held = completeModel(
            callOf("wsh jarvis complete --report r.md"),
            LEAD,
            run({ land: { state: "held", reason: "the final stage failed" }, landpath: "/wt/run-1" }),
            status(failedFinal)
        );
        expect(held.kind === "run" && [held.land, held.reason, held.branch, held.landLine]).toEqual([
            "held",
            "the final stage failed",
            "wave/run-1",
            "wsh runs land run-1 --force",
        ]);
        const dirty = completeModel(
            callOf("wsh jarvis complete --report r.md"),
            LEAD,
            run({ land: { state: "held", reason: "uncommitted changes" } }),
            undefined
        );
        expect(dirty.kind === "run" && [dirty.branch, dirty.landLine, dirty.stats]).toEqual([
            undefined,
            "wsh runs land run-1",
            undefined,
        ]);
    });

    it("is argv alone when the run is missing", () => {
        const m = completeModel(callOf(`wsh jarvis complete --commit ${SHA}`), LEAD, undefined, undefined);
        expect(m).toEqual({ kind: "run", runId: "run-1", land: "unknown", sha: "720eb1a", stats: undefined });
        const noRole = completeModel(callOf("wsh jarvis complete"), {}, undefined, undefined);
        expect(noRole).toEqual({ kind: "run", runId: undefined, land: "unknown", sha: undefined, stats: undefined });
    });
});

describe("dagStatusModel", () => {
    const NOW = 1_000_000;
    const fmt = (ms: number) => `${ms / 1000}s`;
    const g = group([
        task("t-1", { state: "done", merged: true }),
        task("t-2", { state: "running", firstactivity: NOW - 250_000 }),
        task("t-3", { state: "reviewing", lastactivity: NOW - 131_000 }),
        task("t-4", { state: "running" }),
        task("t-5", { state: "pending", deps: ["t-2", "t-1"] }),
        task("t-6", { state: "review-failed" }),
    ]);
    const rtn: CommandDagStatusRtnData = {
        group: g,
        digest: {
            dagversion: 1,
            health: "healthy",
            counts: { total: 6, done: 1 } as DagStatusCounts,
            next: { kind: "dispatch" },
            tasks: [{ taskid: "t-4", waitreason: "ask", mergestate: "", cleanupstate: "" }],
            durations: { elapsedms: 0 },
            report: { workerms: 0, commits: [{ taskid: "t-1", commit: SHA }], answered: 0, forwarded: 0 },
        },
    };

    it("has the header counts and one row per task state", () => {
        const m = dagStatusModel(rtn, undefined, NOW, fmt);
        expect([m.status, m.done, m.total, m.parallelism]).toEqual(["running", 1, 6, 3]);
        expect(m.rows.map((r) => [r.id, r.pill, r.right])).toEqual([
            ["t-1", "landed", "720eb1a"],
            ["t-2", "running", "250s"],
            ["t-3", "review", "idle 131s"],
            ["t-4", "asks", undefined],
            ["t-5", "queued", "after t-2"],
            ["t-6", "failed", undefined],
        ]);
    });

    it("shows only the task the call named", () => {
        expect(dagStatusModel(rtn, "t-3", NOW, fmt).rows.map((r) => r.id)).toEqual(["t-3"]);
    });
});

describe("fmtElapsed", () => {
    it("reads minutes and seconds under an hour, hours and minutes past it", () => {
        expect(fmtElapsed(39 * 60_000 + 38_000)).toBe("39m 38s");
        expect(fmtElapsed(161 * 60_000)).toBe("2h 41m");
    });
});

describe("argv helpers", () => {
    it("shortSha takes literal hashes only", () => {
        expect(shortSha(SHA)).toBe("720eb1a");
        expect(shortSha("$(git rev-parse HEAD)")).toBeUndefined();
        expect(shortSha(true)).toBeUndefined();
    });

    it("dagRunId prefers the role's run, else --runid", () => {
        expect(dagRunId(callOf("wsh jarvis dag status --runid r9"), WORKER)).toBe("run-1");
        expect(dagRunId(callOf("wsh jarvis dag status --runid r9"), {})).toBe("r9");
    });
});
