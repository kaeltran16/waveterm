// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { filterSessions, projectsOf, runtimesOf, searchSessions } from "./sessionsarchivestore";

const mk = (over: Partial<SessionInfo> = {}): SessionInfo => ({
    id: "x",
    runtime: "claude",
    projectpath: "/p",
    projectname: "proj",
    branch: "main",
    task: "do the thing",
    model: "claude",
    tokenstotal: 0,
    lastactivets: 0,
    resumecommand: "claude --resume x",
    ...over,
});

describe("searchSessions", () => {
    const list = [
        mk({ id: "a", task: "Fix the auth race", projectname: "payments", branch: "feat/auth" }),
        mk({ id: "b", task: "Add a button", projectname: "web", branch: "main" }),
    ];
    it("returns all on empty query", () => {
        expect(searchSessions(list, "  ")).toHaveLength(2);
    });
    it("matches task case-insensitively", () => {
        expect(searchSessions(list, "AUTH").map((s) => s.id)).toEqual(["a"]);
    });
    it("matches project and branch", () => {
        expect(searchSessions(list, "web").map((s) => s.id)).toEqual(["b"]);
        expect(searchSessions(list, "feat/").map((s) => s.id)).toEqual(["a"]);
    });
});

describe("filterSessions", () => {
    const list = [
        mk({ id: "a", runtime: "claude", projectname: "payments" }),
        mk({ id: "b", runtime: "codex", projectname: "web" }),
    ];
    it("passes everything on all/all", () => {
        expect(filterSessions(list, { runtime: "all", project: "all" })).toHaveLength(2);
    });
    it("filters by runtime", () => {
        expect(filterSessions(list, { runtime: "codex", project: "all" }).map((s) => s.id)).toEqual(["b"]);
    });
    it("filters by project", () => {
        expect(filterSessions(list, { runtime: "all", project: "payments" }).map((s) => s.id)).toEqual(["a"]);
    });
});

describe("runtimesOf / projectsOf", () => {
    const list = [
        mk({ runtime: "codex", projectname: "web" }),
        mk({ runtime: "claude", projectname: "web" }),
        mk({ runtime: "claude", projectname: "api" }),
    ];
    it("returns unique sorted runtimes", () => {
        expect(runtimesOf(list)).toEqual(["claude", "codex"]);
    });
    it("returns unique sorted projects", () => {
        expect(projectsOf(list)).toEqual(["api", "web"]);
    });
});