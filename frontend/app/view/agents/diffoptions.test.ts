// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    isNewFile,
    LABELLED_MIN_PX,
    paneHeaderLayout,
    paneOptions,
    SPLIT_MIN_PX,
    splitHintText,
    wrapSignLines,
} from "./diffoptions";

describe("the hint on removed lines in the unified view", () => {
    it("points at the split toggle when the pane can draw split", () => {
        expect(splitHintText(true)).toBe("Removed lines: switch to split (⇧D) to comment on them");
    });
    // ⇧D declines on a narrow pane, so naming it there would send the user to a dead key
    it("says how to make room for split when the pane is too narrow", () => {
        expect(splitHintText(false)).toBe(
            "Removed lines: collapse history (⇧H) or widen the window to use split view and comment on them"
        );
    });
});

describe("the diff pane's view switches", () => {
    it("asks for two editors only when split is on", () => {
        expect(paneOptions(true, false).renderSideBySide).toBe(true);
        expect(paneOptions(false, false).renderSideBySide).toBe(false);
    });

    // Monaco's own default is to ignore it, which renders a whitespace-only change as no change at
    // all while the counts in the same header read +2 -2. The pane has to say what git said.
    it("shows whitespace-only changes unless asked not to", () => {
        expect(paneOptions(false, false).ignoreTrimWhitespace).toBe(false);
        expect(paneOptions(false, true).ignoreTrimWhitespace).toBe(true);
    });

    // a new file is one all-lines hunk, so a + on every line says nothing
    it("drops the per-line +/- markers only for a new file", () => {
        expect(paneOptions(false, false).renderIndicators).toBe(true);
        expect(paneOptions(false, false, true).renderIndicators).toBe(false);
    });

    it("calls a file new only when the original is empty and the modified is not", () => {
        expect(isNewFile("", "a\n")).toBe(true);
        expect(isNewFile("", "")).toBe(false);
        expect(isNewFile("a\n", "b\n")).toBe(false);
        expect(isNewFile("a\n", "")).toBe(false);
    });

    // the change map is a 30px column next to the scrollbar, unlike any other scrollbar in the app
    it("draws no diff overview ruler", () => {
        expect(paneOptions(false, false).renderOverviewRuler).toBe(false);
        expect(paneOptions(true, false).renderOverviewRuler).toBe(false);
    });

    it("never lets either side be typed into", () => {
        const o = paneOptions(true, true);
        expect(o.readOnly).toBe(true);
        expect(o.originalEditable).toBe(false);
    });
});

describe("the pane header's layout at a measured width", () => {
    it("drops split and labels on a narrow pane", () => {
        expect(paneHeaderLayout(760)).toEqual({ split: false, labelled: false });
    });
    it("offers split before it can afford labels", () => {
        expect(paneHeaderLayout(SPLIT_MIN_PX)).toEqual({ split: true, labelled: false });
        expect(paneHeaderLayout(LABELLED_MIN_PX - 1)).toEqual({ split: true, labelled: false });
    });
    it("labels the buttons once the pane is wide enough", () => {
        expect(paneHeaderLayout(LABELLED_MIN_PX)).toEqual({ split: true, labelled: true });
    });
    it("treats an unmeasured pane as narrow", () => {
        expect(paneHeaderLayout(0)).toEqual({ split: false, labelled: false });
    });
});

describe("the pane's fixed chrome", () => {
    it("stops scrolling at the last line, with no minimap", () => {
        const o = paneOptions(false, false);
        expect(o.scrollBeyondLastLine).toBe(false);
        expect(o.minimap).toStrictEqual({ enabled: false });
    });

    it("scrolls smoothly, with thin scrollbars and no shadows", () => {
        const o = paneOptions(false, false);
        expect(o.smoothScrolling).toBe(true);
        expect(o.scrollbar).toStrictEqual({ useShadows: false, verticalScrollbarSize: 6, horizontalScrollbarSize: 6 });
    });

    // monaco's default is off, so a ligature face like Fira Code draws -> as two plain glyphs
    it("draws the code font's ligatures", () => {
        expect(paneOptions(false, false).fontLigatures).toBe(true);
    });
});

describe("commenting", () => {
    // the comment + is a glyph-margin widget, which Monaco only draws with the margin on
    it("draws the glyph margin in both views", () => {
        expect(paneOptions(false, false).glyphMargin).toBe(true);
        expect(paneOptions(true, false).glyphMargin).toBe(true);
    });
});

describe("word wrap", () => {
    it("wraps the modified editor and the diff only when asked", () => {
        const on = paneOptions(false, false, false, true);
        expect(on.wordWrap).toBe("on");
        expect(on.diffWordWrap).toBe("on");
        for (const o of [paneOptions(false, false), paneOptions(true, false, false, false)]) {
            expect(o.wordWrap).not.toBe("on");
            expect(o.diffWordWrap).not.toBe("on");
        }
    });
});

describe("folding", () => {
    it("folds unchanged regions with three lines of context", () => {
        expect(paneOptions(false, false).hideUnchangedRegions).toEqual({
            enabled: true,
            contextLineCount: 3,
            minimumLineCount: 3,
            revealLineCount: 20,
        });
    });
});

// monaco draws its indicator on every visual row of a wrapped line, so with wrap on the pane draws its own
describe("the +/- signs when wrapped", () => {
    it("turns monaco's indicators off with wrap, and keeps the new-file rule without it", () => {
        expect(paneOptions(false, false, false, true).renderIndicators).toBe(false);
        expect(paneOptions(false, false, false, false).renderIndicators).toBe(true);
        expect(paneOptions(false, false, true, true).renderIndicators).toBe(false);
        expect(paneOptions(false, false, true, false).renderIndicators).toBe(false);
    });

    const change = (os: number, oe: number, ms: number, me: number) => ({
        originalStartLineNumber: os,
        originalEndLineNumber: oe,
        modifiedStartLineNumber: ms,
        modifiedEndLineNumber: me,
    });

    it("lists every inserted line once and every deleted line once", () => {
        // a pure insert of lines 2-3, a replace of original 5-6 by modified 7, a pure delete of original 9
        const r = wrapSignLines([change(1, 0, 2, 3), change(5, 6, 7, 7), change(9, 9, 10, 0)], false);
        expect(r).toEqual({ inserted: [2, 3, 7], deleted: [5, 6, 9] });
    });

    it("lists nothing for a new file or no changes", () => {
        expect(wrapSignLines([change(0, 0, 1, 4)], true)).toEqual({ inserted: [], deleted: [] });
        expect(wrapSignLines([], false)).toEqual({ inserted: [], deleted: [] });
    });
});
