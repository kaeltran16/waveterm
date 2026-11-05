// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { HISTORY_COLLAPSE_PX, historyLayout, resolveCollapsed } from "./difflayout";

describe("resolveCollapsed", () => {
    it("collapses by default below the threshold — the shipped window is 1000px wide", () => {
        expect(resolveCollapsed(null, 1000)).toBe(true);
    });

    it("expands by default above the threshold", () => {
        expect(resolveCollapsed(null, 1600)).toBe(false);
    });

    it("treats the threshold itself as wide enough", () => {
        expect(resolveCollapsed(null, HISTORY_COLLAPSE_PX)).toBe(false);
    });

    // an explicit choice is a choice: resizing must not silently undo it
    it("lets an explicit expand win at a narrow width", () => {
        expect(resolveCollapsed(false, 900)).toBe(false);
    });

    it("lets an explicit collapse win at a wide width", () => {
        expect(resolveCollapsed(true, 1900)).toBe(true);
    });

    // width is 0 before the first ResizeObserver callback; collapsing then would flash the rail
    it("does not collapse on an unmeasured width", () => {
        expect(resolveCollapsed(null, 0)).toBe(false);
    });
});

describe("historyLayout", () => {
    // expanding below the threshold overlays instead of pushing two fixed columns into the window,
    // which is what left the diff pane 162px wide
    it("overlays an explicit expand below the threshold", () => {
        expect(historyLayout(false, 1000)).toBe("overlay");
    });

    it("is a column when expanded at a wide width", () => {
        expect(historyLayout(false, 1600)).toBe("column");
        expect(historyLayout(null, 1600)).toBe("column");
        expect(historyLayout(false, HISTORY_COLLAPSE_PX)).toBe("column");
    });

    it("is a rail when collapsed, explicitly or by width", () => {
        expect(historyLayout(true, 1600)).toBe("rail");
        expect(historyLayout(null, 1000)).toBe("rail");
    });

    it("is a column on an unmeasured width", () => {
        expect(historyLayout(null, 0)).toBe("column");
        expect(historyLayout(false, 0)).toBe("column");
    });
});
