// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { CanvasBoard } from "./canvasmodel";
import type { CanvasState } from "./canvasstore";
import { canvasListLayout, stepListBoard } from "./workspacecanvastabmodel";

const board = (name: string, w = 1440, h = 900): CanvasBoard => ({ name, x: 0, y: 0, w, h });
const boards = (n: number): CanvasBoard[] => Array.from({ length: n }, (_, i) => board(`B${i}.dc.html`));

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

describe("canvasListLayout", () => {
    it("stacks every board top to bottom at the pane's width, a label row above each and 18px between items", () => {
        const l = canvasListLayout(boards(3), 720);
        // 1440x900 at 720px wide: half size, 450px tall; each item is a 22px label row then the frame
        expect(l.frames.map((f) => [f.left, f.labelTop, f.top, f.width, f.height, f.scale])).toEqual([
            [0, 0, 22, 720, 450, 0.5],
            [0, 490, 512, 720, 450, 0.5],
            [0, 980, 1002, 720, 450, 0.5],
        ]);
        expect(l.width).toBe(720);
        expect(l.height).toBe(3 * (22 + 450) + 2 * 18);
        expect(l.frames.map((f) => f.board.name)).toEqual(["B0.dc.html", "B1.dc.html", "B2.dc.html"]);
    });

    it("never grows a board narrower than the pane", () => {
        const l = canvasListLayout([board("Small.dc.html", 400, 300)], 900);
        expect(l.frames[0]).toMatchObject({ width: 400, height: 300, scale: 1 });
        expect(l.width).toBe(400);
        expect(l.height).toBe(22 + 300);
    });

    it("fits each board on its own: a wide one shrinks, a narrow one keeps its size", () => {
        const l = canvasListLayout([board("Wide.dc.html", 1200, 600), board("Narrow.dc.html", 300, 200)], 600);
        expect(l.frames.map((f) => [f.width, f.height, f.scale])).toEqual([
            [600, 300, 0.5],
            [300, 200, 1],
        ]);
        expect(l.frames[1].labelTop).toBe(22 + 300 + 18);
        expect(l.width).toBe(600);
        expect(l.height).toBe(22 + 300 + 18 + 22 + 200);
    });

    it("lays out nothing for no boards", () => {
        expect(canvasListLayout([], 600)).toMatchObject({ width: 0, height: 0, frames: [] });
    });
});

describe("stepListBoard", () => {
    const s = state({ boards: boards(3), board: "B1.dc.html" });

    it("moves the selection to the next and previous board, wrapping, with no All among them", () => {
        expect(stepListBoard(s, 1)).toBe("B2.dc.html");
        expect(stepListBoard(s, -1)).toBe("B0.dc.html");
        expect(stepListBoard({ ...s, board: "B2.dc.html" }, 1)).toBe("B0.dc.html");
        expect(stepListBoard({ ...s, board: "B0.dc.html" }, -1)).toBe("B2.dc.html");
    });

    it("steps from the board the list shows selected even while the window left the canvas on All", () => {
        expect(stepListBoard({ ...s, all: true }, 1)).toBe("B2.dc.html");
    });

    it("has nowhere to go with no boards", () => {
        expect(stepListBoard(state({}), 1)).toBeNull();
    });
});
