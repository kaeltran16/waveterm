// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it } from "vitest";
import { claudeApiKeyActiveAtom, syncClaudeApiKeyActive } from "./claudeapikeystore";

describe("syncClaudeApiKeyActive", () => {
    beforeEach(() => {
        globalStore.set(claudeApiKeyActiveAtom, false);
    });

    it("sets the atom from the active flag", () => {
        syncClaudeApiKeyActive({
            loggedin: true,
            accounts: [],
            apikey: { saved: true, last4: "abcd", active: true, settingspath: "" },
        });
        expect(globalStore.get(claudeApiKeyActiveAtom)).toBe(true);
    });

    it("leaves the atom alone for null", () => {
        globalStore.set(claudeApiKeyActiveAtom, true);
        syncClaudeApiKeyActive(null);
        expect(globalStore.get(claudeApiKeyActiveAtom)).toBe(true);
    });

    it("clears the atom when the data has no apikey", () => {
        globalStore.set(claudeApiKeyActiveAtom, true);
        syncClaudeApiKeyActive({ loggedin: true, accounts: [] });
        expect(globalStore.get(claudeApiKeyActiveAtom)).toBe(false);
    });
});
