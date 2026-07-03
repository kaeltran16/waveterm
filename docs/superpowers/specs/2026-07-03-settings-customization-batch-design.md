# Settings customization batch — fonts + terminal preferences

**Date:** 2026-07-03
**Status:** Design (approved for planning)
**Supersedes/relates:** builds on `2026-07-03-cockpit-settings-appearance-theming-design.md` (the color theme picker this reuses)

## Goal

Extend the Settings tab (`settingssurface.tsx`) so users can customize, in one batch:

1. **Fonts** — the interface typeface, the code/monospace typeface, and the terminal typeface.
2. **Terminal preferences** — the terminal knobs the backend already honors but that have no UI: cursor style, cursor blink, scrollback, copy-on-select, background transparency, and ANSI color scheme (alongside the font-size control that already exists).

Explicitly **out of scope** (decided during brainstorming): light mode (Paper theme), corner-radius/UI-density controls, and a reduce-motion toggle. See "Rejected / deferred" below for why.

## Prerequisite: the bundled fonts don't currently load (fold-in fix)

Discovered during planning (CDP against the live dev app, 2026-07-03): **none of the bundled fonts actually load.** `fontutil.ts` registers FontFaces via `url('fonts/…woff2')`, but the font files live in repo-root `public/fonts/` while Vite's `root` is `frontend/tauri/`, making the real publicDir `frontend/tauri/public/` (which has no `fonts/`). Every font request 404s → all 9 FontFaces report `status:"error"` → the cockpit silently renders in system fallbacks (Segoe UI / Consolas). Confirmed broken in the packaged build too (`frontend/tauri/dist/` has no `fonts/` dir).

A font picker is a no-op until this is fixed, so the fix is folded in as the **first task**: relocate the font assets from `public/fonts/` → `frontend/tauri/public/fonts/`. No code change to `fontutil.ts`'s `url('fonts/…')` references — the same paths simply resolve once the files are in the served publicDir. This also fixes Hanken/Inter/JetBrains/Hack for everyone, independent of the picker. See [[vite-publicdir-location]].

## Why this is cheap

The cockpit already has all the machinery:

- **Color theming** (`themestore.ts` + `themes.ts`) writes `--color-*` custom properties onto `document.documentElement`; because the app renders through Tailwind v4 `var(--color-*)` utilities, overriding the variables re-skins everything with no component edits. **Font family is the same trick on two more variables** (`--font-sans`, `--font-mono`).
- **The candidate fonts are self-hosted** — `frontend/util/fontutil.ts` registers Hanken Grotesk, Inter, JetBrains Mono, and Hack via `FontFace` from local `fonts/*.woff2|ttf` at boot (`loadFonts()` in `frontend/tauri/main.tsx`). No network, so a font picker stays offline-safe. "System UI" loads nothing. (They must first be relocated to the served publicDir — see Prerequisite. Fira Code is added as one more self-hosted woff2.)
- **Every terminal knob already exists as a config key** (`schema/settings.json`, `frontend/types/gotypes.d.ts`) and the terminal already reads them. Exposing them is pure settings-form work with `SetConfigCommand` — **no backend changes, no `task generate`**.

## Non-goals / boundaries

- No new Go, no new wshrpc command, no schema/codegen changes.
- The font pickers do **not** attempt to load arbitrary system fonts or fetch web fonts. The lists are curated to the already-bundled fonts plus a "System" option. This matches the self-hosted/offline convention and keeps the CSP surface unchanged.
- Terminal controls set the **global default**. Per-terminal overrides set from the terminal context menu (block meta) still take precedence, because terminals resolve via `getOverrideConfigAtom(blockId, key)` (block meta → connection → global settings). This mirrors the existing `term:fontsize` control exactly.

## Design

### A. Fonts

Three controls, two persistence layers.

| Control | Sink | Options | Default |
|---|---|---|---|
| Interface font | `--font-sans` (CSS var on `<html>`, localStorage) | Hanken Grotesk, Inter, System UI | Hanken Grotesk |
| Code font | `--font-mono` (CSS var on `<html>`, localStorage) | JetBrains Mono, Hack, Fira Code | JetBrains Mono |
| Terminal font | `term:fontfamily` (backend config) | Hack, JetBrains Mono, Fira Code | Hack |

Fira Code (a bundled coding font with ligatures) is added per user request. It is a new self-hosted variable woff2 (see Prerequisite/Files). Ligatures render in the CSS-var contexts (UI/code); the terminal renders Fira Code as a plain monospace (xterm ligatures need `@xterm/addon-ligatures`, out of scope).

**Font catalog** — a small const list per axis, each entry `{ id, label, stack }` where `stack` is the full CSS font stack written to the variable (keeps a fallback chain, e.g. Inter → `"Inter", system-ui, sans-serif`; System UI → `system-ui, sans-serif`; JetBrains Mono → `"JetBrains Mono", monospace`; Fira Code → `"Fira Code", monospace`). Code font and terminal font share one `MONO_FONTS` catalog (same three entries); only the default id differs (code → `jetbrains`, terminal → `hack`, matching `term.tsx`'s current fallback).

**Application (interface + code fonts)** — new `frontend/app/view/agents/fontstore.ts`, mirroring `themestore.ts`:

```
export const fontSansAtom = atomWithStorage<string>("cockpit.font.sans", "hanken");
export const fontMonoAtom = atomWithStorage<string>("cockpit.font.mono", "jetbrains");

export function useApplyCockpitFonts(): void {
    const sansId = useAtomValue(fontSansAtom);
    const monoId = useAtomValue(fontMonoAtom);
    useLayoutEffect(() => {
        applyFontVars(document.documentElement, sansId, monoId);
    }, [sansId, monoId]);
}
```

`applyFontVars(root, sansId, monoId)` looks up the stacks from the catalog and sets `--font-sans` / `--font-mono` on the root's inline style (highest specificity, beats the `@theme` `:root` rule). Kept small + injectable so it is unit-testable without a DOM.

Registered once in `frontend/app/cockpit/cockpit-root.tsx` (`CockpitBody`, `cockpit-root.tsx:59`) right next to the existing `useApplyCockpitTheme()`. `atomWithStorage` hydrates synchronously, so a non-default font applies before paint (no flash), same as the theme.

> **Cascade detail to verify during implementation (not a design risk):** Tailwind v4 applies the base body font via `--default-font-family`, which defaults to `var(--font-sans)`. Overriding `--font-sans` on `<html>` should recompute it because custom-property references are live; if CDP shows the body font not following, `applyFontVars` also sets `--default-font-family` (and the mono equivalent). The `font-mono` utility reads `var(--font-mono)` directly, so code text follows unconditionally.

**Terminal font** — no CSS var; it is `term:fontfamily`, read at `term.tsx:303` (`termSettings?.["term:fontfamily"] ?? connFontFamily ?? "Hack"`). Set the global default via `SetConfigCommand({ "term:fontfamily": stack })`, exactly like the font-size stepper. The `TermWrap` re-inits when `termSettings` changes (`term.tsx:345` dep array), so the change applies on the next terminal (re)mount — identical behavior to the existing font-size control.

### B. Terminal preferences

`TerminalSection` grows from the single font-size row into a terminal-preferences block. All rows read the current global default and write via `SetConfigCommand`.

| Control | Key | Type / values | Default | Read atom |
|---|---|---|---|---|
| Font family | `term:fontfamily` | select: Hack / JetBrains Mono | `Hack` | `getSettingsKeyAtom` |
| Font size *(exists)* | `term:fontsize` | stepper (px) | `12` | `getSettingsKeyAtom` |
| Cursor style | `term:cursor` | segmented: Block / Bar / Underline | `block` (via `normalizeCursorStyle`) | `getSettingsKeyAtom` |
| Cursor blink | `term:cursorblink` | toggle | `false` | `getSettingsKeyAtom` |
| Scrollback | `term:scrollback` | number stepper (lines) | `1000` (xterm default when unset) | `getSettingsKeyAtom` |
| Copy on select | `term:copyonselect` | toggle | `false` | `getSettingsKeyAtom` |
| Transparency | `term:transparency` | slider 0–1 (higher = more transparent; `0` = opaque) | `0.5` | `getSettingsKeyAtom` |
| Color scheme | `term:theme` | select from `fullConfig.termthemes` | `default-dark` ("Default Dark") | `atoms.fullConfigAtom` |

**Color scheme options** come from `fullConfig.termthemes` (7 bundled: Default Dark, One Dark Pro, Dracula, Monokai, Campbell, Warm Yellow, Rose Pine), keyed by theme name with `display:name` / `display:order`. Enumerate sorted by `display:order` — the exact source and sort the existing terminal context menu uses (`term-model.ts:875` `getSettingsMenuItems`). No new data source.

**Value coercion** — small pure helpers (mirroring the existing `coerceFontSize` in `cockpitprefsstore.ts`):
- `coerceScrollback(str)` → clamp to a sane integer range (e.g. `[0, 100000]`), `null` on invalid.
- `coerceTransparency(n)` → clamp to `[0, 1]`.
These are unit-testable and keep the UI handlers thin.

### C. UI widgets

Reuse what `settingssurface.tsx` already has; add the minimum:

- **Segmented control** (cursor style, and the font pill rows) — the pattern already used for startup-surface and runtime selectors. Font pills render each label **in its own typeface** for a live preview.
- **Toggle** — already defined (`Toggle`), used for cursor blink + copy-on-select.
- **Stepper** — already used for font size; reused for scrollback.
- **Select** — a small styled `<select>` (or styled dropdown) for terminal font family and color scheme. New, minimal.
- **Slider** — a styled `<input type="range">` for transparency. New, minimal.

Layout: the "Font" block goes into `AppearanceSection` (interface + code font); terminal font + all terminal knobs live in the expanded `TerminalSection`.

## Data flow

```
Interface/code font:  pill click → set fontSansAtom/fontMonoAtom (localStorage)
                       → useApplyCockpitFonts useLayoutEffect → --font-sans/--font-mono on <html>
                       → Tailwind var() utilities re-font the cockpit

Terminal knobs:        control change → coerce (if numeric) → SetConfigCommand({ key: value })
                       → fullConfig/termSettings update → terminal reads new default
                       (applies live where the terminal watches it, else on next remount)
```

## Persistence rationale

- **Interface + code fonts → localStorage** (`atomWithStorage`). Pure cockpit appearance, matching the themestore precedent ("no wconfig / no `task generate`"). These vars are cockpit-only.
- **All terminal keys → backend config** (`SetConfigCommand`). They already live in settings config; terminals (and other non-cockpit consumers) read them from there; the terminal font-size control already writes this way.

## Testing

- **`fonts.test.ts`** (mirrors `themes.test.ts`): catalog integrity (ids unique, default id present in each list) + `applyFontVars` writes the correct stack for a given id onto an injected element.
- **Coercer tests**: `coerceScrollback` / `coerceTransparency` clamp + reject invalid input.
- Terminal-config writes are thin pass-throughs; no unit test beyond the coercers.
- **Visual verification via CDP** (`scripts/cdp-shot.mjs`) on the live dev app: font swap re-fonts UI + code text; terminal cursor/blink/theme/transparency changes take effect. No jsdom render harness exists for the cockpit.

## Files touched

| File | Change |
|---|---|
| `public/fonts/*` → `frontend/tauri/public/fonts/*` | **move** — relocate the 4 existing font families into the served publicDir (Prerequisite fix). |
| `frontend/tauri/public/fonts/fira-code-variable.woff2` | **new asset** — bundled Fira Code variable woff2. |
| `frontend/util/fontutil.ts` | **modify** — add `loadFiraCodeFont()` (variable, weight `300 700`) + call it from `loadFonts()`. |
| `frontend/app/view/agents/fontstore.ts` | **new** — `fontSansAtom`, `fontMonoAtom`, `useApplyCockpitFonts()`. |
| `frontend/app/view/agents/fonts.ts` | **new** — font catalog (`{id,label,stack}[]` per axis) + `applyFontVars`. (May be folded into `fontstore.ts` if it stays tiny.) |
| `frontend/app/view/agents/fonts.test.ts` | **new** — catalog + `applyFontVars` tests. |
| `frontend/app/view/agents/cockpitprefsstore.ts` | **modify** — add `coerceScrollback`, `coerceTransparency` (co-located with `coerceFontSize`). |
| `frontend/app/view/agents/settingssurface.tsx` | **modify** — Font block in `AppearanceSection`; expand `TerminalSection`. |
| `frontend/app/cockpit/cockpit-root.tsx` | **modify** — call `useApplyCockpitFonts()` in `CockpitBody`. |

## Rejected / deferred

- **Light mode (Paper theme)** — the engine already supports it (`paper` in `themes.ts`, filtered out of `PICKER_THEMES`), but `themes.ts` flags that neutral greys/identity colors were tuned for dark only; enabling it needs a visual QA pass. Not in this batch.
- **Corner radius / UI text scale / density** — looks like a one-line var swap but is not: the cockpit hardcodes ~395 `rounded-[Npx]` and pervasive `text-[Npx]` literals instead of the `--radius*` / `--text-default` tokens, so overriding those variables is a near no-op. Making these real requires migrating the literals to token utilities first — a refactor, not a batch add-on.
- **Reduce-motion toggle** — the animation system is mid-revamp (stripped to a Reorder + pulseDot baseline pending an app-wide pass); a motion setting has nothing stable to gate yet.

## Implementation notes

Non-trivial (new store + hook + catalog, two expanded settings sections) → proceed spec → plan → implement. Terminal controls set global defaults; block-level context-menu overrides remain authoritative per `getOverrideConfigAtom` resolution order.
