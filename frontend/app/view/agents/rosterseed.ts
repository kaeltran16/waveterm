// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The roster's first-load gate, kept pure so it is testable without the sidebar model. After a reload every
// terminal's status is read back from event history asynchronously; until each read settles, an empty
// roster means "not read yet", not "no agents".

import type { Atom, createStore, PrimitiveAtom } from "jotai";

type Store = ReturnType<typeof createStore>;

export function isRosterSeeded(
    orefs: string[],
    hasStatus: (oref: string) => boolean,
    settled: ReadonlySet<string>
): boolean {
    return orefs.every((oref) => hasStatus(oref) || settled.has(oref));
}

// One-way: flips latch the first time check reads true, then stops listening. The returned unsubscribe is
// for a caller that goes away before that happens.
export function latchWhenTrue(store: Store, check: Atom<boolean>, latch: PrimitiveAtom<boolean>): () => void {
    if (store.get(latch)) {
        return () => {};
    }
    if (store.get(check)) {
        store.set(latch, true);
        return () => {};
    }
    const unsub = store.sub(check, () => {
        if (store.get(check)) {
            store.set(latch, true);
            unsub();
        }
    });
    return unsub;
}
