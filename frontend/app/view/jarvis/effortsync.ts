// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What the cockpit does on wavesrv's effort:update event, which carries no payload: one flush per burst
// re-reads the effort list, refreshes or drops every cached effort detail it makes stale, and reloads the
// briefing when the Brief is showing.

import { throttle } from "throttle-debounce";

// trailing-only throttle: a burst of ticks is one flush, and a steady stream still flushes once per window
// (a debounce would wait for the stream to stop)
export const EFFORT_SYNC_WINDOW_MS = 500;

// the Brief reloads on entry, so off the Brief a briefing reload (a ~14s FetchWorkState) is wasted
const BRIEF_SURFACE = "jarvis";

export type EffortSyncDeps = {
    surface: () => string;
    cachedORefs: () => string[];
    // the full list, archived included, so an oref missing from it was deleted
    listEfforts: () => Promise<EffortSummary[]>;
    reloadBriefing: () => Promise<void>;
    // a no-op when the cached copy is already as new as freshTs
    refreshDetail: (oref: string, freshTs: number) => Promise<void>;
    dropDetails: (orefs: string[]) => void;
};

export async function flushEffortSync(deps: EffortSyncDeps): Promise<void> {
    if (deps.surface() === BRIEF_SURFACE) {
        void deps.reloadBriefing();
    }
    let listed: EffortSummary[];
    try {
        listed = await deps.listEfforts();
    } catch (e) {
        console.error("effort sync: could not list efforts", e);
        return;
    }
    const freshTs = new Map(listed.map((s) => [s.oref, s.updatedts]));
    const cached = deps.cachedORefs();
    const gone = cached.filter((oref) => !freshTs.has(oref));
    if (gone.length > 0) {
        deps.dropDetails(gone);
    }
    await Promise.all(
        cached
            .filter((oref) => freshTs.has(oref))
            .map((oref) =>
                deps.refreshDetail(oref, freshTs.get(oref)).catch((e) => {
                    console.error(`effort sync: could not refresh ${oref}`, e);
                })
            )
    );
}

export function createEffortSync(deps: EffortSyncDeps): { poke: () => void; cancel: () => void } {
    const poke = throttle(EFFORT_SYNC_WINDOW_MS, () => void flushEffortSync(deps), { noLeading: true });
    return { poke, cancel: () => poke.cancel() };
}
