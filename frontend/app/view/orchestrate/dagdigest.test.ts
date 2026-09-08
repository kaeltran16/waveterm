// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    acceptDigest,
    controlWarning,
    freshCounts,
    healthView,
    nextStepText,
    nextStepView,
    shouldRefreshDigest,
    digestStale,
    lastUpdatedText,
    type TaskBrief,
} from "./dagdigest";

function digest(version: number): DagStatusDigest {
    return {
        dagversion: version,
        health: "healthy",
        counts: { total: 1, done: 0, running: 1, stalled: 0, dependencywaiting: 0, attention: 0, recoveredretry: 0, mergeready: 0 },
        next: { kind: "dispatch" },
        tasks: [],
        durations: { elapsedms: 0 },
    };
}

describe("acceptDigest", () => {
    it("accepts a response matching the observed version from the newest request", () => {
        expect(acceptDigest(digest(4), 4, 7, 7)).toBe(true);
    });

    it("rejects a response for a stale group version", () => {
        expect(acceptDigest(digest(3), 4, 7, 7)).toBe(false);
    });

    it("rejects an older same-version response after a newer request started", () => {
        expect(acceptDigest(digest(4), 4, 5, 7)).toBe(false);
    });

    it("accepts the newest response even when a request failed in between", () => {
        expect(acceptDigest(digest(4), 4, 9, 9)).toBe(true);
    });
});

describe("shouldRefreshDigest", () => {
    it("refreshes on ask lifecycle events", () => {
        expect(shouldRefreshDigest("child-ask")).toBe(true);
        expect(shouldRefreshDigest("child-answered")).toBe(true);
        expect(shouldRefreshDigest("child-ask-cleared")).toBe(true);
    });

    it("refreshes on lead-control delivery events", () => {
        expect(shouldRefreshDigest("lead-control-sent")).toBe(true);
        expect(shouldRefreshDigest("lead-control-failed")).toBe(true);
        expect(shouldRefreshDigest("lead-control-acknowledged")).toBe(true);
    });

    it("does not refresh on activity ticks or unrelated kinds", () => {
        expect(shouldRefreshDigest(undefined)).toBe(false);
        expect(shouldRefreshDigest("phase-started")).toBe(false);
        expect(shouldRefreshDigest("task-spawned")).toBe(false);
    });
});

describe("nextStepText", () => {
    it("renders each typed next kind deterministically", () => {
        expect(nextStepText({ kind: "human-action", actions: ["approve", "sendback"] })).toBe(
            "waiting on you — approve / sendback"
        );
        expect(nextStepText({ kind: "merge-ready" })).toBe("merge ready for review");
        expect(nextStepText({ kind: "dispatch" })).toBe("dispatching next task");
        expect(nextStepText({ kind: "parallelism-wait" })).toBe("waiting on parallelism limit");
        expect(nextStepText({ kind: "dependency-wait" })).toBe("waiting on dependencies");
        expect(nextStepText({ kind: "cleanup-wait" })).toBe("waiting on worktree cleanup");
        expect(nextStepText({ kind: "terminal", terminalstatus: "done" })).toBe("finished (done)");
    });

    it("falls back to a refresh cue for an unknown kind rather than inventing a claim", () => {
        expect(nextStepText({ kind: "mystery" })).toBe("refreshing status");
    });
});
describe("degradation views (spec 8)", () => {
    const digest = (health: string, control?: ControlDigest): DagStatusDigest =>
        ({
            dagversion: 1,
            health,
            counts: { total: 2, done: 1 } as DagStatusCounts,
            next: { kind: "dispatch" },
            tasks: [],
            durations: { elapsedms: 1000 },
            control,
        }) as DagStatusDigest;

    it("never infers healthy when the digest is unavailable", () => {
        const v = healthView({ loading: false, stale: true, error: "boom" });
        expect(v.text).toBe("DAG status unavailable");
        expect(v.tone).not.toContain("success");
    });

    it("hides a stale health claim behind Refreshing status", () => {
        const v = healthView({ loading: false, stale: true, digest: digest("healthy") });
        expect(v.text).toBe("Refreshing status");
        expect(v.tone).not.toContain("success");
    });

    it("shows the digest health when the digest is fresh", () => {
        expect(healthView({ loading: false, stale: false, digest: digest("needs-you") })).toEqual({
            text: "needs-you",
            tone: "text-warning",
        });
        expect(healthView({ loading: false, stale: false, digest: digest("healthy") }).tone).toBe("text-success");
        expect(healthView({ loading: false, stale: false, digest: digest("stalled") }).tone).toBe("text-error");
    });

    it("hides the next move and counts while the digest is stale", () => {
        const stale = { loading: false, stale: true, digest: digest("healthy") };
        expect(nextStepView(stale)).toBeNull();
        expect(freshCounts(stale)).toBeUndefined();
        const fresh = { loading: false, stale: false, digest: digest("healthy") };
        expect(nextStepView(fresh)).toBe("dispatching next task");
        expect(freshCounts(fresh)?.total).toBe(2);
    });

    it("warns only for control states the human should know about", () => {
        expect(controlWarning(digest("healthy"))).toBeNull();
        expect(controlWarning(digest("healthy", { eventid: "e", kind: "gate_open", status: "acknowledged" }))).toBeNull();
        expect(
            controlWarning(digest("healthy", { eventid: "e", kind: "gate_open", status: "unconfirmed" }))
        ).toContain("not confirmed");
        expect(controlWarning(digest("healthy", { eventid: "e", kind: "gate_open", status: "failed" }))).toContain(
            "failed"
        );
        expect(
            controlWarning(digest("healthy", { eventid: "e", kind: "gate_open", status: "unavailable" }))
        ).toContain("unreachable");
    });
});

// Finding 6: "waiting on dependencies" does not say what has to change. The digest already ships the
// waiting and blocking task ids; the overview just was not reading them.
describe("explicit blockers (finding 6)", () => {
    const briefs = new Map<string, TaskBrief>([
        ["t-a", { label: "scaffold API", state: "done" }],
        ["t-b", { label: "write tests", state: "running" }],
        ["t-c", { label: "ship it", state: "pending" }],
    ]);

    it("names the waiting task and the task it is waiting on", () => {
        expect(nextStepText({ kind: "dependency-wait", taskids: ["t-c"], blockingtaskids: ["t-b"] }, briefs)).toBe(
            "ship it waiting on write tests"
        );
    });

    // a dep that is done yet still blocks its successor is waiting to be integrated, not to finish
    it("distinguishes work still executing from completed work awaiting merge", () => {
        expect(nextStepText({ kind: "dependency-wait", taskids: ["t-c"], blockingtaskids: ["t-a"] }, briefs)).toBe(
            "ship it waiting on scaffold API's merge"
        );
    });

    it("names the tasks holding the parallelism slots", () => {
        expect(nextStepText({ kind: "parallelism-wait", blockingtaskids: ["t-b"] }, briefs)).toBe(
            "waiting for a slot — write tests still running"
        );
    });

    it("names the task a human action is about", () => {
        expect(
            nextStepText({ kind: "human-action", taskids: ["t-a"], actions: ["approve", "sendback"] }, briefs)
        ).toBe("waiting on you — approve / sendback: scaffold API");
    });

    it("names merge-ready and cleanup work rather than describing it generically", () => {
        expect(nextStepText({ kind: "merge-ready", taskids: ["t-a"] }, briefs)).toBe(
            "merge ready for review: scaffold API"
        );
        expect(nextStepText({ kind: "cleanup-wait", taskids: ["t-a"] }, briefs)).toBe(
            "waiting on worktree cleanup: scaffold API"
        );
    });

    it("falls back to the task id when no label is known, never inventing one", () => {
        expect(nextStepText({ kind: "dependency-wait", taskids: ["t-x"], blockingtaskids: ["t-y"] })).toBe(
            "t-x waiting on t-y"
        );
    });

    it("summarises a long list instead of overflowing the line", () => {
        expect(nextStepText({ kind: "dispatch", taskids: ["t-a", "t-b", "t-c"] }, briefs)).toBe(
            "dispatching scaffold API, write tests +1 more"
        );
    });
});

// Finding 7: staleness was a stored flag set when a request *returned*, so a digest for an already
// superseded dag version kept being presented as current for the whole load.
describe("freshness (finding 7)", () => {
    it("is stale the moment the observed dag version moves past it, not when the reload returns", () => {
        expect(digestStale(digest(4), 5)).toBe(true);
        expect(digestStale(digest(4), 4)).toBe(false);
    });

    it("treats a missing digest as unavailable rather than stale", () => {
        expect(digestStale(undefined, 4)).toBe(false);
        expect(healthView({ loading: false, stale: false })).toEqual({
            text: "DAG status unavailable",
            tone: "text-muted",
        });
    });

    it("distinguishes a refresh in flight from one that failed", () => {
        const held = digest(3);
        expect(healthView({ digest: held, stale: true, loading: true }).text).toBe("Refreshing status");
        const failed = healthView({ digest: held, stale: true, loading: false, error: "boom" });
        expect(failed.text).toBe("Status update failed");
        expect(failed.tone).toBe("text-warning");
    });

    it("reports when the shown status was last confirmed current", () => {
        expect(lastUpdatedText({ loading: false, stale: false }, 100_000)).toBeNull();
        const state = { loading: false, stale: false, digest: digest(1), lastUpdatedTs: 40_000 };
        expect(lastUpdatedText(state, 70_000)).toBe("updated 30s ago");
        expect(lastUpdatedText(state, 400_000)).toBe("updated 6m ago");
    });
});
