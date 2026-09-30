// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    addMark,
    boxToMark,
    canvasHandoffLine,
    cropRect,
    feedbackRelPath,
    nextFeedbackName,
    removeMark,
    setMarkNote,
    type Mark,
} from "./canvasmarks";

function mark(note: string, x = 0): Mark {
    return { x, y: 0, w: 20, h: 20, note };
}

describe("boxToMark", () => {
    it("normalizes a right-to-left, bottom-to-top drag", () => {
        expect(boxToMark({ x0: 100, y0: 80, x1: 40, y1: 20 })).toEqual({ x: 40, y: 20, w: 60, h: 60, note: "" });
    });

    it("keeps only a box over the minimum on both sides", () => {
        expect(boxToMark({ x0: 0, y0: 0, x1: 10, y1: 40 })).toBeNull();
        expect(boxToMark({ x0: 0, y0: 0, x1: 40, y1: 10 })).toBeNull();
        expect(boxToMark({ x0: 0, y0: 0, x1: 11, y1: 11 })).toEqual({ x: 0, y: 0, w: 11, h: 11, note: "" });
    });
});

describe("mark list", () => {
    it("appends a big enough box and ignores a click-sized one", () => {
        const one = addMark([], { x0: 0, y0: 0, x1: 11, y1: 11 });
        expect(one).toHaveLength(1);
        expect(addMark(one, { x0: 0, y0: 0, x1: 10, y1: 40 })).toBe(one);
    });

    it("removes by index and keeps the rest in order", () => {
        expect(removeMark([mark("a"), mark("b"), mark("c")], 1).map((m) => m.note)).toEqual(["a", "c"]);
    });

    it("sets one mark's note", () => {
        const marks = [mark("a"), mark("b")];
        const next = setMarkNote(marks, 1, "too wide");
        expect(next.map((m) => m.note)).toEqual(["a", "too wide"]);
        expect(marks[1].note).toBe("b");
    });
});

describe("nextFeedbackName", () => {
    it("starts at 001", () => {
        expect(nextFeedbackName([])).toBe("001.png");
    });

    // only NNN.png counts: a notes file, a two-digit name or a backup must not move the number
    it("follows the highest numbered capture and ignores other files", () => {
        expect(nextFeedbackName(["001.png", "003.png", "notes.txt", "12.png", "007.png.bak"])).toBe("004.png");
    });

    it("keeps counting past 999", () => {
        expect(nextFeedbackName(["999.png"])).toBe("1000.png");
        expect(nextFeedbackName(["999.png", "1000.png"])).toBe("1001.png");
    });
});

describe("feedbackRelPath", () => {
    it("is relative to the agent's cwd with forward slashes", () => {
        expect(feedbackRelPath("t", "003.png")).toBe(".superpowers/design/t/feedback/003.png");
    });
});

describe("canvasHandoffLine", () => {
    it("numbers the marks, names an empty note, and stays one line", () => {
        const line = canvasHandoffLine(".superpowers/design/t/feedback/003.png", "Main.dc.html", [
            mark("too wide"),
            mark("  "),
            mark("a\nb"),
        ]);
        expect(line).toBe(
            "look at .superpowers/design/t/feedback/003.png — marks on Main.dc.html: 1 too wide; 2 (no note); 3 a b"
        );
    });

    // only the line matters: a ; inside a note is kept as written
    it("keeps a semicolon in a note verbatim", () => {
        expect(canvasHandoffLine("f.png", "Main.dc.html", [mark("a; b")])).toBe(
            "look at f.png — marks on Main.dc.html: 1 a; b"
        );
    });
});

describe("cropRect", () => {
    it("scales the board rect to the capture's pixels", () => {
        expect(cropRect({ left: 100, top: 50, width: 640, height: 400 }, 1600, { width: 3200, height: 1900 })).toEqual({
            sx: 200,
            sy: 100,
            sw: 1280,
            sh: 800,
        });
    });

    it("clamps to the bitmap", () => {
        expect(
            cropRect({ left: 1200, top: 800, width: 640, height: 400 }, 1600, { width: 3200, height: 1900 })
        ).toEqual({ sx: 2400, sy: 1600, sw: 800, sh: 300 });
    });
});
