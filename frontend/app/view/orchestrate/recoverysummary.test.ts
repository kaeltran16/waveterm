// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { recoverySummary, recoveryText } from "./recoverysummary";

function ev(kind: string, detail: Record<string, unknown>, ts: number): RunEvent {
    return { id: `${kind}-${ts}`, runid: "r", channelid: "c", ts, kind, detail: JSON.stringify(detail) } as RunEvent;
}

const retried = (taskid: string, kind: string, attempt: number, ts: number) =>
    ev("task-retried", { taskid, kind, attempt }, ts);
const failed = (taskid: string, lastfailurekind: string, attempts: number, ts: number) =>
    ev("task-failed", { taskid, runid: "child", lastfailurekind, attempts }, ts);

describe("recoverySummary", () => {
    it("says nothing about a task that never failed", () => {
        expect(recoverySummary([ev("task-done", { taskid: "t-1" }, 1)], "t-1")).toBeNull();
        expect(recoverySummary([], "t-1")).toBeNull();
    });

    it("counts only the retries actually retained, for the task asked about", () => {
        const events = [
            retried("t-1", "tool-error", 1, 10),
            retried("t-1", "tool-error", 2, 20),
            retried("t-2", "timeout", 1, 30),
        ];
        expect(recoverySummary(events, "t-1")?.retries).toBe(2);
        expect(recoverySummary(events, "t-2")?.retries).toBe(1);
    });

    it("keeps a failure kind from a row stamped at time zero", () => {
        expect(recoverySummary([retried("t-1", "tool-error", 1, 0)], "t-1")?.lastFailureKind).toBe("tool-error");
        expect(recoverySummary([failed("t-1", "timeout", 1, 0)], "t-1")?.lastFailureKind).toBe("timeout");
    });

    it("takes the newest retry's kind whatever order the rows arrive in, and the first of equal stamps", () => {
        const newestFirst = [retried("t-1", "timeout", 2, 20), retried("t-1", "tool-error", 1, 10)];
        expect(recoverySummary(newestFirst, "t-1")?.lastFailureKind).toBe("timeout");
        const tied = [retried("t-1", "timeout", 1, 10), retried("t-1", "tool-error", 2, 10)];
        expect(recoverySummary(tied, "t-1")?.lastFailureKind).toBe("timeout");
    });

    it("takes the newest terminal failure's kind whatever order the rows arrive in, and the first of equal stamps", () => {
        const newestFirst = [failed("t-1", "context-window", 2, 20), failed("t-1", "timeout", 2, 10)];
        expect(recoverySummary(newestFirst, "t-1")?.lastFailureKind).toBe("context-window");
        const tied = [failed("t-1", "context-window", 2, 10), failed("t-1", "timeout", 2, 10)];
        expect(recoverySummary(tied, "t-1")?.lastFailureKind).toBe("context-window");
    });

    it("ignores another task's terminal failure", () => {
        const events = [retried("t-1", "tool-error", 1, 10), failed("t-2", "timeout", 3, 20)];
        expect(recoverySummary(events, "t-1")).toEqual({
            retries: 1,
            lastFailureKind: "tool-error",
            partial: false,
            terminalFailure: false,
        });
        expect(recoverySummary([failed("t-2", "timeout", 1, 20)], "t-1")).toBeNull();
    });

    it("flags a terminal failure whose attempts the retained retries cannot account for", () => {
        expect(recoverySummary([failed("t-1", "timeout", 3, 10)], "t-1")).toEqual({
            retries: 0,
            lastFailureKind: "timeout",
            partial: true,
            terminalFailure: true,
        });
    });

    it("carries the newest failure kind, not the first one seen", () => {
        const events = [retried("t-1", "tool-error", 1, 10), failed("t-1", "context-window", 2, 20)];
        expect(recoverySummary(events, "t-1")?.lastFailureKind).toBe("context-window");
    });

    // The event log is bounded, so "how many times was this retried" can only ever be answered from
    // what survived. The attempt numbers the surviving rows carry are what expose the gap.
    it("flags history that cannot account for the attempts its own rows record", () => {
        expect(recoverySummary([retried("t-1", "tool-error", 3, 30)], "t-1")?.partial).toBe(true);
    });

    it("does not flag a complete retry history as partial", () => {
        const events = [retried("t-1", "tool-error", 1, 10), retried("t-1", "tool-error", 2, 20)];
        expect(recoverySummary(events, "t-1")?.partial).toBe(false);
    });

    // a terminal failure consumes an attempt without emitting a retry, so attempts legitimately
    // exceeds retries by exactly one
    it("does not flag a terminal failure as missing a retry that never happened", () => {
        expect(recoverySummary([failed("t-1", "timeout", 1, 10)], "t-1")?.partial).toBe(false);
        const events = [retried("t-1", "timeout", 1, 10), failed("t-1", "timeout", 2, 20)];
        expect(recoverySummary(events, "t-1")?.partial).toBe(false);
    });
});

describe("recoveryText", () => {
    it("summarises a recovered retry with its kind and where the task stands now", () => {
        const summary = recoverySummary([retried("t-1", "tool-error", 1, 10)], "t-1")!;
        expect(recoveryText(summary, "running")).toBe("Retried once · tool-error · now running");
    });

    it("pluralises repeated retries", () => {
        const events = [retried("t-1", "timeout", 1, 10), retried("t-1", "timeout", 2, 20)];
        expect(recoveryText(recoverySummary(events, "t-1")!, "done")).toBe("Retried 2 times · timeout · now done");
    });

    it("reports a failure that was never retried as a failure, not a recovery", () => {
        const summary = recoverySummary([failed("t-1", "timeout", 1, 10)], "t-1")!;
        expect(recoveryText(summary, "failed")).toBe("Failed · timeout · now failed");
    });

    it("says so when the history behind the summary is incomplete", () => {
        const summary = recoverySummary([retried("t-1", "tool-error", 4, 40)], "t-1")!;
        expect(recoveryText(summary, "running")).toBe(
            "Retried at least once · tool-error · now running · earlier history not retained"
        );
    });
});
