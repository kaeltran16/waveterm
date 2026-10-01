// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { runTiming } from "./runtiming";

const MIN = 60_000;
const LAUNCH = 1_700_000_000_000;

function at(minutes: number): number {
    return LAUNCH + minutes * MIN;
}

function act(key: string, from: number, to?: number): DagTimingActivity {
    return { key, startts: at(from), endts: to == null ? undefined : at(to) };
}

function run(status: string): Run {
    return { status, createdts: LAUNCH } as Run;
}

function digest(timing: DagTimingDigest | undefined): DagStatusDigest {
    return { timing } as DagStatusDigest;
}

function task(id: string, state: string): TaskNode {
    return { id, state };
}

const COMPLETED: DagTimingDigest = {
    startts: LAUNCH,
    endts: at(42),
    activities: [
        act("planning", 0, 8),
        act("execution", 8, 32),
        act("review", 18, 34),
        act("merge", 20, 34),
        act("final", 34, 41),
        act("landing", 41, 42),
    ],
};

// the prototype's running sheet at 30m, with the merge this plan adds already under way
const LIVE: DagTimingDigest = {
    startts: LAUNCH,
    activities: [act("planning", 0, 8), act("execution", 8), act("review", 18), act("merge", 20)],
};

const LIVE_TASKS = [task("t-1", "done"), task("t-2", "done"), task("t-3", "running"), task("t-4", "reviewing")];

describe("runTiming", () => {
    it("lays a completed run's six activities on the since-launch axis", () => {
        const view = runTiming({ run: run("done"), digest: digest(COMPLETED), tasks: [], nowMs: at(99) });
        expect(view.header).toBe("Finished in 42m");
        expect(view.axis).toEqual(["0m", "21m", "42m"]);
        expect(view.defaultOpen).toBe(true);
        expect(view.summary).toEqual([]);
        expect(view.rows.map((r) => r.key)).toEqual(["planning", "execution", "review", "merge", "final", "landing"]);
        expect(view.rows.map((r) => r.label)).toEqual([
            "Planning",
            "Execution",
            "Task review",
            "Merge & Verify",
            "Final verification",
            "Landing / wrap-up",
        ]);
        expect(view.rows.map((r) => r.duration)).toEqual(["8m", "24m", "16m", "14m", "7m", "1m"]);
        const spans = [
            [0, 8],
            [8, 32],
            [18, 34],
            [20, 34],
            [34, 41],
            [41, 42],
        ];
        view.rows.forEach((r, i) => {
            expect(r.left).toBeCloseTo((spans[i][0] / 42) * 100);
            expect(r.width).toBeCloseTo(((spans[i][1] - spans[i][0]) / 42) * 100);
            expect(r.open).toBe(false);
        });
        expect(view.notes).toEqual([
            "Elapsed since launch. Activities overlap; do not add these rows.",
            "Longest activity: execution, 24m. This is not summed worker time.",
        ]);
    });

    it("grows a live run's open activities to now and says what is left", () => {
        const view = runTiming({ run: run("running"), digest: digest(LIVE), tasks: LIVE_TASKS, nowMs: at(30) });
        expect(view.header).toBe("30m elapsed");
        expect(view.axis).toEqual(["0m", "15m", "30m"]);
        expect(view.defaultOpen).toBe(false);
        expect(view.rows.map((r) => r.open)).toEqual([false, true, true, true]);
        for (const r of view.rows.filter((r) => r.open)) {
            expect(r.left + r.width).toBeCloseTo(100);
        }
        expect(view.rows.map((r) => r.duration)).toEqual(["8m", "22m", "12m", "10m"]);
        expect(view.summary).toEqual([
            "Task 3 is the last task still executing.",
            "Its review and final verification are still ahead.",
        ]);
        expect(view.notes).toEqual([
            "Elapsed since launch. Activities overlap; do not add these rows.",
            "Review and merge & Verify have overlapped execution. Final verification has not started.",
        ]);
    });

    it("says a task is merely executing while others still wait", () => {
        const tasks = [task("t-1", "running"), task("t-2", "pending")];
        const view = runTiming({ run: run("running"), digest: digest(LIVE), tasks, nowMs: at(30) });
        expect(view.summary[0]).toBe("Task 1 is executing.");
    });

    it("names several executing tasks together", () => {
        const tasks = [task("t-3", "running"), task("t-4", "stalled")];
        const view = runTiming({ run: run("running"), digest: digest(LIVE), tasks, nowMs: at(30) });
        expect(view.summary).toEqual([
            "Tasks 3 and 4 are executing.",
            "Their review and final verification are still ahead.",
        ]);
    });

    it("has no summary when no task is executing", () => {
        const tasks = [task("t-1", "done"), task("t-2", "reviewing")];
        const view = runTiming({ run: run("running"), digest: digest(LIVE), tasks, nowMs: at(30) });
        expect(view.summary).toEqual([]);
    });

    it("ends a cancelled run at its own end, never at now", () => {
        const timing: DagTimingDigest = {
            startts: LAUNCH,
            endts: at(12),
            activities: [act("planning", 0, 4), act("execution", 4, 12)],
        };
        const view = runTiming({ run: run("cancelled"), digest: digest(timing), tasks: LIVE_TASKS, nowMs: at(99) });
        expect(view.header).toBe("Ended after 12m");
        expect(view.axis).toEqual(["0m", "6m", "12m"]);
        expect(view.summary).toEqual([]);
        expect(view.defaultOpen).toBe(true);
        expect(view.notes[1]).toBe("Longest activity: execution, 8m. This is not summed worker time.");
    });

    it("shows a planning-only live run as one open row", () => {
        const timing: DagTimingDigest = { startts: LAUNCH, activities: [act("planning", 0)] };
        const view = runTiming({ run: run("running"), digest: digest(timing), tasks: [], nowMs: at(5) });
        expect(view.rows).toHaveLength(1);
        expect(view.rows[0]).toMatchObject({ key: "planning", left: 0, open: true, duration: "5m" });
        expect(view.rows[0].width).toBeCloseTo(100);
        expect(view.notes[1]).toBe("Execution, review, merge & Verify and final verification have not started.");
    });

    it("gives a zero-length activity a visible width", () => {
        const timing: DagTimingDigest = {
            ...COMPLETED,
            activities: [...COMPLETED.activities.slice(0, 5), act("landing", 42, 42)],
        };
        const view = runTiming({ run: run("done"), digest: digest(timing), tasks: [], nowMs: at(99) });
        const landing = view.rows.find((r) => r.key === "landing");
        expect(landing.width).toBeGreaterThan(0);
        expect(landing.left + landing.width).toBeLessThanOrEqual(100);
    });

    it("notes a pruned boundary", () => {
        const view = runTiming({
            run: run("done"),
            digest: digest({ ...COMPLETED, partial: true }),
            tasks: [],
            nowMs: at(99),
        });
        expect(view.notes).toContain("Some early boundaries were pruned; rows may start late.");
    });

    it("returns null without timing", () => {
        expect(runTiming({ run: run("running"), digest: digest(undefined), tasks: [], nowMs: at(1) })).toBeNull();
        expect(runTiming({ run: run("running"), digest: undefined, tasks: [], nowMs: at(1) })).toBeNull();
    });
});
