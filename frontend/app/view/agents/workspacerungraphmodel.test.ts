// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    chainOf,
    focusView,
    gutterPath,
    IN_FLIGHT_MAX,
    inFlight,
    laneLayout,
    reduceDeps,
    type LaneLayout,
} from "./workspacerungraphmodel";

// the canvas's fixtures (run-tab-polish Graph.dc.html: FD with LD), labels dropped
type Fixture = {
    tasks: { id: string; deps: string[] }[];
    states: Record<string, string>;
    ids: string[];
    edges: [string, string][];
};

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t-${i + 1}`);

function fixture(
    deps: Record<string, string[]>,
    n: number,
    states: Record<string, string>,
    rows: string[],
    edges: [string, string][]
): Fixture {
    return { tasks: ids(n).map((id) => ({ id, deps: deps[id] ?? [] })), states, ids: rows, edges };
}

const A = fixture(
    { "t-3": ["t-1"], "t-4": ["t-1"], "t-7": ["t-3", "t-4"], "t-8": ["t-1"] },
    8,
    {
        "t-1": "merged",
        "t-2": "live",
        "t-3": "asked",
        "t-4": "live",
        "t-5": "live",
        "t-6": "failed",
        "t-7": "waits",
        "t-8": "waits",
    },
    ["t-1", "t-3", "t-4", "t-7", "t-8", "t-2", "t-5", "t-6"],
    [
        ["t-1", "t-3"],
        ["t-1", "t-4"],
        ["t-3", "t-7"],
        ["t-4", "t-7"],
        ["t-1", "t-8"],
    ]
);

const B = fixture(
    {
        "t-2": ["t-1"],
        "t-3": ["t-2"],
        "t-4": ["t-2"],
        "t-7": ["t-6"],
        "t-8": ["t-6"],
        "t-9": ["t-6"],
        "t-10": ["t-6"],
        "t-11": ["t-6"],
        "t-12": ["t-7", "t-8", "t-9", "t-10"],
        "t-13": ["t-11", "t-12"],
        "t-14": ["t-13"],
        "t-15": ["t-13"],
        "t-16": ["t-13"],
        "t-17": ["t-13"],
    },
    21,
    {
        "t-1": "merged",
        "t-2": "live",
        "t-3": "waits",
        "t-4": "waits",
        "t-5": "merged",
        "t-6": "merged",
        "t-7": "asked",
        "t-8": "live",
        "t-9": "failed",
        "t-10": "live",
        "t-11": "live",
        "t-12": "waits",
        "t-13": "waits",
        "t-14": "waits",
        "t-15": "waits",
        "t-16": "waits",
        "t-17": "waits",
        "t-18": "merged",
        "t-19": "merged",
        "t-20": "merged",
        "t-21": "merged",
    },
    [
        "t-1",
        "t-2",
        "t-3",
        "t-4",
        "t-5",
        "t-6",
        "t-7",
        "t-8",
        "t-9",
        "t-10",
        "t-12",
        "t-11",
        "t-13",
        "t-14",
        "t-15",
        "t-16",
        "t-17",
        "t-18",
        "t-19",
        "t-20",
        "t-21",
    ],
    [
        ["t-1", "t-2"],
        ["t-2", "t-3"],
        ["t-2", "t-4"],
        ["t-6", "t-7"],
        ["t-6", "t-8"],
        ["t-6", "t-9"],
        ["t-6", "t-10"],
        ["t-7", "t-12"],
        ["t-8", "t-12"],
        ["t-9", "t-12"],
        ["t-10", "t-12"],
        ["t-6", "t-11"],
        ["t-11", "t-13"],
        ["t-12", "t-13"],
        ["t-13", "t-14"],
        ["t-13", "t-15"],
        ["t-13", "t-16"],
        ["t-13", "t-17"],
    ]
);

const C = fixture(
    {
        "t-7": ["t-1"],
        "t-10": ["t-3"],
        "t-11": ["t-2", "t-7"],
        "t-12": ["t-5", "t-10"],
        "t-13": ["t-8", "t-12"],
        "t-14": ["t-10", "t-4", "t-9"],
        "t-15": ["t-4", "t-13"],
        "t-16": ["t-11", "t-5"],
        "t-17": ["t-9", "t-10", "t-4"],
        "t-18": ["t-12"],
        "t-19": ["t-16", "t-17"],
        "t-20": ["t-5"],
        "t-21": ["t-5"],
        "t-23": ["t-20", "t-15", "t-18", "t-21"],
        "t-24": ["t-23", "t-19"],
        "t-25": ["t-15", "t-21"],
        "t-26": ["t-22", "t-23", "t-19"],
        "t-27": ["t-25", "t-6", "t-24", "t-26"],
        "t-28": ["t-26"],
        "t-29": ["t-28"],
        "t-30": ["t-29", "t-14"],
        "t-31": ["t-29"],
        "t-32": ["t-30", "t-31"],
        "t-33": ["t-32"],
        "t-34": ["t-33", "t-27"],
        "t-36": ["t-35"],
        "t-37": ["t-36"],
        "t-38": ["t-36"],
    },
    39,
    {},
    [
        "t-1",
        "t-7",
        "t-2",
        "t-11",
        "t-3",
        "t-10",
        "t-4",
        "t-5",
        "t-12",
        "t-18",
        "t-16",
        "t-20",
        "t-21",
        "t-6",
        "t-8",
        "t-13",
        "t-15",
        "t-23",
        "t-25",
        "t-9",
        "t-14",
        "t-17",
        "t-19",
        "t-24",
        "t-22",
        "t-26",
        "t-27",
        "t-28",
        "t-29",
        "t-30",
        "t-31",
        "t-32",
        "t-33",
        "t-34",
        "t-35",
        "t-36",
        "t-37",
        "t-38",
        "t-39",
    ],
    [
        ["t-1", "t-7"],
        ["t-2", "t-11"],
        ["t-7", "t-11"],
        ["t-3", "t-10"],
        ["t-5", "t-12"],
        ["t-10", "t-12"],
        ["t-12", "t-18"],
        ["t-11", "t-16"],
        ["t-5", "t-16"],
        ["t-5", "t-20"],
        ["t-5", "t-21"],
        ["t-8", "t-13"],
        ["t-12", "t-13"],
        ["t-4", "t-15"],
        ["t-13", "t-15"],
        ["t-20", "t-23"],
        ["t-15", "t-23"],
        ["t-18", "t-23"],
        ["t-21", "t-23"],
        ["t-15", "t-25"],
        ["t-21", "t-25"],
        ["t-10", "t-14"],
        ["t-4", "t-14"],
        ["t-9", "t-14"],
        ["t-9", "t-17"],
        ["t-10", "t-17"],
        ["t-4", "t-17"],
        ["t-16", "t-19"],
        ["t-17", "t-19"],
        ["t-23", "t-24"],
        ["t-19", "t-24"],
        ["t-22", "t-26"],
        ["t-23", "t-26"],
        ["t-19", "t-26"],
        ["t-25", "t-27"],
        ["t-6", "t-27"],
        ["t-24", "t-27"],
        ["t-26", "t-27"],
        ["t-26", "t-28"],
        ["t-28", "t-29"],
        ["t-29", "t-30"],
        ["t-14", "t-30"],
        ["t-29", "t-31"],
        ["t-30", "t-32"],
        ["t-31", "t-32"],
        ["t-32", "t-33"],
        ["t-33", "t-34"],
        ["t-27", "t-34"],
        ["t-35", "t-36"],
        ["t-36", "t-37"],
        ["t-36", "t-38"],
    ]
);

const key = (e: [string, string]) => e.join(">");
const edgeSet = (edges: [string, string][]) => [...edges].map(key).sort();

// every dep above its dependent, and no task's row inside the lane of an edge passing it
function expectSound(f: Fixture, layout: LaneLayout) {
    const row = Object.fromEntries(layout.rows.map((id, i) => [id, i]));
    for (const t of f.tasks) for (const d of t.deps) expect(row[d]).toBeLessThan(row[t.id]);
    for (const [p, c] of layout.edges) {
        for (let r = row[p] + 1; r < row[c]; r++) {
            expect(layout.lane[layout.rows[r]], `${layout.rows[r]} sits in ${p}->${c}'s lane`).not.toBe(layout.lane[p]);
        }
    }
}

describe("reduceDeps", () => {
    it("drops an edge implied through another path and keeps the rest", () => {
        const tasks = [{ id: "a" }, { id: "b", deps: ["a"] }, { id: "c", deps: ["a", "b"] }, { id: "d", deps: ["a"] }];
        expect(edgeSet(reduceDeps(tasks))).toEqual(
            edgeSet([
                ["a", "b"],
                ["b", "c"],
                ["a", "d"],
            ])
        );
    });

    it("reduces the canvas's 8, 21 and 39-task dags to exactly their lane edges", () => {
        for (const f of [A, B, C]) expect(edgeSet(reduceDeps(f.tasks))).toEqual(edgeSet(f.edges));
    });
});

describe("laneLayout", () => {
    it("orders the 8-task dag depth first in 3 lanes", () => {
        const layout = laneLayout(A.tasks);
        expect(layout.rows).toEqual(["t-1", "t-3", "t-4", "t-7", "t-8", "t-2", "t-5", "t-6"]);
        expect(layout.laneCount).toBe(3);
        expect(layout.lane).toEqual({ "t-1": 0, "t-3": 1, "t-4": 2, "t-7": 1, "t-8": 0, "t-2": 0, "t-5": 0, "t-6": 0 });
        expect(edgeSet(layout.edges)).toEqual(edgeSet(A.edges));
        expectSound(A, layout);
    });

    it("orders the 21 and 39-task dags as the canvas does, in 5 and 9 lanes", () => {
        const b = laneLayout(B.tasks);
        expect(b.rows).toEqual(B.ids);
        expect(b.laneCount).toBe(5);
        expectSound(B, b);
        const c = laneLayout(C.tasks);
        expect(c.rows).toEqual(C.ids);
        expect(c.laneCount).toBe(9);
        expectSound(C, c);
    });

    it("lays out an empty plan as no rows", () => {
        expect(laneLayout([])).toEqual({ rows: [], lane: {}, laneCount: 0, edges: [] });
    });
});

describe("gutterPath", () => {
    const geo = { rowH: 34, laneW: 13, x0: 10 };

    it("draws the canvas's gutter for the 8-task dag", () => {
        const layout = laneLayout(A.tasks);
        expect(gutterPath(layout, ["t-1", "t-3"], geo)).toBe("M10 17 V37 C10 47, 23 43, 23 51");
        expect(gutterPath(layout, ["t-1", "t-4"], geo)).toBe("M10 17 V71 C10 81, 36 77, 36 85");
        expect(gutterPath(layout, ["t-3", "t-7"], geo)).toBe("M23 51 V119");
        expect(gutterPath(layout, ["t-4", "t-7"], geo)).toBe("M36 85 V105 C36 115, 23 111, 23 119");
        expect(gutterPath(layout, ["t-1", "t-8"], geo)).toBe("M10 17 V153");
    });
});

describe("chainOf", () => {
    it("is the task plus everything up and downstream", () => {
        expect(chainOf(A.edges, "t-3")).toEqual(new Set(["t-1", "t-3", "t-7"]));
        expect(chainOf(A.edges, "t-1")).toEqual(new Set(["t-1", "t-3", "t-4", "t-7", "t-8"]));
        expect(chainOf(A.edges, "t-2")).toEqual(new Set(["t-2"]));
    });
});

describe("focusView", () => {
    it("shows a task's own deps above and dependents below", () => {
        expect(focusView(A.tasks, "t-7")).toEqual({
            centre: "t-7",
            up: ["t-3", "t-4"],
            upMore: [],
            down: [],
            downMore: [],
            upStage: false,
            downStage: true,
        });
    });

    it("folds more than 3 on a side into the first 2 and the rest", () => {
        const tasks = [...ids(5).map((id) => ({ id })), { id: "x", deps: ids(5) }];
        const v = focusView(tasks, "x");
        expect(v.up).toEqual(["t-1", "t-2"]);
        expect(v.upMore).toEqual(["t-3", "t-4", "t-5"]);
        const c13 = focusView(C.tasks, "t-13");
        expect(c13.down).toEqual(["t-15"]);
        const b6 = focusView(B.tasks, "t-6");
        expect(b6.down).toEqual(["t-7", "t-8"]);
        expect(b6.downMore).toEqual(["t-9", "t-10", "t-11"]);
    });

    it("keeps exactly 3 on a side unfolded", () => {
        const v = focusView(C.tasks, "t-14");
        expect(v.up).toEqual(["t-10", "t-4", "t-9"]);
        expect(v.upMore).toEqual([]);
    });

    it("lists every dep the engine waits on, implied ones included", () => {
        const tasks = [{ id: "a" }, { id: "b", deps: ["a"] }, { id: "c", deps: ["a", "b"] }];
        expect(focusView(tasks, "c").up).toEqual(["a", "b"]);
    });

    it("puts Plan review above a root and Final verification below a leaf", () => {
        const root = focusView(A.tasks, "t-1");
        expect(root.upStage).toBe(true);
        expect(root.downStage).toBe(false);
        expect(root.down).toEqual(["t-3", "t-4", "t-8"]);
        const lone = focusView(A.tasks, "t-2");
        expect(lone.upStage).toBe(true);
        expect(lone.downStage).toBe(true);
    });

    it("takes a smaller limit", () => {
        const v = focusView(A.tasks, "t-1", 2);
        expect(v.down).toEqual(["t-3"]);
        expect(v.downMore).toEqual(["t-4", "t-8"]);
    });
});

describe("inFlight", () => {
    const kindOf = (f: Fixture) => (id: string) =>
        ({ live: "working", asked: "asked", failed: "failed" })[f.states[id]] ?? f.states[id];

    it("puts asked first, then failed, then working, each in plan order", () => {
        expect(inFlight(ids(8), kindOf(A))).toEqual(["t-3", "t-6", "t-2", "t-4", "t-5"]);
    });

    it("keeps at most 5, leaving the 21-task dag's sixth working task off", () => {
        expect(IN_FLIGHT_MAX).toBe(5);
        expect(inFlight(ids(21), kindOf(B))).toEqual(["t-7", "t-9", "t-2", "t-8", "t-10"]);
    });

    it("never lists merged or waiting tasks", () => {
        expect(inFlight(["a", "b"], (id) => (id === "a" ? "merged" : "waits"))).toEqual([]);
    });
});
