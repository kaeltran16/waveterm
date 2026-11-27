// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const tabbedOwns = vi.hoisted(() => ({ value: false }));
vi.mock("@/app/store/keybindings/dispatcher", () => ({ tabbedControlOwns: () => tabbedOwns.value }));

import type { KeyboardEvent } from "react";
import type { GridPath } from "./cockpitgridmodel";
import { useCockpitKeyboard, type CockpitKeyDeps } from "./usecockpitkeyboard";

const PATH: GridPath = { grid: ["a", "b", "c"], idle: ["i1"], strip: ["strip:r1"], columns: 3 };

function handler(cursorId: string) {
    const deps = {
        path: PATH,
        cursorId,
        setCursorId: vi.fn(),
        trailRef: { current: {} },
        zoom: vi.fn(),
        zoomIdle: vi.fn(),
        dismiss: vi.fn(),
        openStrip: vi.fn(),
        openAgent: vi.fn(),
    } satisfies CockpitKeyDeps;
    return { deps, onKey: useCockpitKeyboard(deps) };
}

const press = (key: string, over: Record<string, unknown> = {}) => {
    const e = { key, target: { tagName: "DIV" }, preventDefault: vi.fn(), ...over };
    return e as unknown as KeyboardEvent;
};

describe("the Cockpit grid's keys", () => {
    it.each<[string, string, string, (d: CockpitKeyDeps) => unknown, unknown[]]>([
        ["Space on a thumbnail zooms it", "b", " ", (d) => d.zoom, ["b"]],
        ["Space on an Idle name zooms it back out of Idle", "i1", " ", (d) => d.zoomIdle, ["i1"]],
        ["Space on a strip line opens its run", "strip:r1", " ", (d) => d.openStrip, ["strip:r1"]],
        ["d on a thumbnail dismisses it, the cursor taking the next", "b", "d", (d) => d.dismiss, ["b", "c"]],
        ["Enter on a thumbnail opens it on the Agent surface", "b", "Enter", (d) => d.openAgent, ["b"]],
        ["Enter on an Idle name opens it on the Agent surface", "i1", "Enter", (d) => d.openAgent, ["i1"]],
        ["an arrow moves the cursor along the path", "b", "ArrowRight", (d) => d.setCursorId, ["c"]],
    ])("%s", (_, cursor, key, pick, args) => {
        const { deps, onKey } = handler(cursor);
        const e = press(key);
        onKey(e);
        expect(pick(deps)).toHaveBeenCalledWith(...args);
        expect(e.preventDefault).toHaveBeenCalled();
    });

    it.each<[string, string, string]>([
        ["d on an Idle name", "i1", "d"],
        ["d on a strip line", "strip:r1", "d"],
        ["Enter on a strip line", "strip:r1", "Enter"],
    ])("%s does nothing", (_, cursor, key) => {
        const { deps, onKey } = handler(cursor);
        onKey(press(key));
        for (const fn of [deps.zoom, deps.zoomIdle, deps.dismiss, deps.openStrip, deps.openAgent]) {
            expect(fn).not.toHaveBeenCalled();
        }
    });

    it.each<[string, Record<string, unknown>]>([
        ["a chord with Ctrl", { ctrlKey: true }],
        ["a chord with Alt", { altKey: true }],
        ["a key typed into an input", { target: { tagName: "INPUT" } }],
    ])("leave %s alone", (_, over) => {
        const { deps, onKey } = handler("b");
        const e = press(" ", over);
        onKey(e);
        expect(deps.zoom).not.toHaveBeenCalled();
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it("leave Enter to a button reached with Tab", () => {
        const { deps, onKey } = handler("b");
        tabbedOwns.value = true;
        const e = press("Enter");
        onKey(e);
        tabbedOwns.value = false;
        expect(deps.openAgent).not.toHaveBeenCalled();
        expect(e.preventDefault).not.toHaveBeenCalled();
    });
});
