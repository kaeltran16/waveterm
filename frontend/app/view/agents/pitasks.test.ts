// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { capTasks, edgeSummary, groupTasks } from "./pitasks";

const task = (id: string, status: string, updatedat: number, extra?: Partial<PiTask>): PiTask => ({
    id,
    status,
    subject: `task ${id}`,
    description: "",
    owner: "",
    blocks: [],
    blockedby: [],
    createdat: updatedat,
    updatedat,
    ...extra,
});

describe("groupTasks", () => {
    it("buckets by status in display order, updatedAt desc within group", () => {
        const groups = groupTasks([
            task("1", "pending", 100),
            task("2", "in_progress", 300),
            task("3", "completed", 200),
            task("4", "pending", 150),
        ]);
        expect(groups.map((g) => g.status)).toEqual(["in_progress", "pending", "completed"]);
        expect(groups[1].tasks.map((t) => t.id)).toEqual(["4", "1"]);
    });

    it("drops unknown statuses and empty groups", () => {
        expect(groupTasks([task("1", "shipped", 100)])).toEqual([]);
    });

    it("returns [] for empty input", () => {
        expect(groupTasks([])).toEqual([]);
    });
});

describe("capTasks", () => {
    it("keeps the first cap rows and counts the rest", () => {
        const groups = groupTasks([task("1", "pending", 100), task("2", "pending", 200), task("3", "pending", 300)]);
        const { groups: kept, more } = capTasks(groups, 2);
        expect(more).toBe(1);
        expect(kept.flatMap((g) => g.tasks).length).toBe(2);
    });

    it("no more when under cap", () => {
        const { groups: kept, more } = capTasks(groupTasks([task("1", "pending", 100)]), 8);
        expect(more).toBe(0);
        expect(kept.flatMap((g) => g.tasks).length).toBe(1);
    });
});

describe("edgeSummary", () => {
    it("null when no edges", () => {
        expect(edgeSummary(task("1", "pending", 100))).toBeNull();
    });

    it("renders counts for blocks and blockedBy", () => {
        expect(edgeSummary(task("1", "pending", 100, { blocks: ["a"], blockedby: ["b", "c"] }))).toBe(
            "blocks 1 · blocked by 2"
        );
    });
});
