# Modal consolidation — Canvas-13 style

Date: 2026-07-24
Status: approved, ready for implementation

## Problem

The cockpit has three parallel modal chromes:

1. **`ModalShell`** (`frontend/app/modals/modalshell.tsx`) — modern, Tailwind, `bg-modalbg`, `rounded-[14px]`, motion tokens. Used by NewAgentModal, NewProjectModal, CommandPalette, ShortcutsCheatSheet.
2. **Legacy `Modal`/`FlexiModal`** (`frontend/app/modals/modal.tsx` + `modal.scss` + `messagemodal.scss`) — older SCSS, portals to `#main`. Used by ConfirmModal, MessageModal, UserInputModal, AgentToolDetailModal.
3. **Ad-hoc** — NewMemoryModal hand-rolls its own backdrop `div`.

Result: inconsistent look, duplicated backdrop/motion/Esc logic, dead SCSS. The confirm dialog also lacks a confirm keyboard shortcut (only `Esc` is wired).

The target is the `Canvas-13.dc.html` design (claude.ai/design project `76055164-…`): a tone-aware confirm/alert dialog — scrim + blur, a centered `#12161c` card (max 440px, radius 14, entrance motion), a header with a 32px tinted icon square + title + muted body, and a right-aligned Cancel + tone-colored CTA footer.

## Goal

One chrome (`ModalShell`) for every modal, and a shared `ConfirmDialog` that renders the exact Canvas-13 layout for the alert family. Retire the legacy `Modal`/`FlexiModal` system. Add a confirm keyboard shortcut.

## Color mapping (no new tokens, no hardcoded colors)

Canvas-13 was drawn from this app's `@theme` palette:

| Canvas-13 | Token |
|---|---|
| card `#12161c` | `--color-modalbg` (`#13171d`) |
| border `#232a32` | `--color-edge-strong` (`#2a313a`) |
| title `#f0f3f6` | `--color-primary` (`#e6e9ed`) |
| body `#9aa3ad` | `--color-muted` |
| CTA `#7c95ff` / hover `#8da3ff` | `--color-accent-400` / `--color-accent-300` (exact) |
| danger `#e0726c` | `--color-error` (exact) |
| warning `#e6b450` | `--color-warning` (exact, already defined) |

Tinted icon-square and CTA backgrounds (`rgba(…, .10–.42)`) use Tailwind opacity modifiers on these tokens (`bg-error/10`, `border-error/40`, `text-error`, etc.). No raw hex is added.

## Components

### ModalShell (change: add `align`)
Add `align?: "top" | "center"` (default `"top"`). `"top"` keeps `items-start` + `topClass`; `"center"` uses `items-center` and drops the top padding. Everything else unchanged. Canvas-13 alerts pass `align="center"`; forms/palette keep the default top offset.

### DialogButton (new — `frontend/app/modals/dialogbutton.tsx`)
The shared footer button, so alerts and form footers share one styling.
- `variant`: `"secondary" | "primary" | "danger" | "warning"`.
- `secondary`: `bg-modalbg`-adjacent surface, `border-edge-strong`, muted text, hover brighten.
- `primary`: solid accent (`bg-accent`), dark text.
- `danger`/`warning`: tinted-fill CTA per Canvas-13 (`bg-error/10 border-error/40 text-error`, hover intensifies), matching the design's danger CTA treatment.
- Passes through `onClick`, `disabled`, `type`, `autoFocus`, `title`, and optional trailing `hint` chip (e.g. `⏎`).

### ConfirmDialog (new — `frontend/app/modals/confirmdialog.tsx`)
Renders the Canvas-13 layout inside `ModalShell align="center"`.
- Props: `open` (default true when self-mounted), `tone` (`"danger" | "warning" | "info"`, default `"info"`), `icon?` (ReactNode; defaults per tone — triangle-exclamation for danger/warning, info glyph for info), `title?`, `body` (ReactNode), `confirmLabel` (default "OK"), `cancelLabel?` (omit → single-button alert), `onConfirm`, `onClose`, `confirmDisabled?`.
- Layout: header row (`gap-3.5`), 32px `rounded-[9px]` tinted icon square (bg/border/stroke tinted by tone), title (`text-[16px] font-bold text-primary`) + body (`text-[13.5px] text-muted`). Footer right-aligned, `gap-2.5`: optional Cancel (`DialogButton secondary`) + CTA (`DialogButton` of tone).
- Keyboard: `Enter` → `onConfirm` (CTA is `autoFocus`, so activation is native and safe), `Esc` → `onClose`. Handled in `ConfirmDialog` (no text input in this layout, so plain `Enter` is unambiguous). Key-hint chips: `⏎` on the CTA, `esc` on Cancel.

## Per-modal migration

| Modal | Change | Public contract |
|---|---|---|
| ConfirmModal | Reimplement body as `ConfirmDialog` (`tone = destructive ? "danger" : "info"`). | Props + `displayName="ConfirmModal"` unchanged. 6 push sites + `runactions.test.ts` untouched. |
| MessageModal | Reimplement as single-button (`cancelLabel` omitted) info `ConfirmDialog`, `body={children}`, confirm "OK". | Props (`children`) + `displayName` unchanged. 2 push sites untouched. |
| UserInputModal | Chrome `Modal` → `ModalShell`; footer → `DialogButton`. Keep bespoke body (countdown title, markdown query, input, checkbox). Keeps its `keyutil` Enter=submit / Esc=cancel. | `displayName` + `UserInputRequest` props unchanged. |
| AgentToolDetailModal | `FlexiModal` → `ModalShell` (wide, `align="top"`, keeps its own header/scroll body). | Unchanged. |
| NewMemoryModal | Ad-hoc backdrop `div` → `ModalShell`; footer → `DialogButton`. Keep body. | Unchanged (`onClose`, `cwd`). |
| NewAgentModal / NewProjectModal | Already on `ModalShell`. Align footer buttons to `DialogButton` where low-risk (no body/logic change). | Unchanged. |
| CommandPalette / ShortcutsCheatSheet | Already on `ModalShell`. No change beyond inheriting the shell. | Unchanged. |

## Retirements

Delete once no consumers remain:
- `frontend/app/modals/modal.tsx` (`Modal`, `FlexiModal`, `ModalContent`, `ModalFooter`)
- `frontend/app/modals/modal.scss`
- `frontend/app/modals/messagemodal.scss`

`element/modal.tsx` + `element/modal.scss` are already dead (zero importers). **Out of strict scope** — flagged, not deleted, unless requested.

## Non-goals

- No change to the `modalsModel` push/pop stack API or `ModalsRenderer` registry.
- No change to modal *behavior* (what each modal does), only chrome + the confirm keyboard shortcut.
- Light mode is not addressed (permanently off the table).

## Testing / verification

- `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` clean (baseline is exit 0).
- `npx vitest run frontend/app/view/agents/runactions.test.ts` green (asserts the ConfirmModal push contract).
- CDP screenshot of the live "Close terminal" confirm (`confirmCloseAgent`) — it is the literal Canvas-13 example — to confirm visual match.
- `npx eslint` / `npx prettier --check` on touched files.
