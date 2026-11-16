// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// key rules of the suggestion panel the Rendered box opens for `/` and `@`; the box runs these before its own keys

export type SuggestKeyResult = { move: number } | { pick: number } | { close: true } | null; // null: the box handles the key

export function suggestKey(
    key: { key: string; shiftKey: boolean; isComposing?: boolean },
    at: number,
    count: number
): SuggestKeyResult {
    if (count === 0 || key.isComposing) return null;
    switch (key.key) {
        case "ArrowDown":
            return { move: (at + 1) % count };
        case "ArrowUp":
            return { move: (at - 1 + count) % count };
        case "Tab":
            return { pick: at };
        case "Enter":
            // shift+enter stays the box's newline
            return key.shiftKey ? null : { pick: at };
        case "Escape":
            return { close: true };
        default:
            return null;
    }
}

// a panel Esc closed stays closed while the word that opened it is still the one at the caret
export function stillDismissed(dismissedAt: number | null, wordAt: number | null): boolean {
    return dismissedAt != null && wordAt != null && dismissedAt === wordAt;
}
