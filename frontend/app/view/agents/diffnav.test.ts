// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { changePosition, clearDiffNav, gotoChange, setDiffNav } from "./diffnav";

function pane() {
    return { goToDiff: vi.fn() };
}

describe("diff pane navigation", () => {
    beforeEach(() => {
        // The registry is module state, and a pane leaked from an earlier case would make every
        // later one pass vacuously. Emptying it through the public API rather than a test-only reset.
        const stale = pane();
        setDiffNav(stale);
        clearDiffNav(stale);
    });

    it("reports that nothing moved when no pane is mounted", () => {
        expect(gotoChange("next")).toBe(false);
    });

    it("routes next and previous to the mounted pane", () => {
        const p = pane();
        setDiffNav(p);
        expect(gotoChange("next")).toBe(true);
        expect(gotoChange("previous")).toBe(true);
        expect(p.goToDiff.mock.calls).toEqual([["next"], ["previous"]]);
    });

    it("hands the keys to the newer pane when one replaces another", () => {
        const first = pane();
        const second = pane();
        setDiffNav(first);
        setDiffNav(second);
        gotoChange("next");
        expect(first.goToDiff).not.toHaveBeenCalled();
        expect(second.goToDiff).toHaveBeenCalledWith("next");
    });

    it("goes inert once the mounted pane tears down", () => {
        const p = pane();
        setDiffNav(p);
        clearDiffNav(p);
        expect(gotoChange("next")).toBe(false);
        expect(p.goToDiff).not.toHaveBeenCalled();
    });

    // Selecting a binary file unmounts the editor and mounts the message pane; going back mounts a new
    // editor. If a late teardown from the old one cleared unconditionally, the keys would die silently
    // on a pane that is visibly on screen.
    it("ignores a teardown from a pane that is no longer the mounted one", () => {
        const old = pane();
        const live = pane();
        setDiffNav(old);
        setDiffNav(live);
        clearDiffNav(old);
        expect(gotoChange("next")).toBe(true);
        expect(live.goToDiff).toHaveBeenCalledWith("next");
    });
});

describe("changePosition", () => {
    const changes = [
        { start: 10, end: 12 },
        { start: 40, end: 0 }, // a pure deletion: Monaco reports end 0
        { start: 90, end: 95 },
    ];
    it("is 0 of N before the first change", () => {
        expect(changePosition(changes, 1)).toEqual({ index: 0, total: 3 });
    });
    it("counts the change the cursor is in or has passed", () => {
        expect(changePosition(changes, 10)).toEqual({ index: 1, total: 3 });
        expect(changePosition(changes, 30)).toEqual({ index: 1, total: 3 });
    });
    it("counts a pure deletion once the cursor reaches it", () => {
        expect(changePosition(changes, 40)).toEqual({ index: 2, total: 3 });
    });
    it("stays on the last change past the end", () => {
        expect(changePosition(changes, 500)).toEqual({ index: 3, total: 3 });
    });
    it("is 0 of 0 with nothing changed", () => {
        expect(changePosition([], 5)).toEqual({ index: 0, total: 0 });
    });
});
