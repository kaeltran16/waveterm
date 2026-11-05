// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The bridge between the cockpit's theme vocabulary and Monaco's. The cockpit tokenizes six syntax
// roles (--color-syntax-*) plus chrome roles the runtime engine writes as --color-* vars; Monaco's
// tokenizer scopes do not map one-to-one, so the mapping is family-level and everything else
// inherits the stock base theme. The module imports monaco-editor only as a type, so it stays
// outside the lazy monaco chunk and unit-testable in node.

import { activePalette, buildThemeVars } from "@/app/view/agents/themes";
import { themeOverridesAtom, themePresetAtom } from "@/app/view/agents/themestore";
import { colord } from "colord";
import { useAtomValue } from "jotai";
import type { editor } from "monaco-editor";
import { useLayoutEffect } from "react";

export interface SyntaxTokens {
    keyword: string | null;
    string: string | null;
    number: string | null;
    comment: string | null;
    punct: string | null;
    ident: string | null;
}

export interface MonacoChrome {
    foreground: string | null;
    selection: string | null;
    lineHighlight: string | null;
    // the app scrollbar's thumb colors (::-webkit-scrollbar-thumb in tailwindsetup.css)
    scrollThumb: string | null;
    scrollThumbHover: string | null;
}

const SELECTION_ALPHA = 0.5;
const LINE_HIGHLIGHT_ALPHA = 0.35;
// the share of --color-edge-strong in the thumb's hover color; the rest is --color-ink-faint
const SCROLL_THUMB_HOVER_SHARE = 0.75;
// GitHub Desktop's dark diff (app/styles/themes/_dark.scss): primer's green-900 / red-900 darkened for the
// line and darker still for the gutter. Its changed-text fill (green-600 #22863a, red-700 #b31d28) left the
// gray comment token at 1.06:1, so that is mixed only 30% of the way from the line color toward it.
const DIFF_BANDS: Record<string, string> = {
    "diffEditor.insertedLineBackground": "#113a1b",
    "diffEditor.insertedTextBackground": "#165024",
    "diffEditorGutter.insertedLineBackground": "#0b2611",
    "diffEditor.removedLineBackground": "#450c0f",
    "diffEditor.removedTextBackground": "#641117",
    "diffEditorGutter.removedLineBackground": "#2f090a",
};

// token family -> cockpit role. "storage"/"control" read as keyword-family declarations
// (let/const/type), "delimiter" joins "punctuation" (braces, brackets, separators).
const KEYWORD_SCOPES = ["keyword", "storage", "control"] as const;
const PUNCT_SCOPES = ["punctuation", "delimiter"] as const;

export function monacoThemeFromTokens(
    tokens: SyntaxTokens,
    chrome: MonacoChrome,
    dark: boolean
): editor.IStandaloneThemeData {
    const rules: editor.IStandaloneThemeData["rules"] = [];
    const add = (token: string, color: string | null): void => {
        if (color != null) {
            rules.push({ token, foreground: color });
        }
    };
    for (const scope of KEYWORD_SCOPES) {
        add(scope, tokens.keyword);
    }
    add("string", tokens.string);
    add("constant.numeric", tokens.number);
    add("comment", tokens.comment);
    for (const scope of PUNCT_SCOPES) {
        add(scope, tokens.punct);
    }
    const colors: Record<string, string> = {
        // transparent background lets the surface chrome show through; opaque on light
        "editor.background": dark ? "#00000000" : "#fefefe",
        // carried over from the original scaffold so the minimap/sticky scroll do not regress
        "editorStickyScroll.background": "#00000055",
        "minimap.background": "#00000077",
        focusBorder: "#00000000",
    };
    // the text role governs plain text; the ident token is the code-default fallback (see plan
    // "Spec ambiguity resolved" — chrome wins, ident is the pre-engine fallback)
    const fg = chrome.foreground ?? tokens.ident;
    if (fg != null) {
        colors["editor.foreground"] = fg;
    }
    if (chrome.selection != null) {
        colors["editor.selectionBackground"] = colord(chrome.selection).alpha(SELECTION_ALPHA).toHex();
    }
    if (chrome.lineHighlight != null) {
        colors["editor.lineHighlightBackground"] = colord(chrome.lineHighlight).alpha(LINE_HIGHLIGHT_ALPHA).toHex();
    }
    if (dark) {
        // vs-dark's slider is a light gray that stands out from every other scrollbar in the app
        if (chrome.scrollThumb != null) {
            colors["scrollbarSlider.background"] = chrome.scrollThumb;
        }
        if (chrome.scrollThumbHover != null) {
            colors["scrollbarSlider.hoverBackground"] = chrome.scrollThumbHover;
            colors["scrollbarSlider.activeBackground"] = chrome.scrollThumbHover;
        }
        // the overview ruler's hairline reads as a second scrollbar track
        colors["editorOverviewRuler.border"] = "#00000000";
        Object.assign(colors, DIFF_BANDS);
    }
    return { base: dark ? "vs-dark" : "vs", inherit: true, rules, colors };
}

function cssVar(root: HTMLElement, name: string): string | null {
    const v = root.ownerDocument.defaultView?.getComputedStyle(root).getPropertyValue(name).trim();
    return v === "" ? null : v;
}

// the six --color-syntax-* vars are static @theme defaults, so a read at any point after CSS load
// is stable; a null means "inherit the base theme", never a guessed value
export function readSyntaxTokens(root: HTMLElement): SyntaxTokens {
    return {
        keyword: cssVar(root, "--color-syntax-keyword"),
        string: cssVar(root, "--color-syntax-string"),
        number: cssVar(root, "--color-syntax-number"),
        comment: cssVar(root, "--color-syntax-comment"),
        punct: cssVar(root, "--color-syntax-punct"),
        ident: cssVar(root, "--color-syntax-ident"),
    };
}

// the css thumb hover is color-mix(in srgb, edge-strong 75%, ink-faint), so the mix is per sRGB channel;
// colord's mix plugin mixes in LAB and would land a different color
export function scrollThumbHover(edgeStrong: string | null, inkFaint: string | null): string | null {
    if (edgeStrong == null || inkFaint == null) {
        return null;
    }
    const a = colord(edgeStrong).toRgb();
    const b = colord(inkFaint).toRgb();
    const mix = (x: number, y: number) => x * SCROLL_THUMB_HOVER_SHARE + y * (1 - SCROLL_THUMB_HOVER_SHARE);
    return colord({ r: mix(a.r, b.r), g: mix(a.g, b.g), b: mix(a.b, b.b), a: mix(a.a, b.a) }).toHex();
}

export function readChromeRoles(root: HTMLElement): MonacoChrome {
    const edgeStrong = cssVar(root, "--color-edge-strong");
    return {
        foreground: cssVar(root, "--color-foreground"),
        selection: cssVar(root, "--color-surface-selected"),
        lineHighlight: cssVar(root, "--color-surface-hover"),
        scrollThumb: edgeStrong,
        scrollThumbHover: scrollThumbHover(edgeStrong, cssVar(root, "--color-ink-faint")),
    };
}

// Watches the same atoms the theme engine watches and re-themes Monaco. Chrome roles are derived
// through the engine's own pure buildThemeVars rather than computed style, because this layout
// effect runs BEFORE cockpit-root's (child effects run first) and a computed-style read would race
// the engine on the commit where the theme changes. Syntax tokens are static, so readSyntaxTokens
// is safe here. The dynamic import keeps monaco-editor out of the
// surface's static chunk graph.
export function useSyncMonacoTheme(): void {
    const preset = useAtomValue(themePresetAtom);
    const overrides = useAtomValue(themeOverridesAtom);
    useLayoutEffect(() => {
        const vars = buildThemeVars(activePalette(preset), overrides);
        const chrome: MonacoChrome = {
            foreground: vars["--color-foreground"],
            selection: vars["--color-surface-selected"],
            lineHighlight: vars["--color-surface-hover"],
            scrollThumb: vars["--color-edge-strong"],
            scrollThumbHover: scrollThumbHover(vars["--color-edge-strong"], vars["--color-ink-faint"]),
        };
        const tokens = readSyntaxTokens(document.documentElement);
        let cancelled = false;
        void import("@/app/monaco/monaco-env").then((m) => {
            if (cancelled) {
                return;
            }
            m.loadMonaco();
            m.applyMonacoTheme("wave-theme-dark", monacoThemeFromTokens(tokens, chrome, true));
        });
        return () => {
            cancelled = true;
        };
    }, [preset, overrides]);
}
