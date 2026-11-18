// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { CanvasBoard } from "./canvasmodel";
import type { CanvasState } from "./canvasstore";
import { canvasEscape, windowGridLayout } from "./canvaswindowmodel";

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
