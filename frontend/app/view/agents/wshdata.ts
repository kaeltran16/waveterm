// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The one cache behind wsh cards and views: data a card needs beyond its own argv, keyed by what it reads
// ("effort:<id>", "run:<id>"), so many cards for one object fetch it once. The dev fixture seam seeds it.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, useAtomValue, type PrimitiveAtom } from "jotai";
import { useEffect } from "react";

export type WshDataState<T> = { status: "idle" | "loading" | "ready" | "error"; data?: T; error?: string };

// a card shows what it fetched for this long before a render refetches it
export const WSH_DATA_TTL_MS = 30_000;

const IDLE: WshDataState<never> = { status: "idle" };
const idleAtom = atom<WshDataState<unknown>>(IDLE);
const atoms = new Map<string, PrimitiveAtom<WshDataState<unknown>>>();
const fetchedAt = new Map<string, number>();
const inFlight = new Set<string>();
const seeded = new Set<string>();

export function wshDataAtom(key: string): PrimitiveAtom<WshDataState<unknown>> {
    let a = atoms.get(key);
    if (!a) {
        a = atom<WshDataState<unknown>>(IDLE) as PrimitiveAtom<WshDataState<unknown>>;
        atoms.set(key, a);
    }
    return a;
}

// requestWshData starts a fetch for key unless one is in flight, the key is seeded, or its last result is fresh.
// A refetch keeps the old data on screen until it lands.
export function requestWshData<T>(key: string, fetch: () => Promise<T>, now = Date.now()): void {
    if (seeded.has(key) || inFlight.has(key)) {
        return;
    }
    const a = wshDataAtom(key);
    const prev = globalStore.get(a);
    const last = fetchedAt.get(key);
    if (prev.status !== "idle" && last != null && now - last < WSH_DATA_TTL_MS) {
        return;
    }
    inFlight.add(key);
    if (prev.data === undefined) {
        globalStore.set(a, { status: "loading" });
    }
    const settle = (next: WshDataState<unknown>) => {
        inFlight.delete(key);
        fetchedAt.set(key, Date.now());
        globalStore.set(a, next);
    };
    let pending: Promise<T>;
    try {
        pending = fetch();
    } catch (e) {
        pending = Promise.reject(e);
    }
    pending.then(
        (data) => settle({ status: "ready", data }),
        (e) => {
            const error = e instanceof Error ? e.message : String(e);
            console.warn(`wshdata: fetch for ${key} failed`, error);
            settle({ status: "error", data: globalStore.get(a).data, error });
        }
    );
}

// null key = disabled. Every render past the TTL refetches, showing the old data meanwhile.
export function useWshData<T>(key: string | null, fetch: () => Promise<T>): WshDataState<T> {
    const state = useAtomValue(key ? wshDataAtom(key) : idleAtom);
    useEffect(() => {
        if (key) {
            requestWshData(key, fetch);
        }
    });
    return state as WshDataState<T>;
}

// seeded keys never expire, so a fixture's data is never replaced by a live fetch
export function seedWshData(seed: Record<string, unknown>): void {
    for (const [key, data] of Object.entries(seed)) {
        seeded.add(key);
        globalStore.set(wshDataAtom(key), { status: "ready", data });
    }
}
