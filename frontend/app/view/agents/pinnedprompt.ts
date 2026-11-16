// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: the Rendered view's pinned prompt bar. The bar shows your last prompt once its bubble has scrolled above the
// top of the scroll area. A user entry Arc typed (a wake, a brief, a brainstorm line) draws as an event, not a
// bubble, so it is never the prompt pinned.

import type { AgentEntry } from "./agentsviewmodel";
import { arcMessageOf } from "./arcmessage";
import type { TranscriptContext } from "./transcriptcontext";

export interface PinnedPrompt {
    index: number;
    text: string;
}

/** The last user entry the human typed; null when there is none. */
export function lastPrompt(entries: AgentEntry[], ctx?: TranscriptContext): PinnedPrompt | null {
    const firstUser = entries.findIndex((e) => e.kind === "user");
    for (let i = entries.length - 1; i >= firstUser && firstUser >= 0; i--) {
        const e = entries[i];
        if (e.kind === "user" && arcMessageOf(e, i === firstUser, ctx) == null) {
            return { index: i, text: e.text.trim() };
        }
    }
    return null;
}

/** The prompt to pin, given the last bubble's rect and the scroller's: only once the bubble is wholly above the
 *  scroller's top. A bubble not in the DOM (cut by the render cap, or not laid out yet) pins nothing. */
export function pinnedPrompt(
    entries: AgentEntry[],
    bubble: { bottom: number } | null,
    scroller: { top: number },
    ctx?: TranscriptContext
): PinnedPrompt | null {
    if (bubble == null || bubble.bottom > scroller.top) {
        return null;
    }
    return lastPrompt(entries, ctx);
}
