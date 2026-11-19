// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { CanvasBoard } from "./canvasmodel";
import type { CanvasState } from "./canvasstore";
import { previewFit, stepListBoard, tabRows, tabView } from "./workspacecanvastabmodel";

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

describe("tabRows", () => {
    const listed = [
        board("Talk.dc.html", 1280, 800),
        board("Main.dc.html", 400, 800),
        board("Wide.dc.html", 1440, 2500),
    ];

    it("keeps canvas order, labels each board without .dc.html and sizes it with ×", () => {
        const rows = tabRows(state({ boards: listed, board: "Main.dc.html" }));
        expect(rows.map((r) => [r.board.name, r.label, r.size])).toEqual([
            ["Talk.dc.html", "Talk", "1280×800"],
            ["Main.dc.html", "Main", "400×800"],
            ["Wide.dc.html", "Wide", "1440×2500"],
        ]);
    });

    it("selects exactly the row of the board shown", () => {
        const rows = tabRows(state({ boards: listed, board: "Wide.dc.html" }));
        expect(rows.map((r) => r.selected)).toEqual([false, false, true]);
    });

    it("selects the first row for a stale pick", () => {
        const rows = tabRows(state({ boards: listed, board: "Gone.dc.html" }));
        expect(rows.map((r) => r.selected)).toEqual([true, false, false]);
    });

    it("has no rows, so none selected, with no boards", () => {
        expect(tabRows(state({ boards: [] }))).toEqual([]);
    });
});

describe("previewFit", () => {
    const BOX_W = 106;
    const BOX_H = 64;
    const inside = (w: number, h: number) => {
        const f = previewFit(w, h);
        return {
            ...f,
            right: f.left + w * f.scale,
            bottom: f.top + h * f.scale,
        };
    };

    it("fits a 1280×800 board to the box's height, centred side to side", () => {
        const f = inside(1280, 800);
        // 106 / 1280 shrinks it to 106×66.25, too tall: the height binds at 64 / 800, so it is 102.4 wide
        expect(f.scale).toBeCloseTo(0.08);
        expect(f.top).toBeCloseTo(0);
        expect(f.bottom).toBeCloseTo(BOX_H);
        expect(f.left).toBeCloseTo((BOX_W - 102.4) / 2);
        expect(f.right).toBeCloseTo(BOX_W - (BOX_W - 102.4) / 2);
    });

    it("fits a tall 400×800 board to the box's height, centred side to side", () => {
        const f = inside(400, 800);
        expect(f.scale).toBeCloseTo(0.08);
        expect(f.top).toBeCloseTo(0);
        expect(f.bottom).toBeCloseTo(BOX_H);
        // 32 wide
        expect(f.left).toBeCloseTo(37);
        expect(f.right).toBeCloseTo(69);
    });

    it("fits a 1440×2500 board wholly inside, centred side to side", () => {
        const f = inside(1440, 2500);
        expect(f.scale).toBeCloseTo(64 / 2500);
        expect(f.top).toBeCloseTo(0);
        expect(f.bottom).toBeCloseTo(BOX_H);
        // 36.864 wide
        expect(f.left).toBeCloseTo((BOX_W - 36.864) / 2);
        expect(f.right).toBeLessThanOrEqual(BOX_W);
    });

    it("fits a wide board to the box's width, centred top to bottom", () => {
        const f = inside(2120, 640);
        expect(f.scale).toBeCloseTo(0.05);
        expect(f.left).toBeCloseTo(0);
        expect(f.right).toBeCloseTo(BOX_W);
        // 32 tall
        expect(f.top).toBeCloseTo(16);
        expect(f.bottom).toBeCloseTo(48);
    });
});

describe("tabView", () => {
    it("maps each status to its view", () => {
        expect(tabView(state({ status: "ready", boards: boards(2) }))).toBe("boards");
        expect(tabView(state({ status: "removed", boards: boards(2) }))).toBe("removed");
        expect(tabView(state({ status: "server-down", boards: boards(2) }))).toBe("server-down");
    });

    it("reads a ready canvas with no boards as no-boards", () => {
        expect(tabView(state({ status: "ready", boards: [] }))).toBe("no-boards");
    });

    it("keeps probing with no boards on the (empty) list, so attaching never flashes no-boards", () => {
        expect(tabView(state({ status: "probing", boards: [] }))).toBe("boards");
    });

    it("keeps removed and server-down when there are no boards", () => {
        expect(tabView(state({ status: "removed", boards: [] }))).toBe("removed");
        expect(tabView(state({ status: "server-down", boards: [] }))).toBe("server-down");
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
