// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { monacoThemeFromTokens, type MonacoChrome, type SyntaxTokens } from "./monacotheme";

const TOKENS: SyntaxTokens = {
    keyword: "#aebfff",
    string: "#7fd6ab",
    number: "#e6b450",
    comment: "#6b7178",
    punct: "#8b939d",
    ident: "#cdd3da",
};

const CHROME: MonacoChrome = {
    foreground: "#e2e8f0",
    selection: "#1a222c",
    lineHighlight: "#171c22",
};

describe("monacoThemeFromTokens", () => {
    it("maps each syntax token to its scope family on a dark base", () => {
        const t = monacoThemeFromTokens(TOKENS, CHROME, true);
        expect(t.base).toBe("vs-dark");
        expect(t.inherit).toBe(true);
        const rule = (token: string) => t.rules.find((r) => r.token === token);
        expect(rule("keyword")?.foreground).toBe("#aebfff");
        expect(rule("storage")?.foreground).toBe("#aebfff");
        expect(rule("control")?.foreground).toBe("#aebfff");
        expect(rule("string")?.foreground).toBe("#7fd6ab");
        expect(rule("constant.numeric")?.foreground).toBe("#e6b450");
        expect(rule("comment")?.foreground).toBe("#6b7178");
        expect(rule("punctuation")?.foreground).toBe("#8b939d");
        expect(rule("delimiter")?.foreground).toBe("#8b939d");
    });

    it("drops rules for null tokens instead of inventing colors", () => {
        const t = monacoThemeFromTokens({ ...TOKENS, keyword: null, punct: null }, CHROME, true);
        for (const token of ["keyword", "storage", "control", "punctuation", "delimiter"]) {
            expect(t.rules.find((r) => r.token === token)).toBeUndefined();
        }
        expect(t.rules.find((r) => r.token === "string")).toBeDefined();
    });

    it("sets editor.foreground from chrome, falling back to the ident token", () => {
        expect(monacoThemeFromTokens(TOKENS, CHROME, true).colors["editor.foreground"]).toBe("#e2e8f0");
        const noChrome = monacoThemeFromTokens(TOKENS, { ...CHROME, foreground: null }, true);
        expect(noChrome.colors["editor.foreground"]).toBe("#cdd3da");
        const neither = monacoThemeFromTokens({ ...TOKENS, ident: null }, { ...CHROME, foreground: null }, true);
        expect(neither.colors["editor.foreground"]).toBeUndefined();
    });

    it("alpha-blends the selection and line-highlight chrome colors", () => {
        const t = monacoThemeFromTokens(TOKENS, CHROME, true);
        expect(t.colors["editor.selectionBackground"]).toMatch(/^#1a222c[0-9a-f]{2}$/);
        expect(t.colors["editor.lineHighlightBackground"]).toMatch(/^#171c22[0-9a-f]{2}$/);
    });

    it("drops chrome colors that are null so the base theme's values inherit", () => {
        const t = monacoThemeFromTokens(TOKENS, { ...CHROME, selection: null, lineHighlight: null }, true);
        expect(t.colors["editor.selectionBackground"]).toBeUndefined();
        expect(t.colors["editor.lineHighlightBackground"]).toBeUndefined();
    });

    it("keeps the editor background transparent on dark and opaque on light", () => {
        expect(monacoThemeFromTokens(TOKENS, CHROME, true).colors["editor.background"]).toBe("#00000000");
        expect(monacoThemeFromTokens(TOKENS, CHROME, false).colors["editor.background"]).toBe("#fefefe");
    });

    it("keeps the existing minimap/sticky-scroll chrome values", () => {
        const t = monacoThemeFromTokens(TOKENS, CHROME, true);
        expect(t.colors["minimap.background"]).toBe("#00000077");
        expect(t.colors["editorStickyScroll.background"]).toBe("#00000055");
    });

    it("selects the light base when dark is false", () => {
        expect(monacoThemeFromTokens(TOKENS, CHROME, false).base).toBe("vs");
    });
});
