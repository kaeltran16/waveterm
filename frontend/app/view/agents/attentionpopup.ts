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

// an attention item as the popup and the taskbar see it: a run's wait carries the sentence saying why it came to you
export type OutwardItem = AttentionItem & { escalated?: string };

export type PopupBubble = {
    key: string;
    // escalated: a run's wait that came to you from its conductor
    kind?: "brainstorm" | "escalated";
    label: string;
    name?: string;
    text: string;
    // a second line under the text: which part of the design a brainstorm question is for
    detail?: string;
    more: number;
};

const ASK_KIND = "ask";
const BRAINSTORM_KIND = "brainstorm";
const ESCALATED_KIND = "escalated";
const ASK_LABEL = "Asking you";
const POPUP_MARGIN = 16;

export function newAttention<T extends AttentionItem>(prev: AttentionItem[], next: T[]): T[] {
    const known = new Set(prev.map((i) => i.key));
    return next.filter((i) => !known.has(i.key));
}

// popupBubble fires on the same condition as the taskbar flash (taskbarSignal): an item not in the
// previous list while Arc is unfocused. The list arrives in rank order, so the first new item is the
// one the server ranks highest.
export function popupBubble(prev: AttentionItem[], next: OutwardItem[], focused: boolean): PopupBubble | null {
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
        };
    }
    const bubble: PopupBubble = {
        key: first.key,
        label: first.kind === ASK_KIND ? ASK_LABEL : first.action,
        name: first.source,
        text: first.text,
        more: fresh.length - 1,
    };
    if (first.escalated) {
        bubble.kind = ESCALATED_KIND;
        bubble.detail = first.escalated;
    }
    return bubble;
}

type Box = { x: number; y: number; width: number; height: number };

export function popupPlacement(workArea: Box, size: { width: number; height: number }): { x: number; y: number } {
    return {
        x: workArea.x + workArea.width - size.width - POPUP_MARGIN,
        y: workArea.y + workArea.height - size.height - POPUP_MARGIN,
    };
}
