// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    EMPTY_WORKSPACE,
    type RunGraphState,
    type RunView,
    type WorkspaceState,
    type WorkspaceTab,
} from "./workspacemodel";
import {
    backFrom,
    chainOf,
    dagFocusTask,
    flightIds,
    focusLayout,
    focusOn,
    focusRowLabel,
    focusView,
    graphEscapeKey,
    graphNodes,
    gutterPath,
    IN_FLIGHT_MAX,
    inFlight,
    laneLayout,
    laneWord,
    moveTo,
    reduceDeps,
    stepDir,
    toFocus,
    toLanes,
    type FocusLayout,
    type FocusView,
    type GraphNode,
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

// the run-graph-focus boards' geometry: a 564px board, 190 x 52 neighbours, a 440px centre, 40px arrows
describe("focusLayout", () => {
    const view = (v: Partial<FocusView>): FocusView => ({
        centre: "c",
        up: [],
        upMore: [],
        down: [],
        downMore: [],
        upStage: false,
        downStage: false,
        ...v,
    });
    const stages = { planReview: true, final: true };
    const at = (l: FocusLayout, id: string) => l.boxes.find((b) => b.id === id || b.stage === id);

    it("lays Focus-Working out: t-1 above, the centre, t-7 below, straight edges, as tall as its last row", () => {
        const l = focusLayout(view({ centre: "t-4", up: ["t-1"], down: ["t-7"] }), {
            width: 564,
            centreH: 144,
            ...stages,
        });
        expect(at(l, "t-1")).toMatchObject({ side: "up", x: 187, y: 20, w: 190, h: 52 });
        expect(at(l, "t-4")).toMatchObject({ side: "centre", x: 62, y: 116, w: 440, h: 144 });
        expect(at(l, "t-7")).toMatchObject({ side: "down", x: 187, y: 304, w: 190, h: 52 });
        expect(l.edges.map((e) => e.d)).toEqual(["M282 72 V112", "M282 260 V300"]);
        expect(l.edges[0].arrow).toBe("M277.5 106 L282 112 L286.5 106");
        expect(l.height).toBe(356);
    });

    it("lays Focus-Waits out: two above with curved edges, Final verification below a 40px arrow", () => {
        const l = focusLayout(view({ centre: "t-7", up: ["t-3", "t-4"], downStage: true }), {
            width: 564,
            centreH: 100,
            ...stages,
        });
        expect([at(l, "t-3")?.x, at(l, "t-4")?.x]).toEqual([77, 297]);
        expect(l.edges[0].d).toBe("M172 72 C172 96, 282 88, 282 112");
        expect(at(l, "final")).toMatchObject({ side: "down", x: 187, y: 260, w: 190, h: 52 });
        expect(l.height).toBe(312);
    });

    it("gives a row with nothing in it no space", () => {
        const lone = focusLayout(view({ upStage: true, downStage: true }), {
            width: 564,
            centreH: 100,
            planReview: false,
            final: false,
        });
        expect(lone.boxes.map((b) => b.side)).toEqual(["centre"]);
        expect(at(lone, "c")?.y).toBe(20);
        expect(lone.edges).toEqual([]);
        expect(lone.height).toBe(120);
        const root = focusLayout(view({ upStage: true, downStage: true }), { width: 564, centreH: 100, ...stages });
        expect(root.boxes.map((b) => b.stage ?? b.side)).toEqual(["plan-review", "centre", "final"]);
    });

    it("narrows the centre to a narrow board", () => {
        const l = focusLayout(view({}), { width: 400, centreH: 100, ...stages });
        expect(at(l, "c")).toMatchObject({ x: 0, w: 400 });
    });

    it("keeps a full row clear of the row labels at the left, and of their mirror at the right", () => {
        const l = focusLayout(view({ up: ["a", "b", "d"] }), { width: 564, centreH: 100, ...stages });
        const ups = l.boxes.filter((b) => b.side === "up");
        expect(ups[0].x).toBeGreaterThanOrEqual(64);
        expect(ups[2].x + ups[2].w).toBeLessThanOrEqual(564 - 64);
    });
});

describe("focusRowLabel", () => {
    const v: FocusView = {
        centre: "t-5",
        up: ["t-1"],
        upMore: [],
        down: ["t-12", "t-16"],
        downMore: ["t-20", "t-21"],
        upStage: false,
        downStage: false,
    };

    it.each<[string, FocusView, "up" | "down", string]>([
        ["counts the tasks above", v, "up", "waits on 1"],
        ["counts folded tasks below too", v, "down", "then 4"],
        ["drops the count over Plan review", { ...v, up: [], upStage: true }, "up", "waits on"],
        ["drops the count over Final verification", { ...v, down: [], downMore: [], downStage: true }, "down", "then"],
    ])("%s", (_, view, side, want) => {
        expect(focusRowLabel(view, side)).toBe(want);
    });
});

// the Main board's run as the engine records it (workspace-run-fixture.mjs): t-1 merged, t-2 merged and verifying,
// t-3 asking the lead, t-4 working, t-5 reviewing, t-6 failed, t-7 and t-8 not started
const node = (id: string, state: string, extra: Partial<TaskNode> = {}): TaskNode => ({
    id,
    label: `task ${id}`,
    state,
    ...extra,
});
const NOW = Date.UTC(2026, 10, 27, 14, 0, 0);
const MIN = 60_000;
const MAIN_DAG = {
    oid: "dag-1",
    tasks: [
        node("t-1", "done", { merged: true, spawnedts: NOW - 20 * MIN }),
        node("t-2", "verifying", { merged: true, spawnedts: NOW - 20 * MIN }),
        node("t-3", "running", { deps: ["t-1"], spawnedts: NOW - 6 * MIN, askts: NOW - 3 * MIN }),
        node("t-4", "running", { deps: ["t-1"], spawnedts: NOW - 4 * MIN }),
        node("t-5", "reviewing", { spawnedts: NOW - 15 * MIN }),
        node("t-6", "failed", { spawnedts: NOW - 15 * MIN }),
        node("t-7", "pending", { deps: ["t-3", "t-4"] }),
        node("t-8", "ready", { deps: ["t-1"] }),
    ],
} as TaskGroup;
const digestOf = (rows: Partial<DagTaskDigest>[], runms: Record<string, number> = {}) =>
    ({
        tasks: rows.map((r) => ({ waitreason: "", mergestate: "", cleanupstate: "", ...r })),
        durations: { elapsedms: 0, tasks: Object.entries(runms).map(([taskid, ms]) => ({ taskid, runms: ms })) },
    }) as DagStatusDigest;
const MAIN_DIGEST = digestOf([{ taskid: "t-3", waitreason: "lead-ask" }], { "t-2": 9 * MIN });
const ev = (kind: string, taskid: string, ts: number) =>
    ({ id: `${kind}-${taskid}-${ts}`, kind, ts, detail: JSON.stringify({ taskid }) }) as RunEvent;
// t-6 failed its verify 10m ago and again 90s ago; another task's later failure is not t-6's
const MAIN_EVENTS = [
    ev("task-verify-failed", "t-6", NOW - 10 * MIN),
    ev("task-failed", "t-6", NOW - 90_000),
    ev("task-failed", "t-5", NOW - 5_000),
];
const mainNodes = (digest = MAIN_DIGEST, dag = MAIN_DAG, events = MAIN_EVENTS) => graphNodes(dag, digest, events, NOW);
const field = <K extends keyof GraphNode>(nodes: GraphNode[], k: K) =>
    Object.fromEntries(nodes.map((n) => [n.id, n[k]]));

describe("graphNodes", () => {
    it("gives each task the canvas's short word: merged, working, asked the lead, failed, waits", () => {
        const words = field(mainNodes(), "word");
        expect(words).toEqual({
            "t-1": "merged",
            "t-2": "working",
            "t-3": "asked the lead",
            "t-4": "working",
            "t-5": "working",
            "t-6": "failed",
            "t-7": "waits",
            "t-8": "waits",
        });
    });

    it("says asking you for a question that is the user's", () => {
        const n = mainNodes(digestOf([{ taskid: "t-3", waitreason: "ask" }])).find((x) => x.id === "t-3");
        expect(n).toMatchObject({ dot: "asked", word: "asking you", time: "3m" });
    });

    it("keeps plan order, the full name and the deps", () => {
        const nodes = mainNodes();
        expect(nodes.map((n) => n.id)).toEqual(ids(8));
        expect(nodes[6]).toMatchObject({ name: "task t-7", deps: ["t-3", "t-4"], dot: "waits" });
    });

    it("times working by the digest's run time else since spawn, asked since its ask, failed since its latest failure; merged and waits have none", () => {
        expect(field(mainNodes(), "time")).toEqual({
            "t-1": "",
            "t-2": "9m",
            "t-3": "3m",
            "t-4": "4m",
            "t-5": "15m",
            "t-6": "1m ago",
            "t-7": "",
            "t-8": "",
        });
    });

    it("times an ask with no askts by the task's time, and a failure with no event not at all", () => {
        const dag = {
            ...MAIN_DAG,
            tasks: MAIN_DAG.tasks.map((t) => (t.id === "t-3" ? { ...t, askts: undefined } : t)),
        };
        const time = field(mainNodes(MAIN_DIGEST, dag, []), "time");
        expect([time["t-3"], time["t-6"]]).toEqual(["6m", ""]);
    });

    it("lists what a waiting task waits on: deps neither merged nor done", () => {
        const dag = {
            ...MAIN_DAG,
            tasks: [...MAIN_DAG.tasks, node("t-9", "pending", { deps: ["t-2", "t-5", "t-10"] }), node("t-10", "done")],
        };
        const waitsOn = field(mainNodes(MAIN_DIGEST, dag), "waitsOn");
        expect([waitsOn["t-7"], waitsOn["t-8"], waitsOn["t-9"], waitsOn["t-4"]]).toEqual([
            ["t-3", "t-4"],
            [],
            ["t-5"],
            [],
        ]);
    });
});

describe("laneWord", () => {
    const n = (dot: GraphNode["dot"], word: string, time = "", waitsOn: string[] = []): GraphNode => ({
        id: "t-1",
        name: "x",
        deps: [],
        dot,
        word,
        time,
        waitsOn,
    });

    it.each([
        ["waits on its unmet deps", n("waits", "waits", "", ["t-3", "t-4"]), "waits on t-3, t-4"],
        ["waits with none unmet", n("waits", "waits"), "waits"],
        ["merged, no time", n("merged", "merged"), "merged"],
        ["working with its time", n("working", "working", "4m"), "working · 4m"],
        ["failed with its time ago", n("failed", "failed", "1m ago"), "failed · 1m ago"],
        ["failed with no time", n("failed", "failed"), "failed"],
    ])("%s", (_, node, want) => {
        expect(laneWord(node)).toBe(want);
    });
});

describe("flightIds", () => {
    it("is the Main board's In flight: t-3, t-6, t-2, t-4, t-5", () => {
        expect(flightIds(mainNodes())).toEqual(["t-3", "t-6", "t-2", "t-4", "t-5"]);
    });

    it("is empty once every task merged", () => {
        const done = { ...MAIN_DAG, tasks: MAIN_DAG.tasks.map((t) => ({ ...t, state: "done", merged: true })) };
        expect(flightIds(graphNodes(done, undefined, [], NOW))).toEqual([]);
    });
});

describe("graph state moves", () => {
    const focus7: RunGraphState = { mode: "focus", focus: "t-7", trail: [] };

    it("a chip or a Lanes row opens Focus on the task with an empty trail", () => {
        expect(focusOn("t-3")).toEqual({ mode: "focus", focus: "t-3", trail: [] });
    });

    it("moving pushes the trail and back pops it", () => {
        const moved = moveTo(focus7, "t-3");
        expect(moved).toEqual({ mode: "focus", focus: "t-3", trail: ["t-7"] });
        expect(backFrom(moved)).toEqual(focus7);
    });

    it("Lanes keeps the selection, and Focus returns to it, else to the fallback", () => {
        const lanes = toLanes(moveTo(focus7, "t-3"));
        expect(lanes).toEqual({ mode: "lanes", focus: "t-3", trail: ["t-7"] });
        expect(toFocus(lanes, "t-1")).toMatchObject({ mode: "focus", focus: "t-3" });
        expect(toFocus(undefined, "t-1")).toEqual({ mode: "focus", focus: "t-1", trail: [] });
    });

    it("steps forward into Focus or deeper, back out to Lanes or up the trail", () => {
        const moved = moveTo(focus7, "t-3");
        expect(stepDir(undefined, focus7)).toBe(1);
        expect(stepDir(focus7, moved)).toBe(1);
        expect(stepDir(moved, backFrom(moved))).toBe(-1);
        expect(stepDir(moved, toLanes(moved))).toBe(-1);
        expect(stepDir(moved, focusOn("t-5"))).toBe(1);
    });

    it("the DAG opens on the focused task only in Focus", () => {
        expect(dagFocusTask(focus7)).toBe("t-7");
        expect(dagFocusTask(toLanes(focus7))).toBeNull();
        expect(dagFocusTask(undefined)).toBeNull();
    });
});

describe("graphEscapeKey", () => {
    const run = (view: RunView, graph?: RunGraphState): WorkspaceTab => ({ kind: "run", runId: "r1", view, graph });
    const ws = (tabs: WorkspaceTab[], active: string | null, extra: Partial<WorkspaceState> = {}): WorkspaceState => ({
        ...EMPTY_WORKSPACE,
        tabs,
        active,
        ...extra,
    });
    const inFocus = run("graph", { mode: "focus", focus: "t-3", trail: [] });

    it("is the run tab's key on Graph in Focus", () => {
        expect(graphEscapeKey(ws([inFocus], "run:r1"))).toBe("run:r1");
    });

    it("is null in Lanes, on Tasks, or with another tab active", () => {
        expect(graphEscapeKey(ws([run("graph", { mode: "lanes", focus: "t-3", trail: [] })], "run:r1"))).toBeNull();
        expect(graphEscapeKey(ws([run("tasks", { mode: "focus", focus: "t-3", trail: [] })], "run:r1"))).toBeNull();
        expect(graphEscapeKey(ws([inFocus, { kind: "changes", selected: null }], "changes"))).toBeNull();
        expect(graphEscapeKey(ws([], null))).toBeNull();
    });

    it("is null while the pane is collapsed, as the tab is not on screen", () => {
        expect(graphEscapeKey(ws([inFocus], "run:r1", { collapsed: true }))).toBeNull();
    });
});
