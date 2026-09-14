// frontend/app/view/code/codeeditorcache.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: the recency bookkeeping behind the editors the Code surface keeps alive after they unmount.
// A Map already iterates in insertion order, so re-inserting a key is what makes it most recent.

// Returns the values pushed out past `cap`, oldest first, so the caller can release what they hold.
export function remember<T>(cache: Map<string, T>, key: string, value: T, cap: number): T[] {
    cache.delete(key);
    cache.set(key, value);
    const evicted: T[] = [];
    for (const [k, v] of cache) {
        if (cache.size <= cap) {
            break;
        }
        cache.delete(k);
        evicted.push(v);
    }
    return evicted;
}
