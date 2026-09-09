// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief's j/k cursor: one flat list of row ids in render order, across all four regions.
// subjectscolumn.tsx is the only other production provider of a jarvis ListNavController (meta spec
// §4a item 9), and it belongs to the three-pane composition — the two never mount together, so the
// Brief simply registers its own for the same surface.
//
// Ids are region-prefixed because the underlying keys are only unique within their own collection: a
// delta row and a shipped row can name the same object, and an effort's oref can appear in both the
// initiatives list and the shipped list.

export interface BriefNavInput {
    queue: { key: string }[];
    efforts: { oref: string }[];
    sessions: { key: string }[];
    deltaGroups: { rows: { key: string }[] }[];
    shipped: { oref: string }[];
}

export function briefNavIds(input: BriefNavInput): string[] {
    return [
        ...input.queue.map((q) => `waiting:${q.key}`),
        ...input.efforts.map((e) => `initiatives:${e.oref}`),
        ...input.sessions.map((s) => `sessions:${s.key}`),
        ...input.deltaGroups.flatMap((g) => g.rows.map((d) => `behind:${d.key}`)),
        ...input.shipped.map((s) => `behind:shipped:${s.oref}`),
    ];
}

/**
 * The cursor the surface should actually render. The Brief re-derives every row on each snapshot
 * refresh, so the row under the cursor can resolve out from under it — an ask gets answered, a session
 * finishes. A cursor naming a row that no longer exists would leave j/k dead with nothing highlighted,
 * so it falls back to the first row rather than persisting a reference to something gone.
 */
export function resolveBriefCursor(ids: string[], cursor: string | undefined): string | undefined {
    if (ids.length === 0) {
        return undefined;
    }
    return cursor != null && ids.includes(cursor) ? cursor : ids[0];
}
