// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseChunkLines } from "./effortcreateform";

describe("parseChunkLines", () => {
    it("splits lines and defaults unchecked", () => {
        expect(parseChunkLines("Phase 1\nPhase 2 — N1 WAF\n")).toEqual([
            { label: "Phase 1", checked: false },
            { label: "Phase 2 — N1 WAF", checked: false },
        ]);
    });
    it("drops blank lines and trims", () => {
        expect(parseChunkLines("  \nP1  \n\n  P2")).toEqual([
            { label: "P1", checked: false },
            { label: "P2", checked: false },
        ]);
    });
});
