// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Shared preferred-route state. The route pin is authoritative for run-worker launches; the
// compatibility harness setter keeps consult callers on the same persisted choice.

import { atom } from "jotai";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { globalStore } from "@/app/store/global";
import { capabilityFor } from "./route";

export interface HarnessPreferenceState {
    route: RoutePin | null;
    persistedRoute: RoutePin | null;
    saving: boolean;
    error?: string;
}

export const emptyHarnessPreference: HarnessPreferenceState = {
    route: null,
    persistedRoute: null,
    saving: false,
};

export const harnessPreferenceAtom = atom<HarnessPreferenceState>(emptyHarnessPreference);
export const harnessesAtom = atom<HarnessInfo[]>([]);

export function resolveDefaultRuntime(pref: string, harnesses: HarnessInfo[]): string {
    if (pref && harnesses.some((h) => h.runtime === pref && h.installed && h.runworkercapable)) {
        return pref;
    }
    const first = harnesses.find((h) => h.installed && h.runworkercapable);
    return first ? first.runtime : "";
}

function toPin(routeOrRuntime: RoutePin | string, tier?: string): RoutePin {
    return typeof routeOrRuntime === "string" ? { runtime: routeOrRuntime, tier: tier || "capable" } : routeOrRuntime;
}

export function beginSave(state: HarnessPreferenceState, routeOrRuntime: RoutePin | string, tier?: string): HarnessPreferenceState {
    return { route: toPin(routeOrRuntime, tier), persistedRoute: state.persistedRoute, saving: true };
}

export function persistSave(state: HarnessPreferenceState): HarnessPreferenceState {
    return { route: state.route, persistedRoute: state.route, saving: false, error: undefined };
}

export function failSave(state: HarnessPreferenceState, error: string): HarnessPreferenceState {
    return { route: state.persistedRoute, persistedRoute: state.persistedRoute, saving: false, error };
}

export function setPreferredRoute(route: RoutePin): void {
    const current = globalStore.get(harnessPreferenceAtom);
    if (current.saving || (current.route?.runtime === route.runtime && current.route?.tier === route.tier)) {
        return;
    }
    globalStore.set(harnessPreferenceAtom, beginSave(current, route));
    void (async () => {
        try {
            await RpcApi.SetConfigCommand(TabRpcClient, {
                "harness:preferredruntime": route.runtime,
                "harness:preferredtier": route.tier,
            } as Parameters<typeof RpcApi.SetConfigCommand>[1]);
            globalStore.set(harnessPreferenceAtom, persistSave(globalStore.get(harnessPreferenceAtom)));
        } catch (e) {
            globalStore.set(harnessPreferenceAtom, failSave(globalStore.get(harnessPreferenceAtom), String(e)));
        }
    })();
}

// Consult still passes a runtime string. Pick a backend-provided route rather than manufacturing a pair.
export function setPreferredHarness(runtime: string): void {
    const current = globalStore.get(harnessPreferenceAtom);
    const harness = globalStore.get(harnessesAtom).find((h) => h.runtime === runtime);
    const tier = current.route?.tier || "capable";
    const route = harness?.routecapabilities?.find((c) => c.tier === tier) ?? harness?.routecapabilities?.find((c) => c.tier === "capable");
    if (route == null) {
        globalStore.set(harnessPreferenceAtom, { ...current, error: `No route capability available for ${runtime}` });
        return;
    }
    setPreferredRoute({ runtime: route.runtime, tier: route.tier });
}

export function initHarnessPreference(persistedRuntime: string, persistedTier = ""): void {
    const current = globalStore.get(harnessPreferenceAtom);
    if (current.saving) {
        return;
    }
    const route = persistedRuntime ? { runtime: persistedRuntime, tier: persistedTier || "capable" } : null;
    globalStore.set(harnessPreferenceAtom, { route, persistedRoute: route, saving: false });
}

export async function loadHarnesses(): Promise<void> {
    try {
        const rtn = await RpcApi.ListHarnessesCommand(TabRpcClient);
        globalStore.set(harnessesAtom, rtn?.harnesses ?? []);
    } catch (e) {
        console.error("loading harness catalog failed", e);
        globalStore.set(harnessesAtom, []);
    }
}

export function preferredCapability(route: RoutePin | null): RouteCapabilityInfo | undefined {
    return route == null ? undefined : capabilityFor(route, globalStore.get(harnessesAtom));
}
