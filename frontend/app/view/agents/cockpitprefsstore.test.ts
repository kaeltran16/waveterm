// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { coerceFontSize, startupSurfaceOptions } from "./cockpitprefsstore";

describe("startupSurfaceOptions", () => {
    it("returns the workflow surfaces without the agent surface", () => {
        const opts = startupSurfaceOptions();
        expect(opts).not.toContain("agent");
        expect(opts).not.toContain("settings");
        expect(opts).toContain("cockpit");
        expect(opts).toContain("usage");
    });
});

describe("coerceFontSize", () => {
    it("parses a valid integer", () => {
        expect(coerceFontSize("14")).toBe(14);
    });
    it("clamps below the minimum", () => {
        expect(coerceFontSize("2")).toBe(6);
    });
    it("clamps above the maximum", () => {
        expect(coerceFontSize("999")).toBe(48);
    });
    it("floors a decimal", () => {
        expect(coerceFontSize("13.7")).toBe(13);
    });
    it("rejects non-numeric input", () => {
        expect(coerceFontSize("abc")).toBeNull();
    });
    it("rejects empty input", () => {
        expect(coerceFontSize("")).toBeNull();
    });
});
