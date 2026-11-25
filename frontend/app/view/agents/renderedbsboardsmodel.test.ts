// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { BrainstormFile, BrainstormQuestion } from "./brainstormmodel";
import type { CanvasBoard } from "./canvasmodel";
import type { CanvasState } from "./canvasstore";
import {
    boardCount,
    boardsUpdatedMs,
    canvasRevealView,
    mockupView,
    questionChips,
    revealBoard,
    revealedCanvas,
    shownOf,
} from "./renderedbsboardsmodel";

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

describe("boardsUpdatedMs", () => {
    it("is the newest Last-Modified among the served boards", () => {
        expect(boardsUpdatedMs(state({ boardModifiedMs: { "Main.dc.html": 1000, "States.dc.html": 3000 } }))).toBe(
            3000
        );
    });

    it("is null with no board served, or only boards served without a Last-Modified", () => {
        expect(boardsUpdatedMs(state())).toBeNull();
        expect(boardsUpdatedMs(state({ boardModifiedMs: { "Main.dc.html": 0 } }))).toBeNull();
    });

    it("ignores a board file canvas.json no longer names", () => {
        expect(boardsUpdatedMs(state({ boardModifiedMs: { "Main.dc.html": 1000, "Gone.dc.html": 9000 } }))).toBe(1000);
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

describe("questionChips", () => {
    const BASE = "http://127.0.0.1:5005/canvas/tok";
    const MAIN = "Main.dc.html";
    const STATES = "States.dc.html";
    const asked = (q: Partial<BrainstormQuestion>, partBoards: string[] = [MAIN, STATES]): BrainstormFile => ({
        v: 1,
        title: "Final queue",
        spec: "",
        canvas: "final-queue",
        question: { n: 4, text: "Should a waiting verify show in the graph?", part: "approach", ...q },
        working: null,
        parts: [{ id: "approach", title: "Approach", state: "asked", body: "", boards: partBoards }],
        history: [],
        done: false,
        check: null,
        run: null,
    });
    const opt = (label: string, boards?: string[]) => ({ label, detail: "", ...(boards ? { boards } : {}) });
    const onCanvas = [MAIN, STATES];

    it("gives each option's chip boards, in option order (Main)", () => {
        const f = asked({ options: [opt("A queued chip", [MAIN]), opt("Only the banner"), opt("Both", [STATES])] });
        expect(questionChips(f, BASE, onCanvas)).toEqual([[MAIN], [], [STATES]]);
    });

    it("gives a board only an asked part names no chip", () => {
        const f = asked({ options: [opt("A", [STATES]), opt("B")] }, [MAIN, STATES]);
        expect(questionChips(f, BASE, onCanvas)).toEqual([[STATES], []]);
    });

    it("gives a board two options name a chip on each", () => {
        const f = asked({ options: [opt("A", [MAIN]), opt("B", [MAIN, STATES])] });
        expect(questionChips(f, BASE, onCanvas)).toEqual([[MAIN], [MAIN, STATES]]);
    });

    it("leaves out a board an option names that the canvas does not have", () => {
        const f = asked({ options: [opt("A", ["Gone.dc.html", MAIN]), opt("B")] }, [MAIN]);
        expect(questionChips(f, BASE, [MAIN])).toEqual([[MAIN], []]);
    });

    it("chips the approaches' boards while the judge weighs them", () => {
        const f = asked({
            options: [opt("A", [MAIN])],
            approaches: [
                { name: "Chip", description: "", facts: [] },
                { name: "Banner", description: "", facts: [], boards: [STATES] },
            ],
        });
        expect(questionChips(f, BASE, onCanvas, true)).toEqual([[], [STATES]]);
    });

    it("has nothing to draw until the canvas is served, or with no board named", () => {
        const f = asked({ options: [opt("A", [MAIN])] });
        expect(questionChips(f, null, onCanvas)).toBeNull();
        expect(questionChips({ ...f, canvas: undefined }, BASE, onCanvas)).toBeNull();
        expect(questionChips(asked({ options: [opt("A")] }, []), BASE, onCanvas)).toBeNull();
    });
});

describe("boardCount", () => {
    it("counts in the singular for one board", () => {
        expect(boardCount(1)).toBe("1 board");
        expect(boardCount(2)).toBe("2 boards");
    });
});

describe("canvasRevealView", () => {
    const base = { latest: true, topic: "final-queue", canvas: state() };

    it("draws the card on the latest reveal and an opening row on an earlier one", () => {
        expect(canvasRevealView(base)).toBe("card");
        expect(canvasRevealView({ ...base, latest: false })).toBe("row-open");
    });

    it("keeps the plain row for a canvas the agent no longer has, or one removed", () => {
        expect(canvasRevealView({ ...base, canvas: null })).toBe("row");
        expect(canvasRevealView({ ...base, topic: "older-topic" })).toBe("row");
        expect(canvasRevealView({ ...base, latest: false, canvas: state({ status: "removed" }) })).toBe("row");
    });

    it("leaves a removed canvas's latest reveal to the card, which draws the removed row", () => {
        expect(canvasRevealView({ ...base, canvas: state({ status: "removed" }) })).toBe("card");
    });
});

describe("revealedCanvas and revealBoard", () => {
    it("reads the topic and board a reveal names, and nothing else", () => {
        expect(revealedCanvas("canvas:final-queue/States")).toEqual({ topic: "final-queue", board: "States.dc.html" });
        expect(revealedCanvas("canvas:final-queue")).toEqual({ topic: "final-queue", board: undefined });
        expect(revealedCanvas("run:eb4d4b0e")).toBeNull();
        expect(revealedCanvas(undefined)).toBeNull();
    });

    it("opens the board a reveal named while served, else the canvas's own board, else the first", () => {
        const served = { "Main.dc.html": 1, "States.dc.html": 2 };
        const s = state({ boardModifiedMs: served });
        expect(revealBoard(s, "States.dc.html")).toBe("States.dc.html");
        expect(revealBoard(state({ boardModifiedMs: served, board: "States.dc.html" }), undefined)).toBe(
            "States.dc.html"
        );
        expect(revealBoard(s, "Gone.dc.html")).toBe("Main.dc.html");
        expect(revealBoard(state({ boardModifiedMs: {} }), undefined)).toBe("Main.dc.html");
    });
});
