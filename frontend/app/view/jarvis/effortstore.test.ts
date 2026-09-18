// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { effortChunkRows, effortDetailIsFresh } from "./effortstore";

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

    // an effort created with no chunks serializes its nil Go slice as null, and expanding it in the Brief
    // threw during render, which took the whole cockpit down
    it("reads an effort whose chunks came over the wire as null as having none", () => {
        expect(effortChunkRows({ ...effort, chunks: null } as unknown as Effort)).toEqual([]);
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
