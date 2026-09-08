// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { attentionQueue, type QueueEntry } from "./attentionqueue";

function node(id: string, over: Partial<TaskNode> = {}): TaskNode {
    return { id, label: id.toUpperCase(), state: "pending", ...over } as TaskNode;
}

function row(taskid: string, over: Partial<DagTaskDigest> = {}): DagTaskDigest {
    return { taskid, waitreason: "none", mergestate: "not-required", cleanupstate: "clear", ...over };
}

function queue(tasks: TaskNode[], rows: DagTaskDigest[]): QueueEntry[] {
    const group = { tasks } as TaskGroup;
    const digest = { tasks: rows } as DagStatusDigest;
    return attentionQueue(digest, group);
}

describe("attentionQueue membership", () => {
    it("holds only actionable exceptions and merge-ready work", () => {
        const entries = queue(
            [
                node("t-run", { state: "running", runid: "r1" }),
                node("t-done", { state: "done", runid: "r2" }),
                node("t-fail", { state: "failed", runid: "r3" }),
                node("t-merge", { state: "done", runid: "r4" }),
            ],
            [
                row("t-run"),
                row("t-done", { waitreason: "terminal" }),
                row("t-fail", { waitreason: "failure", humanactions: ["retry", "skip", "escalate"] }),
                row("t-merge", { mergestate: "ready", humanactions: ["resolve-merge"] }),
            ]
        );
        expect(entries.map((e) => e.taskId)).toEqual(["t-fail", "t-merge"]);
    });

    it("skips a task the digest has no row for rather than guessing its condition", () => {
        expect(queue([node("t-fail", { state: "failed", runid: "r1" })], [])).toEqual([]);
    });
});

describe("attentionQueue entry content", () => {
    // Today an ask replaces the row's text entirely, so the one thing that identifies which task is
    // being asked about disappears exactly when the reader needs to act on it.
    it("keeps the task's identity alongside the question it is asking", () => {
        const [entry] = queue(
            [node("t-1", { label: "migrate schema", state: "running", runid: "r1" })],
            [row("t-1", { waitreason: "ask", asksummary: "Which migration order?", humanactions: ["answer"] })]
        );
        expect(entry.label).toBe("migrate schema");
        expect(entry.detail).toBe("Which migration order?");
    });

    it("says an ask is waiting even when its question did not survive", () => {
        const [entry] = queue(
            [node("t-1", { state: "running", runid: "r1" })],
            [row("t-1", { waitreason: "ask", humanactions: ["answer"] })]
        );
        expect(entry.detail).toBe("waiting for an answer");
    });

    it("names the condition for merge, cleanup and plain task failures", () => {
        const entries = queue(
            [
                node("t-merge", { state: "done", runid: "r1" }),
                node("t-clean", { state: "done", runid: "r2" }),
                node("t-stall", { state: "stalled", runid: "r3" }),
            ],
            [row("t-merge", { mergestate: "ready" }), row("t-clean", { cleanupstate: "failed" }), row("t-stall", {})]
        );
        expect(entries.map((e) => e.detail)).toEqual(["merge ready", "cleanup failed", "stalled"]);
    });

    it("carries the digest's own actions rather than reconstructing them from task state", () => {
        const [entry] = queue(
            [node("t-1", { state: "failed", runid: "r1" })],
            [row("t-1", { waitreason: "failure", humanactions: ["retry", "skip", "escalate"] })]
        );
        expect(entry.actions).toEqual(["retry", "skip", "escalate"]);
    });

    // "unavailable actions are not presented as executable" — a row the digest attributes no action to
    // must not sprout one here.
    it("offers no action when the digest attributes none", () => {
        const [entry] = queue([node("t-1", { state: "stalled", runid: "r1" })], [row("t-1", {})]);
        expect(entry.actions).toEqual([]);
    });
});

describe("attentionQueue navigation", () => {
    it("sends asks and failures to the worker, where the answer and the transcript are", () => {
        const entries = queue(
            [node("t-ask", { state: "running", runid: "r1" }), node("t-fail", { state: "failed", runid: "r2" })],
            [row("t-ask", { waitreason: "ask", humanactions: ["answer"] }), row("t-fail", { waitreason: "failure" })]
        );
        expect(entries.map((e) => e.target)).toEqual(["worker", "worker"]);
    });

    it("sends merge and cleanup exceptions to the task, where those actions live", () => {
        const entries = queue(
            [node("t-merge", { state: "done", runid: "r1" }), node("t-clean", { state: "done", runid: "r2" })],
            [row("t-merge", { mergestate: "ready" }), row("t-clean", { cleanupstate: "failed" })]
        );
        expect(entries.map((e) => e.target)).toEqual(["task", "task"]);
    });

    it("never routes to a worker for a task that was never dispatched", () => {
        const [entry] = queue([node("t-1", { state: "failed" })], [row("t-1", { waitreason: "failure" })]);
        expect(entry.target).toBe("task");
        expect(entry.runId).toBeUndefined();
    });
});
