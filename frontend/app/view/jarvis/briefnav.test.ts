// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { resolveBriefCursor } from "./briefnav";

describe("resolveBriefCursor", () => {
    it("keeps a cursor that still names a row", () => {
        expect(resolveBriefCursor(["a", "b"], "b")).toBe("b");
    });

    it("falls back to the first row when the cursor's row resolved away", () => {
        expect(resolveBriefCursor(["a", "b"], "gone")).toBe("a");
    });

    it("starts at the first row when nothing is selected yet", () => {
        expect(resolveBriefCursor(["a", "b"], undefined)).toBe("a");
    });

    it("has no cursor at all when there are no rows", () => {
        expect(resolveBriefCursor([], "a")).toBeUndefined();
    });
});
