// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import type { Mark } from "./canvasmarks";
import {
    attachCanvas,
    canvasOwner,
    clearMarks,
    detachCanvas,
    focusedCanvas,
    focusedCanvasMode,
    getCanvas,
    selectCanvasBoard,
    setCanvasMode,
    setMarking,
    stepCanvasBoard,
    updateCanvas,
} from "./canvasstore";

const IDS = ["a1", "a2"];
const A = { topic: "t", dir: "/p/.superpowers/design/t", projectDir: "/p" };
const MARK: Mark = { x: 0, y: 0, w: 20, h: 20, note: "n" };
const BOARDS = [
    { name: "Main.dc.html", w: 1440 },
    { name: "States.dc.html", w: 1440 },
];

function withMarks(id: string): void {
    updateCanvas(id, (s) => ({ ...s, marking: true, marks: [MARK], boards: BOARDS }));
}

afterEach(() => {
    IDS.forEach(detachCanvas);
});

describe("attachCanvas", () => {
    it("starts in terminal mode, probing, with nothing marked", () => {
        attachCanvas("a1", A, 100);
        expect(getCanvas("a1")).toEqual({
            ...A,
            mode: "terminal",
            board: null,
            boards: [],
            port: null,
            status: "probing",
            lastModifiedMs: null,
            lastViewedMs: 100,
            marking: false,
            marks: [],
            reloadKey: 0,
        });
    });

    it("takes the board it was given", () => {
        attachCanvas("a1", { ...A, board: "States.dc.html" }, 100);
        expect(getCanvas("a1").board).toBe("States.dc.html");
    });

    it("resets the board and marks for a new topic", () => {
        attachCanvas("a1", { ...A, board: "States.dc.html" }, 100);
        withMarks("a1");
        updateCanvas("a1", (s) => ({ ...s, port: 8766 }));
        attachCanvas("a1", { topic: "u", dir: "/p/.superpowers/design/u", projectDir: "/p" }, 200);
        const s = getCanvas("a1");
        expect(s.board).toBeNull();
        expect(s.marks).toEqual([]);
        expect(s.port).toBeNull();
    });

    it("keeps the port and the current board for the same topic", () => {
        attachCanvas("a1", { ...A, board: "States.dc.html" }, 100);
        withMarks("a1");
        updateCanvas("a1", (s) => ({ ...s, port: 8766 }));
        attachCanvas("a1", A, 200);
        const s = getCanvas("a1");
        expect(s.port).toBe(8766);
        expect(s.board).toBe("States.dc.html");
        expect(s.marks).toEqual([MARK]);
    });
});

describe("setCanvasMode", () => {
    it("marks the canvas viewed on entering it", () => {
        attachCanvas("a1", A, 100);
        setCanvasMode("a1", "canvas", 500);
        expect(getCanvas("a1").mode).toBe("canvas");
        expect(getCanvas("a1").lastViewedMs).toBe(500);
    });

    it("drops marking and marks on leaving it", () => {
        attachCanvas("a1", A, 100);
        setCanvasMode("a1", "canvas", 500);
        withMarks("a1");
        setCanvasMode("a1", "terminal", 600);
        const s = getCanvas("a1");
        expect(s.mode).toBe("terminal");
        expect(s.marking).toBe(false);
        expect(s.marks).toEqual([]);
    });

    it("changes only the agent it names", () => {
        attachCanvas("a1", A, 100);
        attachCanvas("a2", A, 100);
        setCanvasMode("a2", "canvas", 500);
        setCanvasMode("a1", "canvas", 500);
        setCanvasMode("a1", "terminal", 600);
        expect(getCanvas("a1").mode).toBe("terminal");
        expect(getCanvas("a2").mode).toBe("canvas");
        expect(getCanvas("a2").lastViewedMs).toBe(500);
    });

    it("does nothing for an agent with no canvas", () => {
        setCanvasMode("a1", "canvas", 500);
        expect(getCanvas("a1")).toBeNull();
    });
});

describe("board switches", () => {
    it("steps the board and drops the marks", () => {
        attachCanvas("a1", A, 100);
        withMarks("a1");
        stepCanvasBoard("a1", 1);
        expect(getCanvas("a1").board).toBe("States.dc.html");
        expect(getCanvas("a1").marks).toEqual([]);
    });

    it("selects a board and drops the marks", () => {
        attachCanvas("a1", A, 100);
        withMarks("a1");
        selectCanvasBoard("a1", "States.dc.html");
        expect(getCanvas("a1").board).toBe("States.dc.html");
        expect(getCanvas("a1").marks).toEqual([]);
    });
});

describe("marking", () => {
    it("drops the marks when marking ends", () => {
        attachCanvas("a1", A, 100);
        withMarks("a1");
        setMarking("a1", false);
        expect(getCanvas("a1").marking).toBe(false);
        expect(getCanvas("a1").marks).toEqual([]);
    });

    it("clears the marks and keeps marking on", () => {
        attachCanvas("a1", A, 100);
        withMarks("a1");
        clearMarks("a1");
        expect(getCanvas("a1").marking).toBe(true);
        expect(getCanvas("a1").marks).toEqual([]);
    });
});

describe("ownership", () => {
    it("finds the agent holding a topic, and forgets it on detach", () => {
        attachCanvas("a2", A, 100);
        expect(canvasOwner("t")).toBe("a2");
        expect(canvasOwner("u")).toBeNull();
        detachCanvas("a2");
        expect(getCanvas("a2")).toBeNull();
        expect(canvasOwner("t")).toBeNull();
    });
});

describe("focused canvas", () => {
    const model = { focusIdAtom: atom("a1") } as any;

    it("reads the focused agent's canvas, and only in canvas mode for focusedCanvasMode", () => {
        attachCanvas("a1", A, 100);
        attachCanvas("a2", A, 100);
        setCanvasMode("a2", "canvas", 500);
        expect(focusedCanvas(model)?.topic).toBe("t");
        expect(focusedCanvasMode(model)).toBeNull();
        setCanvasMode("a1", "canvas", 500);
        expect(focusedCanvasMode(model)).toBe(getCanvas("a1"));
    });

    it("is null with nothing focused", () => {
        attachCanvas("a1", A, 100);
        expect(focusedCanvas({ focusIdAtom: atom(undefined) } as any)).toBeNull();
    });
});
