// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { stillDismissed, suggestKey } from "./composersuggestmodel";

const key = (k: string, extra: { shiftKey?: boolean; isComposing?: boolean } = {}) => ({
    key: k,
    shiftKey: extra.shiftKey ?? false,
    isComposing: extra.isComposing,
});

describe("suggestKey", () => {
    it("moves down and wraps from the last row to the first", () => {
        expect(suggestKey(key("ArrowDown"), 0, 3)).toEqual({ move: 1 });
        expect(suggestKey(key("ArrowDown"), 2, 3)).toEqual({ move: 0 });
    });
    it("moves up and wraps from the first row to the last", () => {
        expect(suggestKey(key("ArrowUp"), 2, 3)).toEqual({ move: 1 });
        expect(suggestKey(key("ArrowUp"), 0, 3)).toEqual({ move: 2 });
    });
    it("picks the highlighted row on Tab and Enter", () => {
        expect(suggestKey(key("Tab"), 1, 3)).toEqual({ pick: 1 });
        expect(suggestKey(key("Enter"), 2, 3)).toEqual({ pick: 2 });
    });
    it("closes on Escape", () => {
        expect(suggestKey(key("Escape"), 0, 3)).toEqual({ close: true });
    });
    it("leaves Shift+Enter to the box as a newline", () => {
        expect(suggestKey(key("Enter", { shiftKey: true }), 0, 3)).toBeNull();
    });
    it("leaves keys during an IME composition to the box", () => {
        for (const k of ["Enter", "Tab", "ArrowDown", "Escape"]) {
            expect(suggestKey(key(k, { isComposing: true }), 0, 3)).toBeNull();
        }
    });
    it("handles no key when there are no rows", () => {
        for (const k of ["Enter", "Tab", "ArrowDown", "ArrowUp", "Escape"]) {
            expect(suggestKey(key(k), 0, 0)).toBeNull();
        }
    });
    it("leaves other keys to the box", () => {
        expect(suggestKey(key("a"), 0, 3)).toBeNull();
        expect(suggestKey(key("Backspace"), 0, 3)).toBeNull();
    });
});

describe("stillDismissed", () => {
    it("stays dismissed while the caret is in the word Esc closed", () => {
        expect(stillDismissed(4, 4)).toBe(true);
    });
    it("reopens once the caret leaves every panel word", () => {
        expect(stillDismissed(4, null)).toBe(false);
    });
    it("reopens on a word with another start", () => {
        expect(stillDismissed(4, 9)).toBe(false);
    });
    it("is not dismissed when nothing was", () => {
        expect(stillDismissed(null, 4)).toBe(false);
        expect(stillDismissed(null, null)).toBe(false);
    });
});
