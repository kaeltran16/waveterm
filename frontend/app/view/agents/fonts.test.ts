// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    applyFontVars,
    DEFAULT_MONO,
    DEFAULT_SANS,
    DEFAULT_TERM_FONT,
    MONO_FONTS,
    SANS_FONTS,
    stackOf,
    termFontId,
    termFontPatch,
} from "./fonts";

describe("font catalog", () => {
    it("sans list has unique ids and includes the default", () => {
        const ids = SANS_FONTS.map((f) => f.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toContain(DEFAULT_SANS);
    });
    it("mono list has unique ids, includes the default and Fira Code", () => {
        const ids = MONO_FONTS.map((f) => f.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toContain(DEFAULT_MONO);
        expect(ids).toContain("firacode");
    });
    it("every stack is a non-empty string", () => {
        for (const f of [...SANS_FONTS, ...MONO_FONTS]) {
            expect(f.stack.length).toBeGreaterThan(0);
        }
    });
});

describe("stackOf", () => {
    it("returns the matching stack", () => {
        expect(stackOf(SANS_FONTS, "inter")).toBe('"Inter", system-ui, sans-serif');
    });
    it("falls back to the first entry for an unknown id", () => {
        expect(stackOf(SANS_FONTS, "nope")).toBe(SANS_FONTS[0].stack);
    });
});

describe("applyFontVars", () => {
    it("writes --font-sans and --font-mono from the given ids", () => {
        const set: Record<string, string> = {};
        const root = { style: { setProperty: (k: string, v: string) => (set[k] = v) } };
        applyFontVars(root as unknown as HTMLElement, "inter", "firacode");
        expect(set["--font-sans"]).toBe('"Inter", system-ui, sans-serif');
        expect(set["--font-mono"]).toBe('"Fira Code", monospace');
    });
});

describe("termFontId", () => {
    it("matches the bare family name the shipped default stores", () => {
        expect(termFontId("Fira Code")).toBe("firacode");
    });
    it("matches a catalog stack", () => {
        expect(termFontId('"JetBrains Mono", monospace')).toBe("jetbrains");
    });
    it("falls back to the terminal's own fallback when unset or unknown", () => {
        expect(termFontId("")).toBe(DEFAULT_TERM_FONT);
        expect(termFontId("Comic Mono")).toBe(DEFAULT_TERM_FONT);
    });
});

describe("termFontPatch", () => {
    it("drops the override when the pick is the shipped default's face", () => {
        expect(termFontPatch("firacode", "Fira Code")).toBeNull();
    });
    it("writes the catalog stack for any other face", () => {
        expect(termFontPatch("hack", "Fira Code")).toBe('"Hack", monospace');
    });
});
