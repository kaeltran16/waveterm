// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Runtime theming engine. Themes are expressed in the cockpit's own --color-* vocabulary (NOT the
// mockup's --wv-*): buildThemeVars maps a per-theme base palette to the full --color-* override set,
// which useApplyCockpitTheme (themestore.ts) writes onto document.documentElement. Because the whole
// cockpit renders through Tailwind v4 var(--color-*) utilities, overriding those custom properties
// re-skins everything with no component edits.

// The base roles we theme. A deliberately small set: the identity-carrying "chrome". Subtle greys
// (muted-foreground, ink-mid, lane, feed-*) and identity colors (avatar/mem/rt/ansi) are left at their
// tailwindsetup.css @theme defaults — safe across all dark themes; revisited with light mode (Paper).
export interface ThemePalette {
    bg: string;
    surface: string;
    surfaceRaised: string;
    surfaceHover: string;
    surfaceSelected: string;
    code: string;
    border: string;
    edgeMid: string;
    edgeStrong: string;
    edgeFaint: string;
    text: string;
    secondary: string;
    muted: string;
    inkFaint: string;
    accent: string;
    success: string;
    warning: string;
    error: string;
}

// Roles the "Custom colors" card can override; buildThemeVars merges {...palette, ...overrides}.
export type OverrideRole = "accent" | "success" | "warning" | "error";

export interface ThemeDef {
    id: string;
    name: string;
    dark: boolean; // the picker shows dark themes only in v1 (see spec §6)
    palette: ThemePalette;
}

export const THEMES: ThemeDef[] = [
    {
        id: "midnight",
        name: "Midnight",
        dark: true,
        // Authored to the CURRENT tailwindsetup.css values (not the mockup's Midnight) so the default
        // theme reproduces today's look exactly — guarded by themes.test.ts.
        palette: {
            bg: "#0c0e11", surface: "#0e1116", surfaceRaised: "#13171d", surfaceHover: "#171c22",
            surfaceSelected: "#1a222c", code: "#0b0d10", border: "#1c2128", edgeMid: "#20262e",
            edgeStrong: "#2a313a", edgeFaint: "#161a20", text: "#e6e9ed", secondary: "#cfd5db",
            muted: "#6b7178", inkFaint: "#3a424c", accent: "#7c95ff", success: "#54c79a",
            warning: "#e6b450", error: "#e0726c",
        },
    },
    {
        id: "slate", name: "Slate", dark: true,
        palette: {
            bg: "#0d1117", surface: "#111722", surfaceRaised: "#161d2b", surfaceHover: "#1b2434",
            surfaceSelected: "#1e2942", code: "#0a0e15", border: "#1f2733", edgeMid: "#28323f",
            edgeStrong: "#374252", edgeFaint: "#19212c", text: "#dbe2ec", secondary: "#9fb0c3",
            muted: "#5f7185", inkFaint: "#38414f", accent: "#4d9fff", success: "#3fb98f",
            warning: "#e0aa3e", error: "#e46b6b",
        },
    },
    {
        id: "carbon", name: "Carbon", dark: true,
        palette: {
            bg: "#0e0e0d", surface: "#141412", surfaceRaised: "#1b1b18", surfaceHover: "#212120",
            surfaceSelected: "#282824", code: "#0b0b0a", border: "#232320", edgeMid: "#2d2d29",
            edgeStrong: "#3a3a34", edgeFaint: "#1c1c19", text: "#e5e3db", secondary: "#b3b0a4",
            muted: "#6b6960", inkFaint: "#3f3d37", accent: "#e08a4f", success: "#5fb98a",
            warning: "#d9b24a", error: "#e0726c",
        },
    },
    {
        id: "nocturne", name: "Nocturne", dark: true,
        palette: {
            bg: "#0d0b12", surface: "#131019", surfaceRaised: "#191527", surfaceHover: "#201a2e",
            surfaceSelected: "#241d38", code: "#0a0810", border: "#221d30", edgeMid: "#2c2640",
            edgeStrong: "#3a3352", edgeFaint: "#1b1728", text: "#e4dff0", secondary: "#b0a6c6",
            muted: "#6b6285", inkFaint: "#3f3752", accent: "#b57cff", success: "#54c79a",
            warning: "#e6b450", error: "#e0726c",
        },
    },
    {
        id: "onedark", name: "One Dark", dark: true,
        palette: {
            bg: "#282c34", surface: "#21252b", surfaceRaised: "#2f343d", surfaceHover: "#3a4048",
            surfaceSelected: "#3e4451", code: "#1e2228", border: "#3a3f4b", edgeMid: "#454b58",
            edgeStrong: "#565d6b", edgeFaint: "#2c313a", text: "#abb2bf", secondary: "#9298a4",
            muted: "#636b78", inkFaint: "#3e4451", accent: "#61afef", success: "#98c379",
            warning: "#e5c07b", error: "#e06c75",
        },
    },
    {
        id: "monokai", name: "Monokai", dark: true,
        palette: {
            bg: "#272822", surface: "#2d2e28", surfaceRaised: "#33342d", surfaceHover: "#3e4038",
            surfaceSelected: "#494b40", code: "#1d1e19", border: "#3e4035", edgeMid: "#4d4f43",
            edgeStrong: "#62654f", edgeFaint: "#2f302a", text: "#cfd0c2", secondary: "#a8aa98",
            muted: "#75715e", inkFaint: "#4a4a3f", accent: "#66d9ef", success: "#a6e22e",
            warning: "#e6db74", error: "#f92672",
        },
    },
    {
        id: "paper", name: "Paper", dark: false, // light — kept for the engine, omitted from the v1 picker
        palette: {
            bg: "#f4f5f7", surface: "#ffffff", surfaceRaised: "#eceef2", surfaceHover: "#e2e5ec",
            surfaceSelected: "#dde3f0", code: "#f1f2f5", border: "#e4e6ec", edgeMid: "#d5d9e1",
            edgeStrong: "#c2c8d3", edgeFaint: "#ecedf1", text: "#14171d", secondary: "#4e5561",
            muted: "#6b7280", inkFaint: "#c2c8d1", accent: "#4f63c9", success: "#2f9169",
            warning: "#b5842a", error: "#c9524c",
        },
    },
];

export const PICKER_THEMES: ThemeDef[] = THEMES.filter((t) => t.dark);

// Accent quick-picks for the Custom colors card (ports the mockup accentPalette).
export const ACCENT_SWATCHES: string[] = [
    "#7c95ff", "#4d9fff", "#66d9ef", "#2fb8a0", "#a6e22e",
    "#e6b450", "#e08a4f", "#f92672", "#b57cff", "#e0726c",
];

export function activePalette(presetId: string): ThemePalette {
    return (THEMES.find((t) => t.id === presetId) ?? THEMES[0]).palette;
}

export function colorOf(palette: ThemePalette, overrides: Partial<Record<OverrideRole, string>>, role: OverrideRole): string {
    return overrides[role] ?? palette[role];
}

// ---- color math (ports the mockup's helpers) ----
function clampByte(n: number): number {
    return Math.max(0, Math.min(255, Math.round(n)));
}
function toHex(n: number): string {
    return clampByte(n).toString(16).padStart(2, "0");
}
function parseHex(h: string): [number, number, number] {
    let s = h.replace("#", "");
    if (s.length === 3) {
        s = s.split("").map((c) => c + c).join("");
    }
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function mix(a: string, b: string, t: number): string {
    const [ar, ag, ab] = parseHex(a);
    const [br, bg, bb] = parseHex(b);
    return "#" + toHex(ar + (br - ar) * t) + toHex(ag + (bg - ag) * t) + toHex(ab + (bb - ab) * t);
}
function lighten(h: string, t: number): string {
    return mix(h, "#ffffff", t);
}
function darken(h: string, t: number): string {
    return mix(h, "#000000", t);
}
function rgba(h: string, a: number): string {
    const [r, g, b] = parseHex(h);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// Build the full --color-* override map from a base palette + user overrides. Only the themed "chrome"
// tokens are emitted; everything else keeps its @theme default.
export function buildThemeVars(palette: ThemePalette, overrides: Partial<Record<OverrideRole, string>>): Record<string, string> {
    const p = { ...palette, ...overrides };
    return {
        // surfaces
        "--color-background": p.bg,
        "--color-surface": p.surface,
        "--color-surface-raised": p.surfaceRaised,
        "--color-surface-hover": p.surfaceHover,
        "--color-surface-selected": p.surfaceSelected,
        "--color-surface-code": p.code,
        "--color-panel": rgba(p.surfaceRaised, 0.6),
        "--color-modalbg": p.surfaceRaised,
        // text
        "--color-foreground": p.text,
        "--color-white": p.text,
        "--color-primary": p.text,
        "--color-secondary": p.secondary,
        "--color-muted": p.muted,
        "--color-ink-faint": p.inkFaint,
        // borders
        "--color-border": p.border,
        "--color-edge-mid": p.edgeMid,
        "--color-edge-strong": p.edgeStrong,
        "--color-edge-faint": p.edgeFaint,
        // accent + ramp
        "--color-accent": p.accent,
        "--color-accent-400": p.accent,
        "--color-accenthover": lighten(p.accent, 0.14),
        "--color-accent-300": lighten(p.accent, 0.14),
        "--color-accent-soft": lighten(p.accent, 0.3),
        "--color-accent-200": lighten(p.accent, 0.3),
        "--color-accent-100": lighten(p.accent, 0.58),
        "--color-accent-50": lighten(p.accent, 0.8),
        "--color-accent-500": darken(p.accent, 0.18),
        "--color-accent-600": darken(p.accent, 0.34),
        "--color-accent-700": darken(p.accent, 0.48),
        "--color-accent-800": darken(p.accent, 0.62),
        "--color-accent-900": darken(p.accent, 0.72),
        "--color-accentbg": rgba(p.accent, 0.12),
        // status
        "--color-success": p.success,
        "--color-working": p.success,
        "--color-success-soft": lighten(p.success, 0.4),
        "--color-warning": p.warning,
        "--color-asking": p.warning,
        "--color-ask-question": lighten(p.warning, 0.89),
        "--color-ask-label": darken(p.warning, 0.28),
        "--color-on-warning": darken(p.warning, 0.9),
        "--color-error": p.error,
    };
}

// Write the computed vars onto a root element's inline style (highest specificity — beats the @theme
// :root rule). Kept tiny + injectable so it's unit-testable without a DOM.
export function applyThemeVars(root: HTMLElement, vars: Record<string, string>): void {
    for (const [k, v] of Object.entries(vars)) {
        root.style.setProperty(k, v);
    }
}
