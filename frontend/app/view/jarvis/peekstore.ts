// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The item the avatar popup is peeking at, if any. A peek shows a target without landing on it: openref.ts
// loads the target and writes it here, and the popup renders it in place of the hub. Nothing here touches a
// destination's selection, which is the point of a peek.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type PrimitiveAtom } from "jotai";
import type { OpenTarget } from "./address";
import { petPeekOpenAtom } from "./petstore";

export type PeekTarget = Exclude<OpenTarget, { kind: "channel" } | { kind: "canvas" }>;

// from: where Back and Escape return to. A peek started on a closed popup closes it again; one started from the
// hub returns there.
export type PeekItem = { target: PeekTarget; status: "loading" | "ready"; from: "closed" | "hub" };

export const peekItemAtom = atom<PeekItem | null>(null) as PrimitiveAtom<PeekItem | null>;

type PeekBase = { item: PeekItem | null; open: boolean };

// What a loading peek returns to if its load fails or an open supersedes it. Taken when a peek starts from a
// settled state; a peek that replaces a loading one keeps the base it found, so a failure never restores a
// spinner.
let base: PeekBase = { item: null, open: false };

export function backToHub(): void {
    globalStore.set(peekItemAtom, null);
    globalStore.set(petPeekOpenAtom, true);
}

export function closePeek(): void {
    globalStore.set(peekItemAtom, null);
    globalStore.set(petPeekOpenAtom, false);
}

// The popup opens at once on a loading item; the returned item is the handle settlePeek checks against.
export function startPeek(target: PeekTarget): PeekItem {
    const cur = globalStore.get(peekItemAtom);
    if (cur?.status !== "loading") {
        const open = globalStore.get(petPeekOpenAtom);
        // an item left behind by a popup closed some other way is not something to return to
        base = { item: open ? cur : null, open };
    }
    const item: PeekItem = { target, status: "loading", from: base.open ? (base.item?.from ?? "hub") : "closed" };
    globalStore.set(peekItemAtom, item);
    globalStore.set(petPeekOpenAtom, true);
    return item;
}

// A no-op once the item has been replaced or dismissed: a load that finishes after the user closed the popup
// must not reopen it.
export function settlePeek(item: PeekItem): void {
    if (globalStore.get(peekItemAtom) !== item) {
        return;
    }
    globalStore.set(peekItemAtom, { ...item, status: "ready" });
}

export function clearLoadingPeek(): void {
    if (globalStore.get(peekItemAtom)?.status !== "loading") {
        return;
    }
    globalStore.set(peekItemAtom, base.item);
    globalStore.set(petPeekOpenAtom, base.open);
}
