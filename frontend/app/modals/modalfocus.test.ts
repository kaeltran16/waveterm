// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusTrapTarget, takeModalFocus } from "./modalfocus";

function fakePanel(contains: boolean) {
    return { focus: vi.fn(), contains: vi.fn(() => contains) } as unknown as HTMLElement;
}

// focus() moves document.activeElement, as a focusable element's does
function fakeNode(isConnected: boolean, visible = true) {
    const node = { blur: vi.fn(), isConnected, checkVisibility: () => visible } as unknown as HTMLElement;
    node.focus = vi.fn(() => {
        (document as { activeElement: Element | null }).activeElement = node;
    });
    return node;
}

describe("focusTrapTarget", () => {
    const first = fakeNode(true);
    const second = fakeNode(true);
    const third = fakeNode(true);

    it("wraps forward and reverse through the focusable list", () => {
        expect(focusTrapTarget([first, second, third], third, false)).toBe(first);
        expect(focusTrapTarget([first, second, third], first, true)).toBe(third);
    });

    it("steps to the neighbour of the focused target", () => {
        expect(focusTrapTarget([first, second, third], first, false)).toBe(second);
        expect(focusTrapTarget([first, second, third], second, false)).toBe(third);
        expect(focusTrapTarget([first, second, third], second, true)).toBe(first);
        expect(focusTrapTarget([first, second, third], third, true)).toBe(second);
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

    const noHome = () => null;

    it("restores focus to the still-connected element it took it from", () => {
        const previous = fakeNode(true);
        takeModalFocus(fakePanel(false), previous, noHome)();
        expect(previous.focus).toHaveBeenCalledOnce();
    });

    it("does not refocus an element that left the DOM", () => {
        const previous = fakeNode(false);
        takeModalFocus(fakePanel(false), previous, noHome)();
        expect(previous.focus).not.toHaveBeenCalled();
    });

    it("does not refocus an element hidden since the modal opened", () => {
        const previous = fakeNode(true, false);
        takeModalFocus(fakePanel(false), previous, noHome)();
        expect(previous.focus).not.toHaveBeenCalled();
    });

    // the palette stays in the DOM through its exit animation; focus left in it blocked the surface the
    // pick navigated to from claiming focus, and then fell to <body>
    it("blurs the panel when there is no home", () => {
        const input = fakeNode(true);
        vi.stubGlobal("document", { activeElement: input });
        takeModalFocus(fakePanel(true), fakeNode(true, false), noHome)();
        expect(input.blur).toHaveBeenCalledOnce();
    });

    it("hands focus to the focus home when the previous element is hidden", () => {
        const previous = fakeNode(true, false);
        const home = fakeNode(true);
        takeModalFocus(fakePanel(false), previous, () => home)();
        expect(home.focus).toHaveBeenCalledOnce();
        expect(previous.focus).not.toHaveBeenCalled();
    });

    it("hands focus to the focus home when there was no previous element", () => {
        const home = fakeNode(true);
        takeModalFocus(fakePanel(false), null, () => home)();
        expect(home.focus).toHaveBeenCalledOnce();
    });

    // the palette opened over nothing focused: previous is <body>, which ignores focus()
    it("hands focus to the focus home when the previous element ignores focus", () => {
        const input = fakeNode(true);
        vi.stubGlobal("document", { activeElement: input });
        const body = { isConnected: true, checkVisibility: () => true, focus: vi.fn() } as unknown as HTMLElement;
        const home = fakeNode(true);
        takeModalFocus(fakePanel(true), body, () => home)();
        expect(input.blur).toHaveBeenCalledOnce();
        expect(home.focus).toHaveBeenCalledOnce();
    });

    it("returns focus to a visible previous element, not the home", () => {
        const previous = fakeNode(true, true);
        const home = fakeNode(true);
        takeModalFocus(fakePanel(false), previous, () => home)();
        expect(previous.focus).toHaveBeenCalledOnce();
        expect(home.focus).not.toHaveBeenCalled();
    });

    it("leaves focus that already moved outside the panel alone", () => {
        const elsewhere = fakeNode(true);
        vi.stubGlobal("document", { activeElement: elsewhere });
        takeModalFocus(fakePanel(false), fakeNode(false), noHome)();
        expect(elsewhere.blur).not.toHaveBeenCalled();
    });

    it("is a no-op when the panel ref is not attached yet", () => {
        expect(() => takeModalFocus(null, fakeNode(true), noHome)()).not.toThrow();
    });
});
