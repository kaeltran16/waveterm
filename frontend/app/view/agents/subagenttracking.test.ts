// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { advancedActivity, enterRefreshes } from "./subagenttracking";

describe("enterRefreshes", () => {
    it("enterRefreshes reads a new id", () => {
        const tracked = new Map([["a", "/a.jsonl"]]);
        expect(
            enterRefreshes(tracked, [
                { id: "a", transcriptPath: "/a.jsonl" },
                { id: "b", transcriptPath: "/b.jsonl" },
            ])
        ).toEqual(["b"]);
    });
    it("enterRefreshes reads an id whose path arrived", () => {
        const tracked = new Map<string, string | undefined>([["a", undefined]]);
        expect(enterRefreshes(tracked, [{ id: "a", transcriptPath: "/a.jsonl" }])).toEqual(["a"]);
    });
    it("enterRefreshes skips an unchanged id", () => {
        const tracked = new Map<string, string | undefined>([
            ["a", "/a.jsonl"],
            ["b", undefined],
        ]);
        expect(enterRefreshes(tracked, [{ id: "a", transcriptPath: "/a.jsonl" }, { id: "b" }])).toEqual([]);
    });
});

describe("advancedActivity", () => {
    it("schedules only the ids whose stamp advanced, not every stamped id", () => {
        // a chunks again; b went quiet at 100 and must keep its pending debounce, not be re-armed
        const seen = new Map([
            ["a", 200],
            ["b", 100],
        ]);
        const next = advancedActivity(seen, { a: 300, b: 100 }, ["a", "b"]);
        expect(next.advanced).toEqual(["a"]);
        expect([...next.seen]).toEqual([
            ["a", 300],
            ["b", 100],
        ]);
    });
    it("schedules a first-seen stamp: activity after the enter read is not covered by it", () => {
        expect(advancedActivity(new Map(), { a: 100 }, ["a", "b"]).advanced).toEqual(["a"]);
    });
    it("forgets ids no longer tracked, so a returning id schedules again", () => {
        const next = advancedActivity(new Map([["gone", 100]]), { gone: 100 }, ["a"]);
        expect([...next.seen]).toEqual([]);
        expect(advancedActivity(next.seen, { gone: 100 }, ["gone"]).advanced).toEqual(["gone"]);
    });
});
