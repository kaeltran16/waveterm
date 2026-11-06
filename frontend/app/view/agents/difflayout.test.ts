// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { HISTORY_COLLAPSE_PX, diffBody, historyLayout, resolveCollapsed } from "./difflayout";

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

describe("diffBody", () => {
    const loaded = { cwd: "/repo", isRepo: true, changes: { files: [] } };

    // F6: a broken history read must not take the working tree with it
    it("keeps the body and puts a history failure in its column when the change list is good", () => {
        expect(diffBody(true, loaded)).toBe("history-failure-in-column");
    });

    // the change-list read that failed is the one that would have said isRepo, so nothing is good to keep
    it("takes over the body on a history failure with no good change list", () => {
        expect(diffBody(true, { cwd: "/repo", isRepo: false, changes: null })).toBe("whole-body-failure");
        expect(diffBody(true, { cwd: "/repo", isRepo: true, changes: null })).toBe("whole-body-failure");
        expect(diffBody(true, null)).toBe("whole-body-failure");
    });

    it("says not-a-repo for a folder git does not read as one", () => {
        expect(diffBody(false, { cwd: "/plain", isRepo: false, changes: null })).toBe("not-a-repo");
    });

    it("draws the body otherwise, including while the change list is still loading", () => {
        expect(diffBody(false, loaded)).toBe("body");
        expect(diffBody(false, null)).toBe("body");
        expect(diffBody(false, { cwd: null, isRepo: false, changes: null })).toBe("body");
    });
});
