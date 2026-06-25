# Cockpit Foundation: Theme & Design System

Date: 2026-06-25
Status: approved-design / combined spec + implementation
Scope: trivial-collapsed (spec and plan in one doc — few tightly-coupled theme files, no new components/interfaces/data flow)

## Goal

Re-theme the application to the Claude Design handoff visual identity (see `wave-handoff/wave/project/Wave-cockpit-live.dc.html`). This is the **foundation slice** of the handoff rebuild: establish the design-system tokens, typography, and motion that every later surface slice (Cockpit, Agent, Activity, Channels, Sessions, Files, Memory) consumes. No surface UI is built here — only the shared foundation.

## Decision: global re-theme (remap values, keep names)

The cockpit is the sole rendered frontend (Phase 5b stripped ~22k lines / 144 files). The handoff palette maps almost 1:1 onto token *names* that already exist in `frontend/tailwindsetup.css` `@theme` and `frontend/app/theme.scss` `:root`. Therefore:

- **Remap the values** of the existing identity tokens to the handoff palette. Every remaining consumer (15–19 files per core token) adopts the new look with zero per-file edits.
- **Add new tokens** only for the handoff's finer ramp (surface levels, ink-faint, edge variants, status aliases, radius scale, popover shadow).
- **Do not** introduce a parallel namespace, and **do not** rewrite token names. Single source of truth stays in `@theme`; `theme.scss` legacy vars are remapped to the same values for the components that still read them.

Rejected: a parallel `--cp-*` namespace (strangler-fig). It would require migrating every consumer file by hand for no benefit, since the whole app is moving to the new theme anyway.

## Token vocabulary

Authoritative source: `frontend/tailwindsetup.css` `@theme`. `theme.scss` `:root` legacy vars are remapped to the same hex so SCSS consumers match.

### Surfaces (bg ramp)

| Token | Value | Role | Status |
|---|---|---|---|
| `--color-background` | `#0c0e11` | app background | remap |
| `--color-surface` | `#0e1116` | chrome: titlebar, nav rail | new |
| `--color-surface-raised` | `#13171d` | popovers, inputs, cards | new |
| `--color-surface-hover` | `#171c22` | hover fills on chrome | new |
| `--color-panel` | `rgba(19,23,29,0.6)` | translucent panel (was green-tinted) | remap |
| `--color-modalbg` | `#13171d` | modal/popover bg | remap |

Neutral white-overlay tokens (`--color-hover`, `--color-hoverbg`, `--color-highlightbg`) are **preserved** — they're theme-agnostic and used by legacy components; new chrome uses `--color-surface-hover` instead.

The green `accent-50…900` ramp (consumed by `quicktips.tsx`, `secretscontent.tsx`) is **remapped to periwinkle**, anchored on the handoff values `#aebfff`/`#8da3ff`/`#7c95ff`/`#5f74e0` with the remaining stops interpolated.

### Text (ink ramp)

| Token | Value | Role | Status |
|---|---|---|---|
| `--color-foreground` / `--color-white` / `--color-primary` | `#e6e9ed` | primary text | remap |
| `--color-secondary` | `#cfd5db` | secondary text (`text-secondary`, 19 files) | remap |
| `--color-muted-foreground` | `#c3cad1` | muted-but-readable | remap |
| `--color-muted` | `#6b7178` | muted text (`text-muted`, 17 files) | remap |
| `--color-ink-faint` | `#3a424c` | faint dividers/glyphs | new |

### Borders (edge)

| Token | Value | Role | Status |
|---|---|---|---|
| `--color-border` | `#1c2128` | default divider (`border-border`, 16 files) | remap |
| `--color-edge-mid` | `#20262e` | input/control edge | new |
| `--color-edge-strong` | `#2a313a` | popover edge | new |

### Accent + status

| Token | Value | Role | Status |
|---|---|---|---|
| `--color-accent` | `#7c95ff` | primary action (green → periwinkle) | remap |
| `--color-accenthover` | `#8da3ff` | accent hover | remap |
| `--color-accent-soft` | `#aebfff` | accent text on dark | new |
| `--color-accentbg` | `rgba(124,149,255,0.1)` | accent fill (nav active) | remap |
| `--color-warning` | `#e6b450` | agent **asking** (amber) | remap |
| `--color-asking` | `#e6b450` | semantic alias for asking | new |
| `--color-success` | `#54c79a` | agent **working** (green) | remap |
| `--color-working` | `#54c79a` | semantic alias for working | new |
| `--color-error` | `#f0625a` | danger / error | remap |

### Type, radius, shadow

| Token | Value | Status |
|---|---|---|
| `--font-sans` | `"Hanken Grotesk", system-ui, sans-serif` | remap (was Inter) |
| `--font-mono` | `"JetBrains Mono", monospace` | remap (was Hack) |
| `--radius` | `8px` | keep |
| `--radius-sm` | `6px` | new |
| `--radius-lg` | `12px` | new |
| `--shadow-popover` | `0 20px 56px rgba(0,0,0,0.55)` | new |

`theme.scss` mirrors: `--main-bg-color`→`#0c0e11`, `--main-text-color`→`#e6e9ed`, `--secondary-text-color`→`#cfd5db`, `--grey-text-color`→`#6b7178`, `--border-color`→`#1c2128`, `--accent-color`→`#7c95ff`, `--panel-bg-color`→`rgba(19,23,29,0.6)`, `--error-color`→`#f0625a`, `--warning-color`→`#e6b450`, `--success-color`→`#54c79a`, `--link-color`→`#7c95ff`, `--modal-bg-color`→`#13171d`, `--base-font`/`--header-font` family→Hanken Grotesk, `--fixed-font` family→JetBrains Mono. Structural tokens (z-index, `--term-*`, form/button/keybinding, `--tab-green`, conn/sysinfo feature colors) are left untouched.

## Typography

Fonts load via the JS `FontFace` API in `frontend/util/fontutil.ts` (not CSS `@font-face`). JetBrains Mono is already bundled (`public/fonts/jetbrains-mono-v13-latin-{200,400,700}.woff2`) and loaded — `--font-mono` just points at it.

Hanken Grotesk is **not** bundled. It is a **variable font** on Google Fonts (one woff2 covers the full weight axis), so bundle it like `inter-variable.woff2`:

1. Bundle `public/fonts/hanken-grotesk-variable.woff2` (latin subset, sourced from Google Fonts at implementation time). The app self-hosts all fonts (Inter/JetBrains Mono/Hack already bundled) and loads them via `FontFace` — follow that pattern; do not add a CDN dependency.
2. Add `loadHankenGroteskFont()` to `fontutil.ts` mirroring `loadInterFont()` (single `FontFace`, `weight: "100 900"`, `style: normal`), and call it from `loadFonts()`.

Hack (terminal font) is untouched — xterm theming is separate.

## Motion + globals

Add to the global layer of `frontend/tailwindsetup.css` (outside `@theme`):

- The 7 handoff keyframes: `pulseDot`, `ringAmber`, `ringGreen`, `flow`, `caret`, `fadeUp`, `slideUp` (verbatim from the prototype `<style>` block).
- Scrollbar styling matching the handoff: 10px, thumb `#262c34` (hover `#343c46`), transparent track, `border-radius: 6px`, `border: 2px solid transparent; background-clip: padding-box`.

## Scope boundaries

**In:** palette + typography + motion/keyframes + scrollbar + radius/shadow tokens, across `tailwindsetup.css` and `theme.scss`.

**Out (deliberate):**
- Primitive components (Button, StatusDot, Popover, Pill, etc.) — validated against a real surface; belong to the first *surface* slice.
- `theme.scss` structural tokens: z-index scale, ANSI/`--term-*` colors, xterm theming, form/modal/button-color tokens not part of the visual identity. Green-named structural tokens (`--term-green`, `--button-green-*`, `--tab-green`) are left as-is.

## Interim state

After this slice, the embedded `AgentsViewModel` body renders in the new palette/fonts but on its *current* layout. Expected and accepted — it gets rebuilt in the Cockpit-surface slice.

## Files touched

- `frontend/tailwindsetup.css` — `@theme` value remaps + new tokens; keyframes + scrollbar in global layer.
- `frontend/app/theme.scss` — `:root` identity-token value remaps.
- `frontend/util/fontutil.ts` — register Hanken Grotesk; call from `loadFonts()`.
- `public/fonts/hanken-grotesk-variable.woff2` — new font asset (variable, latin subset).

## Implementation (ordered)

1. **Bundle Hanken Grotesk.** Download latin-subset woff2 for weights 400/500/600/700 into `public/fonts/` with the naming above.
2. **Register the font.** Add `loadHankenGroteskFont()` to `fontutil.ts` and call it in `loadFonts()`.
3. **Remap `@theme`** in `tailwindsetup.css`: update existing color/font/radius token values per the table; add the new tokens (`--color-surface*`, `--color-ink-faint`, `--color-edge-*`, `--color-accent-soft`, `--color-asking`, `--color-working`, `--radius-sm/-lg`, `--shadow-popover`).
4. **Add globals** to `tailwindsetup.css`: the 7 keyframes + handoff scrollbar rules.
5. **Remap `theme.scss`** `:root` identity tokens (mirror list above); leave structural tokens untouched.
6. **Verify** (see below).

## Verification

- `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — expect only the 3 pre-existing `api.test.ts` errors (baseline), no new errors.
- `npx vitest run` — green.
- `npm run dev` (Tauri) + CDP on :9222 — confirm: app bg is `#0c0e11`, accent renders periwinkle `#7c95ff`, UI font is Hanken Grotesk, mono/labels are JetBrains Mono, scrollbars match. The agents body should show the new palette on its old layout (expected).

## Success criteria

- All identity tokens carry handoff values; the app reads as the handoff palette/typography without per-component edits.
- Hanken Grotesk loads and is the active UI font; JetBrains Mono is the active mono font.
- No new tsc/vitest failures vs baseline.
- No parallel token namespace introduced; `@theme` remains the single source of truth.
