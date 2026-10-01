// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    buildProjectList,
    pushRecentProject,
    RECENT_PROJECTS_CAP,
    recentFirst,
    rowsWithChannel,
    switcherProjects,
} from "./projectsstore";

const ch = (oid: string, projectpath: string) => ({ oid, projectpath }) as Channel;

describe("buildProjectList", () => {
    it("lists the registered projects that have a path, name-sorted, each with its channel", () => {
        const registry = { zeta: { path: "C:\\src\\zeta" }, alpha: { path: "C:/src/alpha" }, nopath: { path: "" } };
        const channels = [ch("cz", "C:/src/zeta/"), ch("orphan", "C:/src/removed"), ch("pathless", "")];
        expect(buildProjectList(registry as any, channels)).toEqual([
            { name: "alpha", path: "C:/src/alpha", channel: undefined },
            { name: "zeta", path: "C:\\src\\zeta", channel: channels[0] },
        ]);
    });
    it("leaves out channels that belong to no registered project", () => {
        const rows = buildProjectList({} as any, [ch("orphan", "C:/src/removed")]);
        expect(rows).toEqual([]);
    });
    it("is empty before the config or channels load", () => {
        expect(buildProjectList(undefined, null)).toEqual([]);
        expect(buildProjectList({ a: { path: "/a" } } as any, null)).toEqual([{ name: "a", path: "/a", channel: undefined }]);
    });
});

describe("rowsWithChannel", () => {
    it("keeps only the rows whose channel has loaded", () => {
        const rows = [
            { name: "a", path: "/a", channel: ch("ca", "/a") },
            { name: "b", path: "/b" },
        ];
        expect(rowsWithChannel(rows).map((r) => r.name)).toEqual(["a"]);
    });
});

describe("switcherProjects", () => {
    it("shows every project, with live counts laid over it and zero for projects with no agents", () => {
        const rows = [
            { name: "arc", path: "/arc" },
            { name: "fresh", path: "/fresh" },
        ];
        const live = [
            { name: "arc", askingCount: 1, agentCount: 3 },
            { name: "unregistered-folder", askingCount: 0, agentCount: 2 },
        ];
        expect(switcherProjects(rows, live)).toEqual([
            { name: "arc", askingCount: 1, agentCount: 3 },
            { name: "fresh", askingCount: 0, agentCount: 0 },
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
