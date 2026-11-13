// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { initialChangeFlashState, nextChangeFlash, nextLastShown } from "./motionhooks";

describe("nextChangeFlash", () => {
    it("does not flash the first value it sees", () => {
        const r = nextChangeFlash(initialChangeFlashState(), "queued");
        expect(r.flash).toBe(false);
        expect(r.state).toEqual({ seen: true, value: "queued" });
    });

    it("does not flash a value equal to the previous one", () => {
        const first = nextChangeFlash(initialChangeFlashState(), 3);
        expect(nextChangeFlash(first.state, 3).flash).toBe(false);
    });

    it("flashes a value that differs from the previous one, and remembers it", () => {
        const first = nextChangeFlash(initialChangeFlashState(), "queued");
        const r = nextChangeFlash(first.state, "running");
        expect(r.flash).toBe(true);
        expect(r.state.value).toBe("running");
        expect(nextChangeFlash(r.state, "running").flash).toBe(false);
    });

    it("treats a first value of undefined as seen, so a later value flashes", () => {
        const first = nextChangeFlash<string | undefined>(initialChangeFlashState(), undefined);
        expect(first.flash).toBe(false);
        expect(nextChangeFlash(first.state, "done").flash).toBe(true);
    });
});

describe("nextLastShown", () => {
    it("is null before any value", () => {
        expect(nextLastShown<string>(null, null)).toBeNull();
        expect(nextLastShown<string>(null, undefined)).toBeNull();
    });

    it("returns the live value", () => {
        expect(nextLastShown<string>(null, "refused")).toBe("refused");
    });

    it("holds the last value after null or undefined", () => {
        const held = nextLastShown<string>(null, "refused");
        expect(nextLastShown(held, null)).toBe("refused");
        expect(nextLastShown(held, undefined)).toBe("refused");
    });

    it("replaces the held value with a second, different one", () => {
        const first = nextLastShown<string>(null, "refused");
        const cleared = nextLastShown(first, null);
        expect(nextLastShown(cleared, "timed out")).toBe("timed out");
    });
});
