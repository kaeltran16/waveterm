# Cockpit Settings — Appearance & Theming redesign

**Date:** 2026-07-03
**Source design:** `Wave-settings.dc.html` (claude.ai/design project `wave`, `76055164-…`)
**Status:** Design — awaiting user review

## 1. Context

A Settings surface already ships (`frontend/app/view/agents/settingssurface.tsx`, commit `3b5c596b`) with four
sections: **General** (startup surface, details-rail toggle), **New Agent Defaults** (remember-flags, per-CLI flag
checkboxes), **Terminal** (font size), **Memory** (vault path). It is routed via the nav rail (pinned bottom,
`navrail.tsx`) and rendered by `cockpitshell.tsx` when `surfaceAtom === "settings"`.

`Wave-settings.dc.html` redesigns that page and adds a new **Appearance** section: a 7-preset theme picker plus a
"Custom colors" card that overrides the accent + three status roles, recomputing tints/gradients live.

**Current theming reality** (verified): the cockpit is single-theme. All colors live in `frontend/tailwindsetup.css`
`@theme` as ~60 `--color-*` tokens; components consume them almost entirely through Tailwind v4 generated utilities
(`bg-surface-raised`, `text-secondary`, `border-edge-mid`) plus a few inline `var(--color-*)` reads and one
`getComputedStyle(document.documentElement)` read in `memgraph.tsx`. There is **no** runtime theme mechanism today
(no `data-theme`, no `setProperty`). Crucially, the design's **Midnight** preset is byte-for-byte the current palette
(`bg #0c0e11`, `surface #0e1116`, `accent #7c95ff`, `success #54c79a`, `warning #e6b450`, `error #e0726c`, …), so this
work is "Midnight = today's look, + alternates," not "replace the palette."

## 2. Goals / Non-goals

**Goals**
- Add an **Appearance** section: theme-preset picker + custom accent/status overrides, matching the mockup.
- A **runtime theming engine** that re-skins the whole cockpit by overriding `--color-*` on `document.documentElement`.
- **Full faithful port** of the existing four sections to the mockup's visual language (segmented startup control,
  ±font stepper, restyled toggles/cards), keeping their existing state wiring.

**Non-goals (this iteration)**
- Rebuilding the nav rail (`navrail.tsx`) — it already exists; the mockup rail is context only.
- The mockup's `density` (comfortable/compact) preview prop — a canvas knob, not a user setting. Fixed at comfortable.
- Backend/`wconfig` changes for theme (theme is pure-frontend appearance → localStorage, matching existing
  cockpit-native prefs). No `task generate`.
- **Faithful light mode (Paper).** See §6 — deferred; engine stays light-capable.

## 3. Decisions

Two scope questions were asked; no response (user away). Proceeding on the **recommended** path, flagged for override
at the review gate:
- **Port scope:** full faithful port of all sections (not Appearance-only). Matches the mockup's cohesive redesign and
  prior pixel-port commits.
- **Custom colors:** included in v1 (accent + 3 status overrides, live recompute, reset).

## 4. Theming engine

### 4.1 Token strategy — override existing `--color-*`, don't adopt `--wv-*`

The mockup uses its own `--wv-*` namespace and computes every var at runtime. We do **not** adopt `--wv-*` (that would
touch dozens of component files). Instead the mockup is a **source of color values and derivation math**: we express
the 7 palettes and the derivation in the cockpit's own `--color-*` vocabulary and override those tokens at runtime.
Because the entire cockpit already resolves `var(--color-*)`, overriding them re-skins everything with zero component
edits.

**Themed tokens** (recomputed per theme) — the "chrome":
- Surfaces: `background, surface, surface-raised, surface-hover, surface-selected, surface-code, panel, modalbg, lane, lane-asking`
- Text: `foreground, white, primary, secondary, muted-foreground, ink-hi, ink-mid, muted, ink-faint`
- Borders: `border, edge-mid, edge-strong, edge-faint`
- Accent: `accent, accenthover, accent-soft, accentbg, accent-50…900`
- Status: `error, warning, asking, success, working, success-soft, ask-question, ask-label, on-warning`
- Greys derived from the palette so light mode is possible later: `cacheread, feed-label, feed-summary, feed-time, feed-glyph`

**Fixed tokens** (theme-agnostic identity/brand; left at `@theme` defaults, never overridden):
- `avatar-1…6` (channel identity), `mem-project/reference/feedback/user` (legend), `rt-claude/codex/terminal*`
  (runtime brand), all `--ansi-*` (terminal), `hover/hoverbg/highlightbg` (neutral white-alpha overlays).

### 4.2 New files

`frontend/app/view/agents/themes.ts`
- `ThemePalette` — the base roles ported from the mockup (`bg, panel, code, s1, s2, s3, bd, bdSubtle, bd2, bdh,
  tp, ts, tm, tf, td, ac, gr, am, rd`; the mockup's `elevated/s1h/tb/tff` are dropped — no cockpit token needs them,
  headings map to `primary`).
- `THEMES: ThemeDef[]` — the 7 palettes verbatim from the mockup (`id, name, palette`).
- Color math ported from the mockup: `mix, lighten, darken, rgba, luminance, onColor`.
- `buildThemeVars(palette, overrides): Record<string,string>` — returns `{ "--color-…": value }` for every themed
  token. Direct maps (`background←bg`, `surface←panel`, `surface-raised←s1`, `surface-hover←s2`,
  `surface-selected←s3`, `surface-code←code`, `border←bd`, `edge-faint←bdSubtle`, `edge-mid←bd2`, `edge-strong←bdh`,
  `primary/foreground/white←tp`, `secondary←ts`, `muted←tf`, `ink-faint←td`, `accent←ac`, `success/working←gr`,
  `warning/asking←am`, `error←rd`). Derived: accent ramp + `accenthover/accent-soft/accentbg`, status softs/tints
  (`success-soft, ask-question, ask-label, on-warning`), translucent `panel = rgba(s1,.6)`, `modalbg = s1`,
  lane fills, and the grey ramp. Derivation constants are tuned so **Midnight reproduces the current `@theme`
  values** (guarded by test, §7).

`frontend/app/view/agents/themestore.ts`
- `themePresetAtom = atomWithStorage<string>("cockpit.theme.preset", "midnight")`
- `themeOverridesAtom = atomWithStorage<Record<string,string>>("cockpit.theme.overrides", {})` — keyed by base role
  (`ac/gr/am/rd`), matching the mockup's override model. Selecting a preset clears overrides.

### 4.3 Applying the theme

A `useApplyCockpitTheme()` hook, called once from `CockpitRoot`/`CockpitBody` (`cockpit-root.tsx`):
- reads both atoms, computes `buildThemeVars(activePalette, overrides)`, and writes each var via
  `document.documentElement.style.setProperty(name, value)` in a `useLayoutEffect` (pre-paint; `atomWithStorage`
  hydrates from localStorage synchronously, so a non-default theme applies without a flash of Midnight).
- We always write the **full** themed set (Midnight included), so switching presets needs no stale-key cleanup.
- Applied to `document.documentElement` (not `.cockpit-shell`) so inline `var()` reads and `memgraph.tsx`'s
  `getComputedStyle(document.documentElement)` both resolve. (memgraph snapshots at mount — a theme switch while the
  graph is open won't live-recolor it; acceptable, pre-existing limitation.)

### 4.4 Why not the alternatives
- **Adopt `--wv-*` wholesale** — rejected: rewrites ~all component color usages; massive churn, no benefit.
- **CSS bridge (`--color-x: var(--wv-x)` in `@theme`)** — rejected: adds an indirection layer and still needs the
  same derivation; overriding `--color-*` directly is simpler and keeps `@theme` as the readable default.

## 5. Settings surface — full port

Rebuild `settingssurface.tsx` to the mockup's layout (`max-width:720px`, section labels in uppercase JetBrains-Mono,
mockup spacing). Section **state wiring is reused as-is**; only markup/styles change, plus the new Appearance section.

- **Appearance** (new): theme label + live `themeName` (`Custom · based on <preset>` when overridden); 4-col preset
  grid (each button: 2×2 dot swatch from `bg/panel/ac/gr` + name, accent border/bg when active) → `themePresetAtom`;
  "Custom colors" card with accent row (10 preset swatches + `<input type=color>` custom hex) and 3 status rows
  (Working / Asking / Blocked, hex label + color input) → `themeOverridesAtom`; "Reset to preset" (visible when
  overridden) clears overrides.
- **General**: startup surface as a **segmented bar** (equal columns) → `startupSurfaceAtom` + `startupSurfaceOptions()`;
  details-rail **toggle** → `railVisibleAtom`. Toggle resized to the mockup's 42×23.
- **New Agent Defaults**: remember-flags toggle → `naRememberFlagsAtom`; CLI selector (Claude Code/Codex/Antigravity)
  → local `runtime` state; flag checkbox card (checkbox + mono flag + right-aligned desc) → `naFlagsAtom` over
  `RUNTIME_FLAGS`.
- **Terminal**: font size as a **−/＋ stepper** (±1, clamped via existing `coerceFontSize`, 6–48) →
  `SetConfigCommand("term:fontsize")`.
- **Memory**: vault path input + Save (green "Saved ✓" on success) → `SetConfigCommand("memory:vaultpath")`, keeping
  the existing dirty/saved logic.

No routing changes: `"settings"` already resolves through `navrail.tsx` + `cockpitshell.tsx`.

## 6. Light mode / Paper — deferred (recommended)

Paper is a **light** palette (`bg #f4f5f7`). Even with every chrome token themed, the cockpit still has dark-assumed
inline `rgba(255,255,255,α)` overlays (hover states, `.agent-md` dividers/code fills), hardcoded scrollbar hexes
(`tailwindsetup.css`), and `cockpit.scss` fallbacks that would render broken on a light background. Doing Paper right
is a **cockpit-wide hardcoded-color audit**, out of scope for a settings feature and risky to bundle in.

**Recommendation:** ship the **6 dark presets** (Midnight, Slate, Carbon, Nocturne, One Dark, Monokai) in v1; keep the
Paper palette in `THEMES` (engine is structurally light-capable) but omit it from the picker, with a `docs/deferred.md`
entry for the light-mode overlay audit. **Open for user override at review** — if you want Paper in v1, it becomes a
larger, separate audit task.

## 7. Testing (vitest, behavior-level)

`themes.test.ts`:
- **Midnight == current**: `buildThemeVars(midnight, {})` yields the exact current `@theme` values for the directly
  mapped, high-traffic tokens (`background, surface, surface-raised, surface-hover, surface-selected, surface-code,
  border, accent, success, warning, error, primary, muted`). This is the no-visual-regression guard.
- **Color math**: `lighten/darken/mix/rgba` on known inputs.
- **Overrides**: `buildThemeVars(midnight, { ac:"#66d9ef" })` sets `--color-accent:#66d9ef` and derived
  `accenthover/accent-soft/accentbg` track it; empty overrides ⇒ preset values.
- **Preset switch clears overrides** (store-level helper, if extracted).

## 8. Change list

| File | Change |
|---|---|
| `frontend/app/view/agents/themes.ts` | **new** — palettes, color math, `buildThemeVars` |
| `frontend/app/view/agents/themestore.ts` | **new** — `themePresetAtom`, `themeOverridesAtom` |
| `frontend/app/view/agents/themes.test.ts` | **new** — Midnight-parity + math + overrides |
| `frontend/app/view/agents/settingssurface.tsx` | rewrite to mockup layout + Appearance section, reuse existing wiring |
| `frontend/app/cockpit/cockpit-root.tsx` | mount `useApplyCockpitTheme()` |

No Go, no `wconfig`, no `task generate`, no `tailwindsetup.css` token changes (defaults unchanged; runtime overrides only).

## 9. Open questions (review gate)

1. **Paper / light mode** — ship 6 dark presets and defer Paper (recommended §6), or commit to the full light-mode
   audit in v1?
2. **Port scope & custom colors** — confirm the recommended full-port + overrides-in-v1 (asked, unanswered).

## 10. Next step

Non-trivial → after user approves this spec, invoke **writing-plans** for the ordered implementation plan. Per the
user's git policy, this spec is **not** committed separately; it folds into the feature commit.
