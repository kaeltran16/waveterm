// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { cockpitCounts, plural, rosterLoadPhase } from "./cockpitsurfacemodel";

function agent(over: Partial<AgentVM>): AgentVM {
    return { id: "t1", name: "claude", task: "", state: "working", ...over };
}

describe("rosterLoadPhase", () => {
    it("is loading, never empty, while an empty roster has not been read yet", () => {
        expect(rosterLoadPhase(false, 0)).toBe("loading");
    });
    it("is empty once the roster has been read and holds no agents", () => {
        expect(rosterLoadPhase(true, 0)).toBe("empty");
    });
    it("is ready whenever there are agents to show, read or not", () => {
        expect(rosterLoadPhase(false, 2)).toBe("ready");
        expect(rosterLoadPhase(true, 1)).toBe("ready");
    });
});

describe("cockpitCounts", () => {
    const roster = [
        agent({ id: "a", project: "demo", state: "asking" }),
        agent({ id: "b", project: "demo", state: "idle" }),
        agent({ id: "c", project: "other" }),
    ];
    const asking = (a: AgentVM) => a.state === "asking";
    it("counts the whole roster unscoped", () => {
        expect(cockpitCounts(roster, "all", asking)).toEqual({ agents: 3, projects: 2, needsYou: 1 });
    });
    it("counts only the scoped project", () => {
        expect(cockpitCounts(roster, "other", asking)).toEqual({ agents: 1, projects: 1, needsYou: 0 });
    });
    it("counts an agent with no transcript", () => {
        expect(cockpitCounts([agent({ id: "boot", project: "demo", booting: true })], "all", asking).agents).toBe(1);
    });
});

describe("plural", () => {
    it("is singular for one and plural otherwise", () => {
        expect(plural(1, "agent")).toBe("1 agent");
        expect(plural(0, "agent")).toBe("0 agents");
        expect(plural(2, "project")).toBe("2 projects");
    });
});
