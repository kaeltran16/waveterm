// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { launchableProjects, mergeSwitcherProjects, type SwitcherProject } from "./projectsstore";

describe("mergeSwitcherProjects", () => {
    it("appends registry-only projects with zero counts", () => {
        const live: SwitcherProject[] = [{ name: "payments-api", askingCount: 1, agentCount: 3 }];
        const registry = { "payments-api": { path: "/a" }, "fresh-proj": { path: "/b" } };
        expect(mergeSwitcherProjects(live, registry as any)).toEqual([
            { name: "payments-api", askingCount: 1, agentCount: 3 },
            { name: "fresh-proj", askingCount: 0, agentCount: 0 },
        ]);
    });
    it("is a no-op when the registry is empty", () => {
        const live: SwitcherProject[] = [{ name: "x", askingCount: 0, agentCount: 1 }];
        expect(mergeSwitcherProjects(live, {} as any)).toEqual(live);
    });
});

describe("launchableProjects", () => {
    it("returns name+path for entries that have a path", () => {
        const registry = { a: { path: "/a" }, b: { path: "" } };
        expect(launchableProjects(registry as any)).toEqual([{ name: "a", path: "/a" }]);
    });
});
