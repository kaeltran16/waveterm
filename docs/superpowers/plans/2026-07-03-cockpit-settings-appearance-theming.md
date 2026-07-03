# Cockpit Settings — Appearance & Theming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Appearance section (7-preset theme picker + custom accent/status overrides) to the cockpit Settings surface and a runtime theming engine that re-skins the whole cockpit, plus a full faithful port of the existing Settings sections to the mockup layout.

**Architecture:** Themes are expressed in the cockpit's own `--color-*` vocabulary (not the mockup's `--wv-*`). A pure `buildThemeVars(palette, overrides)` computes the full `--color-*` override map from a per-theme base palette; a `useLayoutEffect` writes them onto `document.documentElement`, so the entire Tailwind-v4 `var(--color-*)` utility layer re-resolves with zero component edits. Midnight is authored to today's exact palette (guarded by test) so the default is a visual no-op. State persists in two localStorage jotai atoms (matching the existing cockpit-native pref pattern — no Go/wconfig).

**Tech Stack:** React 19, Tailwind v4 (`@theme`), jotai (`atomWithStorage`), vitest, TypeScript. Verify frontend rendering over CDP (`:9222`) per repo convention — there is no jsdom render harness.

**Git policy (user, STRICT):** Do NOT commit without explicit approval. Per-task "Stage" steps only `git add`; a single final commit (Task 5) batches everything and is gated on user approval. This spec + plan fold into that one feature commit — no separate docs commit.

**Spec:** `docs/superpowers/specs/2026-07-03-cockpit-settings-appearance-theming-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `frontend/app/view/agents/themes.ts` | **new** — `ThemePalette`/`ThemeDef` types, the 7 palettes, color math, `buildThemeVars`, `applyThemeVars`, `activePalette`, `colorOf`, `PICKER_THEMES`, `ACCENT_SWATCHES`. Pure, fully unit-tested. |
| `frontend/app/view/agents/themes.test.ts` | **new** — Midnight-parity guard, color math, overrides, helpers. |
| `frontend/app/view/agents/themestore.ts` | **new** — `themePresetAtom`, `themeOverridesAtom`, `useApplyCockpitTheme()` hook. |
| `frontend/app/view/agents/settingssurface.tsx` | **rewrite** — mockup layout + new Appearance section; existing sections restyled, wiring reused. |
| `frontend/app/cockpit/cockpit-root.tsx` | **modify** — call `useApplyCockpitTheme()` in `CockpitBody`. |
| `docs/deferred.md` | **append** — Paper / light-mode overlay audit. |

---

## Task 1: Theming engine (`themes.ts`) — pure logic, TDD

**Files:**
- Create: `frontend/app/view/agents/themes.ts`
- Test: `frontend/app/view/agents/themes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/themes.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    ACCENT_SWATCHES,
    activePalette,
    applyThemeVars,
    buildThemeVars,
    colorOf,
    PICKER_THEMES,
    THEMES,
} from "./themes";

describe("buildThemeVars — Midnight parity", () => {
    // These 24 high-traffic tokens MUST equal the current tailwindsetup.css @theme values,
    // so enabling the picker is a visual no-op until the user switches themes.
    const expected: Record<string, string> = {
        "--color-background": "#0c0e11",
        "--color-surface": "#0e1116",
        "--color-surface-raised": "#13171d",
        "--color-surface-hover": "#171c22",
        "--color-surface-selected": "#1a222c",
        "--color-surface-code": "#0b0d10",
        "--color-panel": "rgba(19, 23, 29, 0.6)",
        "--color-modalbg": "#13171d",
        "--color-foreground": "#e6e9ed",
        "--color-primary": "#e6e9ed",
        "--color-white": "#e6e9ed",
        "--color-secondary": "#cfd5db",
        "--color-muted": "#6b7178",
        "--color-ink-faint": "#3a424c",
        "--color-border": "#1c2128",
        "--color-edge-mid": "#20262e",
        "--color-edge-strong": "#2a313a",
        "--color-edge-faint": "#161a20",
        "--color-accent": "#7c95ff",
        "--color-accentbg": "rgba(124, 149, 255, 0.12)",
        "--color-error": "#e0726c",
        "--color-warning": "#e6b450",
        "--color-asking": "#e6b450",
        "--color-success": "#54c79a",
    };
    const vars = buildThemeVars(activePalette("midnight"), {});
    for (const [k, v] of Object.entries(expected)) {
        it(`${k} === ${v}`, () => expect(vars[k]).toBe(v));
    }
});

describe("color math (via override derivation)", () => {
    it("accent override propagates to accent-400 and accentbg", () => {
        const vars = buildThemeVars(activePalette("midnight"), { accent: "#66d9ef" });
        expect(vars["--color-accent"]).toBe("#66d9ef");
        expect(vars["--color-accent-400"]).toBe("#66d9ef");
        expect(vars["--color-accentbg"]).toBe("rgba(102, 217, 239, 0.12)");
    });
    it("status override propagates: success -> success + working", () => {
        const vars = buildThemeVars(activePalette("midnight"), { success: "#00ff00" });
        expect(vars["--color-success"]).toBe("#00ff00");
        expect(vars["--color-working"]).toBe("#00ff00");
    });
    it("no override -> preset accent", () => {
        const vars = buildThemeVars(activePalette("slate"), {});
        expect(vars["--color-accent"]).toBe("#4d9fff");
    });
});

describe("helpers", () => {
    it("activePalette falls back to midnight for unknown id", () => {
        expect(activePalette("nope")).toBe(activePalette("midnight"));
    });
    it("colorOf prefers override over palette", () => {
        const p = activePalette("midnight");
        expect(colorOf(p, {}, "accent")).toBe("#7c95ff");
        expect(colorOf(p, { accent: "#123456" }, "accent")).toBe("#123456");
    });
    it("PICKER_THEMES excludes the light (paper) theme", () => {
        expect(THEMES.some((t) => t.id === "paper")).toBe(true);
        expect(PICKER_THEMES.some((t) => t.id === "paper")).toBe(false);
        expect(PICKER_THEMES).toHaveLength(6);
    });
    it("ACCENT_SWATCHES has 10 hex values", () => {
        expect(ACCENT_SWATCHES).toHaveLength(10);
        expect(ACCENT_SWATCHES[0]).toBe("#7c95ff");
    });
    it("applyThemeVars sets each var on the root style", () => {
        const set: Record<string, string> = {};
        const root = { style: { setProperty: (k: string, v: string) => (set[k] = v) } };
        applyThemeVars(root as unknown as HTMLElement, { "--color-accent": "#abc" });
        expect(set["--color-accent"]).toBe("#abc");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/themes.test.ts`
Expected: FAIL — cannot resolve `./themes`.

- [ ] **Step 3: Write the implementation**

Create `frontend/app/view/agents/themes.ts`:

```ts
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
        "--color-ask-question": lighten(p.warning, 0.42),
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/themes.test.ts`
Expected: PASS (all Midnight-parity, math, helper cases green).

- [ ] **Step 5: Stage**

Run: `git add frontend/app/view/agents/themes.ts frontend/app/view/agents/themes.test.ts`

---

## Task 2: Theme store + apply hook (`themestore.ts`) + mount

**Files:**
- Create: `frontend/app/view/agents/themestore.ts`
- Modify: `frontend/app/cockpit/cockpit-root.tsx` (imports; call hook in `CockpitBody`)

- [ ] **Step 1: Create the store + hook**

Create `frontend/app/view/agents/themestore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Theme selection state, persisted to localStorage (the atomWithStorage convention from railstore.ts /
// cockpitprefsstore.ts). Pure-frontend appearance -> no wconfig / no task generate.

import { useAtomValue } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useLayoutEffect } from "react";

import { activePalette, applyThemeVars, buildThemeVars, type OverrideRole } from "./themes";

// The selected preset id (see THEMES). Defaults to "midnight" == today's palette.
export const themePresetAtom = atomWithStorage<string>("cockpit.theme.preset", "midnight");

// Per-role color overrides on top of the preset. Keyed by OverrideRole. Cleared when a preset is picked.
export const themeOverridesAtom = atomWithStorage<Partial<Record<OverrideRole, string>>>(
    "cockpit.theme.overrides",
    {}
);

// Applies the active theme's CSS vars to <html> before paint. atomWithStorage hydrates synchronously
// from localStorage, so a non-default theme applies without a flash of Midnight. Always writes the full
// themed set, so switching presets needs no stale-key cleanup.
export function useApplyCockpitTheme(): void {
    const preset = useAtomValue(themePresetAtom);
    const overrides = useAtomValue(themeOverridesAtom);
    useLayoutEffect(() => {
        applyThemeVars(document.documentElement, buildThemeVars(activePalette(preset), overrides));
    }, [preset, overrides]);
}
```

- [ ] **Step 2: Mount the hook in `CockpitBody`**

In `frontend/app/cockpit/cockpit-root.tsx`, add the import near the other agents imports (after line 9's `startupSurfaceAtom` import):

```ts
import { useApplyCockpitTheme } from "@/app/view/agents/themestore";
```

Then call it as the first line inside `CockpitBody`, immediately after `const model = agentsModelRef.current;` (currently line 54):

```ts
    const model = agentsModelRef.current;
    useApplyCockpitTheme();
```

(`CockpitBody` is rendered inside `<Provider store={globalStore}>`, so `useAtomValue` resolves against the boot store — same reason the file's comment on line 37 gives.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors (baseline: ~3 pre-existing errors in `frontend/tauri/api.test.ts` only).

- [ ] **Step 4: Full unit test sweep**

Run: `npx vitest run`
Expected: PASS, including the new `themes.test.ts`.

- [ ] **Step 5: Stage**

Run: `git add frontend/app/view/agents/themestore.ts frontend/app/cockpit/cockpit-root.tsx`

---

## Task 3: Settings surface — full port + Appearance section

**Files:**
- Modify (rewrite): `frontend/app/view/agents/settingssurface.tsx`

Existing state wiring is reused verbatim (`startupSurfaceAtom`, `startupSurfaceOptions`, `railVisibleAtom`, `naFlagsAtom`, `naRememberFlagsAtom`, `RUNTIME_FLAGS`, `getSettingsKeyAtom`, `coerceFontSize`, `SetConfigCommand`). Only markup/styles change, plus the new Appearance section wired to Task 2's atoms.

- [ ] **Step 1: Replace the file contents**

Overwrite `frontend/app/view/agents/settingssurface.tsx` with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getSettingsKeyAtom } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { useState } from "react";
import type { AgentsViewModel, SurfaceKey } from "./agents";
import { coerceFontSize, startupSurfaceAtom, startupSurfaceOptions } from "./cockpitprefsstore";
import { RUNTIME_FLAGS, type Runtime } from "./launch";
import { naFlagsAtom, naRememberFlagsAtom } from "./naflagsstore";
import { ITEMS } from "./navrail";
import { railVisibleAtom } from "./railstore";
import { ACCENT_SWATCHES, activePalette, colorOf, PICKER_THEMES, type OverrideRole } from "./themes";
import { themeOverridesAtom, themePresetAtom } from "./themestore";

const LABEL: Record<SurfaceKey, string> = Object.fromEntries(ITEMS.map((i) => [i.key, i.label])) as Record<
    SurfaceKey,
    string
>;

// Runtimes with a flag catalog (terminal has none) — the flag editor only lists these.
const FLAG_RUNTIMES: { id: Runtime; name: string }[] = [
    { id: "claude", name: "Claude Code" },
    { id: "codex", name: "Codex" },
    { id: "antigravity", name: "Antigravity" },
];

export function SettingsSurface(_props: { model: AgentsViewModel }) {
    return (
        <div className="flex h-full flex-col overflow-y-auto bg-background px-10 py-9">
            <div className="mx-auto w-full max-w-[720px]">
                <h1 className="text-[26px] font-extrabold tracking-[-0.025em] text-primary">Settings</h1>
                <p className="mb-9 mt-1.5 text-[13.5px] text-muted">
                    Cockpit preferences, appearance, and New Agent defaults.
                </p>
                <AppearanceSection />
                <SectionGap />
                <GeneralSection />
                <SectionGap />
                <NewAgentDefaultsSection />
                <SectionGap />
                <TerminalSection />
                <SectionGap />
                <MemorySection />
            </div>
        </div>
    );
}

function SectionGap() {
    return <div className="h-[34px]" />;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <div className="mb-4 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted">{children}</div>
    );
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            onClick={onToggle}
            className={cn(
                "relative mt-0.5 h-[23px] w-[42px] shrink-0 cursor-pointer rounded-full transition-colors",
                on ? "bg-accent" : "bg-surface-selected"
            )}
        >
            <span
                className={cn(
                    "absolute top-[2px] h-[19px] w-[19px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.4)] transition-all",
                    on ? "left-[21px]" : "left-[2px]"
                )}
            />
        </button>
    );
}

function CheckIcon() {
    return (
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M3.5 8.5 7 12l6-7.5" />
        </svg>
    );
}

function Swatch({ color }: { color: string }) {
    return <span className="h-[13px] w-[13px] rounded-[4px]" style={{ background: color }} />;
}

function AppearanceSection() {
    const [preset, setPreset] = useAtom(themePresetAtom);
    const [overrides, setOverrides] = useAtom(themeOverridesAtom);
    const palette = activePalette(preset);
    const isCustom = Object.keys(overrides).length > 0;
    const activeName = PICKER_THEMES.find((t) => t.id === preset)?.name ?? "Midnight";
    const setOverride = (role: OverrideRole, hex: string) => setOverrides((prev) => ({ ...prev, [role]: hex }));
    const selectPreset = (id: string) => {
        setPreset(id);
        setOverrides({});
    };
    const accent = colorOf(palette, overrides, "accent");
    const statusRoles: { role: OverrideRole; label: string; desc: string }[] = [
        { role: "success", label: "Working / accept", desc: "Live agents, accepted diffs" },
        { role: "warning", label: "Asking / attention", desc: "Awaiting your reply" },
        { role: "error", label: "Blocked / reject", desc: "Errors, discarded changes" },
    ];
    return (
        <div>
            <SectionLabel>Appearance</SectionLabel>
            <div className="mb-[22px]">
                <div className="text-[14px] font-semibold text-primary">Theme</div>
                <div className="mb-3.5 mt-0.5 text-[12.5px] text-muted">
                    Base palette for every surface.{" "}
                    <span className="font-semibold text-accent">
                        {isCustom ? `Custom · based on ${activeName}` : activeName}
                    </span>
                </div>
                <div className="grid grid-cols-4 gap-2.5">
                    {PICKER_THEMES.map((t) => {
                        const on = t.id === preset;
                        return (
                            <button
                                key={t.id}
                                type="button"
                                onClick={() => selectPreset(t.id)}
                                className={cn(
                                    "flex cursor-pointer items-center gap-2.5 rounded-[11px] border p-[10px] text-left transition-colors",
                                    on ? "border-accent-700 bg-surface-hover" : "border-border hover:border-edge-strong"
                                )}
                            >
                                <div className="flex flex-none flex-col gap-[3px]">
                                    <div className="flex gap-[3px]">
                                        <Swatch color={t.palette.bg} />
                                        <Swatch color={t.palette.surface} />
                                    </div>
                                    <div className="flex gap-[3px]">
                                        <Swatch color={t.palette.accent} />
                                        <Swatch color={t.palette.success} />
                                    </div>
                                </div>
                                <span
                                    className={cn(
                                        "min-w-0 flex-1 truncate text-[12px] font-semibold",
                                        on ? "text-primary" : "text-secondary"
                                    )}
                                >
                                    {t.name}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="rounded-[14px] border border-border bg-surface p-[18px]">
                <div className="mb-4 flex items-center justify-between">
                    <div>
                        <div className="text-[13.5px] font-semibold text-primary">Custom colors</div>
                        <div className="text-[12px] text-muted">
                            Override any role. Tints and gradients recompute automatically.
                        </div>
                    </div>
                    {isCustom ? (
                        <button
                            type="button"
                            onClick={() => setOverrides({})}
                            className="cursor-pointer rounded-[8px] border border-edge-mid px-[11px] py-1.5 text-[12px] font-semibold text-secondary hover:border-edge-strong hover:text-primary"
                        >
                            Reset to preset
                        </button>
                    ) : null}
                </div>

                <div className="flex items-center gap-3.5 border-t border-edge-faint py-[11px]">
                    <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] font-semibold text-primary">Accent</div>
                        <div className="text-[11.5px] text-muted">Primary actions, active nav, links</div>
                    </div>
                    <div className="flex flex-none items-center gap-[7px]">
                        {ACCENT_SWATCHES.map((hex) => (
                            <button
                                key={hex}
                                type="button"
                                title={hex}
                                onClick={() => setOverride("accent", hex)}
                                className="h-[22px] w-[22px] cursor-pointer rounded-[6px] border-2 p-0"
                                style={{
                                    background: hex,
                                    borderColor:
                                        hex.toLowerCase() === accent.toLowerCase()
                                            ? "var(--color-primary)"
                                            : "transparent",
                                }}
                            />
                        ))}
                        <label
                            title="Custom hex"
                            className="relative flex h-[22px] w-[22px] flex-none cursor-pointer items-center justify-center overflow-hidden rounded-[6px] border border-edge-mid"
                        >
                            <span className="pointer-events-none absolute font-mono text-[12px] font-bold text-muted">
                                +
                            </span>
                            <input
                                type="color"
                                value={accent}
                                onChange={(e) => setOverride("accent", e.target.value)}
                                className="h-[36px] w-[36px] cursor-pointer opacity-0"
                            />
                        </label>
                    </div>
                </div>

                {statusRoles.map((r) => {
                    const hex = colorOf(palette, overrides, r.role);
                    return (
                        <div key={r.role} className="flex items-center gap-3.5 border-t border-edge-faint py-[11px]">
                            <div className="min-w-0 flex-1">
                                <div className="text-[12.5px] font-semibold text-primary">{r.label}</div>
                                <div className="text-[11.5px] text-muted">{r.desc}</div>
                            </div>
                            <div className="flex flex-none items-center gap-[9px]">
                                <span className="font-mono text-[11px] text-muted">{hex}</span>
                                <label className="block h-[24px] w-[34px] cursor-pointer overflow-hidden rounded-[7px] border border-edge-mid">
                                    <input
                                        type="color"
                                        value={hex}
                                        onChange={(e) => setOverride(r.role, e.target.value)}
                                        className="m-[-5px] h-[34px] w-[44px] cursor-pointer"
                                    />
                                </label>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function GeneralSection() {
    const [startup, setStartup] = useAtom(startupSurfaceAtom);
    const [railVisible, setRailVisible] = useAtom(railVisibleAtom);
    const options = startupSurfaceOptions();
    return (
        <div>
            <SectionLabel>General</SectionLabel>
            <div className="mb-5 border-b border-edge-faint pb-5">
                <div className="mb-3">
                    <div className="text-[14px] font-semibold text-primary">Startup surface</div>
                    <div className="mt-0.5 text-[12.5px] text-muted">Which surface opens when the app launches.</div>
                </div>
                <div
                    className="grid overflow-hidden rounded-[9px] border border-edge-mid bg-surface-raised"
                    style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}
                >
                    {options.map((k, i) => (
                        <button
                            key={k}
                            type="button"
                            onClick={() => setStartup(k)}
                            className={cn(
                                "cursor-pointer whitespace-nowrap px-2 py-[9px] text-[12.5px] font-semibold transition-colors",
                                i > 0 && "border-l border-border",
                                startup === k ? "bg-accentbg text-accent" : "text-secondary hover:text-primary"
                            )}
                        >
                            {LABEL[k] ?? k}
                        </button>
                    ))}
                </div>
            </div>
            <div className="flex items-start justify-between gap-5">
                <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold text-primary">Show details rail by default</div>
                    <div className="text-[12.5px] text-muted">The per-agent git/details rail on the Agent surface.</div>
                </div>
                <Toggle on={railVisible} onToggle={() => setRailVisible((v) => !v)} />
            </div>
        </div>
    );
}

function NewAgentDefaultsSection() {
    const [flags, setFlags] = useAtom(naFlagsAtom);
    const [remember, setRemember] = useAtom(naRememberFlagsAtom);
    const [runtime, setRuntime] = useState<Runtime>("claude");
    const catalog = RUNTIME_FLAGS[runtime];
    const runtimeFlags = flags[runtime] ?? {};
    const setFlag = (id: string, on: boolean) =>
        setFlags((prev) => ({ ...prev, [runtime]: { ...prev[runtime], [id]: on } }));
    return (
        <div>
            <SectionLabel>New Agent Defaults</SectionLabel>
            <div className="mb-[18px] flex items-start justify-between gap-5">
                <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold text-primary">Remember flags</div>
                    <div className="text-[12.5px] text-muted">
                        Reuse the enabled flags for every new agent (instead of clearing after launch).
                    </div>
                </div>
                <Toggle on={remember} onToggle={() => setRemember((v) => !v)} />
            </div>
            <div className="mb-4 flex gap-[7px]">
                {FLAG_RUNTIMES.map((r) => (
                    <button
                        key={r.id}
                        type="button"
                        onClick={() => setRuntime(r.id)}
                        className={cn(
                            "cursor-pointer rounded-[8px] border px-3.5 py-[7px] text-[12.5px] font-semibold transition-colors",
                            runtime === r.id
                                ? "border-accent-700 bg-accentbg text-accent"
                                : "border-edge-mid bg-surface-raised text-secondary hover:border-edge-strong"
                        )}
                    >
                        {r.name}
                    </button>
                ))}
            </div>
            <div className="rounded-[14px] border border-border bg-surface px-4 py-1.5">
                {catalog.map((f, i) => {
                    const on = !!runtimeFlags[f.id];
                    return (
                        <button
                            key={f.id}
                            type="button"
                            onClick={() => setFlag(f.id, !on)}
                            className={cn(
                                "flex w-full cursor-pointer items-center gap-3 py-3 text-left",
                                i > 0 && "border-t border-edge-faint"
                            )}
                        >
                            <span
                                className={cn(
                                    "flex h-[17px] w-[17px] flex-none items-center justify-center rounded-[5px] border-[1.5px] text-background",
                                    on ? "border-accent bg-accent" : "border-edge-strong"
                                )}
                            >
                                {on ? <CheckIcon /> : null}
                            </span>
                            <span
                                className={cn(
                                    "flex-none font-mono text-[12.5px] font-semibold",
                                    on ? "text-accent" : "text-primary"
                                )}
                            >
                                {f.flag}
                            </span>
                            <span className="flex-1" />
                            <span
                                className={cn(
                                    "text-right text-[12px] font-medium",
                                    on ? "text-accent-soft" : "text-muted"
                                )}
                            >
                                {f.desc}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function TerminalSection() {
    const stored = useAtomValue(getSettingsKeyAtom("term:fontsize"));
    const current = typeof stored === "number" ? stored : 12;
    const step = (delta: number) => {
        const next = coerceFontSize(String(current + delta));
        if (next != null && next !== current) {
            void RpcApi.SetConfigCommand(TabRpcClient, { "term:fontsize": next });
        }
    };
    return (
        <div>
            <SectionLabel>Terminal</SectionLabel>
            <div className="flex items-center justify-between gap-5">
                <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold text-primary">Font size</div>
                    <div className="text-[12.5px] text-muted">Default font size for agent terminals (px).</div>
                </div>
                <div className="flex flex-none items-center overflow-hidden rounded-[9px] border border-edge-mid bg-surface-raised">
                    <button
                        type="button"
                        aria-label="Decrease font size"
                        onClick={() => step(-1)}
                        className="h-[34px] w-[34px] cursor-pointer border-r border-border text-[17px] font-semibold text-secondary hover:bg-surface-hover"
                    >
                        −
                    </button>
                    <div className="w-[48px] text-center font-mono text-[13px] text-primary">{current}</div>
                    <button
                        type="button"
                        aria-label="Increase font size"
                        onClick={() => step(1)}
                        className="h-[34px] w-[34px] cursor-pointer border-l border-border text-[17px] font-semibold text-secondary hover:bg-surface-hover"
                    >
                        +
                    </button>
                </div>
            </div>
        </div>
    );
}

function MemorySection() {
    const stored = useAtomValue(getSettingsKeyAtom("memory:vaultpath"));
    const [draft, setDraft] = useState<string>(stored ?? "");
    const [saved, setSaved] = useState(false);
    const dirty = draft !== (stored ?? "");
    const showSaved = saved && !dirty;
    const commit = () => {
        void RpcApi.SetConfigCommand(TabRpcClient, { "memory:vaultpath": draft.trim() }).then(() => setSaved(true));
    };
    return (
        <div>
            <SectionLabel>Memory</SectionLabel>
            <div className="text-[14px] font-semibold text-primary">Vault path</div>
            <div className="mb-3 mt-0.5 text-[12.5px] text-muted">Folder the Memory surface reads and writes.</div>
            <div className="flex gap-2.5">
                <input
                    type="text"
                    value={draft}
                    placeholder="~/vault"
                    onChange={(e) => {
                        setDraft(e.target.value);
                        setSaved(false);
                    }}
                    className="min-w-0 flex-1 rounded-[9px] border border-edge-mid bg-surface-raised px-3.5 py-2.5 font-mono text-[13px] text-primary outline-none focus:border-accent-700"
                />
                <button
                    type="button"
                    onClick={commit}
                    className={cn(
                        "shrink-0 rounded-[9px] border px-[18px] text-[13px] font-semibold transition-colors",
                        showSaved
                            ? "border-success/40 bg-success/[0.14] text-success-soft"
                            : "border-edge-mid bg-surface-raised text-secondary hover:border-edge-strong"
                    )}
                >
                    {showSaved ? "Saved ✓" : "Save"}
                </button>
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors beyond the 3 baseline `api.test.ts` errors.

- [ ] **Step 3: Unit test sweep**

Run: `npx vitest run`
Expected: PASS (no settings surface unit tests exist; confirm nothing else broke).

- [ ] **Step 4: Visual verification over CDP**

Ensure the dev app is running (`tail -f /dev/null | task dev` if headless — see memory `dev-task-dev-stdin-eof`). Then:
1. Navigate to the Settings surface: `node scripts/cdp-shot.mjs` after clicking the bottom gear, or set the surface via CDP `Runtime.evaluate`. Capture `settings-appearance.png`.
2. Switch presets and re-capture: use CDP to set localStorage + reload is fragile (breaks Tauri boot — see memory `dev-task-dev-stdin-eof`); instead click each preset button and screenshot. Verify: Midnight is unchanged vs today; Slate/Carbon/Nocturne/One Dark/Monokai re-skin the whole cockpit (nav rail, app bar, cards).
3. Toggle a custom accent swatch; confirm the "Custom · based on …" label, the ring on the active swatch, and that the accent propagates cockpit-wide. Click "Reset to preset"; confirm it clears.
4. Confirm the four ported sections render and still function (startup segmented control highlights; rail toggle flips; flag checkboxes toggle; font ± writes; vault Save shows "Saved ✓").

Expected: matches `Wave-settings.dc.html`; Midnight is a visual no-op.

- [ ] **Step 5: Stage**

Run: `git add frontend/app/view/agents/settingssurface.tsx`

---

## Task 4: Deferred note (Paper / light mode)

**Files:**
- Modify: `docs/deferred.md` (append; create if missing)

- [ ] **Step 1: Append the entry**

Add to `docs/deferred.md`:

```markdown
## Cockpit light mode (Paper theme) — 2026-07-03

The theming engine (`themes.ts`) is light-capable and the `paper` palette exists in `THEMES`, but it is
omitted from the v1 picker (`PICKER_THEMES` = dark only). A faithful light mode needs a cockpit-wide
audit of dark-assumed hardcoded colors: inline `rgba(255,255,255,α)` overlays (hover states, `.agent-md`
dividers/code fills in `tailwindsetup.css`), the hardcoded scrollbar hexes (`tailwindsetup.css`
`::-webkit-scrollbar-thumb`), `cockpit.scss` fallbacks, and the greys left fixed by `buildThemeVars`
(`muted-foreground`, `ink-mid`, `lane`, `lane-asking`, `cacheread`, `feed-*`). Convert those to themed
tokens, then set `paper.dark = true`-equivalent exposure in the picker.
```

- [ ] **Step 2: Stage**

Run: `git add docs/deferred.md`

---

## Task 5: Commit (AWAITING USER APPROVAL — per STRICT git policy)

Do not run until the user explicitly approves. Batch everything into one feature commit (spec + plan fold in).

- [ ] **Step 1: Show the diff summary and proposed message, ask for approval**

Files (all Added/Modified):
- A `frontend/app/view/agents/themes.ts`
- A `frontend/app/view/agents/themes.test.ts`
- A `frontend/app/view/agents/themestore.ts`
- M `frontend/app/view/agents/settingssurface.tsx`
- M `frontend/app/cockpit/cockpit-root.tsx`
- A `docs/deferred.md` (or M)
- A `docs/superpowers/specs/2026-07-03-cockpit-settings-appearance-theming-design.md`
- A `docs/superpowers/plans/2026-07-03-cockpit-settings-appearance-theming.md`

Proposed message:

```
feat(cockpit): theme picker + Appearance settings

Adds a runtime theming engine (6 dark presets + accent/status overrides)
that re-skins the cockpit by overriding --color-* on <html>, and ports the
Settings surface to the Wave-settings design. Midnight reproduces the current
palette exactly (test-guarded), so the default is unchanged. Paper/light mode
deferred (needs a hardcoded-overlay audit).
```

- [ ] **Step 2: On "yes", commit**

```bash
git add frontend/app/view/agents/themes.ts frontend/app/view/agents/themes.test.ts \
  frontend/app/view/agents/themestore.ts frontend/app/view/agents/settingssurface.tsx \
  frontend/app/cockpit/cockpit-root.tsx docs/deferred.md \
  docs/superpowers/specs/2026-07-03-cockpit-settings-appearance-theming-design.md \
  docs/superpowers/plans/2026-07-03-cockpit-settings-appearance-theming.md
git commit -m "feat(cockpit): theme picker + Appearance settings" -m "..."
```

---

## Self-review

**Spec coverage:** Appearance section + engine (Tasks 1–3) ✓; full port of General/NewAgent/Terminal/Memory (Task 3) ✓; custom overrides (Task 3 AppearanceSection) ✓; localStorage persistence, no wconfig (Task 2) ✓; apply on `document.documentElement` (Task 2) ✓; Midnight parity test (Task 1) ✓; Paper deferred (Task 4) ✓; no routing change (settings already wired) ✓.

**Placeholder scan:** none — all steps carry complete code/commands.

**Type consistency:** `OverrideRole`, `ThemePalette`, `activePalette`, `colorOf`, `buildThemeVars`, `applyThemeVars`, `PICKER_THEMES`, `ACCENT_SWATCHES`, `themePresetAtom`, `themeOverridesAtom`, `useApplyCockpitTheme` used identically across Tasks 1–3. `colorOf`/overrides keyed by `OverrideRole` throughout. Reused existing symbols (`startupSurfaceOptions`, `coerceFontSize`, `RUNTIME_FLAGS`, `getSettingsKeyAtom`, `railVisibleAtom`, `naFlagsAtom`, `naRememberFlagsAtom`) match their real signatures verified in the source.
