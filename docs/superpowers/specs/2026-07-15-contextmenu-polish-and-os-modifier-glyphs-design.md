# Context-menu visual polish + centralized OS-modifier glyphs

Date: 2026-07-15

## Summary

Two related pieces of work, driven by a "make the right-click menu look better" request:

1. **Context-menu visual polish** — rework the shared `contextmenu.tsx` renderer: leading lucide icons per action, real `Check`/`ChevronRight` glyphs (replacing literal `x`/`>`), an inset rounded highlight, "Comfortable" spacing, and a right-aligned keycap shortcut column. Populate leading icons across every context-menu call site. Behavior, items, ordering, and keyboard nav are untouched — this is visual only.

2. **Centralized OS-modifier glyphs** — today at least five surfaces render keyboard-modifier glyphs with five different hardcoded conventions (`⌘P`, `⌃P`, `Ctrl`, `⌘ Cmd`, `⌘↵`), none reliably platform-aware. On Windows the `⌘` glyph is simply wrong. Introduce a single source of truth that maps a modifier to its platform glyph (`^` on Windows/Linux, `⌘` on macOS; `⇧`, `⌥`, `⏎`, arrows) plus a shared keycap component, and migrate every live render site onto it.

## Goals

- The context menu reads as a polished, modern menu (icons, real glyphs, floating highlight) while keeping the cockpit's monospace aesthetic.
- Exactly one place in the codebase decides "what glyph represents this modifier on this OS." Every shortcut display flows through it.
- On Windows, no shortcut hint ever shows the macOS Command glyph.

## Non-goals / out of scope

- Changing which keys trigger which actions, or the key-event dispatch in `keyutil.ts`/keybindings. This is display-only.
- Changing menu items, ordering, roles, or keyboard navigation.
- `quicktips.tsx` — dead code (0 imports, Electron-era). Not migrated; noted as a removal candidate for a separate cleanup.
- Composer send-labels (`"Run ⏎"`, `"Send ⏎"`, `"Steer ⏎"`) — inline button text, already consistent; migrating them is optional and deferred unless trivial.

## Current state (fragmentation)

| Site | Imports | Renders modifiers as | Platform-aware? |
|---|---|---|---|
| `cockpit/app-bar.tsx` | live | `⌘P` (hardcoded span) | no |
| `view/agents/cockpitemptystate.tsx` | live | `⌘N`, `⌘P` | no |
| `view/agents/newagentmodal.tsx` | live | `⌘↵` | no |
| `cockpit/footerhints.ts` | live | `⌃P`, `⌃N`, `⇧Esc` (glyph strings) | no |
| `view/agents/cockpithelp.tsx` | live | `⌃P`, `⌃N`, `⏎` | no |
| `cockpit/shortcuts-cheatsheet.tsx` | live | raw text chips `Ctrl` `Shift` `Tab` | no |
| `cockpit/hints-footer.tsx` | live | `Chip` with `glyph` string | no |
| `cockpit/command-palette.tsx` | live | `⏎` (Enter) | n/a |
| `element/quicktips.tsx` | **dead** | `⌘ Cmd` / `^ Ctrl` / `⇧ Shift` | partial |

Cockpit bindings (`store/keybindings/bindings.ts`) declare the primary accelerator as `Ctrl:` (e.g. `Ctrl:p`, `Ctrl:n`, `Ctrl:Shift:Tab`), plus leader chords (`g p`) and named keys (`Shift:?`, `Shift:Escape`, `Escape`).

## Convention decision (flagged for review)

The cockpit's `Ctrl:`-notation bindings are treated as the **primary accelerator** (the "Cmd-or-Ctrl" key). The central formatter renders that primary modifier as:

- **`^`** on Windows/Linux (matches reality — `Ctrl:p` fires on Ctrl+P on Windows, and the caret matches the existing cockpit hint style).
- **`⌘`** on macOS (per the explicit request "command icon on Mac", and the conventional cross-platform mapping).

Consequence: on macOS a genuinely-literal Control binding would also display `⌘`. Given the app is currently **Windows-only** (packaging is Windows-only per `CLAUDE.md`), no live binding depends on distinguishing literal-Control from primary-accelerator on Mac. If that changes, the formatter can gain a distinct `LiteralCtrl` token. **This assumption is the main thing to confirm at spec review.**

Other modifiers: `Shift` → `⇧`; `Alt`/`Option` → `⌥` (Mac) / `Alt` (Win/Linux); `Meta` (Windows key) → `⊞` (rare; likely unused). Common non-modifier keys handled by the same map for consistency: `Enter`/`Return` → `⏎`; `Escape` → `esc`; arrows → `← → ↑ ↓`; `Space` → `Space`; `Tab` → `Tab`. Single letters upper-cased.

## Design

Five isolated units. Units 1–2 are the foundation; 3 is the headline UI; 4–5 are the fan-out that consumes the foundation.

### Unit 1 — `keysym` central module (`frontend/util/keysym.ts`, new)

Pure functions, no React. Single source of truth for glyphs. Reads platform from `platformutil` (`isMacOS()` / `PLATFORM`) — the same handle already set at boot.

```
// token = one segment of a chord in binding notation: "Ctrl" | "Cmd" | "Shift" | "Alt" | "Option" | "Meta" | "Enter" | "Escape" | "ArrowLeft" | "p" | ...
modSymbol(token: string): string        // "Ctrl"/"Cmd" -> "^" (win) / "⌘" (mac); "Shift" -> "⇧"; "p" -> "P"
formatChord(keys: string): string[]     // "Ctrl:Shift:Tab" -> ["^","⇧","Tab"]; "g p" -> ["g","p"]
formatChordString(keys: string): string // joined, e.g. "^⇧Tab" — for terse inline hints
```

Both `Cmd` and `Ctrl` tokens map to the **same** primary-accelerator glyph (`^`/`⌘`) — the app has two notations for the same key (legacy `Cmd:` in `keyutil`, modern `Ctrl:` in cockpit bindings) and both should display identically. Collapsing them is intentional (see the convention decision above).

`formatChord` reuses the split rule already in `shortcuts-cheatsheet.keyChips` (split on `" "` for leader chords, else on `":"`). The glyph table is a small record keyed by token, with the platform-varying entries (`Ctrl`/`Cmd`, `Alt`/`Option`) branched on `isMacOS()`.

Fully unit-testable by toggling `setPlatform()` (mac vs win) and asserting output — mirrors the existing `term-model.test.ts` pattern that mocks `platformutil`.

### Unit 2 — `<KeyCap>` shared element (`frontend/app/element/keycap.tsx`, new)

The one keycap chip. Consolidates the three near-identical inline chip styles (`hints-footer.Chip`, `shortcuts-cheatsheet` chip, `app-bar` span). Built on Unit 1.

```
<KeyCap chord="Ctrl:p" />           // renders chips: [^][P]  (splits + maps via formatChord)
<KeyCap chord="Ctrl:p" variant="inline" />   // terse single chip "^P" for dense footers
```

Styling matches the current house chip: `rounded-[5px] border border-edge-mid px-[6px] py-0.5 font-mono text-[10.5px]`, color by variant. Existing per-site sizing differences become `variant`/`className` props so no surface regresses visually.

### Unit 3 — context-menu renderer (`frontend/app/element/contextmenu.tsx`)

Data-model additions (`frontend/types/custom.d.ts`, `ContextMenuItem`):
- `icon?: React.ReactNode` — leading icon for the row (a lucide element from the call site).
- `accel?: string` — chord in binding notation (e.g. `"Cmd:t"`); rendered right-aligned via `<KeyCap>`.

Renderer changes:
- **Leading column.** Reserve a fixed-width (18px) leading slot **only when the menu has at least one item with an `icon`, checkbox, or radio** (`items.some(...)`), so plain menus stay flush. In that slot: the item's `icon` for normal rows; a lucide `Check` for a checked checkbox; a filled accent dot for radio-on; empty otherwise. Icon color muted, `accent-soft` when the row is highlighted, `error` when `danger`.
- **Glyphs.** Replace literal `x` marker with lucide `Check`; replace literal `>` submenu marker with lucide `ChevronRight`.
- **Highlight.** Panel gains a small padding gutter (`p-1`); rows get `rounded-md`; highlight tint (`bg-accent/13`) floats inside instead of bleeding to the border corners.
- **Comfortable spacing.** Rows `~py-1.5 px-2.5`, `gap` ~11px, 15px icons; separators inset (`mx-2`) to align with rows; header top-gap tightened.
- **Shortcut column.** When `accel` is set, render `<KeyCap chord={accel} variant="inline"/>` pushed right with `ml-auto`, muted. (No current item declares `accel`; this is ready-capability. The submenu chevron and an `accel` are mutually exclusive per row.)

Kept exactly: monospace font, accent highlight hue, `danger` red, disabled dimming, header style, and every keyboard-nav path (`MenuPath`, arrow/Enter/Esc/Left-Right, roving highlight).

### Unit 4 — icon population (every context-menu call site)

Add a semantically-appropriate lucide `icon` to each item in the menus built by: `term-model.ts`, `term.tsx`, `agentrow.tsx`, `agentheader.tsx`, `agenttree.tsx`, `channelrail.tsx`, `channelsprimitives.tsx`, `filessurface.tsx`, `memorysurface.tsx`, `narrationtimeline.tsx`. Icons chosen to match action verbs (e.g. copy→`Copy`, open-terminal→`Terminal`, reveal→`FolderOpen`, rename→`Pencil`, close→`X`, delete→`Trash2`). Radio/checkbox groups keep the state marker (no per-item icon). Where a menu is purely toggles with no actions, the leading column stays state-only.

### Unit 5 — migrate render sites onto Unit 1/2

Replace hardcoded glyphs with `<KeyCap>` / `formatChord`:
- `app-bar.tsx` `⌘P` → `<KeyCap chord="Ctrl:p" variant="inline"/>`.
- `cockpitemptystate.tsx` `⌘N`/`⌘P` → `<KeyCap>`.
- `newagentmodal.tsx` `⌘↵` → `<KeyCap chord="Cmd:Enter"/>`.
- `footerhints.ts` — glyph strings become chord strings; the footer chip renders via `formatChord`/`<KeyCap>`.
- `cockpithelp.tsx` — same.
- `shortcuts-cheatsheet.tsx` — `keyChips` delegates to `formatChord`; chips render via `<KeyCap>`.
- `hints-footer.tsx` — `Chip` reuses `<KeyCap>` (or `formatChord` for its glyph).
- `command-palette.tsx` — `⏎` via `modSymbol("Enter")` (cosmetic; Enter is platform-invariant).

**Migration accuracy:** for each site, set the chord to the binding that *actually* fires the action (cross-check `store/keybindings/bindings.ts` or the component's own handler) — do not blindly reuse the old hardcoded glyph's implied key. Since `Cmd` and `Ctrl` tokens display identically, the display is correct either way on Windows; the point is to keep the chord string truthful for the future Mac render and for maintainers.

## Testing

- **Unit 1** (`keysym.test.ts`, new): mac vs win platform → correct glyphs for `Ctrl`/`Cmd`/`Shift`/`Alt`; `formatChord` for `"Ctrl:Shift:Tab"`, leader `"g p"`, single keys, `Enter`/`Escape`/arrows.
- **Unit 3**: extend `contextmenu.test.ts` — leading-column reservation logic (`hasLeading`), that `accel`/submenu are mutually exclusive, and that existing keyboard-nav tests stay green.
- Full `vitest` + `tsc` (`node --stack-size=4000 …`) clean.

## Verification (CDP)

Reuse the dev-app CDP inject flow (already used to capture the baseline): inject the representative menu (all item types + a sample `accel`) into the live app and screenshot before/after. Spot-check one migrated surface (app-bar search chip) shows `^P` on this Windows dev build. See `[[cdp-verify-dev-app]]`.

## Risks

- **Convention assumption** (Ctrl→`⌘` on Mac) — see the flagged decision above; low risk while Windows-only.
- **Visual regression on migrated surfaces** — mitigated by `variant`/`className` props preserving each site's current sizing; verify the footer and cheatsheet still look right.
- **Icon-choice churn** — Unit 4 is subjective; pick conservative, verb-matching icons; the renderer degrades gracefully if an item has no icon.
