// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { assignLanes, laneCount, type GraphCommit } from "./gitgraph";

const c = (hash: string, ...parents: string[]): GraphCommit => ({ hash, parents });

describe("assignLanes", () => {
    it("keeps a linear history in one lane", () => {
        const rows = assignLanes([c("a", "b"), c("b", "c"), c("c")]);
        expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
        expect(laneCount(rows)).toBe(1);
    });

    it("puts a side branch in its own lane and rejoins at the merge base", () => {
        // m is a merge of a and b; both descend from c
        const rows = assignLanes([c("m", "a", "b"), c("a", "c"), c("b", "c"), c("c")]);
        expect(rows.map((r) => `${r.hash}:${r.lane}`)).toEqual(["m:0", "a:0", "b:1", "c:0"]);
        expect(laneCount(rows)).toBe(2);
    });

    it("flags merge commits by parent count", () => {
        const rows = assignLanes([c("m", "a", "b"), c("a", "c"), c("b", "c"), c("c")]);
        expect(rows.map((r) => r.merge)).toEqual([true, false, false, false]);
    });

    it("frees a lane at a root commit so a later branch reuses it", () => {
        // two disconnected roots: r1 ends, so r2 takes lane 0 rather than lane 1
        const rows = assignLanes([c("r1"), c("r2")]);
        expect(rows.map((r) => r.lane)).toEqual([0, 0]);
        expect(laneCount(rows)).toBe(1);
    });

    it("holds a lane open for a parent outside the loaded window", () => {
        // 'z' is never loaded; its lane stays reserved so a sibling does not steal it
        const rows = assignLanes([c("a", "z"), c("b", "y")]);
        expect(rows.map((r) => r.lane)).toEqual([0, 1]);
        expect(laneCount(rows)).toBe(2);
    });

    it("carries the original commit through unchanged", () => {
        const rows = assignLanes([c("a", "b"), c("b")]);
        expect(rows[0].hash).toBe("a");
        expect(rows[0].parents).toEqual(["b"]);
    });

    it("returns an empty result for empty input", () => {
        expect(assignLanes([])).toEqual([]);
        expect(laneCount([])).toBe(0);
    });
});
