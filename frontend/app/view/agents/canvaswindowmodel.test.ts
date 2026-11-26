// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { CanvasBoard } from "./canvasmodel";
import type { CanvasState } from "./canvasstore";
import {
    canvasEscape,
    digitTab,
    OTHER_TAB,
    otherBoards,
    windowGridLayout,
    windowTab,
    windowTabs,
    type BandAnswer,
    type ScopeBand,
    type WindowScope,
} from "./canvaswindowmodel";

function state(over: Partial<CanvasState>): CanvasState {
    return {
        topic: "t",
        dir: "/p/.superpowers/design/t",
        projectDir: "/p",
        mode: "terminal",
        board: null,
        all: false,
        boards: [],
        base: null,
        status: "ready",
        lastModifiedMs: null,
        lastViewedMs: 0,
        marking: false,
        mark: null,
        reloadKey: 0,
        ...over,
    };
}

const boards = (n: number): CanvasBoard[] =>
    Array.from({ length: n }, (_, i) => ({ name: `B${i}.dc.html`, x: 0, y: 0, w: 1440, h: 900 }));

describe("canvasEscape", () => {
    it("drops a drawn mark first", () => {
        expect(canvasEscape(state({ marking: true, mark: { x: 1, y: 1, w: 9, h: 9, note: "" } }))).toBe("drop-mark");
    });

    it("closes while marking with nothing drawn, and when not marking", () => {
        expect(canvasEscape(state({ marking: true }))).toBe("close");
        expect(canvasEscape(state({}))).toBe("close");
    });
});

describe("windowGridLayout", () => {
    it("lays 6 boards in 2 rows of 3, in canvas order, 80px apart in a row and 120px between rows", () => {
        const layout = windowGridLayout(boards(6), 10_000);
        expect(layout.scale).toBe(1);
        expect(layout.frames.map((f) => [f.board.name, f.left, f.top, f.width, f.height])).toEqual([
            ["B0.dc.html", 0, 0, 1440, 900],
            ["B1.dc.html", 1520, 0, 1440, 900],
            ["B2.dc.html", 3040, 0, 1440, 900],
            ["B3.dc.html", 0, 1020, 1440, 900],
            ["B4.dc.html", 1520, 1020, 1440, 900],
            ["B5.dc.html", 3040, 1020, 1440, 900],
        ]);
        expect([layout.width, layout.height]).toEqual([4480, 1920]);
    });

    it("lays 2 boards in one row of 2", () => {
        const layout = windowGridLayout(boards(2), 10_000);
        expect(layout.frames.map((f) => [f.left, f.top])).toEqual([
            [0, 0],
            [1520, 0],
        ]);
        expect([layout.width, layout.height]).toEqual([2960, 900]);
    });

    it("scales everything so the widest row fits the width", () => {
        const layout = windowGridLayout(boards(6), 2240);
        expect(layout.scale).toBe(0.5);
        expect(layout.frames[4]).toMatchObject({ left: 760, top: 510, width: 720, height: 450 });
        expect([layout.width, layout.height]).toEqual([2240, 960]);
    });

    it("never grows the boards past their size", () => {
        expect(windowGridLayout(boards(1), 5000).scale).toBe(1);
    });
});

const answer = (index: number): BandAnswer => ({
    index,
    label: `A${index}`,
    detail: "",
    pick: false,
    pros: [],
    cons: [],
});
const answersBand = (...idx: number[]): ScopeBand => ({ kind: "answers", answers: idx.map(answer) });
const questionScope = (tabs: [string, ScopeBand][]): WindowScope => ({
    source: { kind: "question", n: 1, text: "q", judging: false, judged: false },
    tabs: tabs.map(([board, band]) => ({ board, label: board, band })),
});
const named = (...names: string[]): CanvasBoard[] => names.map((name) => ({ name, x: 0, y: 0, w: 1440, h: 900 }));

describe("window tabs", () => {
    const scope = questionScope([
        ["A.dc.html", answersBand(0)],
        ["B.dc.html", answersBand(1, 2)],
        ["C.dc.html", answersBand(2)],
    ]);

    it("lists the scope's boards in scope order, without Other boards when every board is a tab", () => {
        expect(windowTabs(scope, named("C.dc.html", "A.dc.html", "B.dc.html"))).toEqual([
            "A.dc.html",
            "B.dc.html",
            "C.dc.html",
        ]);
    });

    it("drops a tab whose board left the canvas and adds Other boards for a board outside the tabs", () => {
        const boards = named("A.dc.html", "C.dc.html", "Extra.dc.html");
        expect(windowTabs(scope, boards)).toEqual(["A.dc.html", "C.dc.html", OTHER_TAB]);
        expect(otherBoards(scope, boards).map((b) => b.name)).toEqual(["Extra.dc.html"]);
    });

    it("shows the shown board's key, and Other boards for the grid or a board outside the tabs", () => {
        const boards = named("A.dc.html", "B.dc.html", "Extra.dc.html");
        expect(windowTab(scope, state({ boards, board: "B.dc.html" }))).toBe("B.dc.html");
        expect(windowTab(scope, state({ boards, board: "B.dc.html", all: true }))).toBe(OTHER_TAB);
        expect(windowTab(scope, state({ boards, board: "Extra.dc.html" }))).toBe(OTHER_TAB);
    });
});

describe("digitTab", () => {
    it("returns an answer's first tab on a question scope, and null past the answers", () => {
        const scope = questionScope([
            ["A.dc.html", answersBand(0)],
            ["B.dc.html", answersBand(1, 2)],
            ["C.dc.html", answersBand(2)],
        ]);
        expect(digitTab(scope, 2)).toBe("B.dc.html");
        expect(digitTab(scope, 0)).toBe("A.dc.html");
        expect(digitTab(scope, 3)).toBeNull();
    });

    it("returns the Nth tab on a part scope", () => {
        const scope: WindowScope = {
            source: { kind: "part", id: "p", title: "P" },
            tabs: ["A.dc.html", "B.dc.html"].map((board) => ({
                board,
                label: board,
                band: { kind: "part", title: "P", gist: "" },
            })),
        };
        expect(digitTab(scope, 1)).toBe("B.dc.html");
        expect(digitTab(scope, 2)).toBeNull();
    });
});
