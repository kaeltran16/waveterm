// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { NAV_NARROW_WINDOW_PX, navRailCollapsed } from "./navrailwidth";

describe("navRailCollapsed", () => {
    it("stays wide on a roomy window", () => {
        expect(navRailCollapsed(1920)).toBe(false);
        expect(navRailCollapsed(NAV_NARROW_WINDOW_PX)).toBe(false);
    });

    it("collapses below the threshold", () => {
        expect(navRailCollapsed(NAV_NARROW_WINDOW_PX - 1)).toBe(true);
        expect(navRailCollapsed(720)).toBe(true);
    });

    it("treats an unmeasured width as roomy rather than slamming shut on the first frame", () => {
        expect(navRailCollapsed(0)).toBe(false);
    });
});
