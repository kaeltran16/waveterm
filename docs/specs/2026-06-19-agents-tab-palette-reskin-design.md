# Agents Surface — Palette Re-skin to Wave Theme Tokens

**Date:** 2026-06-19
**Status:** Design approved (brainstorm complete); implementation plan pending
**Base:** Visual-polish pass over the existing Agents feature (`frontend/app/view/agents/` + the session sidebar `frontend/app/tab/sessionsidebar/`). **Layout, density, spacing, type sizes, interactions, and all animations are unchanged.** This cut only rebinds color from a bespoke hardcoded palette to Wave's native `@theme` design tokens.

## UI reference (visual companion mockup)

- **`assets/2026-06-19-agents-tab-palette-reskin/01-target-reskin.html`** — the target: sidebar + Agents tab on Wave's tokens, with the token map. Layout matches today's shipped view; only color changes.
- **`assets/2026-06-19-agents-tab-palette-reskin/02-surface-scope.html`** — why the sidebar is in scope: tab-only vs tab+sidebar, showing the color seam when only the tab is re-skinned.

## 1. What this is

A pure **palette re-skin**. The Agents tab and the session sidebar currently render in a bespoke, hardcoded GitHub-dark palette (cool blue-black canvas `#0b0e14`, borders `#1c2230`/`#20242b`, green `#3fb950`, amber `#d29922`, red `#f85149`, blue `#429dff`/`#58a6ff`/`#1f6feb`). None of it is theme-driven. The rest of Wave Terminal runs on the `@theme` tokens in `frontend/tailwindsetup.css` (warm-grey background `rgb(34,34,34)`, primary text `#f7f7f7`, accent green `rgb(88,193,66)`, `--color-warning`, `--color-error`, `--color-border`, …). The Agents surface visibly reads as a different app. This cut rebinds every agent-surface color to those tokens so it belongs to Wave and follows the user's theme.

## 2. Problem

For a "make it feel refined" pass, the largest single win is consistency of identity, not spacing or type. Concretely:

1. **Off-theme palette.** Dozens of hardcoded hex values across the agents view and sidebar, divorced from `@theme`. The surface doesn't match the app and won't respond to theme changes.
2. **Two surfaces, two palettes for the same agents.** The sidebar and the tab show the same agents side by side, but with a different green, a different amber, and a different canvas — a visible seam (see `02-surface-scope.html`).

## 3. Scope / non-goals

**In scope**
- Rebind all color on the Agents tab (`agents.tsx`, `askcard.tsx`, `outputpanel.tsx`, `narrationtimeline.tsx`) to Wave `@theme` tokens.
- Rebind the sidebar's **agent status/accent colors** to the same tokens (`sessionrow.tsx`, `sessionviewmodel.ts`, `sessionsidebar.tsx`) so working/asking/fail read identically across both surfaces.

**Non-goals (explicitly unchanged)**
- **Layout, density, spacing, type sizes** — the focus/queue asks region, the working grid, the panel structure, all paddings and font sizes stay exactly as shipped. (Density alternatives were considered and rejected during the brainstorm.)
- **All motion** — every `motion`/`AnimatePresence` block stays as tuned in the motion cut (`docs/specs/2026-06-19-agents-tab-answering-layout-motion-design.md`). Motion polish is a separate follow-up if anything reads off once the new colors land.
- **Any pure logic** in `agentsviewmodel.ts` / `sessionviewmodel.ts` (only the color constant *values* change).
- **No new RPC, Go types, `task generate`, or config.**
- A broader sidebar restructure. The sidebar's **translucent dark-glass container background** (`rgba(0,0,0,0.55)` + backdrop blur) stays as-is — it's an intentional overlay, not a flat themed panel. Its **borders, muted text, and status/accent colors** migrate to tokens. (So the sidebar canvas stays a dark overlay while the tab canvas is `background`; this is fine — the sidebar floats over content, the tab fills it.)
- Theme-token additions — we map onto existing `@theme` tokens; we don't add new ones.

## 4. Approach — token binding

Two mechanisms, both sourcing the single `@theme` block in `tailwindsetup.css`. No new constants file, no semantic-color abstraction layer (the theme vars are the source of truth; a wrapper would duplicate it).

- **Static colors → Tailwind theme utility classes.** Tailwind v4 generates utilities from each `@theme` `--color-*` var. These already exist and are already used in the codebase (e.g. `sessionrow.tsx` uses `text-secondary`, `text-primary`). Opacity modifiers carry over.
  - `bg-[#0b0e14]` → `bg-background`
  - `text-[#e6edf3]` / `#f0f6fc` → `text-primary`
  - `text-[#6b7585]` / `#7d8896` / `#8b949e` → `text-secondary` or `text-muted`
  - `border-[#1c2230]` / `#20242b` → `border-border`
  - amber `#d29922` → `*-warning`; green `#3fb950` → `*-accent`; red `#f85149` → `*-error`
  - `bg-[#d29922]/[0.05]` → `bg-warning/5`, `border-[#d29922]/60` → `border-warning/60`, etc.

- **JS / inline-style colors → CSS vars.** Colors set through `style={{}}` or JS constants can't be utility classes, so they reference the same theme vars directly:
  - `STATUS_COLOR`, `SUBAGENT_MARKER_COLOR` (`sessionrow.tsx`), `COLOR_WORKING` / `COLOR_WAITING` (`sessionviewmodel.ts`) → `var(--color-accent)` / `var(--color-warning)` / `var(--color-muted)` / `var(--color-error)`.
  - The existing CSS `transition-[background-color] duration-300` on the status dot still tweens between two resolved color values.

## 5. Semantic color map

| Meaning | Today (hardcoded) | → Wave token |
|---|---|---|
| Canvas / panels | `#0b0e14` | `background` |
| Borders / dividers | `#1c2230`, `#20242b` | `border` |
| Primary / accented text | `#e6edf3`, `#f0f6fc` | `primary` |
| Muted / meta text | `#6b7585`, `#7d8896`, `#8b949e`, `#adbac7` | `secondary` / `muted` |
| Working · live · `✓` | `#3fb950` | `accent` |
| Asking / blocked | `#d29922` | `warning` |
| Fail · `✗` · error | `#f85149` | `error` |
| Idle | `#7d8590` | `muted` |
| Selected / Submit pill | `#238636` + white text | `bg-accent/80 text-primary hover:bg-accent` (Wave's documented accent-button idiom) |
| Active-row / selection / "new" pill | `#429dff`, `#58a6ff`, `#1f6feb` | `accent` (see §6.1) |

## 6. Judgment calls (approved)

1. **No blue token exists in Wave; map blue → `accent`.** The sidebar active-row accent (`#429dff`), the answer-selection blue (`#58a6ff`), and the "↓ N new" pill (`#1f6feb`) all map to `accent` — Wave uses green as its selection/action color. Consequence: a row that is both active and working shows a green border + green dot, which reads correctly as "active + working." (Alternative considered and rejected: a neutral `--color-highlightbg` for active rows to keep selection visually distinct from status.)
2. **One green, not two.** Working-dot green and action-`✓` green collapse onto the single `accent` token rather than splitting `accent` + `success` (Wave defines both). Keeps the surface to one "positive" green.

## 7. Files

**Tab** (`frontend/app/view/agents/`)
- `agents.tsx` — header, counts, empty state, queue rows, focus/working wrappers.
- `askcard.tsx` — amber card chrome, option/submit pills, recommended-border, sent state.
- `outputpanel.tsx` — panel chrome, status dot (working/quiet), liveness `⟳`, "new output" pill.
- `narrationtimeline.tsx` — message accent border, action strip, `✓`/`✗` outcome colors.

**Sidebar** (`frontend/app/tab/sessionsidebar/`)
- `sessionrow.tsx` — `STATUS_COLOR`, `SUBAGENT_MARKER_COLOR`, active/blocked row accents (`#429dff`/`#d29922`), drop-indicator blue, idle text hex.
- `sessionviewmodel.ts` — `COLOR_WORKING` / `COLOR_WAITING` constant values.
- `sessionsidebar.tsx` — header dot/badge `#d29922` → `warning`, container **border** `#20242b` → `border` (the `rgba(0,0,0,0.55)` glass background is left as-is per §3), hover/text hex → tokens.

## 8. Testing / verification

- **Unit tests unaffected**, with one expected exception: `sessionviewmodel.test.ts` asserts the literal `#3fb950` / `#d29922` round-trip in `badgeToStatus`. If those constants change to `var(...)` strings, that mapping logic and its test must be updated together (the badge-color → status classification must still work for whatever the new source values are). Confirm `badgeToStatus`'s input contract during implementation — it may receive resolved colors rather than the constants.
- **Pure logic untouched** in `agentsviewmodel.ts` (sorting, grouping, ask-answer building) — its tests stay green.
- **Visual confirmation in the running dev app** via the CDP flow (`memory/cdp-verify-dev-app.md`): sidebar + tab across asking / working / idle / quiet / fail / active states, confirming colors resolve to theme tokens and the two surfaces match. Because motion and layout are untouched, this is a pure visual diff.

## 9. Open follow-ons
- Motion-quality pass (deferred by choice).
- If the all-green active+status reading proves ambiguous in practice, revisit §6.1 (neutral active highlight).
- `badgeToStatus` may want to classify on a semantic field rather than a color literal once colors are theme-driven (small refactor; out of scope here).
