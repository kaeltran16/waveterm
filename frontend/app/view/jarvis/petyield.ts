// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// When the floating avatar steps aside for the surface under it. It is window chrome over every surface, and
// at any width its corner can hold a surface's own control (Settings' Test again, a tunnel token field). A
// layout gutter would cost every surface the avatar's width for good, so instead the avatar yields where it
// matters: while the pointer is over its box and the element under that point is a control, it fades and
// lets the pointer through, and comes back once the pointer leaves. Its box over anything else stays its own.

// what counts as a control under the avatar: what a click or a focus would act on
export const CONTROL_SELECTOR =
    'button, a[href], input, select, textarea, label, summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"], [contenteditable="true"]';

// the yielded avatar's opacity: still there to see, but the control under it reads through
export const YIELD_OPACITY = 0.12;

export interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

// the element under the point once the avatar's own subtree is skipped; closest() is all this reads of it
export interface Beneath {
    closest(selector: string): unknown;
}

export interface PointerAt {
    x: number;
    y: number;
    buttons: number; // a held button is a drag or a press in progress, which the avatar never yields mid-way
}

// Whether the avatar yields for this pointer position. `current` is the state it is in: a held button keeps it,
// so a drag that crosses a control neither drops the avatar nor pulls it back under the pointer. `beneath` is
// read only for a point inside the box, since a hit test on every pointer move anywhere would be waste.
export function petYields(p: PointerAt, box: Box, beneath: () => Beneath | null, current: boolean): boolean {
    if (p.buttons !== 0) {
        return current;
    }
    const inside = p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom;
    return inside && beneath()?.closest(CONTROL_SELECTOR) != null;
}
