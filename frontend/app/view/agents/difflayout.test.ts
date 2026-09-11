// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { HISTORY_COLLAPSE_PX, resolveCollapsed } from "./difflayout";

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
