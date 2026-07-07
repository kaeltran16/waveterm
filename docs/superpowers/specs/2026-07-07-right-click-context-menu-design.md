# Themed right-click context menu

Date: 2026-07-07
Status: Design approved, plan pending

## Problem

The app has one context-menu primitive: `ContextMenuModel.getInstance().showContextMenu(items, ev)`
(`frontend/app/store/contextmenu.ts`), which builds a **native OS menu** through Tauri's
`Menu.popup()` (`frontend/tauri/menu.ts`). Native menus are rendered by WebView2/the OS and
**cannot be themed** — they ignore the cockpit `@theme` tokens, fonts, and accent colors, so every
right-click surfaces a gray Windows system menu inside an otherwise dark, custom UI.

Right-click is also wired in only a few places (`agentheader`, `term`, `preview`, `sysinfo`,
`processviewer`). The core cockpit surfaces — the agents list, the card grid, the transcript — have
almost no right-click affordances.

Goal: replace the native menu with a single themed React menu, and roll right-click out to the
cockpit surfaces that lack it.

## Findings that shaped the design

- `@floating-ui/react` already ships (used by `popover.tsx`, `flyoutmenu.tsx`). It supports
  anchoring to a **virtual element at a cursor `(x,y)`** — exactly what a right-click menu needs.
  No new dependency (no Radix/shadcn).
- `FlyoutMenu` exists but is **click-anchored to a child**, SCSS-styled, and submenu-heavy.
  Retrofitting it to open at a cursor point fights its shape and the no-SCSS rule. A fresh, small
  component is cleaner.
- **No production call site sets `role`** — only `menu.test.ts` does. The terminal already does
  copy/paste in JS (`term-model.ts:739-746`, `825`: `terminal.getSelection()` +
  `navigator.clipboard.writeText`). So replacing the native menu loses nothing real.
- The required feature set (from the terminal's existing menu, `term-model.ts:921-1263`) is:
  labels, separators, **checkboxes**, **nested submenus**, `enabled`/`visible`, and `sublabel`
  (right-aligned hint). These are non-negotiable for parity.

## Approach

Chosen: **A new themed `ContextMenu` component on `@floating-ui/react`, driven by a jotai atom,
with `ContextMenuModel` repointed at it.** Because the imperative `showContextMenu(items, ev)` API
is unchanged, every existing call site becomes themed with zero call-site edits; new surfaces just
define an items array. `frontend/tauri/menu.ts` is deleted.

Rejected alternatives:
- **Hybrid (themed for new surfaces, native for term/preview)** — leaves un-themeable native menus
  and two systems to maintain; term/preview were explicitly in scope for re-theming.
- **Radix `@radix-ui/react-context-menu`** — new dependency, a second positioning system alongside
  floating-ui, and its declarative `<Trigger>` model fights the app-wide imperative API.

## Architecture

Three pieces, mirroring the existing `modalsModel` + `ModalsRenderer` host pattern
(`cockpit-root.tsx:76`):

1. **`frontend/app/element/contextmenu.tsx`** — presentational menu.
   - `@floating-ui/react` anchored to a **virtual reference** whose `getBoundingClientRect` returns
     a zero-size rect at `(x,y)`; `placement: "bottom-start"`, `flip` + `shift` middleware to stay
     on-screen, `FloatingPortal` to escape card/overflow clipping, `useDismiss` for outside-click +
     Esc.
   - Renders item kinds `normal | separator | checkbox | submenu | header`, honors
     `enabled`/`visible`, right-aligns `sublabel`.
   - Submenus open on hover via nested floating-ui (`placement: "right-start"`), themselves
     portaled and flip/shift-corrected.
2. **`contextmenuStore`** — a jotai atom holding `{ items, x, y } | null`.
   `ContextMenuModel.showContextMenu(items, ev)` sets it from `ev.clientX/clientY` instead of
   calling `buildTauriMenu`; dismiss clears it to `null`.
3. **`<ContextMenuHost/>`** — mounted once in `cockpit-root` beside `<ModalsRenderer/>`. Subscribes
   to the atom and renders `<ContextMenu>` when non-null.

## Styling

Tailwind `@theme` tokens only, no SCSS: `bg-surface-raised`, `border-edge-mid`,
`text-primary/secondary/muted`, accent hover, `rounded`, subtle shadow, `font-mono` to match the
cockpit. Add a `--color-*` token in `tailwindsetup.css` only if a needed color is genuinely missing.

## Rollout — per-surface item lists

All actions below are wired today; the menu only calls existing handlers.

- **Agents-list rows** (`agentrow.tsx`): Focus · Open terminal · Review diff *(if diff present)* ·
  Mute/Dismiss · — · Close. Reuses `onCursor`, `onOpenTerminal`, `onOpenDiff`, `muteAction`,
  `onClose`.
- **Cockpit cards**: Focus · Open terminal · Fullscreen / Full-width · — · Close. Wires to the
  rail/fullscreen atoms and `confirmCloseAgent`.
- **Transcript / timeline**: Copy text · Open terminal · Expand / collapse burst. Copy via
  `navigator.clipboard.writeText`.
- **Terminal / preview**: no call-site change — they already pass item arrays and now render
  themed, including their submenus and checkboxes.

The list is a starting point; more items can be added per surface later.

## Migration / deletions

- Repoint `ContextMenuModel.showContextMenu` to the atom; drop the `buildTauriMenu` import.
- Delete `frontend/tauri/menu.ts` and `frontend/tauri/menu.test.ts` (native path is dead).
- Keep the `ContextMenuItem` type in `custom.d.ts`.
- `role`: keep a small JS-clipboard fallback (`copy`/`paste`/`cut`/`selectall`) so the field is not
  silently dead, rather than removing it.

## Keyboard

Mouse-first for v1: hover-highlight, click-activate, hover-open submenus, Esc / outside-click
dismiss (floating-ui `useDismiss`). The component tracks an internal `activeIndex` so arrow / Enter
/ type-ahead navigation can be layered on later without a rewrite. Deferred, not designed out.

## Testing

- **vitest** (`contextmenu.test.ts`, replacing `menu.test.ts`): `visible:false` items skipped;
  separator / checkbox / submenu / header render correctly; disabled items do not fire `click`;
  dismiss clears the atom; viewport-edge flip with mocked rects.
- **Visual**: no jsdom render harness for the cockpit — verify the themed look via CDP screenshot
  of the live dev app (project convention, `scripts/cdp-shot.mjs`).

## Out of scope

- Full keyboard navigation (arrow/Enter/type-ahead) — deferred, seam left in place.
- Icons per menu item (no `icon` field today).
- Right-click on surfaces beyond the four listed above.
