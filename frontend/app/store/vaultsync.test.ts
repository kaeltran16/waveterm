// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { FOCUS_SYNC_MIN_INTERVAL_MS, shouldSyncOnFocus } from "./vaultsync";

describe("shouldSyncOnFocus", () => {
    it("syncs on the first focus", () => {
        expect(shouldSyncOnFocus(null, 1_000)).toBe(true);
    });

    it("stays quiet inside the minimum interval", () => {
        expect(shouldSyncOnFocus(10_000, 10_000 + FOCUS_SYNC_MIN_INTERVAL_MS - 1)).toBe(false);
    });

    it("syncs again at exactly the minimum interval", () => {
        expect(shouldSyncOnFocus(10_000, 10_000 + FOCUS_SYNC_MIN_INTERVAL_MS)).toBe(true);
    });
});
