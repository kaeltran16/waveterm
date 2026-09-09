// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The run configuration being composed: shape, which machine fans out, how wide, and the two routes.
// Module-level rather than component state because the controls are in the launcher (the Stage's thread
// slot) while the goal and the Run ⏎ that consume them are in the composer below it — two components, one
// answer. It is also what keeps the choice across a surface switch, which unmounts everything but Agent.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type PrimitiveAtom } from "jotai";
import type { RunShape } from "./composercommand";
import type { Orchestration } from "./orchestratorpicker";
import { DEFAULT_PARALLELISM, clampParallelism } from "./runconfig";

export const runShapeAtom = atom<RunShape>("quick") as PrimitiveAtom<RunShape>;
export const orchestrationAtom = atom<Orchestration>("engine") as PrimitiveAtom<Orchestration>;
export const runRouteAtom = atom<RoutePin | null>(null) as PrimitiveAtom<RoutePin | null>;
export const workerRouteAtom = atom<RoutePin | null>(null) as PrimitiveAtom<RoutePin | null>;
export const parallelismAtom = atom<number>(DEFAULT_PARALLELISM) as PrimitiveAtom<number>;

// Whether the user has picked a route by hand on this channel. Until they have, the channel's preferred
// route keeps flowing in; after, it must not be overwritten under them. Was a component ref, and has to
// survive the same unmounts the atoms above do.
export const routeTouchedAtom = atom(false) as PrimitiveAtom<boolean>;

export function setParallelism(next: number): void {
    globalStore.set(parallelismAtom, clampParallelism(next));
}

// The stepper's two buttons. A delta rather than a computed value on purpose: clicks batch, so
// `set(atom, clamp(par + 1))` from a render closure re-reads the same stale `par` for every click in
// the batch and a fast double-click advances one step. Measured over CDP — twelve clicks moved 4 -> 5.
export function stepParallelism(delta: number): void {
    globalStore.set(parallelismAtom, (prev) => clampParallelism(prev + delta));
}

// Picking a lead route by hand is what stops the channel's preferred route flowing in over it, so the
// two writes are one action — a caller that set the atom alone would have its choice replaced on the
// next preference tick.
export function setRunRoute(next: RoutePin | null): void {
    globalStore.set(routeTouchedAtom, true);
    globalStore.set(runRouteAtom, next);
}

// A launch blocked for want of a usable route. The composer pairs this with revealing the launcher (the
// picker only exists while the launcher is on the Stage), and RoutePicker's open effect runs on mount, so
// a bump that lands before the picker exists still opens it.
export const routeOpenRequestAtom = atom(0) as PrimitiveAtom<number>;

export function requestRouteOpen(): void {
    globalStore.set(routeOpenRequestAtom, (n) => n + 1);
}

// Every control is per-channel: carrying an orchestrator-with-6-workers setup onto the next channel
// would silently arm a dispatch the user configured somewhere else.
export function resetRunConfig(): void {
    globalStore.set(runShapeAtom, "quick");
    globalStore.set(orchestrationAtom, "engine");
    globalStore.set(runRouteAtom, null);
    globalStore.set(workerRouteAtom, null);
    globalStore.set(parallelismAtom, DEFAULT_PARALLELISM);
    globalStore.set(routeTouchedAtom, false);
}

// The channel the current configuration was built for. Module-level, so a remount does not read as a
// channel change: every surface but Agent unmounts when you switch away, and a mount-keyed reset would
// throw away a configured-but-unlaunched run for the cost of a glance at Usage.
let configuredChannel: string | null | undefined;

export function resetRunConfigForChannel(channelId: string | null): void {
    if (configuredChannel === channelId) {
        return;
    }
    configuredChannel = channelId;
    resetRunConfig();
}

// test seam: resetRunConfig alone cannot clear the remembered channel, and a test that set one would
// otherwise leak it into the next test's first resetRunConfigForChannel call
export function forgetConfiguredChannel(): void {
    configuredChannel = undefined;
}
