// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Settings surface's state that outlives it: which section a deep link wants, and which one is shown. Its
// own file rather than atoms exported from settingssurface.tsx, so a caller does not have to import a surface
// component to navigate into it.

import { pushToast } from "@/app/cockpit/notificationstore";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

export const pendingSettingsSectionAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

// The section Settings shows. Held here, not in the surface, because Settings unmounts on every surface switch.
export const settingsSectionAtom = atom<string>("appearance") as PrimitiveAtom<string>;

export function takePendingSettingsSection(): string | null {
    const want = globalStore.get(pendingSettingsSectionAtom);
    if (want != null) {
        globalStore.set(pendingSettingsSectionAtom, null);
    }
    return want;
}

// SetConfigCommand's data param is a typed settings map; a dynamic-key patch needs the cast. A null
// value deletes the key from settings.json (wconfig.SetBaseConfigValue), which is how Revert works —
// dropping the override lets the shipped default take over again. A refused write never moves the
// stored value, so the row would look saved while it is not: the toast says so.
export async function writeConfig(patch: Record<string, unknown>): Promise<void> {
    try {
        await RpcApi.SetConfigCommand(TabRpcClient, patch as Parameters<typeof RpcApi.SetConfigCommand>[1]);
    } catch (e) {
        console.error("settings write failed", patch, e);
        pushToast({ title: "Setting not saved", message: e instanceof Error ? e.message : String(e), level: "error" });
    }
}
