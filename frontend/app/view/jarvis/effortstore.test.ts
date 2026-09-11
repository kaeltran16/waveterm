// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { effortChunkRows, effortDetailIsFresh, effortSummaryOf } from "./effortstore";

const effort = {
    oid: "abc",
    version: 3,
    title: "Scenario gate clearance",
    chunks: [
        { label: "P1", status: "done", notes: [{ ts: 1, text: "marked done" }] },
        {
            label: "P3",
            status: "active",
            notes: [
                { ts: 3, text: "resolver seeded" },
                { ts: 2, text: "dry-run pending" },
            ],
        },
        { label: "P5", status: "blocked", notes: [{ ts: 1, text: "blocked on substrate" }] },
    ],
} as unknown as Effort;

describe("effortChunkRows", () => {
    it("derives latest note per chunk and full trails", () => {
        const rows = effortChunkRows(effort);
        expect(rows[0].latestNote).toBe("marked done");
        expect(rows[1].latestNote).toBe("resolver seeded");
        expect(rows[1].trail).toHaveLength(2);
        expect(rows[2].tone).toBe("blocked");
    });
});

describe("effortSummaryOf", () => {
    it("re-derives the wire summary from the full record", () => {
        const full = {
            oid: "abc",
            version: 3,
            title: "Scenario gate clearance",
            status: "active",
            updatedts: 5000,
            chunks: [
                { label: "P1", status: "done", updatedts: 1 },
                { label: "P3", status: "active", updatedts: 2 },
                { label: "P5", status: "skipped", updatedts: 3 },
                { label: "P7", status: "pending", updatedts: 4 },
            ],
        } as unknown as Effort;
        const s = effortSummaryOf(full);
        expect(s.oref).toBe("effort:abc");
        expect(s.done).toBe(1);
        expect(s.total).toBe(4);
        expect(s.activechunk).toBe("P3");
        expect(s.chunks).toEqual([
            { label: "P1", status: "done", owner: undefined },
            { label: "P3", status: "active", owner: undefined },
            { label: "P5", status: "skipped", owner: undefined },
            { label: "P7", status: "pending", owner: undefined },
        ]);
    });

    it("falls back to the first non-done chunk when nothing is active", () => {
        const full = {
            oid: "abc",
            version: 3,
            title: "t",
            status: "active",
            updatedts: 1,
            chunks: [
                { label: "P1", status: "done", updatedts: 1 },
                { label: "P2", status: "pending", updatedts: 2 },
            ],
        } as unknown as Effort;
        expect(effortSummaryOf(full).activechunk).toBe("P2");
    });
});

// The cache used to be fetch-once, so an effort ticked by `wsh effort` or by an agent left the rendered
// rows behind the header count that the briefing keeps fresh. The briefing's updatedts is the tie-break.
describe("effortDetailIsFresh", () => {
    const cached = { updatedts: 100 } as Effort;

    it("is stale when the briefing reports the effort newer than the cached copy", () => {
        expect(effortDetailIsFresh(cached, 101)).toBe(false);
    });

    it("is fresh at or ahead of the reported timestamp, so a steady briefing costs no refetch", () => {
        expect(effortDetailIsFresh(cached, 100)).toBe(true);
        expect(effortDetailIsFresh(cached, 99)).toBe(true);
    });

    it("is never fresh with nothing cached, whatever the caller knows", () => {
        expect(effortDetailIsFresh(undefined, 100)).toBe(false);
        expect(effortDetailIsFresh(undefined, undefined)).toBe(false);
    });

    // callers with no summary to hand (the expand path) keep the old fetch-once behaviour rather than
    // refetching on every render
    it("trusts any cached copy when no timestamp is offered", () => {
        expect(effortDetailIsFresh(cached, undefined)).toBe(true);
    });
});
