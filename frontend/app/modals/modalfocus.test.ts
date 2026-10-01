// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusTrapTarget, takeModalFocus } from "./modalfocus";

function fakePanel(contains: boolean) {
    return { focus: vi.fn(), contains: vi.fn(() => contains) } as unknown as HTMLElement;
}

function fakeNode(isConnected: boolean, visible = true) {
    return { focus: vi.fn(), blur: vi.fn(), isConnected, checkVisibility: () => visible } as unknown as HTMLElement;
}

describe("focusTrapTarget", () => {
    const first = fakeNode(true);
    const second = fakeNode(true);
    const third = fakeNode(true);

    it("wraps forward and reverse through the focusable list", () => {
        expect(focusTrapTarget([first, second, third], third, false)).toBe(first);
        expect(focusTrapTarget([first, second, third], first, true)).toBe(third);
    });

    it("chooses the first or last target when focus is outside the list", () => {
        const outside = fakeNode(true);
        expect(focusTrapTarget([first, second], outside, false)).toBe(first);
        expect(focusTrapTarget([first, second], outside, true)).toBe(second);
        expect(focusTrapTarget([], outside, false)).toBeNull();
    });
});

describe("takeModalFocus", () => {
    beforeEach(() => vi.stubGlobal("document", { activeElement: null }));
    afterEach(() => vi.unstubAllGlobals());

    it("focuses the panel when focus is outside it", () => {
        const panel = fakePanel(false);
        takeModalFocus(panel, fakeNode(true));
        expect(panel.focus).toHaveBeenCalledOnce();
    });

    it("leaves focus alone when a child already has it", () => {
        const panel = fakePanel(true);
        takeModalFocus(panel, fakeNode(true));
        expect(panel.focus).not.toHaveBeenCalled();
    });

    it("restores focus to the still-connected element it took it from", () => {
        const previous = fakeNode(true);
        takeModalFocus(fakePanel(false), previous)();
        expect(previous.focus).toHaveBeenCalledOnce();
    });

    it("does not refocus an element that left the DOM", () => {
        const previous = fakeNode(false);
        takeModalFocus(fakePanel(false), previous)();
        expect(previous.focus).not.toHaveBeenCalled();
    });

    it("does not refocus an element hidden since the modal opened", () => {
        const previous = fakeNode(true, false);
        takeModalFocus(fakePanel(false), previous)();
        expect(previous.focus).not.toHaveBeenCalled();
    });

    // the palette stays in the DOM through its exit animation; focus left in it blocked the surface the
    // pick navigated to from claiming focus, and then fell to <body>
    it("drops focus from the closing panel when there is nowhere to restore it", () => {
        const input = fakeNode(true);
        vi.stubGlobal("document", { activeElement: input });
        takeModalFocus(fakePanel(true), fakeNode(true, false))();
        expect(input.blur).toHaveBeenCalledOnce();
    });

    it("leaves focus that already moved outside the panel alone", () => {
        const elsewhere = fakeNode(true);
        vi.stubGlobal("document", { activeElement: elsewhere });
        takeModalFocus(fakePanel(false), fakeNode(false))();
        expect(elsewhere.blur).not.toHaveBeenCalled();
    });

    it("is a no-op when the panel ref is not attached yet", () => {
        expect(() => takeModalFocus(null, fakeNode(true))()).not.toThrow();
    });
});
