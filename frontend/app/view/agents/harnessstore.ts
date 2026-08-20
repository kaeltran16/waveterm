// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Shared preferred-harness state. One global atom holds the selection, its persisted confirmation,
// the in-flight save state, and any save error, so Run creation, Pet Errand, and bare Ask all read the
// same visible choice. The pure transition functions below are unit-tested; the RPC actions wrap them.

import { atom } from "jotai";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { globalStore } from "@/app/store/global";

export interface HarnessPreferenceState {
    runtime: string; // selected, may be ahead of persistence
    persistedRuntime: string; // the last value confirmed by the server
    tier: string; // selected model tier, may be ahead of persistence
    persistedTier: string; // the last tier confirmed by the server
    saving: boolean;
    error?: string;
}

export const emptyHarnessPreference: HarnessPreferenceState = {
    runtime: "",
    persistedRuntime: "",
    tier: "capable",
    persistedTier: "capable",
    saving: false,
};

export const harnessPreferenceAtom = atom<HarnessPreferenceState>(emptyHarnessPreference);

export const harnessesAtom = atom<HarnessInfo[]>([]);

// resolveDefaultRuntime picks the runtime to pre-select for launch paths. An explicit preference
// wins when its harness is installed and run-worker-capable; otherwise pi when installed; otherwise
// the first installed run-worker-capable harness; otherwise "" so the caller blocks (mirrors the
// current "no valid harness" guard).
export function resolveDefaultRuntime(pref: string, harnesses: HarnessInfo[]): string {
    if (pref && harnesses.some((h) => h.runtime === pref && h.installed && h.runworkercapable)) {
        return pref;
    }
    const first = harnesses.find((h) => h.installed && h.runworkercapable);
    return first ? first.runtime : "";
}

// beginSave flips the shared state into saving for a new selection. The runtime updates immediately
// (both pickers stay synchronized) while persistedRuntime is untouched until the write succeeds.
export function beginSave(state: HarnessPreferenceState, runtime: string, tier: string): HarnessPreferenceState {
    return {
        runtime,
        persistedRuntime: state.persistedRuntime,
        tier,
        persistedTier: state.persistedTier,
        saving: true,
    };
}

// persistSave confirms the write succeeded: the selection becomes durable.
export function persistSave(state: HarnessPreferenceState): HarnessPreferenceState {
    return {
        runtime: state.runtime,
        persistedRuntime: state.runtime,
        tier: state.tier,
        persistedTier: state.tier,
        saving: false,
        error: undefined,
    };
}

// failSave rolls the visible selection back to the last persisted value so a failed write is never
// mistaken for durable, and surfaces the error.
export function failSave(state: HarnessPreferenceState, error: string): HarnessPreferenceState {
    return {
        runtime: state.persistedRuntime,
        persistedRuntime: state.persistedRuntime,
        tier: state.persistedTier,
        persistedTier: state.persistedTier,
        saving: false,
        error,
    };
}

// setPreferredHarness updates the shared atom immediately, persists via SetConfigCommand, and rolls
// back on failure. Async by nature; the caller should not await it to dispatch.
export function setPreferredHarness(runtime: string): void {
    const current = globalStore.get(harnessPreferenceAtom);
    if (current.saving || current.runtime === runtime) {
        return;
    }
    const tier = current.tier || "capable";
    globalStore.set(harnessPreferenceAtom, beginSave(current, runtime, tier));
    void (async () => {
        try {
            await RpcApi.SetConfigCommand(TabRpcClient, {
                "harness:preferredruntime": runtime,
                "harness:preferredtier": tier,
            } as Parameters<typeof RpcApi.SetConfigCommand>[1]);
            globalStore.set(harnessPreferenceAtom, persistSave(globalStore.get(harnessPreferenceAtom)));
        } catch (e) {
            globalStore.set(harnessPreferenceAtom, failSave(globalStore.get(harnessPreferenceAtom), String(e)));
        }
    })();
}

// initHarnessPreference seeds the atom from the persisted setting and the server's harness list.
export function initHarnessPreference(persistedRuntime: string, persistedTier = ""): void {
    const current = globalStore.get(harnessPreferenceAtom);
    if (current.saving) {
        return; // a selection is mid-flight; don't clobber it with the boot value
    }
    const tier = persistedTier || "capable";
    globalStore.set(harnessPreferenceAtom, {
        runtime: persistedRuntime,
        persistedRuntime,
        tier,
        persistedTier: tier,
        saving: false,
    });
}

// loadHarnesses fetches the installed harness catalog into the shared atom. Best-effort: a missing
// catalog leaves the picker rows empty rather than crashing the surface.
export async function loadHarnesses(): Promise<void> {
    try {
        const rtn = await RpcApi.ListHarnessesCommand(TabRpcClient);
        globalStore.set(harnessesAtom, rtn?.harnesses ?? []);
    } catch (e) {
        console.error("loading harness catalog failed", e);
        globalStore.set(harnessesAtom, []);
    }
}
