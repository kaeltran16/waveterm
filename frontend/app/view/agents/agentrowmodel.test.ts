// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { entriesToShow, isFinishTransition } from "./agentrowmodel";

describe("entriesToShow", () => {
    it("prefers live entries when present", () => {
        expect(entriesToShow([1, 2], [9])).toEqual([1, 2]);
    });
    it("falls back to previousInfo when live is empty", () => {
        expect(entriesToShow([], [9])).toEqual([9]);
    });
    it("falls back to [] when live is empty and previousInfo is absent", () => {
        expect(entriesToShow([], undefined)).toEqual([]);
    });
});

describe("isFinishTransition", () => {
    it("is true only on working -> idle", () => {
        expect(isFinishTransition("working", "idle")).toBe(true);
        expect(isFinishTransition("asking", "idle")).toBe(false);
        expect(isFinishTransition("working", "asking")).toBe(false);
        expect(isFinishTransition("idle", "idle")).toBe(false);
    });

    it("waits out standing by: finishes when the last shell task ends, not at the Stop", () => {
        expect(isFinishTransition("working", "idle", false, false)).toBe(true);
        expect(isFinishTransition("working", "idle", false, true)).toBe(false);
        expect(isFinishTransition("idle", "idle", true, false)).toBe(true);
        expect(isFinishTransition("idle", "idle", false, false)).toBe(false);
        expect(isFinishTransition("idle", "idle", true, true)).toBe(false);
    });
});
