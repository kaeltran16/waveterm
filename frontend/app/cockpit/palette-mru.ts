// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// What the command palette remembers you using. A plain most-recently-used list rather than a frecency
// score: two effects, one stored array, and no decay constants to guess at. The write path is a pure
// function applied through a functional atom update, so everything here is unit-testable without
// localStorage.

import { atomWithStorage } from "jotai/utils";

export const MAX_MRU = 20;
export const MAX_RECENT = 5; // rows shown under the Recent group on an empty query

// atomWithStorage convention from themestore.ts / railstore.ts.
export const paletteMruAtom = atomWithStorage<string[]>("cockpit.palette.mru", []);

export function nextMru(prev: string[], key: string): string[] {
    return [key, ...prev.filter((k) => k !== key)].slice(0, MAX_MRU);
}

// Floats recently-used items to the front *before* ranking. Array.prototype.sort is stable, so items
// with no history keep their input order — which is what makes "the more recent row wins among equal
// fuzzy scores" true without adding a weighting term to the score itself.
export function sortByMru<T extends { key: string }>(items: T[], mru: string[]): T[] {
    const pos = new Map(mru.map((k, i) => [k, i]));
    const rank = (it: T) => pos.get(it.key) ?? Number.MAX_SAFE_INTEGER;
    return [...items].sort((a, b) => rank(a) - rank(b));
}

// Resolves history keys against the current pool, in history order, dropping keys whose item is gone.
export function recentItems<T extends { key: string }>(items: T[], mru: string[], limit: number): T[] {
    const byKey = new Map(items.map((it) => [it.key, it]));
    const out: T[] = [];
    for (const k of mru) {
        const found = byKey.get(k);
        if (found != null) {
            out.push(found);
        }
        if (out.length === limit) {
            break;
        }
    }
    return out;
}
