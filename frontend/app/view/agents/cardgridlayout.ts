// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What is left of the cockpit's card grid: a leadless run's address, and keeping a cursor on a visible stop.
// No React, no atoms.

const LEADLESS_PREFIX = "run:";

// a run's card with no lead in the roster goes by the run's address, which also opens its run sheet
export function leadlessCardId(runId: string): string {
    return `${LEADLESS_PREFIX}${runId}`;
}

/** Pure: keep the cursor on something visible. An id with no stop of its own (a worker, whose ask lives in its
 *  lead's row) goes to its alias. */
export function resolveCursor(
    cur: string | undefined,
    nav: string[],
    alias: Record<string, string>
): string | undefined {
    if (nav.length === 0) {
        return undefined;
    }
    if (cur != null && nav.includes(cur)) {
        return cur;
    }
    const aliased = cur != null ? alias[cur] : undefined;
    return aliased != null && nav.includes(aliased) ? aliased : nav[0];
}
