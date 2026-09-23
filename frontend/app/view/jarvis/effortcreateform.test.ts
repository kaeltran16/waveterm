// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseChunkLines } from "./effortcreateform";

describe("parseChunkLines", () => {
    it("splits lines and defaults unchecked", () => {
        expect(parseChunkLines("Phase 1\nPhase 2 — N1 WAF\n")).toEqual([
            { label: "Phase 1", stage: "", checked: false },
            { label: "Phase 2 — N1 WAF", stage: "", checked: false },
        ]);
    });
    it("drops blank lines and trims", () => {
        expect(parseChunkLines("  \nP1  \n\n  P2")).toEqual([
            { label: "P1", stage: "", checked: false },
            { label: "P2", stage: "", checked: false },
        ]);
    });
});

describe("parseChunkLines stages", () => {
    it("splits on the first colon-space", () => {
        expect(parseChunkLines("Phase 1: WAF scan\nPhase 1: Rule diff: prod\nloose")).toEqual([
            { label: "WAF scan", stage: "Phase 1", checked: false },
            { label: "Rule diff: prod", stage: "Phase 1", checked: false },
            { label: "loose", stage: "", checked: false },
        ]);
    });
    it("keeps a trailing colon or a colon with no space as part of the label", () => {
        expect(parseChunkLines("Note:\nhttp://x")).toEqual([
            { label: "Note:", stage: "", checked: false },
            { label: "http://x", stage: "", checked: false },
        ]);
    });
});
