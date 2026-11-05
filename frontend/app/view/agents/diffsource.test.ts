// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { DiffScope } from "./diffscope";
import {
    defaultFocusId,
    endedAgentScope,
    filterSources,
    focusFollowAgent,
    moveHighlight,
    pickerRows,
    sourceFor,
    subjectState,
    worktreeParent,
} from "./diffsource";

const agents = [
    { id: "a1", name: "jarvis-recall" },
    { id: "a2", name: "diff-parity" },
];

const agentScope = (id: string): DiffScope => ({
    repo: { origin: { kind: "agent", id }, label: id },
    range: { kind: "session", agentId: id },
});
const projectScope: DiffScope = {
    repo: { origin: { kind: "project", name: "waveterm", path: "/repo" }, label: "waveterm" },
    range: { kind: "working" },
};
const runScope: DiffScope = {
    repo: { origin: { kind: "run", runId: "r1", cwd: "/repo", baseCommit: "" }, label: "run r1" },
    range: { kind: "run", runId: "r1", baseCommit: "" },
};

describe("what the source picker is pointed at", () => {
    it("names the scoped project or agent", () => {
        expect(sourceFor(projectScope, "a1")).toEqual({ kind: "project", name: "waveterm" });
        expect(sourceFor(agentScope("a2"), "a1")).toEqual({ kind: "agent", id: "a2" });
    });

    // The picker falls back to the scope's own label for a run, which it can only reach if nothing
    // claims to be the current source. Answering "the focused agent" here put another worktree's
    // name over a run's diff.
    it("claims nothing while a run's diff is on screen", () => {
        expect(sourceFor(runScope, "a1")).toBeNull();
    });

    it("points at the focused agent before anything is scoped", () => {
        expect(sourceFor(null, "a1")).toEqual({ kind: "agent", id: "a1" });
        expect(sourceFor(null, "")).toBeNull();
    });
});

describe("run beats project beats agent", () => {
    it("adopts the focused agent when the surface is unscoped", () => {
        expect(focusFollowAgent(null, "a2", agents)).toEqual({ id: "a2", name: "diff-parity" });
    });

    it("leaves a pinned project or a run where it is", () => {
        expect(focusFollowAgent(projectScope, "a1", agents)).toBeNull();
        expect(focusFollowAgent(runScope, "a1", agents)).toBeNull();
    });

    it("does not re-scope to the agent it is already showing", () => {
        expect(focusFollowAgent(agentScope("a1"), "a1", agents)).toBeNull();
    });

    it("follows focus from one agent to another", () => {
        expect(focusFollowAgent(agentScope("a1"), "a2", agents)).toEqual({ id: "a2", name: "diff-parity" });
    });

    // the Agent surface moves focus to the first agent when the focused one leaves, which must not
    // carry the surface off the ended agent's state before it can be read
    it("holds an agent scope whose agent has left the roster", () => {
        expect(focusFollowAgent(agentScope("gone"), "a1", agents)).toBeNull();
    });

    // focus can name an agent that has since exited; the surface keeps showing what it has
    it("ignores a focus id no agent answers to", () => {
        expect(focusFollowAgent(agentScope("a1"), "gone", agents)).toBeNull();
        expect(focusFollowAgent(null, "", agents)).toBeNull();
    });
});

describe("the first agent, so opening the surface is useful", () => {
    it("focuses the first agent when nothing is scoped or focused", () => {
        expect(defaultFocusId(null, "", agents)).toBe("a1");
    });

    it("defaults nothing once there is a scope, a focus, or no agents", () => {
        expect(defaultFocusId(projectScope, "", agents)).toBeNull();
        expect(defaultFocusId(null, "a2", agents)).toBeNull();
        expect(defaultFocusId(null, "", [])).toBeNull();
    });
});

describe("filterSources", () => {
    const agents = [{ name: "verify-runs" }, { name: "Rapid" }];
    const projects = [{ name: "waveterm" }, { name: "exp-native" }];
    it("matches either list, case-insensitively", () => {
        expect(filterSources("RA", agents, projects)).toEqual({ agents: [{ name: "Rapid" }], projects: [] });
        expect(filterSources("nat", agents, projects)).toEqual({ agents: [], projects: [{ name: "exp-native" }] });
    });
    it("returns everything for a blank query", () => {
        expect(filterSources("  ", agents, projects)).toEqual({ agents, projects });
    });
});

describe("worktreeParent", () => {
    const projects = [
        { name: "waveterm", path: "C:\\Users\\k\\IdeaProjects\\waveterm" },
        { name: "exp-native", path: "c:/users/k/ideaprojects/waveterm/.worktrees/exp-native" },
        { name: "waveterm2", path: "C:/Users/k/IdeaProjects/waveterm2" },
    ];
    it("finds the project whose path contains this one, across separators and case", () => {
        expect(worktreeParent(projects[1], projects)).toBe("waveterm");
    });
    it("does not treat a sibling that shares a prefix as a parent", () => {
        expect(worktreeParent(projects[2], projects)).toBeNull();
    });
    it("is null for a top-level project", () => {
        expect(worktreeParent(projects[0], projects)).toBeNull();
    });
});

describe("subjectState", () => {
    const projects = [{ name: "waveterm" }];
    it("is empty with nothing scoped and no sources", () => {
        expect(subjectState(null, [], [])).toBe("empty");
    });
    it("asks for a pick with nothing scoped while sources exist", () => {
        expect(subjectState(null, [], projects)).toBe("pick");
        expect(subjectState(null, agents, [])).toBe("pick");
    });
    it("is ended when the scoped agent is no longer in the roster", () => {
        expect(subjectState(agentScope("gone"), agents, projects)).toBe("ended");
    });
    it("is ready for a live agent, a project or a run", () => {
        expect(subjectState(agentScope("a1"), agents, [])).toBe("ready");
        expect(subjectState(projectScope, [], projects)).toBe("ready");
        expect(subjectState(runScope, [], [])).toBe("ready");
    });
});

describe("endedAgentScope", () => {
    const projects = [{ name: "waveterm", path: "C:\\Users\\k\\IdeaProjects\\waveterm" }];
    it("re-scopes to the registered project at the agent's folder, across separators and case", () => {
        expect(endedAgentScope("c:/users/k/ideaprojects/waveterm/", projects)).toEqual({
            repo: { origin: { kind: "project", name: "waveterm", path: projects[0].path }, label: "waveterm" },
            range: { kind: "working" },
        });
    });
    it("names an unregistered folder for itself", () => {
        expect(endedAgentScope("C:\\tmp\\exp-native", projects)).toEqual({
            repo: {
                origin: { kind: "project", name: "exp-native", path: "C:\\tmp\\exp-native" },
                label: "exp-native",
            },
            range: { kind: "working" },
        });
    });
    it("is null with no remembered folder", () => {
        expect(endedAgentScope(undefined, projects)).toBeNull();
        expect(endedAgentScope("", projects)).toBeNull();
    });
});

describe("pickerRows", () => {
    const agents = [
        { id: "a1", name: "verify-runs" },
        { id: "a2", name: "Rapid" },
    ];
    const projects = [{ name: "waveterm" }, { name: "rapid-proj" }];
    it("lists agents before projects, in drawn order", () => {
        expect(pickerRows(agents, projects)).toEqual([
            { kind: "agent", id: "a1" },
            { kind: "agent", id: "a2" },
            { kind: "project", name: "waveterm" },
            { kind: "project", name: "rapid-proj" },
        ]);
    });
    it("is empty under a filter that matches nothing", () => {
        const shown = filterSources("zzz", agents, projects);
        expect(pickerRows(shown.agents, shown.projects)).toEqual([]);
    });
});

describe("moveHighlight", () => {
    it("steps within the rows", () => {
        expect(moveHighlight(3, 0, 1)).toBe(1);
        expect(moveHighlight(3, 2, -1)).toBe(1);
    });
    it("clamps at either end rather than wrapping", () => {
        expect(moveHighlight(3, 2, 1)).toBe(2);
        expect(moveHighlight(3, 0, -1)).toBe(0);
    });
    it("pulls a highlight left past a shrunken list back into range", () => {
        expect(moveHighlight(2, 5, 1)).toBe(1);
    });
    it("is 0 with no rows", () => {
        expect(moveHighlight(0, 0, 1)).toBe(0);
        expect(moveHighlight(0, 0, -1)).toBe(0);
    });
});
