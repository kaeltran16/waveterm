// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { acceptDigest, nextStepText, shouldRefreshDigest } from "./dagdigest";

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
        expect(nextStepText({ kind: "terminal", terminalstatus: "done" })).toBe("finished (done)");
    });

    it("falls back to a refresh cue for an unknown kind rather than inventing a claim", () => {
        expect(nextStepText({ kind: "mystery" })).toBe("refreshing status");
    });
});