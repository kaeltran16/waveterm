// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

// resume.ts / proactive.ts reach the object service and WOS on their *write* path (dismissal). These tests
// exercise only the synchronous meta reads, so stub the backend layer the way jarvissubjectstore.test.ts does.
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/services", () => ({ ObjectService: {} }));

import { ambientRailFor } from "./ambientrail";

const NOW = 1_700_000_000_000;

const run = (over: Partial<Run> & { meta?: Record<string, unknown> }): Run =>
    ({
        id: "a7c7c6cd-1111-2222-3333-444444444444",
        oid: "a7c7c6cd-1111-2222-3333-444444444444",
        goal: "the goal",
        status: "done",
        meta: {},
        ...over,
    }) as unknown as Run;

const withResume = (over: { id?: string; oid?: string; summary?: string; updated?: number }): Run =>
    run({
        id: over.id ?? "a7c7c6cd-1111-2222-3333-444444444444",
        oid: over.oid ?? over.id ?? "a7c7c6cd-1111-2222-3333-444444444444",
        meta: {
            "jarvis:resume": {
                taskId: "task-1",
                summary: over.summary ?? "Landed the boundary; two call sites still bypass it.",
                status: "completed",
                updated: over.updated ?? NOW,
            },
        },
    });

const withProactive = (): Run =>
    run({
        meta: {
            "jarvis:proactive": {
                status: "hit",
                nodeId: "dec-1",
                sourceType: "decision",
                title: "Drop-oldest on overflow",
                snippet: "chose drop-oldest to bound memory",
                why: "Related to this run",
            },
        },
    });

// No dismissal-atom reset is needed: the optimistic hide lives in the card components, and the derivation
// reads only run.meta — including the persisted dismissed flag, which the last test covers.
describe("ambientRailFor", () => {
    it("gives a sealed run its resume narrative — the case the run body cannot draw", () => {
        const r = withResume({});
        const m = ambientRailFor({ kind: "channel", run: r });
        expect(m?.resumeRun).toBe(r);
    });

    it("keys relevant decisions to the run's oref when the engine has any", () => {
        const r = run({});
        const m = ambientRailFor({ kind: "channel", run: r, hasDecisions: true });
        expect(m?.decisionsORef).toBe("run:a7c7c6cd-1111-2222-3333-444444444444");
    });

    it("gives a run with a hit suggestion its proactive card", () => {
        const r = withProactive();
        expect(ambientRailFor({ kind: "channel", run: r })?.proactiveRun).toBe(r);
    });

    it("is absent rather than empty when a run carries nothing at all", () => {
        expect(ambientRailFor({ kind: "channel", run: run({}) })).toBeNull();
    });

    it("is absent on a channel with no resolved run", () => {
        expect(ambientRailFor({ kind: "channel", run: null, hasDecisions: true })).toBeNull();
    });

    it("picks a record's most recent narrative by its updated stamp", () => {
        const older = withResume({ id: "11111111-1111-1111-1111-111111111111", updated: NOW - 5000 });
        const newest = withResume({ id: "22222222-2222-2222-2222-222222222222", updated: NOW });
        const middle = withResume({ id: "33333333-3333-3333-3333-333333333333", updated: NOW - 1000 });
        const m = ambientRailFor({ kind: "dossier", recordRuns: [older, newest, middle] });
        expect(m?.resumeRun).toBe(newest);
    });

    it("shows a record no proactive suggestion — a suggestion is about a dispatch, not a record", () => {
        const m = ambientRailFor({ kind: "dossier", recordRuns: [withResume({}), withProactive()] });
        expect(m?.proactiveRun).toBeNull();
        expect(m?.decisionsORef).toBeNull();
    });

    it("is absent on a record whose runs carry no narrative", () => {
        expect(ambientRailFor({ kind: "dossier", recordRuns: [run({}), withProactive()] })).toBeNull();
    });

    it("is absent on a thread — all three views are run-scoped", () => {
        expect(ambientRailFor({ kind: "conversation" })).toBeNull();
    });

    it("does not count a narrative the user dismissed", () => {
        const r = run({
            meta: {
                "jarvis:resume": { taskId: "t", summary: "s", status: "completed", updated: NOW },
                "jarvis:resume:dismissed": true,
            },
        });
        expect(ambientRailFor({ kind: "channel", run: r })).toBeNull();
    });
});
