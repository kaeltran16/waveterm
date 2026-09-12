// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { FRESH_MARK_CAP, freshKeys } from "./freshrows";

const CURSOR = 1_000;

describe("freshKeys", () => {
    it("marks a row that changed at or after the visit cursor", () => {
        const marked = freshKeys(
            [
                { key: "old", ts: CURSOR - 1 },
                { key: "edge", ts: CURSOR },
                { key: "new", ts: CURSOR + 1 },
            ],
            CURSOR
        );
        expect([...marked].sort()).toEqual(["edge", "new"]);
    });

    it("never marks a row with no timestamp (a blocked chunk has no waiting-since)", () => {
        expect(freshKeys([{ key: "chunk", ts: null }], CURSOR).has("chunk")).toBe(false);
    });

    it("suppresses every mark once more than the cap is fresh — 'new' stops discriminating", () => {
        const rows = Array.from({ length: FRESH_MARK_CAP + 1 }, (_, i) => ({ key: `r${i}`, ts: CURSOR + 1 }));
        expect(freshKeys(rows, CURSOR).size).toBe(0);
    });

    it("marks right up to the cap", () => {
        const rows = Array.from({ length: FRESH_MARK_CAP }, (_, i) => ({ key: `r${i}`, ts: CURSOR + 1 }));
        expect(freshKeys(rows, CURSOR).size).toBe(FRESH_MARK_CAP);
    });

    it("marks nothing when there is no usable cursor, rather than marking everything", () => {
        expect(freshKeys([{ key: "a", ts: 5 }], 0).size).toBe(0);
        expect(freshKeys([{ key: "a", ts: 5 }], Number.NaN).size).toBe(0);
    });

    it("ignores a non-finite row timestamp instead of marking on a comparison with NaN", () => {
        expect(freshKeys([{ key: "a", ts: Number.NaN }], CURSOR).size).toBe(0);
    });

    it("is empty for an empty region", () => {
        expect(freshKeys([], CURSOR).size).toBe(0);
    });
});
