// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { shortModel } from "./modelname";

describe("shortModel", () => {
    it("drops the claude- prefix from a full claude id", () => {
        expect(shortModel("claude-opus-5-5")).toBe("opus-5-5");
    });

    it("leaves an alias as is", () => {
        expect(shortModel("sonnet")).toBe("sonnet");
    });

    it("names an empty model default", () => {
        expect(shortModel("")).toBe("default");
        expect(shortModel(undefined)).toBe("default");
        expect(shortModel(null)).toBe("default");
    });

    // the provider is what tells two pi routes to the same model apart
    it("keeps a pi provider/model whole", () => {
        expect(shortModel("anthropic/claude-opus-5-5")).toBe("anthropic/claude-opus-5-5");
    });
});
