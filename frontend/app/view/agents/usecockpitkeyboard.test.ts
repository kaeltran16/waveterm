// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const tabbedOwns = vi.hoisted(() => ({ value: false }));
vi.mock("@/app/store/keybindings/dispatcher", () => ({ tabbedControlOwns: () => tabbedOwns.value }));
vi.mock("@/app/view/jarvis/openref", () => ({ peekTarget: vi.fn() }));

import type { KeyboardEvent } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { useCockpitKeyboard, type CockpitKeyDeps } from "./usecockpitkeyboard";

function handler() {
    const agent = { id: "a1", name: "claude", task: "", state: "working" } as AgentVM;
    const deps = {
        model: { openTerminal: vi.fn() } as unknown as AgentsViewModel,
        navigableIds: ["a1"],
        cursorId: "a1",
        setCursorId: vi.fn(),
        answerTab: {},
        answerSel: {},
        navCols: [["a1"]],
        rowTargets: {},
        askTargets: [],
        roster: [agent],
        lastJumpRef: { current: undefined },
        setOpenComposerId: vi.fn(),
        selectQuestion: vi.fn(),
        toggleAnswer: vi.fn(),
        submitAnswer: vi.fn(),
        toggleBackground: vi.fn(),
        openFocus: vi.fn(),
        scrollToPulse: vi.fn(),
        focusRowComposer: vi.fn(),
    } satisfies CockpitKeyDeps;
    return { deps, onKey: useCockpitKeyboard(deps) };
}

const press = (key: string, mods: Partial<Record<"ctrlKey" | "altKey" | "metaKey", boolean>> = {}) => {
    const e = { key, target: { tagName: "DIV" }, preventDefault: vi.fn(), ...mods };
    return e as unknown as KeyboardEvent;
};

describe("the Cockpit's own keys", () => {
    it("act on the bare key", () => {
        const { deps, onKey } = handler();
        onKey(press("b"));
        expect(deps.toggleBackground).toHaveBeenCalledWith("a1");
        onKey(press("Enter"));
        expect(deps.openFocus).toHaveBeenCalledWith("a1", false);
    });

    it("leave a chord with Ctrl, Alt or Meta alone", () => {
        const { deps, onKey } = handler();
        const e = press("b", { ctrlKey: true });
        onKey(e);
        onKey(press("Enter", { ctrlKey: true }));
        onKey(press("t", { altKey: true }));
        onKey(press("1", { metaKey: true }));
        expect(deps.toggleBackground).not.toHaveBeenCalled();
        expect(deps.openFocus).not.toHaveBeenCalled();
        expect(deps.model.openTerminal).not.toHaveBeenCalled();
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it("leave Enter to a button reached with Tab", () => {
        const { deps, onKey } = handler();
        tabbedOwns.value = true;
        const e = press("Enter");
        onKey(e);
        tabbedOwns.value = false;
        expect(deps.openFocus).not.toHaveBeenCalled();
        expect(e.preventDefault).not.toHaveBeenCalled();
    });
});
