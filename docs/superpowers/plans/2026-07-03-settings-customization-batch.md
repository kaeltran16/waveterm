# Settings Customization Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add font-family pickers (interface, code, terminal) and terminal preference controls (cursor, blink, scrollback, copy-on-select, transparency, ANSI color scheme) to the Settings tab — and first fix the pre-existing bug that prevents the bundled fonts from loading at all.

**Architecture:** Interface/code fonts are cockpit CSS-var overrides (`--font-sans`/`--font-mono` on `<html>`, localStorage-persisted) mirroring the existing color-theme engine (`themestore.ts`). Terminal font + all terminal knobs are existing backend config keys written via `SetConfigCommand`. The prerequisite fix relocates the self-hosted font files into the Vite publicDir so `fontutil.ts`'s `url('fonts/…')` references resolve.

**Tech Stack:** React 19, jotai (`atomWithStorage`), Tailwind v4 (`var(--*)` utilities), Vite (publicDir), Vitest, CDP visual verification (no jsdom render harness exists).

**Spec:** `docs/superpowers/specs/2026-07-03-settings-customization-batch-design.md`

**Git:** Per the repo's CLAUDE.md, do NOT commit per-task. Each task ends by staging (`git add`) only. A single approval-gated commit is the final task; the spec + this plan fold into that same feature commit. **Create a feature branch (or worktree) before Task 1 — do not work on `main`.**

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/tauri/public/fonts/*` | **(moved here)** the served location for all self-hosted fonts. |
| `frontend/tauri/public/fonts/fira-code-variable.woff2` | **new asset** — bundled Fira Code variable woff2. |
| `frontend/util/fontutil.ts` | register/load font faces at boot; **add** `loadFiraCodeFont()`. |
| `frontend/app/view/agents/fonts.ts` | **new** — font catalog (`SANS_FONTS`/`MONO_FONTS`), defaults, `stackOf`, `applyFontVars`. |
| `frontend/app/view/agents/fonts.test.ts` | **new** — catalog + `applyFontVars` unit tests. |
| `frontend/app/view/agents/fontstore.ts` | **new** — `fontSansAtom`, `fontMonoAtom`, `useApplyCockpitFonts()`. |
| `frontend/app/cockpit/cockpit-root.tsx` | **modify** — mount `useApplyCockpitFonts()`. |
| `frontend/app/view/agents/cockpitprefsstore.ts` | **modify** — add `coerceScrollback`, `coerceTransparency`. |
| `frontend/app/view/agents/cockpitprefsstore.test.ts` | **modify** — tests for the two new coercers. |
| `frontend/app/view/agents/settingssurface.tsx` | **modify** — shared control widgets, Font block in `AppearanceSection`, expanded `TerminalSection`. |

---

### Task 1: Relocate the font assets so the bundled fonts actually load

The fonts are in repo-root `public/fonts/` but Vite's publicDir is `frontend/tauri/public/`, so every `url('fonts/…')` 404s and all faces render as system fallbacks. Move them into the served publicDir. No code change to `fontutil.ts` here — the relative paths resolve once the files move.

**Files:**
- Move: `public/fonts/*` → `frontend/tauri/public/fonts/*`

- [ ] **Step 1: Sanity-check nothing else serves repo-root `public/fonts`**

Run:
```bash
grep -rn "public/fonts" --include=*.go --include=*.ts --include=*.mjs --include=*.rs . | grep -v node_modules | grep -v /dist/
```
Expected: no results (empty). If a Go static handler serves repo-root `public/`, use `cp` instead of `git mv` in Step 2 and note it.

- [ ] **Step 2: Move the font files into the publicDir**

Run:
```bash
mkdir -p frontend/tauri/public/fonts
git mv public/fonts/* frontend/tauri/public/fonts/
ls frontend/tauri/public/fonts/
```
Expected: the 9 files now listed under `frontend/tauri/public/fonts/` (`hanken-grotesk-variable.woff2`, `inter-variable.woff2`, `jetbrains-mono-v13-latin-{regular,200,700}.woff2`, `hacknerdmono-{regular,bold,italic,bolditalic}.ttf`).

- [ ] **Step 3: Verify the font URL now serves a real woff2 (not the SPA fallback)**

With the dev app running (`task dev`), run:
```bash
curl -s -o /dev/null -w "type=%{content_type} size=%{size_download}\n" http://localhost:5174/fonts/hanken-grotesk-variable.woff2
```
Expected: `type=font/woff2` (or `application/octet-stream`) and `size=34704` — NOT `text/html size=71023`. (Vite's sirv serves newly-present publicDir files without a restart.)

- [ ] **Step 4: Verify the faces load at runtime via CDP**

Using the CDP attach pattern from `scripts/cdp-shot.mjs` (dev app on `:9222`), evaluate:
```js
JSON.stringify({
  hanken: document.fonts.check('16px "Hanken Grotesk"'),
  jetbrains: document.fonts.check('16px "JetBrains Mono"'),
  hack: document.fonts.check('16px "Hack"'),
})
```
Expected: `{"hanken":true,"jetbrains":true,"hack":true}` (was all `false` before the move). If still false, hard-reload the dev page over CDP so `document.fonts` re-evaluates.

- [ ] **Step 5: Stage**

```bash
git add public/fonts frontend/tauri/public/fonts
```

---

### Task 2: Bundle Fira Code and register it at boot

**Files:**
- Create: `frontend/tauri/public/fonts/fira-code-variable.woff2`
- Modify: `frontend/util/fontutil.ts`

- [ ] **Step 1: Download the Fira Code variable woff2 into the publicDir**

Run (primary — fontsource CDN):
```bash
curl -fL -o frontend/tauri/public/fonts/fira-code-variable.woff2 \
  https://cdn.jsdelivr.net/npm/@fontsource-variable/fira-code/files/fira-code-latin-wght-normal.woff2
```
Fallback if the URL 404s: `npm i -D @fontsource-variable/fira-code` then `cp node_modules/@fontsource-variable/fira-code/files/fira-code-latin-wght-normal.woff2 frontend/tauri/public/fonts/fira-code-variable.woff2` (you may then `npm uninstall @fontsource-variable/fira-code` — the committed woff2 is the source of truth, matching the other fonts).

- [ ] **Step 2: Verify it's a real woff2, not an HTML error page**

Run:
```bash
head -c4 frontend/tauri/public/fonts/fira-code-variable.woff2 | xxd
ls -l frontend/tauri/public/fonts/fira-code-variable.woff2
```
Expected: the first 4 bytes are `77 4f 46 32` (`wOF2`) and size is > 20000 bytes. If it starts with `<` (`3c`), the download failed — use the fallback.

- [ ] **Step 3: Add the loader in `fontutil.ts`**

Add a module-level flag next to the others (top of file, near `let isHankenGroteskLoaded = false;`):
```ts
let isFiraCodeLoaded = false;
```

Add this function (after `loadHankenGroteskFont`):
```ts
function loadFiraCodeFont() {
    if (isFiraCodeLoaded) {
        return;
    }
    isFiraCodeLoaded = true;
    // variable font: a single woff2 covers the whole weight axis (same as Inter / Hanken)
    const firaFont = new FontFace("Fira Code", "url('fonts/fira-code-variable.woff2')", {
        style: "normal",
        weight: "300 700",
    });
    addToFontFaceSet(document.fonts, firaFont);
    firaFont.load();
}
```

Add the call inside `loadFonts()`:
```ts
function loadFonts() {
    loadHankenGroteskFont();
    loadInterFont();
    loadJetBrainsMonoFont();
    loadHackNerdFont();
    loadFiraCodeFont();
}
```

- [ ] **Step 4: Verify Fira Code loads via CDP**

With the dev app running, evaluate over CDP:
```js
document.fonts.check('16px "Fira Code"')
```
Expected: `true`.

- [ ] **Step 5: Stage**

```bash
git add frontend/tauri/public/fonts/fira-code-variable.woff2 frontend/util/fontutil.ts
```

---

### Task 3: Font catalog + `applyFontVars` (TDD)

**Files:**
- Create: `frontend/app/view/agents/fonts.ts`
- Test: `frontend/app/view/agents/fonts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/fonts.test.ts`:
```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { applyFontVars, DEFAULT_MONO, DEFAULT_SANS, MONO_FONTS, SANS_FONTS, stackOf } from "./fonts";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/fonts.test.ts`
Expected: FAIL — cannot resolve `./fonts` / exports undefined.

- [ ] **Step 3: Write the implementation**

Create `frontend/app/view/agents/fonts.ts`:
```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Font catalog + application. Mirrors themes.ts: the cockpit renders through Tailwind's font-sans/
// font-mono utilities that read var(--font-*), so overriding those custom properties on <html>
// re-fonts everything with no component edits. Curated to the bundled (self-hosted) faces so the
// picker stays offline-safe. Faces are registered in util/fontutil.ts.

export interface FontDef {
    id: string;
    label: string;
    stack: string; // full CSS font stack written to the --font-* var (keeps a fallback chain)
}

export const SANS_FONTS: FontDef[] = [
    { id: "hanken", label: "Hanken Grotesk", stack: '"Hanken Grotesk", system-ui, sans-serif' },
    { id: "inter", label: "Inter", stack: '"Inter", system-ui, sans-serif' },
    { id: "system", label: "System UI", stack: "system-ui, sans-serif" },
];

export const MONO_FONTS: FontDef[] = [
    { id: "jetbrains", label: "JetBrains Mono", stack: '"JetBrains Mono", monospace' },
    { id: "hack", label: "Hack", stack: '"Hack", monospace' },
    { id: "firacode", label: "Fira Code", stack: '"Fira Code", monospace' },
];

export const DEFAULT_SANS = "hanken";
export const DEFAULT_MONO = "jetbrains";
export const DEFAULT_TERM_FONT = "hack"; // matches term.tsx's current fallback

// Look up a font's stack by id, falling back to the list's first entry for an unknown id.
export function stackOf(list: FontDef[], id: string): string {
    return (list.find((f) => f.id === id) ?? list[0]).stack;
}

// Write the sans/mono font vars onto a root element's inline style (highest specificity — beats the
// @theme :root rule). Also sets Tailwind v4's --default-*-font-family (which default to var(--font-*))
// so the base body/code font follows even if a layer pinned them. Kept tiny + injectable for testing.
export function applyFontVars(root: HTMLElement, sansId: string, monoId: string): void {
    const sans = stackOf(SANS_FONTS, sansId);
    const mono = stackOf(MONO_FONTS, monoId);
    root.style.setProperty("--font-sans", sans);
    root.style.setProperty("--font-mono", mono);
    root.style.setProperty("--default-font-family", sans);
    root.style.setProperty("--default-mono-font-family", mono);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/fonts.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Stage**

```bash
git add frontend/app/view/agents/fonts.ts frontend/app/view/agents/fonts.test.ts
```

---

### Task 4: Font store + hook, wired into cockpit-root

**Files:**
- Create: `frontend/app/view/agents/fontstore.ts`
- Modify: `frontend/app/cockpit/cockpit-root.tsx`

- [ ] **Step 1: Create the store**

Create `frontend/app/view/agents/fontstore.ts`:
```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Font selection state, persisted to localStorage (the atomWithStorage convention from themestore.ts).
// Pure-frontend appearance -> no wconfig / no task generate. Applied by useApplyCockpitFonts, mounted
// alongside useApplyCockpitTheme in cockpit-root.

import { useAtomValue } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useLayoutEffect } from "react";

import { applyFontVars, DEFAULT_MONO, DEFAULT_SANS } from "./fonts";

export const fontSansAtom = atomWithStorage<string>("cockpit.font.sans", DEFAULT_SANS);
export const fontMonoAtom = atomWithStorage<string>("cockpit.font.mono", DEFAULT_MONO);

// Writes the active fonts' CSS vars to <html> before paint. atomWithStorage hydrates synchronously
// from localStorage, so a non-default font applies without a flash of the default.
export function useApplyCockpitFonts(): void {
    const sansId = useAtomValue(fontSansAtom);
    const monoId = useAtomValue(fontMonoAtom);
    useLayoutEffect(() => {
        applyFontVars(document.documentElement, sansId, monoId);
    }, [sansId, monoId]);
}
```

- [ ] **Step 2: Import the hook in cockpit-root**

In `frontend/app/cockpit/cockpit-root.tsx`, add after the `useApplyCockpitTheme` import (currently line 12):
```ts
import { useApplyCockpitFonts } from "@/app/view/agents/fontstore";
```

- [ ] **Step 3: Mount the hook**

In the same file, in `CockpitBody`, immediately after the existing `useApplyCockpitTheme();` (currently line 59):
```ts
    useApplyCockpitTheme();
    useApplyCockpitFonts();
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (baseline is clean; any error is yours).

- [ ] **Step 5: Stage**

```bash
git add frontend/app/view/agents/fontstore.ts frontend/app/cockpit/cockpit-root.tsx
```

---

### Task 5: Value coercers for scrollback + transparency (TDD)

**Files:**
- Modify: `frontend/app/view/agents/cockpitprefsstore.ts`
- Test: `frontend/app/view/agents/cockpitprefsstore.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/app/view/agents/cockpitprefsstore.test.ts` (and add the imports to the existing top import line so it reads `import { coerceFontSize, coerceScrollback, coerceTransparency, startupSurfaceOptions } from "./cockpitprefsstore";`):
```ts
describe("coerceScrollback", () => {
    it("parses a valid integer", () => expect(coerceScrollback("5000")).toBe(5000));
    it("clamps below zero", () => expect(coerceScrollback("-10")).toBe(0));
    it("clamps above the max", () => expect(coerceScrollback("999999")).toBe(100000));
    it("floors a decimal", () => expect(coerceScrollback("100.9")).toBe(100));
    it("rejects non-numeric", () => expect(coerceScrollback("abc")).toBeNull());
    it("rejects empty", () => expect(coerceScrollback("")).toBeNull());
});

describe("coerceTransparency", () => {
    it("passes a mid value", () => expect(coerceTransparency(0.5)).toBe(0.5));
    it("clamps above 1", () => expect(coerceTransparency(1.5)).toBe(1));
    it("clamps below 0", () => expect(coerceTransparency(-0.2)).toBe(0));
    it("coerces NaN to 0", () => expect(coerceTransparency(Number.NaN)).toBe(0));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/cockpitprefsstore.test.ts`
Expected: FAIL — `coerceScrollback` / `coerceTransparency` are not exported.

- [ ] **Step 3: Implement the coercers**

Append to `frontend/app/view/agents/cockpitprefsstore.ts`:
```ts
const SCROLLBACK_MIN = 0;
const SCROLLBACK_MAX = 100000;

// Parse a scrollback input to an integer within range, or null when unusable (so the caller can skip
// the config write instead of persisting garbage). Mirrors coerceFontSize.
export function coerceScrollback(raw: string): number | null {
    const n = Number(raw);
    if (raw.trim() === "" || Number.isNaN(n)) {
        return null;
    }
    return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.floor(n)));
}

// Clamp a transparency value to [0, 1]. Non-finite input coerces to 0 (fully opaque).
export function coerceTransparency(n: number): number {
    if (!Number.isFinite(n)) {
        return 0;
    }
    return Math.min(1, Math.max(0, n));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/cockpitprefsstore.test.ts`
Expected: PASS (existing + new cases all green).

- [ ] **Step 5: Stage**

```bash
git add frontend/app/view/agents/cockpitprefsstore.ts frontend/app/view/agents/cockpitprefsstore.test.ts
```

---

### Task 6: Shared settings-control widgets

Add reusable presentational components to `settingssurface.tsx`. No unit tests (presentational, no render harness) — verified by typecheck now and CDP in Task 9.

**Files:**
- Modify: `frontend/app/view/agents/settingssurface.tsx`

- [ ] **Step 1: Add imports**

Update the imports at the top of `frontend/app/view/agents/settingssurface.tsx`:
- Change the global-store import to also pull `atoms`:
```ts
import { atoms, getSettingsKeyAtom } from "@/app/store/global";
```
- Change the cockpitprefsstore import to add the new coercers:
```ts
import { coerceFontSize, coerceScrollback, coerceTransparency, startupSurfaceAtom, startupSurfaceOptions } from "./cockpitprefsstore";
```
- Add the font imports:
```ts
import { DEFAULT_TERM_FONT, MONO_FONTS, SANS_FONTS, stackOf } from "./fonts";
import { fontMonoAtom, fontSansAtom } from "./fontstore";
```

- [ ] **Step 2: Add the widget components**

Add these after the existing `Swatch` component:
```tsx
// mirror termutil.ts DefaultTermTheme (inlined to avoid pulling xterm into the settings bundle)
const DEFAULT_TERM_THEME = "default-dark";

// Labeled settings row: title + description left, control right. Rows stack inside a card; the first
// row drops its top border.
function Row({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-5 border-t border-edge-faint py-3.5 first:border-t-0">
            <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-semibold text-primary">{title}</div>
                <div className="text-[12px] text-muted">{desc}</div>
            </div>
            <div className="flex flex-none items-center">{children}</div>
        </div>
    );
}

// Segmented pill group. `font` renders that pill's label in its own typeface (live font preview).
function Segmented<T extends string>({
    options,
    value,
    onChange,
}: {
    options: { id: T; label: string; font?: string }[];
    value: T;
    onChange: (id: T) => void;
}) {
    return (
        <div className="flex overflow-hidden rounded-[9px] border border-edge-mid bg-surface-raised">
            {options.map((o, i) => (
                <button
                    key={o.id}
                    type="button"
                    onClick={() => onChange(o.id)}
                    style={o.font ? { fontFamily: o.font } : undefined}
                    className={cn(
                        "cursor-pointer whitespace-nowrap px-3 py-[7px] text-[12.5px] font-semibold transition-colors",
                        i > 0 && "border-l border-border",
                        value === o.id ? "bg-accentbg text-accent" : "text-secondary hover:text-primary"
                    )}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

// Styled native select.
function Select<T extends string>({
    options,
    value,
    onChange,
}: {
    options: { value: T; label: string }[];
    value: T;
    onChange: (v: T) => void;
}) {
    return (
        <select
            value={value}
            onChange={(e) => onChange(e.target.value as T)}
            className="cursor-pointer rounded-[9px] border border-edge-mid bg-surface-raised px-3 py-[7px] text-[12.5px] font-semibold text-secondary outline-none hover:border-edge-strong focus:border-accent-700"
        >
            {options.map((o) => (
                <option key={o.value} value={o.value}>
                    {o.label}
                </option>
            ))}
        </select>
    );
}

// +/- stepper. onStep receives -1 or 1; the caller applies its own step size.
function Stepper({ value, onStep, ariaLabel }: { value: number; onStep: (dir: -1 | 1) => void; ariaLabel: string }) {
    return (
        <div className="flex items-center overflow-hidden rounded-[9px] border border-edge-mid bg-surface-raised">
            <button
                type="button"
                aria-label={`Decrease ${ariaLabel}`}
                onClick={() => onStep(-1)}
                className="h-[34px] w-[34px] cursor-pointer border-r border-border text-[17px] font-semibold text-secondary hover:bg-surface-hover"
            >
                −
            </button>
            <div className="min-w-[56px] px-2 text-center font-mono text-[13px] text-primary">{value}</div>
            <button
                type="button"
                aria-label={`Increase ${ariaLabel}`}
                onClick={() => onStep(1)}
                className="h-[34px] w-[34px] cursor-pointer border-l border-border text-[17px] font-semibold text-secondary hover:bg-surface-hover"
            >
                +
            </button>
        </div>
    );
}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (Unused-for-now warnings are fine; these are consumed in Tasks 7–8. If the build flags unused vars as errors, proceed straight to Task 7/8 before typechecking — the components are used there.)

- [ ] **Step 4: Stage**

```bash
git add frontend/app/view/agents/settingssurface.tsx
```

---

### Task 7: Font block in `AppearanceSection`

**Files:**
- Modify: `frontend/app/view/agents/settingssurface.tsx`

- [ ] **Step 1: Add the `FontBlock` component**

Add this component (e.g. directly above `AppearanceSection`):
```tsx
function FontBlock() {
    const [sans, setSans] = useAtom(fontSansAtom);
    const [mono, setMono] = useAtom(fontMonoAtom);
    return (
        <div className="mt-[22px]">
            <div className="text-[14px] font-semibold text-primary">Fonts</div>
            <div className="mb-3.5 mt-0.5 text-[12.5px] text-muted">Interface and code typefaces. Applied instantly.</div>
            <div className="rounded-[14px] border border-border bg-surface px-[18px]">
                <Row title="Interface" desc="Cockpit UI text">
                    <Segmented
                        options={SANS_FONTS.map((f) => ({ id: f.id, label: f.label, font: f.stack }))}
                        value={sans}
                        onChange={setSans}
                    />
                </Row>
                <Row title="Code" desc="Monospace: snippets, chips, hex values">
                    <Segmented
                        options={MONO_FONTS.map((f) => ({ id: f.id, label: f.label, font: f.stack }))}
                        value={mono}
                        onChange={setMono}
                    />
                </Row>
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Render it in `AppearanceSection`**

In `AppearanceSection`, add `<FontBlock />` immediately after the closing `</div>` of the Theme block (`<div className="mb-[22px]"> … </div>`) and before the `Custom colors` card (`<div className="rounded-[14px] border border-border bg-surface p-[18px]">`):
```tsx
            </div>

            <FontBlock />

            <div className="rounded-[14px] border border-border bg-surface p-[18px]">
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Stage**

```bash
git add frontend/app/view/agents/settingssurface.tsx
```

---

### Task 8: Expand `TerminalSection`

Replace the existing font-size-only `TerminalSection` with the full terminal-preferences block. All controls set the global default via `SetConfigCommand`; per-terminal context-menu overrides still win.

**Files:**
- Modify: `frontend/app/view/agents/settingssurface.tsx`

- [ ] **Step 1: Replace `TerminalSection`**

Replace the entire existing `TerminalSection` function with:
```tsx
function TerminalSection() {
    const fontSize = (useAtomValue(getSettingsKeyAtom("term:fontsize")) as number) ?? 12;
    const scrollback = (useAtomValue(getSettingsKeyAtom("term:scrollback")) as number) ?? 1000;
    const cursorRaw = (useAtomValue(getSettingsKeyAtom("term:cursor")) as string) ?? "block";
    const cursorBlink = (useAtomValue(getSettingsKeyAtom("term:cursorblink")) as boolean) ?? false;
    const copyOnSelect = (useAtomValue(getSettingsKeyAtom("term:copyonselect")) as boolean) ?? false;
    const transparency = (useAtomValue(getSettingsKeyAtom("term:transparency")) as number) ?? 0.5;
    const termFontStack = (useAtomValue(getSettingsKeyAtom("term:fontfamily")) as string) ?? "";
    const themeName = (useAtomValue(getSettingsKeyAtom("term:theme")) as string) ?? DEFAULT_TERM_THEME;
    const fullConfig = useAtomValue(atoms.fullConfigAtom);

    // SetConfigCommand's data param is a typed settings map; a dynamic-key patch needs the cast.
    const write = (patch: Record<string, unknown>) =>
        void RpcApi.SetConfigCommand(TabRpcClient, patch as Parameters<typeof RpcApi.SetConfigCommand>[1]);

    // terminal font is stored as the full stack string; match it back to a catalog id for the control.
    const termFontId = MONO_FONTS.find((f) => f.stack === termFontStack)?.id ?? DEFAULT_TERM_FONT;
    const cursor = cursorRaw === "bar" || cursorRaw === "underline" ? cursorRaw : "block";

    const termthemes = fullConfig?.termthemes ?? {};
    const themeOptions = Object.keys(termthemes)
        .sort((a, b) => (termthemes[a]["display:order"] ?? 0) - (termthemes[b]["display:order"] ?? 0))
        .map((k) => ({ value: k, label: termthemes[k]["display:name"] ?? k }));

    const stepFontSize = (dir: -1 | 1) => {
        const next = coerceFontSize(String(fontSize + dir));
        if (next != null && next !== fontSize) write({ "term:fontsize": next });
    };
    const stepScrollback = (dir: -1 | 1) => {
        const next = coerceScrollback(String(scrollback + dir * 1000));
        if (next != null && next !== scrollback) write({ "term:scrollback": next });
    };

    return (
        <div>
            <SectionLabel>Terminal</SectionLabel>
            <div className="rounded-[14px] border border-border bg-surface px-[18px]">
                <Row title="Font family" desc="Default typeface for agent terminals">
                    <Select
                        options={MONO_FONTS.map((f) => ({ value: f.id, label: f.label }))}
                        value={termFontId}
                        onChange={(id) => write({ "term:fontfamily": stackOf(MONO_FONTS, id) })}
                    />
                </Row>
                <Row title="Font size" desc="Terminal font size (px)">
                    <Stepper value={fontSize} onStep={stepFontSize} ariaLabel="font size" />
                </Row>
                <Row title="Cursor style" desc="Shape of the terminal cursor">
                    <Segmented
                        options={[
                            { id: "block", label: "Block" },
                            { id: "bar", label: "Bar" },
                            { id: "underline", label: "Underline" },
                        ]}
                        value={cursor}
                        onChange={(v) => write({ "term:cursor": v })}
                    />
                </Row>
                <Row title="Cursor blink" desc="Blink the terminal cursor">
                    <Toggle on={cursorBlink} onToggle={() => write({ "term:cursorblink": !cursorBlink })} />
                </Row>
                <Row title="Scrollback" desc="Lines of history kept per terminal">
                    <Stepper value={scrollback} onStep={stepScrollback} ariaLabel="scrollback" />
                </Row>
                <Row title="Copy on select" desc="Copy highlighted text to the clipboard automatically">
                    <Toggle on={copyOnSelect} onToggle={() => write({ "term:copyonselect": !copyOnSelect })} />
                </Row>
                <Row title="Transparency" desc="Terminal background transparency">
                    <div className="flex items-center gap-3">
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={transparency}
                            onChange={(e) => write({ "term:transparency": coerceTransparency(Number(e.target.value)) })}
                            className="w-[120px] cursor-pointer accent-accent"
                        />
                        <span className="w-[38px] text-right font-mono text-[12px] text-muted">
                            {Math.round(transparency * 100)}%
                        </span>
                    </div>
                </Row>
                <Row title="Color scheme" desc="ANSI palette for terminals">
                    <Select options={themeOptions} value={themeName} onChange={(v) => write({ "term:theme": v })} />
                </Row>
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. If `termthemes[a]["display:order"]` errors on typing, confirm `atoms.fullConfigAtom`'s `termthemes` value type exposes `display:order`/`display:name` (it does via `TermThemeType`); no cast should be needed.

- [ ] **Step 3: Run the full frontend test suite (nothing regressed)**

Run: `npx vitest run`
Expected: all tests pass (the prior baseline count plus the new `fonts.test.ts` and coercer cases).

- [ ] **Step 4: Stage**

```bash
git add frontend/app/view/agents/settingssurface.tsx
```

---

### Task 9: End-to-end verification + commit

**Files:** none (verification), then the single feature commit.

- [ ] **Step 1: Typecheck + tests (final gate)**

Run:
```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
```
Expected: tsc exit 0; vitest all green.

- [ ] **Step 2: CDP visual — fonts actually change**

With the dev app running, open Settings → Appearance → Fonts. Switch Interface to **Inter**, then **System UI**; switch Code to **Fira Code**. After each, capture `node scripts/cdp-shot.mjs cdp-shots/font-<name>.png` and confirm the cockpit body text and monospace chips visibly change typeface. Also evaluate over CDP:
```js
getComputedStyle(document.documentElement).getPropertyValue('--font-sans')
```
Expected: reflects the selected stack (e.g. `"Inter", system-ui, sans-serif`). Reload the page and confirm the choice persists (localStorage).

- [ ] **Step 3: CDP visual — terminal controls take effect**

Open Settings → Terminal. Change Color scheme, Cursor style, Transparency; toggle Cursor blink. Open/focus an agent terminal and confirm each change is reflected (color scheme + transparency update live via the terminal's theme watcher; font family / cursor apply on the next terminal (re)mount — same behavior as the existing font-size control). Capture a screenshot for the record.

- [ ] **Step 4: Self-review the diff**

Run: `git status && git diff --cached --stat`
Confirm: only the intended files (no debug logs, no commented-out code, no stray files). Ensure the spec and this plan are staged so they fold into the feature commit:
```bash
git add docs/superpowers/specs/2026-07-03-settings-customization-batch-design.md docs/superpowers/plans/2026-07-03-settings-customization-batch.md
```

- [ ] **Step 5: Present the commit for approval (do NOT auto-commit)**

Per CLAUDE.md, show the file list with statuses + a one-line change summary each, and the proposed message, then ask: "Awaiting approval. Proceed? (yes/no)". Proposed message:
```
feat(cockpit): settings font pickers + terminal prefs + font-load fix

Fonts never loaded: they lived in repo-root public/fonts but Vite's
publicDir is frontend/tauri/public, so every url('fonts/…') 404'd and
the cockpit rendered in system fallbacks (dev + packaged). Relocate the
font assets into the publicDir, add a bundled Fira Code, then add:
- Appearance: Interface (--font-sans) + Code (--font-mono) pickers
  (localStorage, applied on <html> like the color theme engine).
- Terminal: font family, cursor style/blink, scrollback, copy-on-select,
  transparency, ANSI color scheme (existing backend config keys).
```

- [ ] **Step 6: Commit only after explicit approval**

```bash
git commit
```

---

## Self-Review

**1. Spec coverage:**
- Prerequisite font-load fix → Task 1. ✓
- Fira Code bundling → Task 2. ✓
- Interface + code font pickers (`--font-sans`/`--font-mono`, localStorage) → Tasks 3, 4, 7. ✓
- Terminal font (`term:fontfamily`) → Task 8 (Font family row). ✓
- Terminal cursor/blink/scrollback/copy-on-select/transparency/color-scheme → Task 8. ✓
- Coercers → Task 5. ✓
- Hook wiring → Task 4. ✓
- Testing (catalog + coercers unit; CDP visual) → Tasks 3, 5, 9. ✓
- Out-of-scope items (light mode, radius/density, reduce-motion) → correctly absent. ✓

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; every command has expected output. ✓

**3. Type consistency:** `FontDef`, `stackOf`, `applyFontVars`, `SANS_FONTS`/`MONO_FONTS`, `DEFAULT_SANS`/`DEFAULT_MONO`/`DEFAULT_TERM_FONT`, `fontSansAtom`/`fontMonoAtom`, `useApplyCockpitFonts`, `coerceScrollback`/`coerceTransparency`, and the widget props (`Row`/`Segmented`/`Select`/`Stepper`) are named identically across the tasks that define and consume them. Terminal-font round-trip (store stack → match id → write stack) is consistent between Task 8's read and write. ✓

**Notes / residual risks (verify during execution, not blockers):**
- `accent-accent` utility for the range input: if Tailwind doesn't generate it, the slider just won't be accent-tinted — swap to `style={{ accentColor: "var(--color-accent)" }}` (still token-based). Caught by Task 9 Step 3.
- Fira Code download URL: de-risked by the woff2 magic-byte check (Task 2 Step 2) and the npm fallback.
- `--default-font-family` / `--default-mono-font-family`: set defensively; harmless if unused. Task 9 Step 2 confirms the visible font actually changes.

---

## Design-alignment revision (post-plan)

After Tasks 1–8, the settings UI was reconciled against the canonical design `Wave-settings.dc.html` (Claude Design project `76055164-…`). The controls and behavior from the plan are unchanged; the **layout** of the font/terminal blocks was restructured to match the design. Deltas vs. the plan as originally written:

- **Fonts is now its own top-level section** (order: Appearance → **Fonts** → General), not a card inside `AppearanceSection`. Task 7's `FontBlock` was replaced by `FontsSection` — three flat rows with dividers (no card): **Interface font** (`--font-sans`), **Code font** (`--font-mono`), **Terminal font** (`term:fontfamily`). Segmented pills render in the UI font (per the design), not a per-pill preview.
- **Terminal section is flat rows (no card)** and drops the "Font family" row (that control moved into Fonts). The native `Select` widget was removed.
- **Color scheme** is now a custom dropdown (`TermThemeDropdown`) — a 3-swatch trigger + popover with per-theme swatches (derived from each backend term theme's `background`/`blue`/`green`) and a check on the active one — replacing the native select.
- **Transparency** label shows the raw value (`0.50`, `toFixed(2)`) and the range uses `style={{ accentColor: "var(--color-accent)" }}`; **Scrollback** steps by 250 with a 100 floor.
- **Fira Code** is kept as a third mono option (superset of the design's two) — it's already bundled/tested; low-risk to expose.
