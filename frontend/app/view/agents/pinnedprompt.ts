// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: the Rendered view's pinned prompt bar. The bar shows your last prompt once its row has scrolled above the
// top of the scroll area, drawn as the transcript draws it: a bubble's text, or the brainstorm row a mark or an
// answer folds to. A user entry Arc typed (a wake, a brief, a brainstorm line) draws as an event, not a bubble, so it
// is never the prompt pinned, unless the transcript draws it as your answer's row.

import type { AgentEntry } from "./agentsviewmodel";
import { arcMessageOf } from "./arcmessage";
import type { EntryRowView } from "./renderedbsrowsmodel";
import type { TranscriptContext } from "./transcriptcontext";

export interface PinnedPrompt {
    index: number;
    text: string;
    // the transcript's own row for the entry (renderedbsrowsmodel); null for a plain bubble
    row: EntryRowView | null;
}

export type RowOf = (entry: AgentEntry) => EntryRowView | null;

/** The last user entry the human typed, or the last one the transcript draws as your row; null when there is none. */
export function lastPrompt(entries: AgentEntry[], ctx?: TranscriptContext, rowOf?: RowOf): PinnedPrompt | null {
    const firstUser = entries.findIndex((e) => e.kind === "user");
    for (let i = entries.length - 1; i >= firstUser && firstUser >= 0; i--) {
        const e = entries[i];
        if (e.kind !== "user") {
            continue;
        }
        const row = rowOf?.(e) ?? null;
        if (row != null || arcMessageOf(e, i === firstUser, ctx) == null) {
            return { index: i, text: e.text.trim(), row };
        }
    }
    return null;
}

/** The prompt to pin, given its row's rect and the scroller's: only once the row is wholly above the scroller's top.
 *  A row not in the DOM (cut by the render cap, or not laid out yet) pins nothing. */
export function pinnedPrompt(
    prompt: PinnedPrompt | null,
    row: { bottom: number } | null,
    scroller: { top: number }
): PinnedPrompt | null {
    if (prompt == null || row == null || row.bottom > scroller.top) {
        return null;
    }
    return prompt;
}

// the view's rows are rebuilt on every read, so a pin is the same pin when it draws the same
export function samePin(a: PinnedPrompt | null, b: PinnedPrompt | null): boolean {
    if (a == null || b == null) {
        return a === b;
    }
    return a.index === b.index && a.text === b.text && JSON.stringify(a.row) === JSON.stringify(b.row);
}
