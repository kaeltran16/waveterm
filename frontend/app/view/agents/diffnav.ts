// frontend/app/view/agents/diffnav.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Lets a surface keybinding reach the diff editor that is currently on screen. The keys fire while
// focus is on the surface wrapper, not inside Monaco — focusing the editor would make ctx.editable
// true and silence every other key on the surface — so the pane has to hand out a way in.
//
// Monaco computes the hunks itself and this asks it where the next one is. Deriving hunk boundaries
// from the two texts here would be a second diff algorithm beside the one that drew the screen, and
// the two would point at different lines.

// Narrow to what is actually called, so a test does not need a Monaco editor to exercise the routing.
export interface DiffNavTarget {
    goToDiff(target: "next" | "previous"): void;
}

let mounted: DiffNavTarget | null = null;

export function setDiffNav(target: DiffNavTarget): void {
    mounted = target;
}

// By identity. Selecting a binary file swaps the editor for a message pane and back, and a teardown
// that arrived after the replacement would otherwise unregister the pane that is on screen.
export function clearDiffNav(target: DiffNavTarget): void {
    if (mounted === target) {
        mounted = null;
    }
}

// false = nothing to move through (no file selected, a binary one, still loading), which lets the
// binding decline the key rather than swallow it.
export function gotoChange(dir: "next" | "previous"): boolean {
    if (mounted == null) {
        return false;
    }
    mounted.goToDiff(dir);
    return true;
}
