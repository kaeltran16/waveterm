// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { LABELLED_MIN_PX, paneHeaderLayout, paneOptions, SPLIT_MIN_PX, splitHintText } from "./diffoptions";

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
