// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure model for pinning Sessions rows: which rows a pin set holds, toggling one, and pruning keys whose
// session left the window. A pin key is a row key (`${runtime}:${id}` or `run:<runId>`). No React, no store.

import { runSelKey, sessionKey } from "./sessionsruns";
import type { Row } from "./sessionssearch";

// a run row is pinned by its own key, or by a member session's key (a session pinned before it joined a run)
export function rowPinKeys(row: Row): string[] {
    return row.run ? [row.key, ...row.run.group.sessions.map(sessionKey)] : [row.key];
}

export function isRowPinned(row: Row, pins: ReadonlySet<string>): boolean {
    return rowPinKeys(row).some((k) => pins.has(k));
}

export function togglePinnedRow(pins: string[], row: Row): string[] {
    if (isRowPinned(row, new Set(pins))) {
        const drop = new Set(rowPinKeys(row));
        return pins.filter((k) => !drop.has(k));
    }
    return [...pins, row.key];
}

// returns the input array itself when nothing is dropped, so a caller can test `next !== pins`
export function prunePins(pins: string[], sessions: SessionActivity[]): string[] {
    const known = new Set<string>();
    for (const s of sessions) {
        known.add(sessionKey(s));
        if (s.runid) {
            known.add(runSelKey(s.runid));
        }
    }
    const kept = pins.filter((k) => known.has(k));
    return kept.length === pins.length ? pins : kept;
}
