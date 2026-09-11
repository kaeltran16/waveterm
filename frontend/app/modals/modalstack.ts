// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Which open modal owns the keyboard. Every ModalShell attaches its own window keydown listener, so
// without this they all fire at once — briefpeekview.tsx documents the consequence: a confirm over a
// peek, and one Escape dismisses both. Last opened wins, which is what "topmost" means for overlays
// that stack in mount order.
//
// The ordering is pure so it is testable; only the holder is module state, and it is read at event
// time rather than captured, so a listener never acts on a stale stack.

export function pushId(stack: string[], id: string): string[] {
    return stack.includes(id) ? stack : [...stack, id];
}

export function popId(stack: string[], id: string): string[] {
    return stack.filter((entry) => entry !== id);
}

export function topId(stack: string[]): string | null {
    return stack.length === 0 ? null : stack[stack.length - 1];
}

let openStack: string[] = [];

/** Registers an open modal and returns its unregister. Call from an effect gated on `open`. */
export function registerModal(id: string): () => void {
    openStack = pushId(openStack, id);
    return () => {
        openStack = popId(openStack, id);
    };
}

export function isTopModal(id: string): boolean {
    return topId(openStack) === id;
}
