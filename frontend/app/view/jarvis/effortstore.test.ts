// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { effortChunkRows } from "./effortstore";

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
