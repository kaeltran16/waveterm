// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearDiffNav, gotoChange, setDiffNav } from "./diffnav";

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
