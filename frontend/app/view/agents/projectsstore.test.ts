// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    launchCandidates,
    mergeSwitcherProjects,
    pushRecentProject,
    RECENT_PROJECTS_CAP,
    recentFirst,
    type SwitcherProject,
} from "./projectsstore";

describe("mergeSwitcherProjects", () => {
    it("appends registry-only projects with zero counts and flags registered rows", () => {
        const live: SwitcherProject[] = [
            { name: "payments-api", askingCount: 1, agentCount: 3 },
            { name: "live-only", askingCount: 0, agentCount: 2 },
        ];
        const registry = { "payments-api": { path: "/a" }, "fresh-proj": { path: "/b" } };
        expect(mergeSwitcherProjects(live, registry as any)).toEqual([
            { name: "payments-api", askingCount: 1, agentCount: 3, registered: true },
            { name: "live-only", askingCount: 0, agentCount: 2, registered: false },
            { name: "fresh-proj", askingCount: 0, agentCount: 0, registered: true },
        ]);
    });
    it("flags all rows as unregistered when the registry is empty", () => {
        const live: SwitcherProject[] = [{ name: "x", askingCount: 0, agentCount: 1 }];
        expect(mergeSwitcherProjects(live, {} as any)).toEqual([
            { name: "x", askingCount: 0, agentCount: 1, registered: false },
        ]);
    });
});

describe("launchCandidates", () => {
    it("includes registry projects (with paths) and live projects (path empty until resolved)", () => {
        const registry = { "wave-test-proj": { path: "/repo" }, nopath: { path: "" } };
        const live = [{ name: "vault", transcriptPath: "/v/a.jsonl" }, { name: "docs" }];
        expect(launchCandidates(registry as any, live)).toEqual([
            { name: "docs", path: "", transcriptPath: undefined, registered: false },
            { name: "vault", path: "", transcriptPath: "/v/a.jsonl", registered: false },
            { name: "wave-test-proj", path: "/repo", registered: true },
        ]);
    });
    it("registry wins on a name collision (live duplicate dropped)", () => {
        const registry = { vault: { path: "/repo/vault" } };
        const live = [{ name: "vault", transcriptPath: "/v/a.jsonl" }];
        expect(launchCandidates(registry as any, live)).toEqual([{ name: "vault", path: "/repo/vault", registered: true }]);
    });
    it("works with an empty registry", () => {
        expect(launchCandidates({} as any, [{ name: "docs", transcriptPath: "/d.jsonl" }])).toEqual([
            { name: "docs", path: "", transcriptPath: "/d.jsonl", registered: false },
        ]);
    });
});

describe("recentFirst", () => {
    const c = (name: string) => ({ name, path: `/${name}`, registered: true });
    const list = [c("a"), c("b"), c("c"), c("d")];
    it("orders used projects by recency, then the never-used ones in their original order", () => {
        expect(recentFirst(list, ["c", "b"]).map((p) => p.name)).toEqual(["c", "b", "a", "d"]);
    });
    it("ignores recent names that are no longer candidates", () => {
        expect(recentFirst(list, ["gone", "d"]).map((p) => p.name)).toEqual(["d", "a", "b", "c"]);
    });
    it("leaves the order alone with no history", () => {
        expect(recentFirst(list, []).map((p) => p.name)).toEqual(["a", "b", "c", "d"]);
        expect(recentFirst(list, undefined).map((p) => p.name)).toEqual(["a", "b", "c", "d"]);
    });
});

describe("pushRecentProject", () => {
    it("puts the launched project at the head without duplicating it", () => {
        expect(pushRecentProject(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
        expect(pushRecentProject([], "a")).toEqual(["a"]);
    });
    it("drops the oldest beyond the cap", () => {
        const full = Array.from({ length: RECENT_PROJECTS_CAP }, (_, i) => `p${i}`);
        const got = pushRecentProject(full, "new");
        expect(got).toHaveLength(RECENT_PROJECTS_CAP);
        expect(got[0]).toBe("new");
        expect(got).not.toContain(`p${RECENT_PROJECTS_CAP - 1}`);
    });
});
