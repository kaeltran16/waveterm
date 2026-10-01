// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Whether Ctrl is held, so a link that would open a target can show it peeks instead (the [data-peek] rule in
// tailwindsetup.css, and the footer's lit peek chip). cockpit-root.tsx feeds window key and blur events through
// nextCtrlHeld.

import { atom, type PrimitiveAtom } from "jotai";

export const ctrlHeldAtom = atom(false) as PrimitiveAtom<boolean>;

export type CtrlEvent = { type: string; key?: string };

// blur clears it: Ctrl released while another window has focus sends this one no keyup, and the flag would
// otherwise stay set, with every link underlined, until the next Ctrl press
export function nextCtrlHeld(held: boolean, ev: CtrlEvent): boolean {
    if (ev.type === "blur") {
        return false;
    }
    if (ev.key !== "Control") {
        return held;
    }
    return ev.type === "keydown";
}
