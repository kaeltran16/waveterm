// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    computeGridLayout,
    filterAgents,
    matchesProjectFilter,
    nextFullWidth,
    projectOf,
    projectsFromAgents,
    resizeRowWeights,
    rowHeightsPx,
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

describe("computeGridLayout", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => mk(`a${i}`, "working"));

    it("packs an even count into rows of two", () => {
        const rows = computeGridLayout(ids(4), {});
        expect(rows.map((r) => r.cells.map((c) => c.id))).toEqual([
            ["a0", "a1"],
            ["a2", "a3"],
        ]);
    });

    it("leaves the odd trailing card alone in its own row", () => {
        const rows = computeGridLayout(ids(5), {});
        expect(rows.map((r) => r.cells.length)).toEqual([2, 2, 1]);
        expect(rows[2].cells[0].id).toBe("a4");
    });

    it("gives a full-width card its own row and does not pair across it", () => {
        const rows = computeGridLayout(ids(4), { a2: { fullWidth: true } });
        expect(rows.map((r) => r.cells.map((c) => c.id))).toEqual([["a0", "a1"], ["a2"], ["a3"]]);
    });

    it("uses the row's first card for the row height weight (default 1)", () => {
        const rows = computeGridLayout(ids(2), { a0: { heightWeight: 2.5 } });
        expect(rows[0].heightWeight).toBe(2.5);
        expect(rows[0].key).toBe("a0");
        expect(computeGridLayout(ids(2), {})[0].heightWeight).toBe(1);
    });

    it("returns no rows for an empty list", () => {
        expect(computeGridLayout([], {})).toEqual([]);
    });
});

describe("rowHeightsPx", () => {
    it("divides the viewport by weight when rows fit the page", () => {
        expect(rowHeightsPx([1, 1, 1], 300)).toEqual([100, 100, 100]);
        expect(rowHeightsPx([2, 1], 300)).toEqual([200, 100]);
    });

    it("keeps the page row-height and overflows when rows exceed the page", () => {
        // 4 rows, page = 3 -> base 100 each -> total 400 > 300 (scrolls)
        expect(rowHeightsPx([1, 1, 1, 1], 300)).toEqual([100, 100, 100, 100]);
    });

    it("is empty for no rows", () => {
        expect(rowHeightsPx([], 300)).toEqual([]);
    });
});

describe("resizeRowWeights", () => {
    it("moves height across the dragged boundary, preserving the pair total", () => {
        // [1,1,1] @ vp 600 -> px [200,200,200]; drag boundary 0 by +30 -> [230,170,...],
        // both neighbours stay well above the 96px min, so nothing clamps.
        expect(resizeRowWeights([1, 1, 1], 0, 30, 600)).toEqual([230, 170, 200]);
    });

    it("clamps so neither neighbour drops below the minimum", () => {
        // pair = 200; min 96 -> above clamps to 104, below to 96
        expect(resizeRowWeights([1, 1, 1], 0, 1000, 300, 96)).toEqual([104, 96, 100]);
    });

    it("returns the weights unchanged for an out-of-range boundary", () => {
        expect(resizeRowWeights([1, 1], 1, 30, 300)).toEqual([1, 1]);
        expect(resizeRowWeights([1, 1], -1, 30, 300)).toEqual([1, 1]);
    });
});

describe("nextFullWidth", () => {
    it("turns on past the positive threshold and off past the negative", () => {
        expect(nextFullWidth(false, 60, 48)).toBe(true);
        expect(nextFullWidth(true, -60, 48)).toBe(false);
    });
    it("holds within the deadzone", () => {
        expect(nextFullWidth(false, 10, 48)).toBe(false);
        expect(nextFullWidth(true, 10, 48)).toBe(true);
    });
});
