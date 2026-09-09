// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { briefNavIds, resolveBriefCursor } from "./briefnav";

const input = {
    queue: [{ key: "gate:1" }, { key: "ask:2" }],
    efforts: [{ oref: "effort:a" }],
    sessions: [{ key: "run:r1" }],
    deltaGroups: [{ rows: [{ key: "d1" }] }, { rows: [{ key: "d2" }, { key: "d3" }] }],
    shipped: [{ oref: "effort:a" }],
};

describe("briefNavIds", () => {
    it("walks the regions in the order they are rendered", () => {
        expect(briefNavIds(input)).toEqual([
            "waiting:gate:1",
            "waiting:ask:2",
            "initiatives:effort:a",
            "sessions:run:r1",
            "behind:d1",
            "behind:d2",
            "behind:d3",
            "behind:shipped:effort:a",
        ]);
    });

    // an effort that shipped appears in both Initiatives and Behind you; without the prefixes the two
    // rows would collide on one id and j/k would skip a row it can see.
    it("keeps the same object distinct when it appears in two regions", () => {
        const ids = briefNavIds(input);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("flattens the delta groups rather than treating each group as a row", () => {
        expect(briefNavIds(input).filter((id) => id.startsWith("behind:") && !id.includes("shipped"))).toHaveLength(3);
    });

    it("is empty for an empty brief", () => {
        expect(briefNavIds({ queue: [], efforts: [], sessions: [], deltaGroups: [], shipped: [] })).toEqual([]);
    });
});

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
