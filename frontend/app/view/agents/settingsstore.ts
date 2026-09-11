// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Settings surface's only cross-surface state: which section a deep link wants. Its own file rather
// than an atom exported from settingssurface.tsx, so a caller does not have to import a surface component
// to navigate into it.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type PrimitiveAtom } from "jotai";
import { SECTION_EMBEDDINGS } from "./settingsmodel";

// The section id from the registry, so a deep link selects a section in the two-pane layout rather
// than naming a scroll target that has to be kept in sync separately.
export const SETTINGS_SECTION_EMBEDDINGS = SECTION_EMBEDDINGS;

export const pendingSettingsSectionAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

export function takePendingSettingsSection(): string | null {
    const want = globalStore.get(pendingSettingsSectionAtom);
    if (want != null) {
        globalStore.set(pendingSettingsSectionAtom, null);
    }
    return want;
}
