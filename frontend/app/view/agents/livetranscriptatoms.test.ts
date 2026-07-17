// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { liveEntriesByIdAtom, lastActivityByIdAtom, tasksByIdAtom } from "./livetranscript";
import { entriesAtomFor, dropLiveId } from "./livetranscriptatoms";

describe("per-id atom slices", () => {
    it("reads the id's slice and is referentially stable when an unrelated id changes", () => {
        const store = createStore();
        store.set(liveEntriesByIdAtom, { a: [{ kind: "message", index: 0, text: "hi" } as any], b: [] });
        const aAtom = entriesAtomFor("a");
        const before = store.get(aAtom);
        // mutate only b's slice (new whole-map object, a's array reference preserved)
        store.set(liveEntriesByIdAtom, { ...store.get(liveEntriesByIdAtom), b: [{ kind: "message", index: 1, text: "x" } as any] });
        const after = store.get(aAtom);
        expect(after).toBe(before); // a's slice unchanged by reference -> selectAtom will not re-render a
    });

    it("dropLiveId removes the id from all whole-map atoms and clears its atomFamily entry", () => {
        const store = createStore();
        store.set(liveEntriesByIdAtom, { a: [], b: [] });
        store.set(lastActivityByIdAtom, { a: 1, b: 2 });
        store.set(tasksByIdAtom, { a: [], b: [] });
        const before = entriesAtomFor("a");
        dropLiveId("a", store);
        expect("a" in store.get(liveEntriesByIdAtom)).toBe(false);
        expect("a" in store.get(lastActivityByIdAtom)).toBe(false);
        expect("a" in store.get(tasksByIdAtom)).toBe(false);
        expect("b" in store.get(liveEntriesByIdAtom)).toBe(true);
        expect("b" in store.get(lastActivityByIdAtom)).toBe(true);
        expect("b" in store.get(tasksByIdAtom)).toBe(true);
        // atomFamily returns the same instance for a given id until .remove() is called; a fresh
        // instance here proves dropLiveId actually cleared the family cache for "a".
        const after = entriesAtomFor("a");
        expect(after).not.toBe(before);
    });
});
