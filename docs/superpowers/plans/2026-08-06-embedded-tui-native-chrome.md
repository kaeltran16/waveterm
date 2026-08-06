# Embedded TUI Native Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Claude Code / Codex TUI embedded in the Agent surface look and behave like part of the cockpit — its colors follow the active cockpit theme, and cockpit keyboard chords stay reachable while it holds focus.

**Architecture:** Two independent slices sharing no file. **Slice A (palette):** `ThemePalette` in `frontend/app/view/agents/themes.ts` becomes the single source for terminal colors, gaining a pure `deriveAnsi` (16 ANSI slots from existing theme roles) and `deriveTermTheme` (an xterm-shaped theme object). The terminal reads that instead of `pkg/wconfig/defaultconfig/termthemes.json`, and its background becomes opaque so xterm stops showing its stylesheet's black viewport. **Slice B (keyboard):** the `g`-leader gets a second door (`Ctrl+G`) that works while a text field has focus, and leader continuations stop consulting the `editable` flag — because once a leader is active the dispatcher consumes the key and it never reaches the agent.

**Tech Stack:** TypeScript, React 19, jotai, Tailwind 4, vitest, `colord` (already a dependency), xterm.js, Chrome DevTools Protocol for visual verification.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-06-embedded-tui-native-chrome-design.md`. Decision numbers below refer to its §3 Resolved decisions (1–11) and §4.1 (decision 12).
- **No Go, no Rust, no `task generate`, no SQL migration.** Appearance and keybindings are pure-frontend.
- **Never hand-edit generated files.** `frontend/app/store/wshclientapi.ts` and `frontend/types/gotypes.d.ts` are generated; this plan does not touch them.
- **Colors only through `@theme` tokens.** No raw hex or rgba in components. The hex literals in this plan appear only inside `themes.ts` (which *is* the token source) and inside test files.
- **Typecheck with** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Bare `npx tsc` stack-overflows on this repo, so `task check:ts` is broken. Baseline is clean (exit 0) — any error it reports is yours.
- **Run single test files with** `npx vitest run <path>`. Filter by name with `-t "<name>"`.
- **Do not run `npx prettier --write`** on files you did not author end-to-end. It reorganizes imports and rewraps the whole file, turning a 4-line edit into a 600-line diff. Hand-format your own lines to match surrounding style (4-space indent).
- **Commits: one at the end, and only with the user's explicit approval.** The project's git policy overrides this skill's frequent-commit default: batch into a single commit, never commit or push unasked, and do not add yourself as co-author. The spec document folds into that same commit — never a separate docs-only commit. Task 9 handles this.
- **Two chords in Slice B are unverified against the agent TUIs** (`Ctrl+G`, `F11`). Task 8 verifies them live before the slice is considered done. Do not skip it.

---

## File Structure

**Slice A — palette**

| File | Responsibility after this plan |
|---|---|
| `frontend/app/view/agents/themes.ts` | Sole source of cockpit color derivation. Gains `AnsiPalette`, `TermPalette`, `deriveAnsi`, `deriveTermTheme`; `buildThemeVars` also emits `--ansi-*`. |
| `frontend/app/view/agents/themes.test.ts` | Adds the four structural invariants, the 3:1 floor, and Midnight's golden ANSI set. |
| `frontend/app/view/term/termutil.ts` | Loses `computeTheme` and `DefaultTermTheme` entirely. Keeps clipboard/cursor helpers. |
| `frontend/app/view/term/termtheme.ts` | `TermThemeUpdater` reads the cockpit theme atoms and applies the derived theme. |
| `frontend/app/view/term/term.tsx` | Construction-time terminal theme comes from the cockpit theme. |
| `frontend/app/view/term/term-model.ts` | Loses `termThemeNameAtom`, `termTransparencyAtom`, `blockBg`, `setTerminalTheme`, the theme submenu, the transparency menu items, and the "Magnify block" item. |
| `frontend/app/view/agents/settingssurface.tsx` | `TerminalSection` keeps its five non-color rows; the Color scheme and Transparency rows go, with their now-dead helpers. |
| `frontend/app/cockpit/cockpit.scss` | Neutralizes xterm's black viewport background inside the focus pane. |
| `frontend/tailwindsetup.css` | `--ansi-*` block re-commented as the un-themed fallback. |

**Slice B — keyboard**

| File | Responsibility after this plan |
|---|---|
| `frontend/app/store/keybindings/matcher.ts` | Adds `LEADER_ALIASES`, Escape interception during leader mode, and the singles fallback. |
| `frontend/app/store/keybindings/matcher.test.ts` | Covers the alias door, the fallback, the `f` precedence, and the Escape race. |
| `frontend/app/store/keybindings/bindings.ts` | `navigate` becomes leader-aware; adds `navigateStrict` for Escape-keyed bindings; adds `leader:enter` and `agent:fullscreen-chord`. |
| `frontend/app/store/keybindings/store.test.ts` | `contexts()` gains `leader: "g"` so the conflict invariant covers the new posture. |
| `frontend/app/cockpit/footerhints.ts` | Chips for `leader:enter` and `agent:fullscreen-chord`. |
| `scripts/cdp/scenarios.mjs` | Adds `terminal-theme`, `tui-leader`, `tui-fullscreen`. |

---

# SLICE A — Palette follows the cockpit theme

### Task 1: `deriveAnsi` — sixteen ANSI colors from theme roles

**Files:**
- Modify: `frontend/app/view/agents/themes.ts` (add after the color-math helpers, which end at `:166`)
- Test: `frontend/app/view/agents/themes.test.ts`

**Interfaces:**
- Consumes: `ThemePalette` (`themes.ts:13-32`), and the existing private helper `lighten(h, t)` (`themes.ts:156`).
- Produces: `export interface AnsiPalette` with exactly the sixteen xterm ANSI field names (`black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `brightBlack`, `brightRed`, `brightGreen`, `brightYellow`, `brightBlue`, `brightMagenta`, `brightCyan`, `brightWhite`), and `export function deriveAnsi(palette: ThemePalette): AnsiPalette`. Tasks 2 and 3 both call `deriveAnsi`.

**Why these mappings:** decision 12 in the spec. Magenta and cyan take a *canonical hue* rather than a rotated accent, because Carbon's accent is amber (`#d7a95c`) and rotating it produced a green ANSI magenta. `white` comes from `text`, not `secondary`, because One Dark defines `muted` lighter than `secondary`, which would render "bright black" lighter than "white".

- [ ] **Step 1: Write the failing test**

Add to `frontend/app/view/agents/themes.test.ts`. Import `deriveAnsi`, `PICKER_THEMES` and `THEMES` by extending the existing import block at the top of the file.

```ts
// --- ANSI derivation -----------------------------------------------------------------------------
// Contrast per WCAG 2.1 relative luminance. Local to the test: production code never needs it.
function channel(c: number): number {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance(hex: string): number {
    const s = hex.replace("#", "");
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a: string, b: string): number {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
// Hue in degrees, from RGB. Only used to assert magenta/cyan land in the right part of the wheel.
function hue(hex: string): number {
    const s = hex.replace("#", "");
    const r = parseInt(s.slice(0, 2), 16) / 255;
    const g = parseInt(s.slice(2, 4), 16) / 255;
    const b = parseInt(s.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) {
        return 0;
    }
    const d = max - min;
    let h: number;
    if (max === r) {
        h = ((g - b) / d) % 6;
    } else if (max === g) {
        h = (b - r) / d + 2;
    } else {
        h = (r - g) / d + 4;
    }
    h *= 60;
    return h < 0 ? h + 360 : h;
}

const ANSI_SLOTS = [
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow",
    "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;
const BRIGHT_PAIRS: [string, string][] = [
    ["black", "brightBlack"], ["red", "brightRed"], ["green", "brightGreen"], ["yellow", "brightYellow"],
    ["blue", "brightBlue"], ["magenta", "brightMagenta"], ["cyan", "brightCyan"], ["white", "brightWhite"],
];

describe("deriveAnsi — structural invariants across every selectable theme", () => {
    // Only the picker themes are reachable: themePresetAtom is written by AppearanceSection, which
    // renders PICKER_THEMES. "paper" exists in THEMES but is excluded (light mode is not shipped).
    for (const theme of PICKER_THEMES) {
        const ansi = deriveAnsi(theme.palette) as unknown as Record<string, string>;

        it(`${theme.id}: all 16 slots are parseable 6-digit hex`, () => {
            for (const slot of ANSI_SLOTS) {
                expect(ansi[slot], slot).toMatch(/^#[0-9a-f]{6}$/i);
            }
        });

        // One Dark defines muted (#a6abb3) LIGHTER than secondary (#9298a4). A white<-secondary
        // mapping would render "bright black" lighter than "white" in the terminal.
        it(`${theme.id}: grey ramp is strictly monotonic black < brightBlack < white < brightWhite`, () => {
            const ramp = ["black", "brightBlack", "white", "brightWhite"];
            for (let i = 1; i < ramp.length; i++) {
                expect(luminance(ansi[ramp[i]]), `${ramp[i]} vs ${ramp[i - 1]}`).toBeGreaterThan(
                    luminance(ansi[ramp[i - 1]])
                );
            }
        });

        it(`${theme.id}: every bright slot is strictly lighter than its base`, () => {
            for (const [base, bright] of BRIGHT_PAIRS) {
                expect(luminance(ansi[bright]), `${bright} vs ${base}`).toBeGreaterThan(luminance(ansi[base]));
            }
        });

        // Guards the Carbon defect: an amber accent must not produce a green "magenta" (spec decision 12).
        it(`${theme.id}: magenta and cyan land in their canonical hue ranges`, () => {
            expect(hue(ansi.magenta), `magenta hue ${hue(ansi.magenta)}`).toBeGreaterThanOrEqual(280);
            expect(hue(ansi.magenta)).toBeLessThanOrEqual(320);
            expect(hue(ansi.cyan), `cyan hue ${hue(ansi.cyan)}`).toBeGreaterThanOrEqual(170);
            expect(hue(ansi.cyan)).toBeLessThanOrEqual(200);
        });

        // 3:1 is WCAG's floor for UI components / large text. Terminal glyphs are not large text, so
        // this catches gross regressions rather than certifying AA. Measured worst case across the six
        // themes is 3.51 (nocturne.black), so this has real margin. See spec decision 5.
        it(`${theme.id}: every slot clears 3:1 against its own background`, () => {
            for (const slot of ANSI_SLOTS) {
                expect(contrast(ansi[slot], theme.palette.bg), `${slot}=${ansi[slot]}`).toBeGreaterThanOrEqual(3);
            }
        });
    }

    it("paper (light, not in the picker) still derives without throwing", () => {
        const paper = THEMES.find((t) => t.id === "paper")!;
        expect(Object.keys(deriveAnsi(paper.palette))).toHaveLength(16);
    });
});

describe("deriveAnsi — Midnight golden set", () => {
    // Pinned so a future edit to Midnight's palette roles surfaces as a reviewable diff rather than a
    // silent change to the terminal's colors.
    it("matches the recorded values", () => {
        expect(deriveAnsi(activePalette("midnight"))).toEqual({
            black: "#646a72",
            brightBlack: "#7f858b",
            red: "#e0726c",
            brightRed: "#e89591",
            green: "#54c79a",
            brightGreen: "#7fd5b3",
            yellow: "#e6b450",
            brightYellow: "#ecc77c",
            blue: "#7c95ff",
            brightBlue: "#9db0ff",
            magenta: "#ff70fa",
            brightMagenta: "#ff94fb",
            cyan: "#70f1ff",
            brightCyan: "#94f5ff",
            white: "#e6e9ed",
            brightWhite: "#eceff2",
        });
    });

    it("an accent override moves ANSI blue, magenta and cyan", () => {
        const base = deriveAnsi(activePalette("midnight"));
        const overridden = deriveAnsi({ ...activePalette("midnight"), accent: "#66d9ef" });
        expect(overridden.blue).toBe("#66d9ef");
        expect(overridden.magenta).not.toBe(base.magenta);
        expect(overridden.cyan).not.toBe(base.cyan);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/themes.test.ts`
Expected: FAIL — `deriveAnsi is not a function` / import resolution error, because `themes.ts` does not export it yet.

- [ ] **Step 3: Implement `deriveAnsi`**

In `frontend/app/view/agents/themes.ts`, add the `colord` import at the top of the file (the file currently has no imports — put it directly under the header comment block that ends at `:8`):

```ts
import { colord } from "colord";
```

Then add this block after the existing color-math helpers (immediately after `rgba`, which ends at `:166`, and before the `buildThemeVars` comment):

```ts
// ---- ANSI derivation ----
// The 16 terminal color slots, derived from roles the palette already defines. Two consumers:
// buildThemeVars (--ansi-* custom properties) and deriveTermTheme (the live xterm palette), so the
// CSS side and the terminal cannot drift.
export interface AnsiPalette {
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
}

const AnsiBrighten = 0.25; // bright-slot lift; large enough that every pair separates in all 6 themes

// Magenta and cyan are the only slots with no cockpit role. Their hue is pinned to the slot's
// canonical position and only saturation/lightness follow the accent — rotating the accent's own hue
// produces a GREEN magenta on Carbon (accent #d7a95c) and a RED cyan, which is worse than ignoring
// the theme. Floors keep a desaturated accent from yielding a grey "magenta" and a dark one from
// yielding an illegible slot.
const MagentaHue = 302;
const CyanHue = 186;
const HueSatFloor = 55;
const HueLightMin = 58;
const HueLightMax = 72;

function atHue(base: string, h: number): string {
    const hsl = colord(base).toHsl();
    return colord({
        h,
        s: Math.max(hsl.s, HueSatFloor),
        l: Math.min(Math.max(hsl.l, HueLightMin), HueLightMax),
    }).toHex();
}

// `secondary` is deliberately unmapped: white comes from `text` so the grey ramp
// black < brightBlack < white < brightWhite stays monotonic even on One Dark, which defines `muted`
// lighter than `secondary`.
export function deriveAnsi(palette: ThemePalette): AnsiPalette {
    const magenta = atHue(palette.accent, MagentaHue);
    const cyan = atHue(palette.accent, CyanHue);
    return {
        black: palette.inkFaint,
        brightBlack: palette.muted,
        red: palette.error,
        brightRed: lighten(palette.error, AnsiBrighten),
        green: palette.success,
        brightGreen: lighten(palette.success, AnsiBrighten),
        yellow: palette.warning,
        brightYellow: lighten(palette.warning, AnsiBrighten),
        blue: palette.accent,
        brightBlue: lighten(palette.accent, AnsiBrighten),
        magenta,
        brightMagenta: lighten(magenta, AnsiBrighten),
        cyan,
        brightCyan: lighten(cyan, AnsiBrighten),
        white: palette.text,
        brightWhite: lighten(palette.text, AnsiBrighten),
    };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/themes.test.ts`
Expected: PASS, all suites. If the golden-set test fails, do **not** edit the golden values to match your output — that would defeat its purpose. Re-check `AnsiBrighten`, `MagentaHue`, `CyanHue` and the three floor constants against the values above.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0, no new errors.

---

### Task 2: `deriveTermTheme` — an xterm-shaped theme from the palette

**Files:**
- Modify: `frontend/app/view/agents/themes.ts`
- Test: `frontend/app/view/agents/themes.test.ts`

**Interfaces:**
- Consumes: `deriveAnsi` and `AnsiPalette` from Task 1; `ThemePalette`, `OverrideRole` (`themes.ts:35`).
- Produces: `export interface TermPalette extends AnsiPalette` adding `background`, `foreground`, `cursor`, `cursorAccent`, `selectionBackground`; and `export function deriveTermTheme(palette: ThemePalette, overrides: Partial<Record<OverrideRole, string>>): TermPalette`. Tasks 4 and 5 call this. It is structurally assignable to xterm's `ITheme`, which is why it does not import `@xterm/xterm` — the theme engine stays free of terminal dependencies.

**The opaque background is the point.** `computeTheme` in `termutil.ts:52` forced `background` to `#00000000`, which is why xterm's own `.xterm-viewport { background-color: #000 }` showed through as a black seam. Returning an opaque `bg` is the fix.

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/agents/themes.test.ts`:

```ts
describe("deriveTermTheme", () => {
    const midnight = activePalette("midnight");

    it("background is the theme background, opaque — never a transparent black", () => {
        const t = deriveTermTheme(midnight, {});
        expect(t.background).toBe("#0c0e11");
        expect(t.background).not.toMatch(/^#00000000$/i);
        expect(t.background).toHaveLength(7); // #rrggbb — no alpha channel
    });

    it("maps foreground, cursor, cursorAccent and selection from palette roles", () => {
        const t = deriveTermTheme(midnight, {});
        expect(t.foreground).toBe("#e6e9ed"); // text
        expect(t.cursor).toBe("#7c95ff"); // accent
        expect(t.cursorAccent).toBe("#0c0e11"); // bg — the glyph under a block cursor
        expect(t.selectionBackground).toBe("#1a222c"); // surfaceSelected
    });

    it("carries all 16 ANSI slots", () => {
        const t = deriveTermTheme(midnight, {}) as unknown as Record<string, string>;
        for (const slot of ANSI_SLOTS) {
            expect(t[slot], slot).toMatch(/^#[0-9a-f]{6}$/i);
        }
    });

    it("applies role overrides, so a custom accent reaches the cursor and ANSI blue", () => {
        const t = deriveTermTheme(midnight, { accent: "#66d9ef" });
        expect(t.cursor).toBe("#66d9ef");
        expect(t.blue).toBe("#66d9ef");
    });

    it("switching preset changes the background — this is what re-skins the live TUI", () => {
        expect(deriveTermTheme(activePalette("monokai"), {}).background).toBe("#272822");
        expect(deriveTermTheme(activePalette("midnight"), {}).background).toBe("#0c0e11");
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/themes.test.ts -t "deriveTermTheme"`
Expected: FAIL — `deriveTermTheme is not a function`.

- [ ] **Step 3: Implement `deriveTermTheme`**

Add to `frontend/app/view/agents/themes.ts`, directly after `deriveAnsi`:

```ts
// The terminal's palette. Structurally assignable to xterm's ITheme; declared locally so the theme
// engine takes no dependency on @xterm/xterm. `background` is OPAQUE on purpose: xterm's own
// stylesheet paints .xterm-viewport #000, and the previous transparent-background behavior is what
// let that show through as a black seam inside a themed cockpit.
export interface TermPalette extends AnsiPalette {
    background: string;
    foreground: string;
    cursor: string;
    cursorAccent: string;
    selectionBackground: string;
}

export function deriveTermTheme(
    palette: ThemePalette,
    overrides: Partial<Record<OverrideRole, string>>
): TermPalette {
    const p = { ...palette, ...overrides };
    return {
        background: p.bg,
        foreground: p.text,
        cursor: p.accent,
        cursorAccent: p.bg,
        selectionBackground: p.surfaceSelected,
        ...deriveAnsi(p),
    };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/themes.test.ts`
Expected: PASS, all suites (Task 1's included).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 3: `buildThemeVars` emits `--ansi-*`

**Files:**
- Modify: `frontend/app/view/agents/themes.ts:169-217` (`buildThemeVars`)
- Modify: `frontend/tailwindsetup.css:146-163` (comment only)
- Test: `frontend/app/view/agents/themes.test.ts`

**Interfaces:**
- Consumes: `deriveAnsi` from Task 1.
- Produces: nothing new. `buildThemeVars`'s return map gains sixteen `--ansi-*` keys.

**Note the casing.** `tailwindsetup.css` declares these all-lowercase — `--ansi-brightblack`, not `--ansi-brightBlack`. The emitted keys must match exactly or they will not override the `@theme` defaults.

**This step is visually inert today.** `ansiline.tsx` — the only file that consumes `--ansi-*` — has no importers; it is orphaned upstream code. So this task closes the duplicate palette definition without changing any rendered pixel. The terminal's colors come from Task 4, not from here. (Spec decision 3.)

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/agents/themes.test.ts`:

```ts
describe("buildThemeVars — ANSI custom properties", () => {
    it("emits all 16 --ansi-* vars, lowercase, matching deriveAnsi", () => {
        const vars = buildThemeVars(activePalette("midnight"), {});
        const ansi = deriveAnsi(activePalette("midnight")) as unknown as Record<string, string>;
        // css custom-property name -> AnsiPalette key
        const pairs: [string, string][] = [
            ["--ansi-black", "black"], ["--ansi-red", "red"], ["--ansi-green", "green"],
            ["--ansi-yellow", "yellow"], ["--ansi-blue", "blue"], ["--ansi-magenta", "magenta"],
            ["--ansi-cyan", "cyan"], ["--ansi-white", "white"],
            ["--ansi-brightblack", "brightBlack"], ["--ansi-brightred", "brightRed"],
            ["--ansi-brightgreen", "brightGreen"], ["--ansi-brightyellow", "brightYellow"],
            ["--ansi-brightblue", "brightBlue"], ["--ansi-brightmagenta", "brightMagenta"],
            ["--ansi-brightcyan", "brightCyan"], ["--ansi-brightwhite", "brightWhite"],
        ];
        for (const [cssVar, key] of pairs) {
            expect(vars[cssVar], cssVar).toBe(ansi[key]);
        }
    });

    it("the terminal and the CSS vars cannot drift — both come from one derivation", () => {
        const palette = activePalette("monokai");
        const vars = buildThemeVars(palette, {});
        const term = deriveTermTheme(palette, {});
        expect(vars["--ansi-red"]).toBe(term.red);
        expect(vars["--ansi-brightwhite"]).toBe(term.brightWhite);
    });

    it("role overrides reach the ANSI vars", () => {
        const vars = buildThemeVars(activePalette("midnight"), { error: "#ff0000" });
        expect(vars["--ansi-red"]).toBe("#ff0000");
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/themes.test.ts -t "ANSI custom properties"`
Expected: FAIL — `expected undefined to be "#646a72"`, because `buildThemeVars` emits no `--ansi-*` keys yet.

- [ ] **Step 3: Emit the vars**

In `frontend/app/view/agents/themes.ts`, inside `buildThemeVars`, add the derivation right after the existing merge on `:170`:

```ts
export function buildThemeVars(palette: ThemePalette, overrides: Partial<Record<OverrideRole, string>>): Record<string, string> {
    const p = { ...palette, ...overrides };
    const ansi = deriveAnsi(p);
    return {
```

Then add this block immediately before the closing `};` of the returned object (after `"--color-error": p.error,` on `:215`):

```ts
        // ANSI palette — same derivation the terminal uses (deriveTermTheme), so the CSS side and the
        // live xterm palette cannot drift. Names are lowercase to match the @theme declarations in
        // tailwindsetup.css, which these override.
        "--ansi-black": ansi.black,
        "--ansi-red": ansi.red,
        "--ansi-green": ansi.green,
        "--ansi-yellow": ansi.yellow,
        "--ansi-blue": ansi.blue,
        "--ansi-magenta": ansi.magenta,
        "--ansi-cyan": ansi.cyan,
        "--ansi-white": ansi.white,
        "--ansi-brightblack": ansi.brightBlack,
        "--ansi-brightred": ansi.brightRed,
        "--ansi-brightgreen": ansi.brightGreen,
        "--ansi-brightyellow": ansi.brightYellow,
        "--ansi-brightblue": ansi.brightBlue,
        "--ansi-brightmagenta": ansi.brightMagenta,
        "--ansi-brightcyan": ansi.brightCyan,
        "--ansi-brightwhite": ansi.brightWhite,
```

- [ ] **Step 4: Re-label the fallback block in `tailwindsetup.css`**

The sixteen `--ansi-*` declarations at `frontend/tailwindsetup.css:148-163` are now overridden at runtime on every theme application. Replace whatever comment precedes them with:

```css
    /* ANSI fallback only. buildThemeVars (view/agents/themes.ts) derives these per theme and writes
       them onto the document root at runtime, so these literals apply only before the first theme
       application. Do not edit them to change terminal colors — edit the theme palette roles. */
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run frontend/app/view/agents/themes.test.ts`
Expected: PASS, all suites — including the pre-existing "Midnight parity" suite, which asserts 24 `--color-*` tokens and must be unaffected.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 4: Wire the live terminal to the cockpit theme

**Files:**
- Modify: `frontend/app/view/term/termutil.ts` — delete `computeTheme` (`:33-54`), `DefaultTermTheme` (`:4`), `applyTransparencyToColor` (`:28-31`)
- Modify: `frontend/app/view/term/termtheme.ts` — whole file
- Modify: `frontend/app/view/term/term.tsx:274-277` and the `<TermThemeUpdater>` JSX usage
- Modify: `frontend/app/view/term/term-model.ts` — delete `termThemeNameAtom` (`:256-260`), `termTransparencyAtom` (`:261-266`), `blockBg` (`:267-276`) and their field declarations
- Modify: `frontend/app/cockpit/cockpit.scss`

**Interfaces:**
- Consumes: `deriveTermTheme` (Task 2), `activePalette` (`themes.ts:129`), `themePresetAtom` + `themeOverridesAtom` (`themestore.ts:14`, `:18`).
- Produces: nothing new. Behavior change only.

**Import direction check:** `view/term/termtheme.ts` → `view/agents/themestore.ts` → `view/agents/themes.ts`. `themestore.ts` imports only jotai, react and `themes.ts`; `themes.ts` imports only `colord`. No cycle. (This matters here: `agentsurface.tsx:10-12` documents an `agents → focus-pane → blockregistry → agents` eval cycle that the codebase works to keep broken.)

**Deletion order matters.** Remove the `computeTheme` callers *before* deleting `computeTheme`, or the typechecker will report errors you then have to read past.

- [ ] **Step 1: Rewrite `TermThemeUpdater`**

Replace the entire contents of `frontend/app/view/term/termtheme.ts` with:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Keeps the live terminal's palette in step with the active cockpit theme. The terminal is cockpit
// chrome, not a guest window: its colors derive from the same ThemePalette that paints every other
// surface, so switching presets re-skins the TUI with no remount.

import type { TermWrap } from "@/app/view/term/termwrap";
import { activePalette, deriveTermTheme } from "@/app/view/agents/themes";
import { themeOverridesAtom, themePresetAtom } from "@/app/view/agents/themestore";
import { useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";

interface TermThemeProps {
    termRef: React.RefObject<TermWrap>;
}

const TermThemeUpdater = ({ termRef }: TermThemeProps) => {
    const preset = useAtomValue(themePresetAtom);
    const overrides = useAtomValue(themeOverridesAtom);
    // memoized so the effect re-runs on a real theme change, not on every parent render
    const theme = useMemo(() => deriveTermTheme(activePalette(preset), overrides), [preset, overrides]);
    useEffect(() => {
        if (termRef.current?.terminal) {
            termRef.current.terminal.options.theme = theme;
        }
    }, [theme, termRef]);
    return null;
};

export { TermThemeUpdater };
```

- [ ] **Step 2: Update the construction-time theme and the JSX usage in `term.tsx`**

Replace lines `274-277` of `frontend/app/view/term/term.tsx`:

```ts
        const termThemeName = globalStore.get(model.termThemeNameAtom);
        const termTransparency = globalStore.get(model.termTransparencyAtom);
        const [termTheme, _] = computeTheme(fullConfig, termThemeName, termTransparency);
```

with:

```ts
        const termTheme = deriveTermTheme(
            activePalette(globalStore.get(themePresetAtom)),
            globalStore.get(themeOverridesAtom)
        );
```

Update the import on `:27` from `import { computeTheme, normalizeCursorStyle } from "./termutil";` to `import { normalizeCursorStyle } from "./termutil";`, and add:

```ts
import { activePalette, deriveTermTheme } from "@/app/view/agents/themes";
import { themeOverridesAtom, themePresetAtom } from "@/app/view/agents/themestore";
```

Find the `<TermThemeUpdater .../>` element in this file and reduce its props to `termRef` only — `blockId` and `model` are no longer part of its interface.

If `fullConfig` becomes unused in that scope after this edit, remove its binding; if other lines still read it, leave it.

- [ ] **Step 3: Delete the dead atoms in `term-model.ts`**

Remove three atom definitions and their corresponding field declarations near `:76`:
- `termThemeNameAtom` (`:256-260`)
- `termTransparencyAtom` (`:261-266`)
- `blockBg` (`:267-276`) — already dead: `CockpitFocusPane` renders the terminal view without the upstream block frame that read it, so nothing consumes it

Also remove `setTerminalTheme` (`:791-795`), which writes the `term:theme` meta this design no longer reads.

Update the import on `:58` from `import { computeTheme, DefaultTermTheme, trimTerminalSelection } from "./termutil";` to `import { trimTerminalSelection } from "./termutil";`.

- [ ] **Step 4: Delete `computeTheme` and friends from `termutil.ts`**

Remove from `frontend/app/view/term/termutil.ts`:
- `export const DefaultTermTheme = "default-dark";` (`:4`)
- `applyTransparencyToColor` (`:28-31`)
- `computeTheme` (`:33-54`)
- the `import { colord } from "colord";` on `:9` **only if** nothing else in the file uses `colord` — check first

Keep everything else (`trimTerminalSelection`, `normalizeCursorStyle`, `MIME_TO_EXT`, clipboard helpers).

- [ ] **Step 5: Neutralize xterm's black viewport**

Append to `frontend/app/cockpit/cockpit.scss`:

```scss
// xterm ships `.xterm .xterm-viewport { background-color: #000 }` in its own stylesheet. The terminal
// now paints an opaque themed background (deriveTermTheme), but during a resize the viewport can be
// visible for a frame before xterm repaints — which read as a black seam inside a themed cockpit.
.cockpit-focus-pane .xterm .xterm-viewport {
    background-color: transparent;
}
```

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. Any error naming `computeTheme`, `termThemeNameAtom`, `termTransparencyAtom`, `blockBg`, `setTerminalTheme` or `DefaultTermTheme` is a caller you have not updated yet — Task 5 handles the two in `term-model.ts`'s context menu and `settingssurface.tsx`. If those are the only errors, proceed to Task 5 and re-run this at the end of it.

- [ ] **Step 7: Run the full frontend test suite**

Run: `npx vitest run`
Expected: PASS. Pre-existing failures unrelated to this change are acceptable; note them rather than fixing them.

---

### Task 5: Remove every control that sets a terminal color

**Files:**
- Modify: `frontend/app/view/term/term-model.ts` — `getSettingsMenuItems` (`:902`+) and the context-menu builder above it
- Modify: `frontend/app/view/agents/settingssurface.tsx` — `TerminalSection` (`:593-681`) and its dead helpers

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing. Deletion only.

**Why (spec decision 11):** with the cockpit theme as the source, anything else that sets a terminal color fights it. There are three such controls, and the two in Settings matter more than the context menu — they are labelled, discoverable and global. The Color scheme row's own description, "ANSI palette used inside agent terminals", becomes false after Task 4.

- [ ] **Step 1: Strip the terminal context menu**

In `frontend/app/view/term/term-model.ts`, remove from the context-menu builder and `getSettingsMenuItems`:
- the **"Magnify block" / "Un-magnify block"** item (`:885-892`) and the `const magnified = ...` line that feeds it, plus the now-orphaned `menu.push({ type: "separator" })` that preceded it — it does nothing under the cockpit's synthetic node model
- the **terminal theme submenu** — the `termThemeKeys` sort, the `submenu` array (`:949-966`) including its `"Default"` radio entry, and the parent menu item that hosts it
- the **transparency items** (`:971-993`) that write `term:transparency` meta
- the now-unused locals at the head of `getSettingsMenuItems`: `termThemes`, `termThemeKeys`, `curThemeName`, `transparencyMeta`

Keep the "Save session as…" item and the font-size items.

- [ ] **Step 2: Strip the two color rows from the Terminal settings card**

In `frontend/app/view/agents/settingssurface.tsx`, inside `TerminalSection`:
- delete the **Transparency** `<Row>` (`:653-670`) and its `transparency` binding (`:599`)
- delete the **Color scheme** `<Row>` (`:671-677`), its `themeName` binding (`:600`), the `fullConfig` binding (`:601`) and the `themeOptions` derivation (`:610-618`) — check `fullConfig` is not read elsewhere in this function before removing it

Keep the five non-color rows: Font size, Cursor style, Cursor blink, Scrollback, Copy on select.

Then delete what those rows were the only users of:
- `DEFAULT_TERM_THEME` (`:121`)
- `type TermThemeOption` (`:508`)
- `function TermThemeDropdown` (`:510`+)
- `coerceTransparency` from the import on `:16` — leave it exported from `cockpitprefsstore.ts`, since `cockpitprefsstore.test.ts:53-57` still tests it and that is harmless

- [ ] **Step 3: Verify nothing dangles**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0, clean.

Run: `npx eslint frontend/app/view/term/term-model.ts frontend/app/view/agents/settingssurface.tsx`
Expected: no unused-variable errors. Pre-existing warnings elsewhere are fine.

- [ ] **Step 4: Confirm the removed settings keys have no frontend readers left**

Run: `npx vitest run` then grep:

```bash
grep -rn "term:theme\|term:transparency" frontend/app --include=*.ts --include=*.tsx
```

Expected: no matches under `frontend/app`. Matches in `frontend/types/gotypes.d.ts` are expected and correct — that file is generated, and spec decision 11 deliberately leaves the Go config in place.

- [ ] **Step 5: Visual check of the theme wiring (CDP)**

The dev app must be running. If it is not: `tail -f /dev/null | task dev` (headless `task dev` dies on stdin EOF), and remember to stop *both* halves afterwards.

Run:

```bash
node -e "
const {attach}=require('./scripts/cdp/attach.mjs');
" 2>/dev/null || node --input-type=module -e "
import { attach } from './scripts/cdp/attach.mjs';
const h = await attach(9222);
await h.cdp('Emulation.setDeviceMetricsOverride', {width:1600,height:950,deviceScaleFactor:1,mobile:false});
await h.goto('agent');
console.log('xterm background :', await h.ev('window.term?.terminal?.options?.theme?.background'));
console.log('--color-background:', await h.ev(\"getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim()\"));
console.log('xterm ansi blue  :', await h.ev('window.term?.terminal?.options?.theme?.blue'));
console.log('--color-accent   :', await h.ev(\"getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()\"));
await h.shot('cdp-shots/terminal-theme-manual.png');
await h.close();
"
```

Expected: the xterm background equals `--color-background` and the xterm ANSI blue equals `--color-accent`. `term.tsx` assigns `window.term = termWrap`, which is why this is readable without exposing jotai.

Pin the viewport as shown — the real dev window is roughly 1000×700, and an unpinned probe renders a narrow layout where by-name element lookups fail.

---

# SLICE B — Cockpit chords reach through the TUI

### Task 6: Matcher — the alias door, Escape precedence, singles fallback

**Files:**
- Modify: `frontend/app/store/keybindings/matcher.ts`
- Test: `frontend/app/store/keybindings/matcher.test.ts`

**Interfaces:**
- Consumes: `Binding`, `KeyContext`, `MatchResult` (`types.ts:20-36`), `keyutil.checkKeyPressed`.
- Produces: `export const LEADER_ALIASES: Record<string, string>` mapping a chord descriptor to the leader it opens. `matchBinding`'s signature is unchanged.

**Three behaviors, in precedence order, all inside the `ctx.leader != null` branch:**
1. a modifier chord cancels the leader and is reprocessed — **existing behavior, keep it first**
2. `Escape` resets — new, and it must precede both match passes
3. sequences, then singles, then reset — the singles pass is new

**Why Escape needs its own rule (spec decision 8):** `Escape` is itself a registered single. `agent:back` (`bindings.ts:509-522`) navigates to the Cockpit and `subagent:back` (`:488-508`) returns to the parent agent. Task 7 makes `navigate`-gated bindings active during leader mode, so without this rule `Ctrl+G` then `Escape` would navigate somewhere instead of cancelling — the opposite of what a which-key interface means by Escape.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/app/store/keybindings/matcher.test.ts`. Extend the existing import on `:5` to `import { LEADER_ALIASES, matchBinding } from "./matcher";`.

```ts
// The leader-aware guard Task 7 installs on bindings.ts. Reproduced here so these tests exercise the
// real posture rule rather than a simplification of it.
const leaderAware = (c: KeyContext) => (!c.editable || c.leader != null) && !c.modalOpen;

describe("matchBinding — leader reachable from a focused text field", () => {
    it("LEADER_ALIASES maps Ctrl+G to the g leader", () => {
        expect(LEADER_ALIASES["Ctrl:g"]).toBe("g");
    });

    it("the alias chord enters leader mode while editable — impossible with a bare prefix", () => {
        const b = bind({ id: "go-agent", keys: "g a", when: leaderAware });
        expect(matchBinding(ev("g", { control: true }), editCtx, [b])).toEqual({
            kind: "enterLeader",
            leader: "g",
        });
    });

    it("the alias works even when NO sequence binding is currently active", () => {
        // The door must not be derived from the when-filtered sequence set: inside the TUI that set is
        // empty, so deriving from it would make the door depend on the thing it exists to open.
        const off = bind({ id: "go-agent", keys: "g a", when: () => false });
        expect(matchBinding(ev("g", { control: true }), editCtx, [off])).toEqual({
            kind: "enterLeader",
            leader: "g",
        });
    });

    it("a bare g still enters leader mode at rest", () => {
        const b = bind({ id: "go-agent", keys: "g a", when: leaderAware });
        expect(matchBinding(ev("g"), navCtx, [b])).toEqual({ kind: "enterLeader", leader: "g" });
    });

    it("a bare g still does NOT enter leader mode while editable — it must reach the agent", () => {
        const b = bind({ id: "go-agent", keys: "g a", when: leaderAware });
        expect(matchBinding(ev("g"), editCtx, [b])).toEqual({ kind: "none" });
    });
});

describe("matchBinding — leader continuations", () => {
    const seqFiles = bind({ id: "go-files", keys: "g f", when: leaderAware });
    const singleRail = bind({ id: "agent:toggle-rail", keys: "d", when: leaderAware });
    const singleFull = bind({ id: "agent:fullscreen", keys: "f", when: leaderAware });
    const leaderEdit: KeyContext = { ...editCtx, leader: "g" };

    it("runs a sequence continuation while editable", () => {
        expect(matchBinding(ev("f"), leaderEdit, [seqFiles])).toEqual({ kind: "run", binding: seqFiles });
    });

    it("falls back to a single when no sequence claims the key", () => {
        expect(matchBinding(ev("d"), leaderEdit, [seqFiles, singleRail])).toEqual({
            kind: "run",
            binding: singleRail,
        });
    });

    // spec decision 9: g f is Files everywhere. Asserted so a future reordering cannot silently flip it.
    it("a sequence beats a single on the same letter — f is Files, not fullscreen", () => {
        expect(matchBinding(ev("f"), leaderEdit, [seqFiles, singleFull])).toEqual({
            kind: "run",
            binding: seqFiles,
        });
    });

    it("resets when neither a sequence nor a single matches", () => {
        expect(matchBinding(ev("z"), leaderEdit, [seqFiles, singleRail])).toEqual({ kind: "reset" });
    });

    // spec decision 8: the case where the singles fallback and the cancel gesture compete.
    it("Escape cancels the leader and does NOT run a registered Escape single", () => {
        const back = bind({ id: "agent:back", keys: "Escape", when: leaderAware });
        expect(matchBinding(ev("Escape"), leaderEdit, [seqFiles, back])).toEqual({ kind: "reset" });
    });

    it("a modifier chord during leader mode still cancels and reprocesses", () => {
        const chord = bind({ id: "s1", keys: "Ctrl:1", when: () => true });
        expect(matchBinding(ev("1", { control: true }), leaderEdit, [seqFiles, chord])).toEqual({
            kind: "resetAndProcess",
            result: { kind: "run", binding: chord },
        });
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/store/keybindings/matcher.test.ts`
Expected: FAIL — `LEADER_ALIASES` is not exported, and the new continuation cases return `{kind:"reset"}` or `{kind:"none"}`.

- [ ] **Step 3: Implement the three behaviors**

Rewrite `matchBinding` in `frontend/app/store/keybindings/matcher.ts`, keeping the file's existing header and `isSequenceKeys`/`hasModifier` helpers:

```ts
// A modifier chord that opens a leader while a text field (or the terminal's hidden textarea) holds
// focus. The bare prefix cannot do this — it has to reach the agent — so the leader gets a second
// door. Checked against this map directly, NOT against the when-filtered sequence set, which is empty
// inside the TUI: deriving the door from that set would make it depend on what it exists to open.
export const LEADER_ALIASES: Record<string, string> = { "Ctrl:g": "g" };

// Pure. No DOM, no atoms. `ctx.leader` carries the active leader prefix (or null).
export function matchBinding(waveEvent: WaveKeyboardEvent, ctx: KeyContext, bindings: Binding[]): MatchResult {
    const active = bindings.filter((b) => (b.when ? b.when(ctx) : true));
    const sequences = active.filter((b) => isSequenceKeys(b.keys));
    const singles = active.filter((b) => !isSequenceKeys(b.keys));

    if (ctx.leader != null) {
        // A modifier chord during leader mode cancels the leader and is processed normally.
        if (hasModifier(waveEvent)) {
            return { kind: "resetAndProcess", result: matchBinding(waveEvent, { ...ctx, leader: null }, bindings) };
        }
        // Escape cancels, ahead of both match passes. It is itself a registered single (agent:back,
        // subagent:back), and with the leader-aware guard those are active here — so without this rule
        // Escape would navigate instead of cancelling, which is the opposite of what the which-key bar
        // implies. Cancelling is the only meaning Escape has while that bar is showing.
        if (keyutil.checkKeyPressed(waveEvent, "Escape")) {
            return { kind: "reset" };
        }
        for (const b of sequences) {
            const [lead, next] = b.keys.split(" ");
            if (lead === ctx.leader && keyutil.checkKeyPressed(waveEvent, next)) {
                return { kind: "run", binding: b };
            }
        }
        // Fall back to the surface's own single-key vocabulary (d, j, k, [, ], ?) so the leader reuses
        // it instead of needing a mirrored `g <letter>` for each. Sequences win on a shared letter,
        // which is why `g f` is Files rather than fullscreen.
        for (const b of singles) {
            if (keyutil.checkKeyPressed(waveEvent, b.keys)) {
                return { kind: "run", binding: b };
            }
        }
        return { kind: "reset" };
    }

    // Exact single/chord matches take priority over entering a leader.
    for (const b of singles) {
        if (keyutil.checkKeyPressed(waveEvent, b.keys)) {
            return { kind: "run", binding: b };
        }
    }
    // Leader entry by alias chord — works regardless of posture, so the tree is reachable from the TUI.
    for (const [chord, leader] of Object.entries(LEADER_ALIASES)) {
        if (keyutil.checkKeyPressed(waveEvent, chord)) {
            return { kind: "enterLeader", leader };
        }
    }
    // Leader entry by bare prefix — only where a sequence binding is actually active.
    const prefixes = new Set(sequences.map((b) => b.keys.split(" ")[0]));
    for (const p of prefixes) {
        if (keyutil.checkKeyPressed(waveEvent, p)) {
            return { kind: "enterLeader", leader: p };
        }
    }
    return { kind: "none" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/store/keybindings/matcher.test.ts`
Expected: PASS, including all eight pre-existing cases. The pre-existing "does not enter leader mode when editable" case must still pass — it asserts the *bare* `g`, which the alias does not change.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 7: Bindings — leader-aware guard, F11 fullscreen, footer chips

**Files:**
- Modify: `frontend/app/store/keybindings/bindings.ts:48` (`navigate`), `:194-220` (`surface:back-home`), `:474` (`agentNav`), `:509-522` (`agent:back`), plus two new bindings
- Modify: `frontend/app/store/keybindings/store.test.ts:43-53` (`contexts()`)
- Modify: `frontend/app/cockpit/footerhints.ts:19-25` and `:31-38`
- Test: `frontend/app/store/keybindings/store.test.ts`, `frontend/app/cockpit/footerhints.test.ts`

**Interfaces:**
- Consumes: `KeyContext` (`types.ts:9-14`), `LEADER_ALIASES` (Task 6) — for the chord string on the new documentation binding.
- Produces: two binding ids that `footerhints.ts` references — `leader:enter` (keys `Ctrl:g`) and `agent:fullscreen-chord` (keys `F11`) — and a module-local `navigateStrict` guard.

**Why two guards.** `navigate` becomes leader-aware so `d`, `j`, `k`, `[`, `]` and `?` work under the leader. But `Escape`-keyed bindings must *not* become active while a text field holds focus, or two of them would claim `Escape` in the same context and the conflict invariant would fail — concretely, `surface:back-home` and `jarvis:blur-composer` (`:426-442`, which requires `editable`) would both be active on the Jarvis surface. `navigateStrict` keeps the current semantics for exactly those bindings; the matcher owns `Escape` during leader mode anyway (Task 6).

**Why `F11`.** `GO_TARGETS` (`:35-46`) already binds `g f` to Files, so under the leader `f` is Files and the fullscreen toggle would be unreachable from inside the TUI. `F11` is the universal fullscreen convention, carries no editor muscle memory, and is not a key a TUI's text input consumes. `keyutil.parseKeyDescription` handles `"F11"` as a modifier-free descriptor — its uppercase-implies-Shift inference is scoped to single-character keys (`keyutil.ts:114-124`) — and no function key is bound anywhere in the registry today.

- [ ] **Step 1: Write the failing tests**

In `frontend/app/store/keybindings/store.test.ts`, extend `contexts()` (`:43-53`) to cover the new posture:

```ts
function contexts(): KeyContext[] {
    const out: KeyContext[] = [];
    for (const surface of SURFACES) {
        for (const editable of [false, true]) {
            for (const modalOpen of [false, true]) {
                // leader: "g" is a real posture now — the alias chord (matcher.ts LEADER_ALIASES) opens
                // the tree from a focused text field, and the leader-aware `navigate` guard activates
                // bindings that are dormant at rest. Without this axis the invariant would pass
                // vacuously for every key the leader newly exposes.
                for (const leader of [null, "g"]) {
                    out.push({ surface, editable, modalOpen, leader });
                }
            }
        }
    }
    return out;
}
```

Then append to the same file's `describe("keybinding conflict invariant", ...)`:

```ts
    it("global + agent + jarvis + files bindings do not conflict in leader posture either", () => {
        const model = {} as any;
        expect(() =>
            assertNoConflicts([
                ...buildGlobalBindings(model),
                ...buildAgentBindings(model),
                ...buildJarvisBindings(),
                ...buildFilesBindings(),
            ])
        ).not.toThrow();
    });
```

And append to `frontend/app/store/keybindings/bindings.test.ts`:

```ts
describe("leader reachability and the fullscreen chord", () => {
    const model = {} as any;
    const inTerm: KeyContext = { surface: "agent", editable: true, modalOpen: false, leader: null };
    const inTermLeader: KeyContext = { ...inTerm, leader: "g" };

    it("registers a documentation-only leader:enter binding on the alias chord", () => {
        const b = buildGlobalBindings(model).find((x) => x.id === "leader:enter")!;
        expect(b).toBeDefined();
        expect(b.keys).toBe("Ctrl:g");
        // documentation only — the matcher performs leader entry, so this must never consume the key
        expect(b.run(inTerm)).toBe(false);
    });

    it("leader:enter is advertised while the terminal holds focus", () => {
        const b = buildGlobalBindings(model).find((x) => x.id === "leader:enter")!;
        expect(b.when?.(inTerm) ?? true).toBe(true);
    });

    it("surface teleports are dormant in the terminal but live under the leader", () => {
        const go = buildGlobalBindings(model).find((x) => x.id === "go:agent")!;
        expect(go.when!(inTerm)).toBe(false);
        expect(go.when!(inTermLeader)).toBe(true);
    });

    it("the details rail is dormant in the terminal but live under the leader", () => {
        const rail = buildAgentBindings(model).find((x) => x.id === "agent:toggle-rail")!;
        expect(rail.when!(inTerm)).toBe(false);
        expect(rail.when!(inTermLeader)).toBe(true);
    });

    it("Escape-keyed navigation stays dormant in BOTH postures (the matcher owns Escape)", () => {
        const back = buildAgentBindings(model).find((x) => x.id === "agent:back")!;
        expect(back.when!(inTerm)).toBe(false);
        expect(back.when!(inTermLeader)).toBe(false);
    });

    it("F11 toggles fullscreen and is live while the terminal holds focus", () => {
        const b = buildAgentBindings(model).find((x) => x.id === "agent:fullscreen-chord")!;
        expect(b.keys).toBe("F11");
        expect(b.when!(inTerm)).toBe(true);
        expect(b.when!({ ...inTerm, surface: "cockpit" })).toBe(false);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/store/keybindings/bindings.test.ts frontend/app/store/keybindings/store.test.ts`
Expected: FAIL — `leader:enter` and `agent:fullscreen-chord` are undefined, and the `go:agent` / `agent:toggle-rail` leader assertions return `false`.

- [ ] **Step 3: Make the guards leader-aware**

In `frontend/app/store/keybindings/bindings.ts`, replace `:48`:

```ts
// Posture guard for keys that reach the cockpit rather than the focused agent. Leader-aware: once a
// leader is active the dispatcher consumes the keystroke and it never reaches the agent, so "focus is
// in a text field" has already been overridden by a deliberate chord. In the TUI with no leader,
// editable is true and leader is null — behavior is bit-for-bit what it was before.
const navigate = (ctx: KeyContext) => (!ctx.editable || ctx.leader != null) && !ctx.modalOpen;

// For Escape-keyed bindings only. Escape must never activate while a text field or the terminal holds
// focus: jarvis:blur-composer claims Escape in exactly that posture, and two active claims on one key
// is what assertNoConflicts exists to catch. During leader mode the matcher intercepts Escape ahead of
// any binding (matcher.ts), so nothing is lost by keeping these strict.
const navigateStrict = (ctx: KeyContext) => !ctx.editable && !ctx.modalOpen;
```

Change the `surface:back-home` binding's `when` (`:203`) from `navigate(ctx) && …` to `navigateStrict(ctx) && …`.

Add a strict variant beside `agentNav` (`:474`):

```ts
const agentNav = (ctx: KeyContext) => navigate(ctx) && ctx.surface === "agent";
const agentNavStrict = (ctx: KeyContext) => navigateStrict(ctx) && ctx.surface === "agent";
```

Change the `agent:back` binding's `when` (`:514`) from `agentNav(ctx) && …` to `agentNavStrict(ctx) && …`.

- [ ] **Step 4: Add the two new bindings**

In `buildGlobalBindings`, add to the returned array (next to the `palette` binding so the always-live chords sit together):

```ts
        {
            // Documentation only: matcher.ts LEADER_ALIASES performs the leader entry, because the
            // dispatcher owns leader state and a binding cannot set it. This exists so the footer
            // (footer-visible.ts renders a chip only for an ACTIVE binding id) and the Shift+? cheat
            // sheet can advertise the chord. Same shape as the cockpit-grid documentation bindings.
            id: "leader:enter",
            keys: "Ctrl:g",
            group: "Navigation",
            label: "Go to… (works inside the agent terminal)",
            when: (ctx) => !ctx.modalOpen,
            run: () => false, // never consume — the matcher already handled it
        },
```

In `buildAgentBindings`, add to the returned array:

```ts
        {
            // The leader letter `f` is taken by the Files surface (GO_TARGETS), so fullscreen needs a
            // chord to stay reachable from inside the TUI. F11 is the universal convention, carries no
            // editor muscle memory, and is not a key a TUI's text input consumes. Deliberately NOT
            // gated on !editable — same shape as close-agent's Ctrl+C, which stays live in the terminal.
            id: "agent:fullscreen-chord",
            keys: "F11",
            group: "Agent",
            label: "Toggle terminal fullscreen",
            when: (ctx) => ctx.surface === "agent" && !ctx.modalOpen,
            run: () => globalStore.set(terminalFullscreenAtom, !globalStore.get(terminalFullscreenAtom)),
        },
```

- [ ] **Step 5: Add the footer chips**

In `frontend/app/cockpit/footerhints.ts`, replace the `go` entry in `GLOBAL_HINTS` and add the chord beside it:

```ts
    { ids: ["go:cockpit"], glyph: "g", label: "go" }, // bare g-leader; drops in the terminal
    { ids: ["leader:enter"], keys: "Ctrl:g", label: "go" }, // the same tree, reachable in the terminal
```

Add to `SURFACE_HINTS.agent`, after the existing `f`/full entry:

```ts
        { ids: ["agent:fullscreen-chord"], keys: "F11", label: "full" }, // reachable in the terminal
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/store/keybindings/ frontend/app/cockpit/footerhints.test.ts`
Expected: PASS. If `assertNoConflicts` throws, read its message — it names the key, both binding ids and the exact context. A conflict at `leader="g", editable=true` means a binding you loosened shares a key with one that was already live in that posture; the fix is to move it to `navigateStrict`, not to weaken the test.

- [ ] **Step 7: Full suite and typecheck**

Run: `npx vitest run`
Expected: PASS.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 8: Live verification — the two unproven chords and three CDP scenarios

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` — add three scenarios and register them in the exported manifest

**Interfaces:**
- Consumes: the harness `h` from `scripts/cdp/attach.mjs:138-180` — `h.ev`, `h.cdp`, `h.goto`, `h.shot`, `h.activeSurfaceLabel`.
- Produces: three scenario objects named `terminal-theme`, `tui-leader`, `tui-fullscreen`.

**This task cannot be skipped.** `Ctrl+G` is `abort` in readline and may be consumed by Claude Code's Ink-based input or the Codex TUI; `F11` may be a WebView2 default. Neither can be settled from this repository. Commit `ccc90133` records this exact failure class — an unclaimed `Ctrl+P` reached WebView2, which answered with a print dialog. The dispatcher's `preventDefault()` + `stopImmediatePropagation()` (`dispatcher.ts:102-105`) is what suppressed that and should suppress these, but it must be observed.

**Do not use `--write` on this file.** `scripts/*.mjs` is excluded from `.editorconfig`, so Prettier reindents it to 2-space. Hand-format at 4-space.

- [ ] **Step 1: Start the dev app with an agent running**

Run: `tail -f /dev/null | task dev` (headless `task dev` dies on stdin EOF). Launch a Claude Code agent from the cockpit so the Agent surface has a live TUI. Remember that this pipeline leaves two processes — stop both when finished, since the `tail -f` half does not exit if `task dev` crashes.

If CDP later refuses the connection mid-run (`ECONNREFUSED :9222`), suspect that a concurrent edit crashed `task dev` rather than a CDP fault — check the dev log for "going away".

- [ ] **Step 2: Verify the two chords by hand before automating them**

With the TUI focused, type a short prompt into the agent and confirm ordinary letters still reach it. Then:

```bash
node --input-type=module -e "
import { attach } from './scripts/cdp/attach.mjs';
const h = await attach(9222);
await h.cdp('Emulation.setDeviceMetricsOverride', {width:1600,height:950,deviceScaleFactor:1,mobile:false});
await h.goto('agent');
await h.ev('window.term?.terminal?.focus()');
const before = await h.ev('window.term.terminal.buffer.active.getLine(window.term.terminal.buffer.active.cursorY).translateToString(true)');
await h.cdp('Input.dispatchKeyEvent', {type:'keyDown', key:'g', code:'KeyG', modifiers:2, windowsVirtualKeyCode:71});
await h.cdp('Input.dispatchKeyEvent', {type:'keyUp',   key:'g', code:'KeyG', modifiers:2, windowsVirtualKeyCode:71});
const footer = await h.ev(\"(document.body.innerText.match(/^.*Cockpit \\\\(home\\\\).*$/m)||[''])[0]\");
const after = await h.ev('window.term.terminal.buffer.active.getLine(window.term.terminal.buffer.active.cursorY).translateToString(true)');
console.log('which-key bar visible :', footer.length > 0);
console.log('terminal line changed :', before !== after, JSON.stringify({before, after}));
await h.close();
"
```

Expected: the which-key bar is visible and the terminal line is **unchanged**. A changed line means `Ctrl+G` leaked to the PTY.

If `Ctrl+G` is consumed by the agent, change `LEADER_ALIASES` in `frontend/app/store/keybindings/matcher.ts` to `{ "Alt:g": "g" }` and update the `leader:enter` binding's `keys` plus its footer chip to `"Alt:g"`, then repeat. Record which chord you settled on in the plan's Outcome notes.

Then check `F11` the same way — dispatch `key:'F11', code:'F11', windowsVirtualKeyCode:122`, and confirm the terminal pane goes fullscreen and no WebView2 fullscreen or other default fires.

- [ ] **Step 3: Add the `terminal-theme` scenario**

Add to `scripts/cdp/scenarios.mjs`:

```javascript
// --- terminal palette follows the cockpit theme -------------------------------------------------
// Asserts against window.term (term.tsx assigns it) + the resolved custom properties, NOT pixels:
// reading the applied xterm theme is exact, where a screenshot sample is not. The shots are for a
// human to judge whether Claude Code's own diff colors read well, which no assertion can decide.
const terminalTheme = {
    name: "terminal-theme",
    surface: "agent",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const readVar = (name) =>
            h.ev(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`);
        const readTheme = (field) => h.ev(`window.term?.terminal?.options?.theme?.${field} ?? null`);
        const pickPreset = (name) =>
            h.ev(`(() => {
                const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(name)});
                if (!b) return false;
                b.click();
                return true;
            })()`);

        await h.goto("agent");
        const bg = await readTheme("background");
        const cssBg = await readVar("--color-background");
        steps.push({
            step: "1. xterm background === --color-background (the black seam is gone)",
            ok: !!bg && bg.toLowerCase() === cssBg.toLowerCase(),
            detail: `xterm=${bg} css=${cssBg}`,
        });

        const blue = await readTheme("blue");
        const cssAccent = await readVar("--color-accent");
        steps.push({
            step: "2. xterm ANSI blue === --color-accent (palette derives from theme roles)",
            ok: !!blue && blue.toLowerCase() === cssAccent.toLowerCase(),
            detail: `blue=${blue} accent=${cssAccent}`,
        });

        steps.push({
            step: "3. xterm background is opaque (#rrggbb, never #00000000)",
            ok: typeof bg === "string" && /^#[0-9a-f]{6}$/i.test(bg),
            detail: `background=${bg}`,
        });
        await h.shot("cdp-shots/terminal-theme-midnight.png");

        // switch presets in Settings, return to the Agent surface, and confirm the TUI re-skinned
        await h.goto("settings");
        const picked = await pickPreset("Monokai");
        await h.goto("agent");
        const bg2 = await readTheme("background");
        steps.push({
            step: "4. switching preset re-skins the live TUI with no remount",
            ok: picked && !!bg2 && bg2.toLowerCase() !== bg.toLowerCase(),
            detail: `picked=${picked} before=${bg} after=${bg2}`,
        });
        await h.shot("cdp-shots/terminal-theme-monokai.png");
        return steps;
    },
    async teardown(h) {
        // restore the default preset so a later scenario is not judged against Monokai
        await h.goto("settings");
        await h.ev(`(() => {
            const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Midnight');
            if (b) b.click();
            return true;
        })()`);
        await h.goto("cockpit");
    },
};
```

- [ ] **Step 4: Add the `tui-leader` and `tui-fullscreen` scenarios**

```javascript
// --- cockpit chords reach through a focused TUI -------------------------------------------------
// The leak is the failure mode that matters: a rail that opened AND a stray "d" in the agent's prompt
// is a failure, not a pass. So every step reads the terminal's own buffer line as well as the DOM.
const CTRL = 2; // CDP Input.dispatchKeyEvent modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8

const pressKey = async (h, { key, code, keyCode, modifiers = 0 }) => {
    for (const type of ["keyDown", "keyUp"]) {
        await h.cdp("Input.dispatchKeyEvent", { type, key, code, modifiers, windowsVirtualKeyCode: keyCode });
    }
};
const termLine = (h) =>
    h.ev(
        `(() => { const b = window.term?.terminal?.buffer?.active; return b ? b.getLine(b.cursorY).translateToString(true) : null; })()`
    );
const railOpen = (h) => h.ev(`!!document.querySelector('[aria-label="Agent details"]')`);

const tuiLeader = {
    name: "tui-leader",
    surface: "agent",
    async arrange(h) {
        await h.goto("agent");
        // the rail is a persisted toggle; record its entry state so the assertion reads a real change
        return { railWasOpen: await railOpen(h) };
    },
    async assert(h, ctx) {
        const steps = [];
        await h.ev("window.term?.terminal?.focus()");

        const baseline = await termLine(h);
        await pressKey(h, { key: "g", code: "KeyG", keyCode: 71, modifiers: CTRL });
        const afterLeader = await termLine(h);
        const whichKey = await h.ev(`document.body.innerText.includes('Cockpit (home)')`);
        steps.push({
            step: "1. Ctrl+G opens the which-key bar and does not reach the PTY",
            ok: whichKey === true && afterLeader === baseline,
            detail: `whichKey=${whichKey} line=${JSON.stringify({ baseline, afterLeader })}`,
        });

        await pressKey(h, { key: "d", code: "KeyD", keyCode: 68 });
        const afterD = await termLine(h);
        const nowOpen = await railOpen(h);
        steps.push({
            step: "2. d toggles the details rail, and no 'd' leaks into the agent's prompt",
            ok: nowOpen !== ctx.railWasOpen && afterD === baseline,
            detail: `railWasOpen=${ctx.railWasOpen} nowOpen=${nowOpen} line=${JSON.stringify(afterD)}`,
        });

        // a bare letter with no leader must still reach the agent — the whole point of the guard
        await pressKey(h, { key: "d", code: "KeyD", keyCode: 68 });
        const afterBareD = await termLine(h);
        steps.push({
            step: "3. without the leader, a bare d still reaches the agent",
            ok: afterBareD !== baseline,
            detail: `line=${JSON.stringify({ baseline, afterBareD })}`,
        });

        await pressKey(h, { key: "g", code: "KeyG", keyCode: 71, modifiers: CTRL });
        await pressKey(h, { key: "c", code: "KeyC", keyCode: 67 });
        const surface = await h.activeSurfaceLabel();
        steps.push({
            step: "4. Ctrl+G then c teleports to Jarvis from inside the terminal",
            ok: surface === SURFACE_LABEL.jarvis,
            detail: `active=${surface}`,
        });
        await h.shot("cdp-shots/tui-leader.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("agent");
        // clear the stray characters this scenario typed into the agent's composer
        await pressKey(h, { key: "Escape", code: "Escape", keyCode: 27 });
        await h.goto("cockpit");
    },
};

const tuiFullscreen = {
    name: "tui-fullscreen",
    surface: "agent",
    async arrange(h) {
        await h.goto("agent");
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.ev("window.term?.terminal?.focus()");
        // fullscreen hides the agent tree; its absence is the observable
        const treeVisible = () => h.ev(`!!document.querySelector('[data-cockpit-surface-wrap] nav, [data-agent-tree]')`);
        const before = await treeVisible();
        const baseline = await termLine(h);
        await pressKey(h, { key: "F11", code: "F11", keyCode: 122 });
        const after = await treeVisible();
        const line = await termLine(h);
        steps.push({
            step: "1. F11 toggles terminal fullscreen and does not reach the PTY",
            ok: after !== before && line === baseline,
            detail: `treeVisible ${before} -> ${after}, line=${JSON.stringify(line)}`,
        });
        await h.shot("cdp-shots/tui-fullscreen.png");
        await pressKey(h, { key: "F11", code: "F11", keyCode: 122 });
        steps.push({
            step: "2. F11 again restores the split view",
            ok: (await treeVisible()) === before,
            detail: `treeVisible=${await treeVisible()}`,
        });
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};
```

Register all three in the manifest this file exports at its end, alongside `surfaceSmoke` and the rest.

- [ ] **Step 5: Run the scenarios**

Run: `task verify:ui -- terminal-theme tui-leader tui-fullscreen`
Expected: a PASS/FAIL table with every step passing, a contact sheet at `cdp-shots/index.html`, and exit 0.

If a step's DOM selector finds nothing, fix the selector rather than the assertion — `[aria-label="Agent details"]` comes from `CollapsibleRail`'s `ariaLabel` prop (`agentdetailsrail.tsx:278`), and the tree selector may need a `data-*` hook added to `agenttree.tsx`. Prefer adding a stable `data-*` attribute to guessing at class names; a document-wide `button` query is known to pick the app bar's global search button instead of the row you meant.

- [ ] **Step 6: Look at the screenshots**

Open `cdp-shots/index.html`. Judge what no assertion can: whether Claude Code's diff colors, box borders and spinner read well against the derived palette in both Midnight and Monokai. The spec flags this as the residual risk — Monokai's `error` is already only 3.9:1 against its own background, which is pre-existing but shows up here as ANSI red.

If a color reads badly, tune `AnsiBrighten`, `HueSatFloor`, `HueLightMin` or `HueLightMax` in `themes.ts`, then re-run Task 1's tests (the golden set will need updating deliberately, with the new values recorded) and re-run this scenario.

---

### Task 9: Land the work

**Files:** all of the above, plus `docs/superpowers/specs/2026-08-06-embedded-tui-native-chrome-design.md` and this plan.

- [ ] **Step 1: Full verification**

```bash
npx vitest run
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx eslint frontend/app/view/agents/themes.ts frontend/app/view/term/ frontend/app/store/keybindings/ frontend/app/cockpit/footerhints.ts
task verify:ui -- terminal-theme tui-leader tui-fullscreen surface-smoke
```

Expected: tests pass, typecheck exits 0, no new lint errors, all four scenarios pass. `surface-smoke` is included because Slice A touches the terminal view that the Agent surface mounts. Note that `jarvis-ask` fails 0/2 for an unrelated reason — it still sends `Ctrl+P` after `1b577a4a` moved the palette — so do not run it as a gate and do not read it as a regression.

- [ ] **Step 2: Self-review the diff**

Run `git diff` and `git status`. Confirm: no commented-out code, no debug logging, no stray `console.log`, no unrelated reformatting, and no generated file touched (`frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`). Confirm the working tree contains only files this plan names — other sessions edit this repository, so stage deliberately rather than with `git add -A`.

- [ ] **Step 3: Record the outcome in the spec**

If Step 2 of Task 8 settled on `Alt+G` instead of `Ctrl+G`, or if `F11` turned out to be claimed, amend §5.3 of the spec to state what was observed and what was chosen. The spec presents both as unverified; leaving that language in place after verifying them would misreport the state of the work.

- [ ] **Step 4: Ask for approval, then commit once**

Do **not** commit before this point. Report to the user: what changed, what the four scenarios showed, which chord was settled on, and anything left undone. Then ask whether to commit.

On approval, stage the plan's files plus both documents — the spec folds into this commit rather than a separate docs-only commit — and write a single commit whose subject states the problem and the resolution, in the style of this repository's recent history (`git log --oneline -10`). Do not add a co-author trailer.

---

## Self-Review

**Spec coverage.** Every numbered decision maps to a task: 1 and 2 → Task 1; 3 → Task 3; 4 → Tasks 2 and 4; 5 → Task 1's invariants; 6 → Tasks 6 and 7 (alias in the matcher, documentation binding in bindings); 7 → Task 7's `navigate`; 8 → Task 6's Escape rule and singles fallback; 9 → Task 7's `F11` and Task 6's precedence test; 10 → no task by design, recorded as a scope boundary; 11 → Task 5; 12 → Task 1's `atHue`. Spec §4.3's import-direction check is stated in Task 4. Spec §6's test list is covered by Tasks 1, 2, 3, 6, 7, 8. Spec §7's file table matches this plan's File Structure with one addition — `store.test.ts`, which the spec's table omits but whose `contexts()` must gain the leader axis or the conflict invariant covers the new posture vacuously.

**Placeholders.** None. Every code step carries the actual code; every run step carries the command and its expected result. The three tuning constants that Task 8 Step 6 may revisit (`AnsiBrighten` and the two hue floors) have concrete values in Task 1, validated against all six themes.

**Type consistency.** `AnsiPalette` (Task 1) is extended by `TermPalette` (Task 2) and consumed by `buildThemeVars` (Task 3) and `TermThemeUpdater` (Task 4) under those exact names. `deriveAnsi(palette)` takes one argument throughout; `deriveTermTheme(palette, overrides)` takes two throughout. The sixteen slot names are the xterm `ITheme` field names in every file that touches them, which is what makes the spread in `deriveTermTheme` valid and the assignment to `terminal.options.theme` type-check. Binding ids `leader:enter` and `agent:fullscreen-chord` are spelled identically in `bindings.ts`, `bindings.test.ts` and `footerhints.ts`. `LEADER_ALIASES` is the same export in `matcher.ts`, `matcher.test.ts` and Task 8's fallback instruction.

**One gap found and closed during this review:** an earlier draft of Task 7 loosened `navigate` without adding `navigateStrict`, which would have put `surface:back-home` and `jarvis:blur-composer` in conflict on `Escape` at `leader="g", editable=true` — and the conflict would have gone undetected, because `contexts()` in `store.test.ts` only generated `leader: null`. Both halves are now in the plan: the strict guard, and the test axis that would have caught its absence.
