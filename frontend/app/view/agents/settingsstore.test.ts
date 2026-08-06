// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it } from "vitest";
import { pendingSettingsSectionAtom, SETTINGS_SECTION_EMBEDDINGS, takePendingSettingsSection } from "./settingsstore";

describe("takePendingSettingsSection", () => {
    it("returns nothing when no escort is pending", () => {
        globalStore.set(pendingSettingsSectionAtom, null);
        expect(takePendingSettingsSection()).toBeNull();
    });

    it("honours one escort exactly once, so a remount does not re-scroll", () => {
        globalStore.set(pendingSettingsSectionAtom, SETTINGS_SECTION_EMBEDDINGS);
        expect(takePendingSettingsSection()).toBe(SETTINGS_SECTION_EMBEDDINGS);
        expect(takePendingSettingsSection()).toBeNull();
    });
});
