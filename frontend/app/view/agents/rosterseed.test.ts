// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom, createStore } from "jotai";
import { describe, expect, it } from "vitest";
import { isLayoutLoaded, isRosterSeeded, latchWhenTrue } from "./rosterseed";

describe("isRosterSeeded", () => {
    it("is seeded with no terminals, so the real empty state shows", () => {
        expect(isRosterSeeded([], () => false, new Set())).toBe(true);
    });
    it("is not seeded while any terminal is still reading its retained status", () => {
        expect(isRosterSeeded(["block:a", "block:b"], (o) => o === "block:a", new Set())).toBe(false);
    });
    it("counts a settled read with no status as seeded (a plain shell, or a failed read)", () => {
        expect(isRosterSeeded(["block:a"], () => false, new Set(["block:a"]))).toBe(true);
    });
    it("counts a live status as seeded before its history read settles", () => {
        expect(isRosterSeeded(["block:a"], () => true, new Set())).toBe(true);
    });
});

describe("isLayoutLoaded", () => {
    const loaded = { loading: false, blockIds: ["b1"] };
    it("is not loaded before the workspace is", () => {
        expect(isLayoutLoaded(null, () => false)).toBe(false);
    });
    it("is not loaded while any tab is still loading", () => {
        expect(isLayoutLoaded([loaded, { loading: true, blockIds: [] }], () => false)).toBe(false);
    });
    it("is not loaded while a block a tab holds is still loading", () => {
        expect(isLayoutLoaded([loaded], (b) => b === "b1")).toBe(false);
    });
    it("counts a failed tab load as settled, so it cannot stall the gate", () => {
        expect(isLayoutLoaded([loaded, { loading: false, blockIds: [] }], () => false)).toBe(true);
    });
    it("is loaded for a workspace with no tabs", () => {
        expect(isLayoutLoaded([], () => true)).toBe(true);
    });
});

describe("latchWhenTrue", () => {
    it("flips when the check turns true and stays true after it turns false again", () => {
        const store = createStore();
        const check = atom(false);
        const latch = atom(false);
        latchWhenTrue(store, check, latch);
        expect(store.get(latch)).toBe(false);
        store.set(check, true);
        expect(store.get(latch)).toBe(true);
        // a terminal opened later makes the check false again; first load is over, so the latch holds
        store.set(check, false);
        expect(store.get(latch)).toBe(true);
    });
    it("flips at once when the check already holds", () => {
        const store = createStore();
        const latch = atom(false);
        latchWhenTrue(store, atom(true), latch);
        expect(store.get(latch)).toBe(true);
    });
    it("stops listening after the unsubscribe", () => {
        const store = createStore();
        const check = atom(false);
        const latch = atom(false);
        latchWhenTrue(store, check, latch)();
        store.set(check, true);
        expect(store.get(latch)).toBe(false);
    });
});
