// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "./activityevents";
import { activityProjects, applyFilter, applyProjectFilter, groupByProject } from "./activitystore";

const e = (project: string, type: ActivityEvent["type"], ts: number): ActivityEvent => ({
    id: `${project}-${ts}`,
    agent: "claude",
    agentName: project,
    project,
    type,
    ts,
    text: type,
    sessionPath: `/p/${project}.jsonl`,
    live: false,
});

describe("applyFilter", () => {
    it("returns all events for 'all' and only matching type otherwise", () => {
        const evs = [e("a", "asked", 1), e("a", "committed", 2)];
        expect(applyFilter(evs, "all")).toHaveLength(2);
        expect(applyFilter(evs, "asked").map((x) => x.type)).toEqual(["asked"]);
    });
});

describe("applyProjectFilter", () => {
    it("returns all events for 'all' and only the matching project otherwise", () => {
        const evs = [e("alpha", "started", 1), e("beta", "asked", 2)];
        expect(applyProjectFilter(evs, "all")).toHaveLength(2);
        expect(applyProjectFilter(evs, "beta").map((x) => x.project)).toEqual(["beta"]);
    });
    it("normalizes a blank project to '—' so it matches the group key", () => {
        expect(applyProjectFilter([e("", "started", 1)], "—")).toHaveLength(1);
    });
});

describe("activityProjects", () => {
    it("lists distinct projects, most-recent first (matches the group order)", () => {
        const evs = [e("alpha", "started", 10), e("beta", "asked", 30), e("alpha", "asked", 20)];
        expect(activityProjects(evs)).toEqual(["beta", "alpha"]);
    });
    it("normalizes a blank project to '—'", () => {
        expect(activityProjects([e("", "started", 1)])).toEqual(["—"]);
    });
});

describe("groupByProject", () => {
    it("groups by project, newest-first within and across groups, counts attn", () => {
        const evs = [e("alpha", "started", 10), e("beta", "asked", 30), e("alpha", "asked", 20)];
        const groups = groupByProject(evs);
        expect(groups.map((g) => g.project)).toEqual(["beta", "alpha"]); // beta's newest (30) > alpha's newest (20)
        const alpha = groups.find((g) => g.project === "alpha")!;
        expect(alpha.events.map((x) => x.ts)).toEqual([20, 10]); // newest-first within group
        expect(alpha.count).toBe(2);
        expect(alpha.attn).toBe(1); // one "asked"
    });
});
