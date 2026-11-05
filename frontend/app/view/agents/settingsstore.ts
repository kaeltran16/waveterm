// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Settings surface's state that outlives it: which section a deep link wants, and which one is shown. Its
// own file rather than atoms exported from settingssurface.tsx, so a caller does not have to import a surface
// component to navigate into it.

import { globalStore } from "@/app/store/jotaiStore";
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
