// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { SURFACE_ORDER } from "./agents";
import { ITEMS } from "./navrail";

describe("radar navigation", () => {
    it("adds radar without dropping any existing surface", () => {
        for (const key of ["cockpit", "agent", "jarvis", "sessions", "files", "usage"]) {
            expect(SURFACE_ORDER).toContain(key);
        }
        expect(SURFACE_ORDER).toContain("radar");
    });

    it("places radar between sessions and usage", () => {
        expect(SURFACE_ORDER.indexOf("radar")).toBe(SURFACE_ORDER.indexOf("sessions") + 1);
        expect(SURFACE_ORDER.indexOf("usage")).toBe(SURFACE_ORDER.indexOf("radar") + 1);
    });

    it("exposes a radar nav item with a label", () => {
        const item = ITEMS.find((i) => i.key === "radar");
        expect(item?.label).toBe("Radar");
    });
});
