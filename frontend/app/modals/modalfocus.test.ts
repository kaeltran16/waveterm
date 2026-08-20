// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { focusTrapTarget, takeModalFocus } from "./modalfocus";

function fakePanel(contains: boolean) {
    return { focus: vi.fn(), contains: vi.fn(() => contains) } as unknown as HTMLElement;
}

function fakeNode(isConnected: boolean) {
    return { focus: vi.fn(), isConnected } as unknown as HTMLElement;
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

    it("is a no-op when the panel ref is not attached yet", () => {
        expect(() => takeModalFocus(null, fakeNode(true))()).not.toThrow();
    });
});
