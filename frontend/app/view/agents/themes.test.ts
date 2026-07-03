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
