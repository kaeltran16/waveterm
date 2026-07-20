// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    filterAgents,
    matchesProjectFilter,
    projectOf,
    projectsFromAgents,
    topFiveHourPct,
    type AgentVM,
} from "./agentsviewmodel";

const P = "/h/.claude/projects/C--Users-u-IdeaProjects-waveterm/x.jsonl";
const Q = "/h/.claude/projects/C--Users-u-IdeaProjects-loom/y.jsonl";

const mk = (id: string, state: AgentVM["state"], extra: Partial<AgentVM> = {}): AgentVM => ({
    id,
    name: id,
    task: "",
    state,
    ...extra,
});

describe("projectOf", () => {
    it("prefers the explicit project field", () => {
        // a hyphenated name the lossy path-derivation could never produce (it returns only "api")
        expect(projectOf(mk("a", "working", { project: "payments-api", transcriptPath: P }))).toBe("payments-api");
    });
    it("falls back to the transcript-path derivation when project is unset", () => {
        expect(projectOf(mk("a", "working", { transcriptPath: P }))).toBe("waveterm");
    });
    it("is empty when neither is available", () => {
        expect(projectOf(mk("a", "working"))).toBe("");
    });
});

describe("projectsFromAgents", () => {
    it("groups by the explicit project field, preserving hyphenated names", () => {
        const out = projectsFromAgents([
            mk("a", "asking", { project: "payments-api" }),
            mk("b", "working", { project: "payments-api" }),
            mk("c", "idle", { project: "web-dashboard" }),
        ]);
        expect(out).toEqual([
            { name: "payments-api", agentCount: 2, askingCount: 1 },
            { name: "web-dashboard", agentCount: 1, askingCount: 0 },
        ]);
    });
    it("groups distinct projects with agent + asking counts, sorted by name", () => {
        const out = projectsFromAgents([
            mk("a", "working", { transcriptPath: P }),
            mk("b", "asking", { transcriptPath: P }),
            mk("c", "idle", { transcriptPath: Q }),
        ]);
        expect(out).toEqual([
            { name: "loom", agentCount: 1, askingCount: 0 },
            { name: "waveterm", agentCount: 2, askingCount: 1 },
        ]);
    });
    it("skips agents whose transcript path yields no project", () => {
        expect(projectsFromAgents([mk("a", "working"), mk("b", "idle", { transcriptPath: "" })])).toEqual([]);
    });
});

describe("matchesProjectFilter", () => {
    it("matches everything for 'all'", () => {
        expect(matchesProjectFilter(mk("a", "working"), "all")).toBe(true);
    });
    it("matches by derived project name", () => {
        expect(matchesProjectFilter(mk("a", "working", { transcriptPath: P }), "waveterm")).toBe(true);
        expect(matchesProjectFilter(mk("a", "working", { transcriptPath: Q }), "waveterm")).toBe(false);
    });
    it("matches by the explicit project field", () => {
        expect(matchesProjectFilter(mk("a", "working", { project: "payments-api" }), "payments-api")).toBe(true);
        expect(matchesProjectFilter(mk("a", "working", { project: "web-dashboard" }), "payments-api")).toBe(false);
    });
});

describe("filterAgents", () => {
    const agents = [
        mk("a", "working", { transcriptPath: P }),
        mk("b", "idle", { transcriptPath: P }),
        mk("c", "asking", { transcriptPath: Q }),
    ];
    it("returns all when filter=all and liveOnly=false", () => {
        expect(filterAgents(agents, "all", false).map((a) => a.id)).toEqual(["a", "b", "c"]);
    });
    it("drops idle when liveOnly", () => {
        expect(filterAgents(agents, "all", true).map((a) => a.id)).toEqual(["a", "c"]);
    });
    it("scopes by project, preserving order", () => {
        expect(filterAgents(agents, "waveterm", false).map((a) => a.id)).toEqual(["a", "b"]);
    });
    it("composes project + liveOnly", () => {
        expect(filterAgents(agents, "waveterm", true).map((a) => a.id)).toEqual(["a"]);
    });
});

describe("topFiveHourPct", () => {
    it("returns the highest non-null fivehourpct", () => {
        expect(
            topFiveHourPct([
                mk("a", "working", { usage: { fivehourpct: 30 } }),
                mk("b", "working", { usage: { fivehourpct: 71 } }),
                mk("c", "working", { usage: {} }),
            ])
        ).toBe(71);
    });
    it("returns undefined when no agent reports a 5h pct", () => {
        expect(topFiveHourPct([mk("a", "working"), mk("b", "working", { usage: {} })])).toBeUndefined();
    });
});
