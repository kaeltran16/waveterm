# Memory detail rail → shared CollapsibleRail

## Problem

The Memory surface (`memorysurface.tsx`) renders its detail panel with a bespoke
`DetailRail` — a hand-rolled always-open `<aside w-330>`. Every other surface that
has a right panel (Agent, Channels, Cockpit) uses the shared
`CollapsibleRail` element (`frontend/app/element/collapsiblerail.tsx`). The result
is a visibly inconsistent tab: different width (330 vs 300px), different border
token (`border-edge-faint` vs `border-border`), different padding, and — most
noticeably — the memory drawer cannot be collapsed while every other drawer can.

## Goal

Memory uses the same drawer as the rest of the cockpit: `CollapsibleRail`, with
the same width, border, collapse affordance, and width-reveal animation — so the
tab reads as part of one system. No regression to the memory detail content
(view/edit/delete, meta rows, related links, conflict handling).

## Non-goals

- No changes to the `CollapsibleRail` API. Auto-expand is achieved caller-side.
- No changes to list/graph rendering, search, sync strip, or the header.
- No new sections in the rail — the memory detail is one logical block.

## Decisions (approved)

- **Default state: open.** The detail view is the point of the tab, so the drawer
  starts expanded (differs from Agent/Channels, which default collapsed).
- **Click-to-expand: yes.** Selecting a note (list or graph) opens a collapsed
  drawer and shows its detail.
- **Editing state lifted to atoms.** Preserves an in-progress draft across collapse
  (and, as a bonus, across leaving/returning to the tab).
- **List stays centered.** Accept the gentle animated horizontal drift on toggle.

## Constraint that shapes the design — layout shift

The reference consumer (Agent surface) puts its header *inside* the flex column
that sits beside the rail, so collapsing the rail reflows the header. Memory must
NOT adopt that topology: its `Header` (Search / Graph·List / New memory) and
`SyncStrip` (Projection / Pull / Project now) are full-**surface**-width rows
*above* the content row, anchored to the surface edge.

The migration keeps that topology. Only the fixed `<aside>` inside the content row
is swapped for `CollapsibleRail`. Therefore:

- Header + SyncStrip never move on toggle (right edge = surface edge).
- Only the list/graph column reflows, animated by `CollapsibleRail`'s own width
  transition — a deliberate, smooth glide, not CLS.
- Graph view is safe: `MemGraph` has a `ResizeObserver` (`memgraph.tsx:74`) that
  only updates canvas dimensions; the force sim resets solely on `data` change
  (`:94`) and `zoomToFit` is one-shot (`fitted.current`). Nodes do not
  re-simulate or jump — the canvas just resizes.

## Architecture

Change surface: `memorysurface.tsx` and `memstore.ts`. `CollapsibleRail` is
untouched.

### 1. State (memstore.ts)

Add module-scope atoms (persist across surface remounts):

- `memRailOpenAtom = atom<boolean>(true)` — drawer open/closed; default open.
- `memEditingAtom = atom<boolean>(false)`
- `memDraftAtom = atom<string>("")`
- `memConflictAtom = atom<boolean>(false)`

In `selectNote(id)`, also `globalStore.set(memRailOpenAtom, true)` (open on
select) and reset `memEditingAtom`/`memConflictAtom` to false. This makes
`selectNote` the single source for selection side effects and lets the current
`useEffect` keyed on `selectedId` be removed.

### 2. Rail (memorysurface.tsx)

- Replace the `DetailRail` `<aside>` with `CollapsibleRail`:
  - `openAtom={memRailOpenAtom}`
  - `ariaLabel="Memory detail"`
  - one `RailSection` whose `content` is the existing detail block (empty-state
    "Select a memory…" + the per-note `AnimatePresence` fade + `DetailBody`).
  - collapsed glyph: `RAIL_ICON.info`.
- `DetailBody` becomes stateless w.r.t. editing: `editing/draft/conflict` come
  from the atoms instead of local `useState`. `startEdit`/`doSave`/cancel set the
  atoms.
- Width drops 330 → 300 (CollapsibleRail's `RAIL_EXPANDED_PX`, matching the
  app-bar usage column for a continuous divider). Textarea (h-220) and meta rows
  fit at 300.

### Data flow

`memNotesAtom` / `memSelectedIdAtom` / `memBodyAtom` / `memEdgesAtom` unchanged.
The rail reads `selectedId` + `notes` to resolve `sel` and `related` exactly as
today. New atoms only carry drawer-open and edit-draft state.

## Testing / verification

- No render-test harness exists (see CLAUDE.md). Verify in the live dev app via
  CDP screenshot (`scripts/cdp-shot.mjs`), with memory injected if needed.
- Manual checks: (a) drawer open on entry; (b) collapse button shrinks to the
  44px strip, header/sync strip do not move; (c) click a note while collapsed →
  drawer expands and shows detail; (d) start editing, collapse, expand → draft
  intact; (e) graph view: toggle drawer → nodes stay put, canvas resizes; (f)
  border/width match the Agent rail side-by-side.
- `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` clean.

## Risks

- Continuous `ResizeObserver` fires during the width animation → a burst of graph
  canvas re-renders. Cheap (canvas dims only); debounce only if measured to
  stutter. YAGNI until then.
