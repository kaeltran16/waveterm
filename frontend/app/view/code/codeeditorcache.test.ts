// frontend/app/view/code/codeeditorcache.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { remember } from "./codeeditorcache";

describe("codeeditorcache", () => {
    it("evicts nothing while under the cap", () => {
        const cache = new Map<string, string>();
        expect(remember(cache, "a", "A", 2)).toEqual([]);
        expect(remember(cache, "b", "B", 2)).toEqual([]);
        expect([...cache.keys()]).toEqual(["a", "b"]);
    });

    it("evicts the least recently remembered entry past the cap", () => {
        const cache = new Map<string, string>();
        remember(cache, "a", "A", 2);
        remember(cache, "b", "B", 2);
        expect(remember(cache, "c", "C", 2)).toEqual(["A"]);
        expect([...cache.keys()]).toEqual(["b", "c"]);
    });

    it("refreshes a re-remembered key instead of evicting it", () => {
        const cache = new Map<string, string>();
        remember(cache, "a", "A", 2);
        remember(cache, "b", "B", 2);
        remember(cache, "a", "A2", 2);
        expect(remember(cache, "c", "C", 2)).toEqual(["B"]);
        expect(cache.get("a")).toBe("A2");
    });
});
