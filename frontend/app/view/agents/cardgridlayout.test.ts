// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { resolveCursor } from "./cardgridlayout";

describe("resolveCursor", () => {
    it("keeps a valid cursor, else follows the alias, else takes the first", () => {
        expect(resolveCursor("b", ["a", "b"], {})).toBe("b");
        expect(resolveCursor("w1", ["L", "row:L:t1"], { w1: "row:L:t1" })).toBe("row:L:t1");
        expect(resolveCursor("gone", ["a"], {})).toBe("a");
        expect(resolveCursor("a", [], {})).toBeUndefined();
    });
    it("takes the first stop when the alias points off the list", () => {
        expect(resolveCursor("w1", ["a", "b"], { w1: "gone" })).toBe("a");
    });
    it("takes the first stop for no cursor, never an alias", () => {
        expect(resolveCursor(undefined, ["a", "b"], { undefined: "b" })).toBe("a");
    });
});
