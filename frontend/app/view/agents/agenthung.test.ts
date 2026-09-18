// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { HUNG_AFTER_MS, hungSilenceMs } from "./agenthung";

const claudeWorking = { agent: "claude", state: "working" as const };

describe("hungSilenceMs", () => {
    it("flags claude working with no output past the threshold", () => {
        expect(hungSilenceMs(claudeWorking, 1_000, 1_000 + HUNG_AFTER_MS)).toBe(HUNG_AFTER_MS);
    });
    it("flips to hung as the clock passes a stamp that never moves", () => {
        const stamp = 10_000;
        expect(hungSilenceMs(claudeWorking, stamp, stamp + HUNG_AFTER_MS - 1)).toBeNull();
        expect(hungSilenceMs(claudeWorking, stamp, stamp + HUNG_AFTER_MS + 60_000)).toBe(HUNG_AFTER_MS + 60_000);
    });
    it("leaves silent-by-design states alone", () => {
        for (const state of ["asking", "idle"] as const) {
            expect(hungSilenceMs({ agent: "claude", state }, 0, HUNG_AFTER_MS * 10)).toBeNull();
        }
    });
    it("does not judge a runtime whose output was never measured", () => {
        expect(hungSilenceMs({ agent: "pi", state: "working" }, 1_000, 1_000 + HUNG_AFTER_MS * 10)).toBeNull();
    });
    it("does not judge a block with no output stamp", () => {
        expect(hungSilenceMs(claudeWorking, undefined, HUNG_AFTER_MS * 10)).toBeNull();
    });
});
