// frontend/util/util.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { cn } from "./util";

describe("cn", () => {
    it("keeps a custom font-size token when a text color rides along", () => {
        const out = cn("font-mono text-xxxs font-semibold uppercase", "bg-warning/10 text-warning");
        expect(out).toContain("text-xxxs");
        expect(out).toContain("text-warning");
    });

    it("keeps every custom font-size token against a color", () => {
        for (const size of ["text-xxxs", "text-xxs", "text-title", "text-default"]) {
            expect(cn(size, "text-success")).toBe(`${size} text-success`);
        }
    });

    it("still resolves a real font-size conflict, last one wins", () => {
        expect(cn("text-xxxs", "text-xxs")).toBe("text-xxs");
        expect(cn("text-sm", "text-xxxs")).toBe("text-xxxs");
    });

    it("still resolves a real text-color conflict, last one wins", () => {
        expect(cn("text-primary", "text-warning")).toBe("text-warning");
    });
});
