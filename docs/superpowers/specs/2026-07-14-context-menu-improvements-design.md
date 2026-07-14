# Context-menu improvements — design

Date: 2026-07-14

## Motivation

The app has nine right-click menus, all rendered through one themed component
(`ContextMenuModel` → `frontend/app/element/contextmenu.tsx`). Auditing them
surfaced three consistency/quality gaps, none of which add features:

1. **Mouse-only.** The menu has no keyboard navigation (only hover + click;
   Esc/click-outside dismiss works). That is out of step with an app whose
   thesis is keyboard-driven triage.
2. **Inconsistent label voice.** The agent-cockpit surfaces use Sentence case
   ("Copy name"); the inherited terminal menu uses Title Case ("Magnify Block",
   "Font Size"); channels mix.
3. **Weak destructive affordance.** `Close agent`, `Delete channel`, and
   `Delete` (memory note) render identically to `Open`. Worse, `Close agent`
   confirms via the shared `ConfirmModal`, but `Delete channel`
   (`deleteChannel(id)`) and `Delete note` (`deleteNote(path)`) fire
   immediately — irreversible, no confirmation.

Scope is limited to these three axes. No new menu actions.

## The nine menus (inventory)

| # | Surface | Site |
|---|---------|------|
| 1 | Agent card | `agentrow.tsx:273` |
| 2 | Agent header | `agentheader.tsx:63` |
| 3 | Agent tree row | `agenttree.tsx:55` |
| 4 | Transcript entry | `narrationtimeline.tsx:449` |
| 5 | Channel row | `channelrail.tsx:108` |
| 6 | Worker row | `channelsprimitives.tsx:132` |
| 7 | File row | `filessurface.tsx:437` |
| 8 | Memory note | `memorysurface.tsx:160` |
| 9 | Terminal view | `term-model.ts:811` (`getContextMenuItems`) |

## 1. Shared component — keyboard navigation

`frontend/app/element/contextmenu.tsx` owns a roving highlight instead of the
current mouse-only rows. Submenu open-state moves out of `SubmenuRow`'s local
`useState` and into a highlight path owned by `ContextMenu`, so keyboard and
mouse drive the same state.

- **Up / Down** — move highlight, skipping separators/headers/disabled, wrapping
  at both ends.
- **Enter**, or **Right** on a leaf — activate the highlighted item.
- **Right** on a submenu row — open it and highlight its first actionable item.
- **Left** — close the current submenu and return to its parent row; at the top
  level, close the whole menu.
- **Esc** — close the whole menu (already wired via `useDismiss`).
- On open, highlight the first actionable item so the keyboard is live
  immediately.
- Mouse hover moves the highlight, keeping both input modes in sync.

No type-ahead (YAGNI).

### Isolation

The navigation logic is a pure reducer over `(items, currentPath, key)` →
`newPath | activate(index) | close`. It takes the item list and current
highlight path and returns the next path (or an activate/close signal). Keeping
it pure means it is unit-testable without a DOM render (the project has no
cockpit render harness). The `ContextMenu` component is the only consumer;
it holds the path state and dispatches keydown into the reducer.

## 2. Type change

One additive field on `ContextMenuItem` (`frontend/types/custom.d.ts`):

```ts
danger?: boolean;   // destructive action — renderer styles it red
```

Orthogonal to `type`; a danger item is still a normal clickable row. The
renderer styles `danger` items with `text-error` and a red-tinted hover.

## 3. Cohesion sweep — Sentence case everywhere

Rewrite every label across all nine menus to Sentence case, terminal included:

- Terminal examples: `Magnify Block` → `Magnify block`,
  `Save Session As…` → `Save session as…`, `Font Size` → `Font size`,
  `Force Restart Controller` → `Force restart controller`,
  `Allow Bracketed Paste Mode` → `Allow bracketed paste mode`,
  `Debug Connection` → `Debug connection`, `Run On Startup` → `Run on startup`,
  `Clear Output On Restart` → `Clear output on restart`,
  `Session Durability` → `Session durability`, etc.
- Proper nouns are left alone (theme display names, "URL").
- **Ordering convention**, made uniform where it is not already:
  primary actions → separator → copy/clipboard → separator → destructive (last).

## 4. Destructive-action treatment

- **Styling:** mark `Close agent` (menus 1–3), `Delete channel` (5), and
  `Delete` (8) with `danger: true`. `Archive channel` and worker `Dismiss` are
  reversible and are **not** marked.
- **Separators:** ensure a separator precedes each danger item. Menus 1–3
  already have one; menu 5 (channel) and menu 8 (memory) get one.
- **Confirm consistency:** route `Delete channel` and `Delete note` through the
  existing shared `ConfirmModal` (the pattern `confirmCloseAgent` already uses:
  `modalsModel.pushModal("ConfirmModal", { title, message, onConfirm })`). Both
  are currently one-click and irreversible; there is no undo, so a confirm is
  the safer default and matches the `Close agent` precedent.
  - New helper alongside `confirmCloseAgent` (in `agentactions.ts` or a local
    equivalent) is not required; the two call sites can push the modal directly,
    matching how `confirmCloseAgent` reads. Keep it DRY only if a second caller
    appears.

## 5. Radio semantics for the terminal groups

The terminal's Theme / Font size / Cursor / Transparency groups are mutually
exclusive but render a checkbox `x`. The `ContextMenuItem` type already declares
`"radio"`. Switch those groups to `type: "radio"` and render a `•` dot in the
renderer's marker slot (checkbox keeps its `x`). Correctness + cohesion win, low
risk, no data-model change.

## 6. Testing

- **Unit:** the navigation reducer (§1) and the item-ordering/visibility helpers
  get tests in the existing `frontend/app/store/contextmenu.test.ts` (or a new
  sibling test for the renderer-level reducer). Cover: skip separators/disabled,
  wrap at ends, Right/Left submenu enter/exit, activate.
- **No render harness** exists for the cockpit, so the rendered menus (danger
  styling, radio dots, Sentence-case labels) are verified visually via CDP
  screenshot against the live dev app — not automated.

## Out of scope

- No new menu actions (explicitly deferred).
- No keyboard-shortcut hints in the `sublabel` slot (few actions have real
  bindings; deferred).
- No icons.
- No use of the `header` item type (supported by the renderer, but no menu needs
  section headers today).

## Files touched

- `frontend/app/element/contextmenu.tsx` — keyboard nav, danger styling, radio dot.
- `frontend/types/custom.d.ts` — `danger?: boolean`.
- `frontend/app/store/contextmenu.test.ts` — reducer tests.
- Label + ordering + danger/confirm edits at the nine call sites:
  `agentrow.tsx`, `agentheader.tsx`, `agenttree.tsx`, `narrationtimeline.tsx`,
  `channelrail.tsx`, `channelsprimitives.tsx`, `filessurface.tsx`,
  `memorysurface.tsx`, `term-model.ts` (and its `channelssurface.tsx` delete
  wiring for the confirm).
