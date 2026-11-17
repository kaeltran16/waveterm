// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { CanvasBoard } from "./canvasmodel";
import type { CanvasState } from "./canvasstore";
import { boardCount, mockupView, shownOf } from "./renderedbsboardsmodel";

const BOARDS: CanvasBoard[] = [
    { name: "Main.dc.html", x: 0, y: 0, w: 1440, h: 900 },
    { name: "States.dc.html", x: 1520, y: 0, w: 1000, h: 600 },
];

function state(over: Partial<CanvasState> = {}): CanvasState {
    return {
        topic: "final-queue",
        dir: "/p/.superpowers/design/final-queue",
        projectDir: "/p",
        mode: "terminal",
        board: null,
        all: false,
        boards: BOARDS,
        base: "http://127.0.0.1:5005/canvas/tok",
        status: "ready",
        lastModifiedMs: null,
        lastViewedMs: 0,
        marking: false,
        mark: null,
        reloadKey: 0,
        ...over,
    };
}

describe("mockupView", () => {
    it("is waiting before the first poll answers", () => {
        expect(mockupView(state({ status: "probing", base: null, boards: [] }))).toEqual({ kind: "probing" });
    });

    it("has no boards while canvas.json names boards whose files are not written yet", () => {
        expect(mockupView(state({ boardModifiedMs: {} }))).toEqual({ kind: "empty" });
        expect(mockupView(state())).toEqual({ kind: "empty" });
    });

    it("draws the boards whose files are there, in canvas order", () => {
        const s = state({ boardModifiedMs: { "States.dc.html": 2, "Main.dc.html": 1 } });
        expect(mockupView(s)).toEqual({ kind: "boards", boards: ["Main.dc.html", "States.dc.html"] });
        expect(mockupView(state({ boardModifiedMs: { "States.dc.html": 2 } }))).toEqual({
            kind: "boards",
            boards: ["States.dc.html"],
        });
    });

    it("is not served while the server is down, still counting the boards it last read", () => {
        const s = state({
            status: "server-down",
            base: null,
            boardModifiedMs: { "Main.dc.html": 1, "States.dc.html": 2 },
        });
        expect(mockupView(s)).toEqual({ kind: "server-down", count: 2 });
    });

    it("is removed once the canvas folder is gone, whatever was read before", () => {
        expect(mockupView(state({ status: "removed", boardModifiedMs: { "Main.dc.html": 1 } }))).toEqual({
            kind: "removed",
        });
    });
});

describe("shownOf", () => {
    it("keeps the board asked for while it is among the tabs", () => {
        expect(shownOf(["Main.dc.html", "States.dc.html"], "States.dc.html")).toBe("States.dc.html");
    });

    it("falls back to the first tab for no pick, or one no longer there", () => {
        expect(shownOf(["Main.dc.html", "States.dc.html"], null)).toBe("Main.dc.html");
        expect(shownOf(["Main.dc.html"], "States.dc.html")).toBe("Main.dc.html");
        expect(shownOf([], "States.dc.html")).toBeNull();
    });
});

describe("boardCount", () => {
    it("counts in the singular for one board", () => {
        expect(boardCount(1)).toBe("1 board");
        expect(boardCount(2)).toBe("2 boards");
    });
});
