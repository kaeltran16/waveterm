// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { pickerTitleFor } from "./route";

describe("pickerTitleFor — A1 compact", () => {
    it("returns custom title when provided", () => {
        expect(pickerTitleFor("Lead model")).toBe("Lead model");
        expect(pickerTitleFor("Workers model")).toBe("Workers model");
    });

    it("falls back to Run route when no custom title", () => {
        expect(pickerTitleFor(undefined)).toBe("Run route");
        expect(pickerTitleFor("")).toBe("Run route");
    });
});
