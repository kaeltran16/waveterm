// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Which rows are new since your last visit — the north star of the Jarvis motion pass
// (docs/superpowers/specs/2026-09-11-jarvis-motion-design.md).
//
// A Set of keys rather than a field on each row type, because the three marked regions build their
// rows in three different places and none of them holds the cursor: the waiting queue comes from
// buildAttentionQueue (the live attention poll), initiatives from buildEffortCard (also called by
// effortdetailview and the list splitter, neither of which has a cursor to give), and sessions from
// mergeActiveWork in the view. One helper keeps the comparison and the cap in a single tested place
// instead of widening three signatures and a shared card model.

// Above this many fresh rows in a region the mark suppresses entirely. At that point every row is new,
// "new" stops discriminating, and the mark is decoration rather than a reading aid — a week away must
// not light up the whole surface. Shipped rows keep their own static "New" badge regardless.
export const FRESH_MARK_CAP = 6;

export interface FreshCandidate {
    key: string;
    /** null is never fresh: a blocked-chunk queue row has no waiting-since to compare against. */
    ts: number | null;
}

export function freshKeys(rows: FreshCandidate[], cursor: number, cap = FRESH_MARK_CAP): Set<string> {
    // a cursor this build cannot trust must mark nothing rather than mark everything
    if (!Number.isFinite(cursor) || cursor <= 0) {
        return new Set();
    }
    const fresh = (rows ?? []).filter((r) => r.ts != null && Number.isFinite(r.ts) && r.ts >= cursor);
    return fresh.length > cap ? new Set() : new Set(fresh.map((r) => r.key));
}
