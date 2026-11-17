// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: what the Rendered check review card draws, from the pane's own checkReview and pick counts, so the card and the
// pane agree on what waits and what is picked.

import {
    checkReview,
    pickCount,
    plural,
    type BrainstormFile,
    type BrainstormPart,
    type PickCount,
    type Picks,
    type ReviewRow,
} from "./brainstormmodel";

export type ReviewPicksView = { line: string; send: string; picked: number; open: number };

export type ReviewCardView = {
    summary: string;
    changed: ReviewRow[];
    anyWas: boolean;
    // the changes still waiting, when there are several to keep in one press
    keepAll: number | null;
    fresh: ReviewRow[];
    unchanged: BrainstormPart[];
    notes: BrainstormPart[];
    picks: ReviewPicksView | null;
};

export function reviewPicksLine(c: PickCount): string {
    const made = `${plural(c.picked, "choice", "choices")} made`;
    return c.open > 0 ? `${made}, ${c.open} still open` : made;
}

export function reviewCardView(f: BrainstormFile, picks: Picks): ReviewCardView {
    const r = checkReview(f);
    const c = pickCount(f, picks);
    return {
        summary: r.summary,
        changed: r.changed,
        anyWas: r.anyWas,
        keepAll: r.pending > 1 ? r.pending : null,
        fresh: r.fresh,
        unchanged: r.unchanged,
        notes: r.notes,
        picks:
            c.picked > 0
                ? {
                      line: reviewPicksLine(c),
                      send: `Send ${plural(c.picked, "choice", "choices")}`,
                      picked: c.picked,
                      open: c.open,
                  }
                : null,
    };
}
