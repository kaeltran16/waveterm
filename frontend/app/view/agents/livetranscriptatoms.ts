// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Leaf module owning the whole-map transcript atoms and the per-id read slices derived
// from them (atomFamily + selectAtom). Per-id slices let a single agent's stream chunk
// re-render only that card instead of the whole fleet: the chunk writer spreads the
// whole map and replaces only [id], so an unchanged id keeps its exact array reference
// and selectAtom's default Object.is equality skips it.
//
// This module must not import from ./livetranscript (that file imports the whole-map
// atoms and dropLiveId from here instead, to avoid a cycle).

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";
import type { AgentEntry, CardTask } from "./agentsviewmodel";

export const liveEntriesByIdAtom = atom<Record<string, AgentEntry[]>>({}) as PrimitiveAtom<Record<string, AgentEntry[]>>;
export const lastActivityByIdAtom = atom<Record<string, number>>({}) as PrimitiveAtom<Record<string, number>>;
// latest TodoWrite task list per agent, projected from the same open stream (card task chip)
export const tasksByIdAtom = atom<Record<string, CardTask[]>>({}) as PrimitiveAtom<Record<string, CardTask[]>>;

const EMPTY_ENTRIES: AgentEntry[] = [];

const entriesFamily = atomFamily((id: string) => selectAtom(liveEntriesByIdAtom, (m) => m[id] ?? EMPTY_ENTRIES));
const activityFamily = atomFamily((id: string) => selectAtom(lastActivityByIdAtom, (m) => m[id]));
const tasksFamily = atomFamily((id: string) => selectAtom(tasksByIdAtom, (m) => m[id]));

export const entriesAtomFor = (id: string): Atom<AgentEntry[]> => entriesFamily(id);
export const activityAtomFor = (id: string): Atom<number | undefined> => activityFamily(id);
export const tasksAtomFor = (id: string): Atom<CardTask[] | undefined> => tasksFamily(id);

type Store = Pick<typeof globalStore, "get" | "set">;

function dropFromMap<T>(store: Store, mapAtom: PrimitiveAtom<Record<string, T>>, id: string): void {
    const cur = store.get(mapAtom);
    if (id in cur) {
        const next = { ...cur };
        delete next[id];
        store.set(mapAtom, next);
    }
}

// Clear an id from every whole-map atom on stream stop (unbounded retention otherwise) and
// drop its atomFamily entries so the derived-atom cache stays bounded too.
export function dropLiveId(id: string, store: Store = globalStore): void {
    dropFromMap(store, liveEntriesByIdAtom, id);
    dropFromMap(store, lastActivityByIdAtom, id);
    dropFromMap(store, tasksByIdAtom, id);
    entriesFamily.remove(id);
    activityFamily.remove(id);
    tasksFamily.remove(id);
}
