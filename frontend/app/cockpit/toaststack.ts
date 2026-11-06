// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Where the cockpit's toast stack sits, and how long an error toast stays. Pure, and types-only imports: the
// avatar's reach comes in as an argument so this does not pull in petview.tsx.

import type { PetCorner } from "@/app/view/jarvis/petstore";

// an error asks to be read, often a long message; 6 s was not enough to read one, so it outlives info and warn
export const ERROR_TOAST_TTL_MS = 12000;

// the bubble's gap above the avatar (petbubble's floating-ui offset), shared so the stack clears it exactly
export const PET_BUBBLE_OFFSET_PX = 10;

const STACK_GAP_PX = 12;
const FOOTER_PX = 28;

// The stack's bottom edge, from the window's bottom: clear of the 28px hints footer, or of the avatar when it
// shares the right corner, and of its speech bubble while one shows there. Only the right corner rises for the
// bubble: the stack never moves to the left corner, which on Agent is the tree, the same overlap problem.
export function toastStackBottom(corner: PetCorner, bubbleHeight: number | null, avatarReach: number): number {
    if (corner !== "bottom-right") {
        return FOOTER_PX + STACK_GAP_PX;
    }
    const bubble = bubbleHeight != null ? PET_BUBBLE_OFFSET_PX + bubbleHeight : 0;
    return avatarReach + bubble + STACK_GAP_PX;
}
