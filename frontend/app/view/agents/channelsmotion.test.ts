// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { computeEntrances, initialEntranceState } from "./channelsmotion";

describe("computeEntrances", () => {
    test("first mount animates nothing and seeds seen", () => {
        const r = computeEntrances(initialEntranceState(), "c1", ["a", "b"]);
        expect([...r.animate]).toEqual([]);
        expect([...r.state.seen].sort()).toEqual(["a", "b"]);
        expect(r.state.key).toBe("c1");
    });

    test("switching channels animates nothing and reseeds", () => {
        const first = computeEntrances(initialEntranceState(), "c1", ["a", "b"]);
        const r = computeEntrances(first.state, "c2", ["x", "y"]);
        expect([...r.animate]).toEqual([]);
        expect([...r.state.seen].sort()).toEqual(["x", "y"]);
        expect(r.state.key).toBe("c2");
    });

    test("same-channel append animates only the new ids", () => {
        const first = computeEntrances(initialEntranceState(), "c1", ["a", "b"]);
        const r = computeEntrances(first.state, "c1", ["a", "b", "c"]);
        expect([...r.animate]).toEqual(["c"]);
        expect([...r.state.seen].sort()).toEqual(["a", "b", "c"]);
    });

    test("re-render with no new ids animates nothing", () => {
        const first = computeEntrances(initialEntranceState(), "c1", ["a", "b"]);
        const r = computeEntrances(first.state, "c1", ["a", "b"]);
        expect([...r.animate]).toEqual([]);
    });

    test("a removed id does not error and stays remembered", () => {
        const first = computeEntrances(initialEntranceState(), "c1", ["a", "b"]);
        const r = computeEntrances(first.state, "c1", ["a"]);
        expect([...r.animate]).toEqual([]);
        expect(r.state.seen.has("a")).toBe(true);
        expect(r.state.seen.has("b")).toBe(true);
    });
});
