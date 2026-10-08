// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The desktop popup's cross-window contract and the decision that fires it. Pure and import-free at
// runtime: the popup page bundles this file and must not pull the cockpit in with it.

export const POPUP_WINDOW_LABEL = "attention-popup";
export const POPUP_PAGE = "popup.html";
export const POPUP_SHOW_EVENT = "attention-popup:show";
export const POPUP_HIDE_EVENT = "attention-popup:hide";
export const POPUP_OPEN_EVENT = "attention-popup:open";

export type PopupBubble = { key: string; label: string; name: string; text: string; more: number };

const ASK_KIND = "ask";
const ASK_LABEL = "Asking you";
const POPUP_MARGIN = 16;

export function newAttention(prev: AttentionItem[], next: AttentionItem[]): AttentionItem[] {
    const known = new Set(prev.map((i) => i.key));
    return next.filter((i) => !known.has(i.key));
}

// popupBubble fires on the same condition as the taskbar flash (taskbarSignal): an item not in the
// previous list while Arc is unfocused. The list arrives in rank order, so the first new item is the
// one the server ranks highest.
export function popupBubble(prev: AttentionItem[], next: AttentionItem[], focused: boolean): PopupBubble | null {
    if (focused) {
        return null;
    }
    const fresh = newAttention(prev, next);
    if (fresh.length === 0) {
        return null;
    }
    const [first] = fresh;
    return {
        key: first.key,
        label: first.kind === ASK_KIND ? ASK_LABEL : first.action,
        name: first.source,
        text: first.text,
        more: fresh.length - 1,
    };
}

type Box = { x: number; y: number; width: number; height: number };

export function popupPlacement(workArea: Box, size: { width: number; height: number }): { x: number; y: number } {
    return {
        x: workArea.x + workArea.width - size.width - POPUP_MARGIN,
        y: workArea.y + workArea.height - size.height - POPUP_MARGIN,
    };
}
