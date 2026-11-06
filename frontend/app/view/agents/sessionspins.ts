// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure model for pinning Sessions rows: which rows a pin set holds, toggling one, and pruning keys whose
// session left the window. A pin key is a row key (`${runtime}:${id}` or `run:<runId>`). No React, no store.

import { memberSession, runSelKey, sessionKey } from "./sessionsruns";
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
    // the lead's key brings a run older than the session window back with its lead
    const lead = row.run ? memberSession(row.run.group.lead) : undefined;
    return lead ? [...pins, row.key, sessionKey(lead)] : [...pins, row.key];
}

// drops a pin only if the load was sent it and returned no session for it: a pin added while the load ran was
// never asked about. Returns the input array itself when nothing is dropped, so a caller can test `next !== pins`
export function prunePins(pins: string[], sessions: SessionActivity[], sent: readonly string[]): string[] {
    const asked = new Set(sent);
    const known = new Set<string>();
    for (const s of sessions) {
        known.add(sessionKey(s));
        if (s.runid) {
            known.add(runSelKey(s.runid));
        }
    }
    const kept = pins.filter((k) => !asked.has(k) || known.has(k));
    return kept.length === pins.length ? pins : kept;
}
