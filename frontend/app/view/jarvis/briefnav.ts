// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief's j/k cursor. The ids it walks are the drawn lines' own (briefrows.ts builds them, region-
// prefixed, because one object can sit in two regions), so a filtered or folded row is never navigable.

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
