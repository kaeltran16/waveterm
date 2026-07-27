// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Active-Space (Presence C) state. Module-scope atoms so focus survives the surface unmount on nav-switch
// (only the agent surface stays mounted). Lives under view/agents/ so the scoped surfaces (roster,
// channels) read it without importing the jarvis view (the one-directional import rule).

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import type { SurfaceKey } from "./agents";

// null = Global (Presence D). A summary = the focused task.
export const activeSpaceAtom = atom<SpaceSummary | null>(null) as PrimitiveAtom<SpaceSummary | null>;
// the resolved scope bundle for the active Space; null when Global or while a resolve is in flight.
export const spaceScopeAtom = atom<SpaceScope | null>(null) as PrimitiveAtom<SpaceScope | null>;
// which scoped surfaces the user clicked "Show all" on; reset on every switch.
export const spaceRevealAtom = atom<Set<SurfaceKey>>(new Set<SurfaceKey>());
// the switcher/palette task list (active+paused), newest-updated first.
export const spacesAtom = atom<SpaceSummary[]>([]);

export function loadSpaces(): void {
    fireAndForget(async () => {
        const rtn = await RpcApi.ListDossiersCommand(TabRpcClient);
        globalStore.set(spacesAtom, rtn?.spaces ?? []);
    });
}

// enterSpace focuses a task: flip the indicator immediately, clear prior reveals, then resolve its scope
// bundle (async). A stale resolve (user switched/exited mid-flight) is discarded.
export function enterSpace(summary: SpaceSummary): void {
    globalStore.set(activeSpaceAtom, summary);
    globalStore.set(spaceRevealAtom, new Set<SurfaceKey>());
    globalStore.set(spaceScopeAtom, null);
    fireAndForget(async () => {
        const scope = await RpcApi.ResolveSpaceScopeCommand(TabRpcClient, { dossierid: summary.id });
        if (globalStore.get(activeSpaceAtom)?.id !== summary.id) {
            return;
        }
        globalStore.set(spaceScopeAtom, scope ?? null);
    });
}

export function exitSpace(): void {
    globalStore.set(activeSpaceAtom, null);
    globalStore.set(spaceScopeAtom, null);
    globalStore.set(spaceRevealAtom, new Set<SurfaceKey>());
}

export function revealSurface(key: SurfaceKey): void {
    const next = new Set(globalStore.get(spaceRevealAtom));
    next.add(key);
    globalStore.set(spaceRevealAtom, next);
}

export function concealSurface(key: SurfaceKey): void {
    const next = new Set(globalStore.get(spaceRevealAtom));
    next.delete(key);
    globalStore.set(spaceRevealAtom, next);
}
