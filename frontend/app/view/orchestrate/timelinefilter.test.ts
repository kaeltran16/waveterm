// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    ATTENTION_KINDS,
    eventClickTarget,
    filterEvents,
    TIMELINE_RAIL_MIN_PX,
    timelineLayout,
} from "./timelinefilter";

function ev(kind: string, detail?: Record<string, unknown>, ts = 1): RunEvent {
    return {
        id: `${kind}-${ts}`,
        runid: "run-1",
        channelid: "ch-1",
        ts,
        kind,
        detail: detail == null ? undefined : JSON.stringify(detail),
    };
}

describe("filterEvents", () => {
    const events = [
        ev("task-spawned", { taskid: "t-0" }, 1),
        ev("child-ask", { taskid: "t-1" }, 2),
        ev("task-done", { taskid: "t-1" }, 3),
        ev("dag-done", undefined, 4),
    ];

    it("all keeps every event", () => {
        expect(filterEvents(events, "all")).toHaveLength(4);
    });

    it("task keeps only the selected task's events", () => {
        expect(filterEvents(events, "task", "t-1").map((e) => e.kind)).toEqual(["child-ask", "task-done"]);
    });

    it("task with no selection keeps nothing rather than silently falling back to all", () => {
        expect(filterEvents(events, "task")).toEqual([]);
    });

    it("attention keeps only the exception kinds", () => {
        expect(filterEvents(events, "attention").map((e) => e.kind)).toEqual(["child-ask"]);
    });

    it("attention covers asks, gates, failures, blocked merges, failed cleanup, hand-offs and failed wakes", () => {
        for (const kind of [
            "child-ask",
            "dag-gate-open",
            "phase-held",
            "task-failed",
            "task-stalled",
            "dag-blocked",
            "task-merge-blocked",
            "task-cleanup-failed",
            "task-forwarded",
            "lead-wake-failed",
        ]) {
            expect(ATTENTION_KINDS.has(kind), kind).toBe(true);
        }
    });

    it("a wake that landed is not attention", () => {
        expect(ATTENTION_KINDS.has("lead-woken")).toBe(false);
    });

    it("a failed Verify is attention; a passing one is not", () => {
        expect(ATTENTION_KINDS.has("task-verify-failed")).toBe(true);
        expect(ATTENTION_KINDS.has("task-verify-passed")).toBe(false);
    });

    it("a resolved ask is not attention", () => {
        expect(ATTENTION_KINDS.has("child-answered")).toBe(false);
        expect(ATTENTION_KINDS.has("child-ask-cleared")).toBe(false);
    });
});

describe("eventClickTarget", () => {
    it("routes worker-scoped kinds to the worker", () => {
        expect(eventClickTarget(ev("task-spawned", { taskid: "t-0" }))).toEqual({ kind: "worker", taskId: "t-0" });
        expect(eventClickTarget(ev("child-ask", { taskid: "t-2" }))).toEqual({ kind: "worker", taskId: "t-2" });
    });

    it("routes gate kinds to the gate action", () => {
        expect(eventClickTarget(ev("dag-gate-open", { taskid: "t-3" }))).toEqual({ kind: "gate", taskId: "t-3" });
    });

    it("routes merge kinds to merge state", () => {
        expect(eventClickTarget(ev("task-merge-blocked", { taskid: "t-4" }))).toEqual({ kind: "merge", taskId: "t-4" });
    });

    it("routes Verify rows to merge state", () => {
        expect(eventClickTarget(ev("task-verify-failed", { taskid: "t-6" }))).toEqual({ kind: "merge", taskId: "t-6" });
    });

    it("routes cleanup kinds to the dag task", () => {
        expect(eventClickTarget(ev("task-cleanup-failed", { taskid: "t-5" }))).toEqual({
            kind: "dag-task",
            taskId: "t-5",
        });
    });

    it("routes a hand-off to the dag task", () => {
        expect(eventClickTarget(ev("task-forwarded", { taskid: "t-6", askid: "a-1", note: "yours" }))).toEqual({
            kind: "dag-task",
            taskId: "t-6",
        });
    });

    it("routes child completion to the child run", () => {
        expect(eventClickTarget(ev("child-done", { childrunid: "r-9" }))).toEqual({ kind: "child-run", runId: "r-9" });
    });

    it("routes evidence to the evidence block", () => {
        expect(eventClickTarget(ev("evidence-sealed"))).toEqual({ kind: "evidence" });
    });

    it("has no target when the row carries no id to route on", () => {
        expect(eventClickTarget(ev("task-spawned"))).toEqual({ kind: "none" });
        expect(eventClickTarget(ev("child-done"))).toEqual({ kind: "none" });
        expect(eventClickTarget(ev("dag-done"))).toEqual({ kind: "none" });
    });
});

describe("timelineLayout", () => {
    it("keeps the rail beside the graph when there is room for both", () => {
        expect(timelineLayout(1600)).toBe("rail");
        expect(timelineLayout(TIMELINE_RAIL_MIN_PX)).toBe("rail");
    });

    it("collapses history into a drawer once the graph would be squeezed", () => {
        expect(timelineLayout(TIMELINE_RAIL_MIN_PX - 1)).toBe("drawer");
        expect(timelineLayout(800)).toBe("drawer");
    });

    it("treats an unmeasured width as wide rather than flapping to a drawer on the first frame", () => {
        expect(timelineLayout(0)).toBe("rail");
    });
});
