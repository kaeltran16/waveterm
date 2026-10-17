// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The desktop popup's cross-window contract and the decision that fires it. Pure and import-free at
// runtime: the popup page bundles this file and must not pull the cockpit in with it.

import type { PetExpression, PetPosture } from "@/app/view/jarvis/petcondition";

export const POPUP_WINDOW_LABEL = "attention-popup";
export const POPUP_PAGE = "popup.html";
export const POPUP_SHOW_EVENT = "attention-popup:show";
export const POPUP_HIDE_EVENT = "attention-popup:hide";
export const POPUP_OPEN_EVENT = "attention-popup:open";

// the face the main window's avatar wears, drawn again beside the popup's card
export type PopupFace = { expression: PetExpression; posture: PetPosture };

export type PopupBubble = {
    key: string;
    kind?: "brainstorm";
    label: string;
    name?: string;
    text: string;
    // a second line under the text: which part of the design a brainstorm question is for
    detail?: string;
    more: number;
    face?: PopupFace;
};

export const POPUP_AT_REST: PopupFace = { expression: { kind: "at-rest" }, posture: "none" };
export const POPUP_AVATAR_PX = 96;

const ASK_KIND = "ask";
const BRAINSTORM_KIND = "brainstorm";
const ASK_LABEL = "Asking you";
const POPUP_MARGIN = 16;

export function newAttention(prev: AttentionItem[], next: AttentionItem[]): AttentionItem[] {
    const known = new Set(prev.map((i) => i.key));
    return next.filter((i) => !known.has(i.key));
}

// popupBubble fires on the same condition as the taskbar flash (taskbarSignal): an item not in the
// previous list while Arc is unfocused. The list arrives in rank order, so the first new item is the
// one the server ranks highest.
export function popupBubble(
    prev: AttentionItem[],
    next: AttentionItem[],
    focused: boolean,
    face?: PopupFace
): PopupBubble | null {
    if (focused) {
        return null;
    }
    const fresh = newAttention(prev, next);
    if (fresh.length === 0) {
        return null;
    }
    const [first] = fresh;
    if (first.kind === BRAINSTORM_KIND) {
        return {
            key: first.key,
            kind: BRAINSTORM_KIND,
            label: `${first.source} · brainstorm`,
            name: undefined,
            text: first.text,
            detail: first.reason,
            more: fresh.length - 1,
            face,
        };
    }
    return {
        key: first.key,
        label: first.kind === ASK_KIND ? ASK_LABEL : first.action,
        name: first.source,
        text: first.text,
        more: fresh.length - 1,
        face,
    };
}

// a payload sent before the main window drew its first face carries none
export function popupFace(bubble: PopupBubble): PopupFace {
    return bubble.face ?? POPUP_AT_REST;
}

type Box = { x: number; y: number; width: number; height: number };

export function popupPlacement(workArea: Box, size: { width: number; height: number }): { x: number; y: number } {
    return {
        x: workArea.x + workArea.width - size.width - POPUP_MARGIN,
        y: workArea.y + workArea.height - size.height - POPUP_MARGIN,
    };
}
