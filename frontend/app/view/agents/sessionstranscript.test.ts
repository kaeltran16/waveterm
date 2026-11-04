import { describe, expect, it } from "vitest";
import { mayHaveEarlier, shouldStick, TAIL_LINES, TIMELINE_RENDER_CAP, transcriptMaxLines } from "./sessionstranscript";

describe("transcriptMaxLines", () => {
    it("tails a claude transcript", () => {
        expect(transcriptMaxLines("claude", false)).toBe(TAIL_LINES);
    });
    it("reads all of a pi transcript, whose active branch needs the whole file", () => {
        expect(transcriptMaxLines("pi", false)).toBe(-1);
    });
    it("reads all once full", () => {
        expect(transcriptMaxLines("claude", true)).toBe(-1);
    });
});

describe("mayHaveEarlier", () => {
    it("is true when the tail came back full", () => {
        expect(mayHaveEarlier(TAIL_LINES, TAIL_LINES, 10, false)).toBe(true);
    });
    it("is true when the items exceed the render cap", () => {
        expect(mayHaveEarlier(500, -1, TIMELINE_RENDER_CAP + 1, false)).toBe(true);
    });
    it("is false for a short tail under the cap", () => {
        expect(mayHaveEarlier(TAIL_LINES - 1, TAIL_LINES, TIMELINE_RENDER_CAP, false)).toBe(false);
    });
    it("is false for a whole-file read under the cap", () => {
        expect(mayHaveEarlier(5000, -1, 10, false)).toBe(false);
    });
    it("is false once already full", () => {
        expect(mayHaveEarlier(TAIL_LINES, TAIL_LINES, TIMELINE_RENDER_CAP + 1, true)).toBe(false);
    });
});

describe("shouldStick", () => {
    it("sticks at the bottom", () => {
        expect(shouldStick(600, 1000, 400)).toBe(true);
    });
    it("sticks within 40px of the bottom", () => {
        expect(shouldStick(560, 1000, 400)).toBe(true);
    });
    it("does not stick for a reader who scrolled up", () => {
        expect(shouldStick(559, 1000, 400)).toBe(false);
        expect(shouldStick(0, 1000, 400)).toBe(false);
    });
    it("sticks when the content fits", () => {
        expect(shouldStick(0, 300, 400)).toBe(true);
    });
});
