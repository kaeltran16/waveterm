// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { MAX_MRU, nextMru, recentItems, sortByMru } from "./palette-mru";

const it_ = (key: string) => ({ key });

describe("nextMru", () => {
    it("puts a new key at the front", () => {
        expect(nextMru(["a", "b"], "c")).toEqual(["c", "a", "b"]);
    });
    it("moves an existing key to the front without duplicating it", () => {
        expect(nextMru(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    });
    it("caps the list", () => {
        const full = Array.from({ length: MAX_MRU }, (_, i) => `k${i}`);
        const next = nextMru(full, "new");
        expect(next).toHaveLength(MAX_MRU);
        expect(next[0]).toBe("new");
        expect(next).not.toContain(`k${MAX_MRU - 1}`);
    });
});

describe("sortByMru", () => {
    it("floats recent items and leaves the rest in input order", () => {
        const items = [it_("a"), it_("b"), it_("c"), it_("d")];
        expect(sortByMru(items, ["c", "a"]).map((i) => i.key)).toEqual(["c", "a", "b", "d"]);
    });
    it("is a no-op with an empty history", () => {
        const items = [it_("a"), it_("b")];
        expect(sortByMru(items, []).map((i) => i.key)).toEqual(["a", "b"]);
    });
    it("does not mutate its input", () => {
        const items = [it_("a"), it_("b")];
        sortByMru(items, ["b"]);
        expect(items.map((i) => i.key)).toEqual(["a", "b"]);
    });
});

describe("recentItems", () => {
    it("resolves keys against the pool, in history order", () => {
        const items = [it_("a"), it_("b"), it_("c")];
        expect(recentItems(items, ["c", "a"], 5).map((i) => i.key)).toEqual(["c", "a"]);
    });
    it("drops history entries whose item no longer exists", () => {
        expect(recentItems([it_("a")], ["gone", "a"], 5).map((i) => i.key)).toEqual(["a"]);
    });
    it("honors the limit", () => {
        const items = [it_("a"), it_("b"), it_("c")];
        expect(recentItems(items, ["a", "b", "c"], 2).map((i) => i.key)).toEqual(["a", "b"]);
    });
});
