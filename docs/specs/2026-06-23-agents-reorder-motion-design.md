# Agents list: motion `Reorder` drag-to-reorder

## Goal

Replace the Agents list's raw HTML5 drag-and-drop with `motion`'s `Reorder`
component so neighbor rows animate out of the way while a row is dragged. Today
the row only snaps to its new slot on drop — there is no motion during the drag.

Behavior is otherwise unchanged: drag starts from the existing ⠿ handle only,
dropping works across the asking/working/recently-idle boundary, and the
anchored ordering (`mergeOrder`) still preserves a manually-placed row's slot
when an agent changes state.

## Why a swap, not an addition

`motion`'s `Reorder` is a replacement for the drag mechanism, not an animation
layered on top: `Reorder.Group`/`Reorder.Item` own pointer handling, live
position tracking, and the layout animation as one unit. The data model already
fits — the list is driven by an `order: string[]` state, which maps directly
onto `Reorder.Group values={order} onReorder={setOrder}`. `Reorder`'s
`onReorder` hands back the fully reordered array, so the manual splice helper
`reorderList` becomes dead code.

`mergeOrder` (anchored ordering) is untouched: `onReorder` writes to the same
`order` state that `mergeOrder` reconciles against, so a manual reorder survives
agent state changes exactly as today.

## Decision

Drag is gated to the existing ⠿ handle via `useDragControls` +
`dragListener={false}`. The rest of the row stays a plain clickable element, so
single-click (move cursor), double-click (open focus), the terminal/dismiss
buttons, and the narration resize grip all behave as they do now. Whole-row
drag was rejected: it would compete with click-to-select and the row's
interactive children.

## Implementation

### `frontend/app/view/agents/agentrow.tsx`
- Import `{ Reorder, useDragControls }` from `motion/react`.
- Add `const controls = useDragControls();` at the top of `AgentRow`.
- Change the root `<div>` to
  `<Reorder.Item as="div" value={agent.id} dragListener={false} dragControls={controls} layout initial={...} animate={...} exit={...}>`.
  The root already has `relative` (required for `Reorder`'s auto z-index lift).
  Carry the enter/exit fade (`initial`/`animate`/`exit`/`transition`) that the
  wrapper `motion.div` holds today.
- Remove the root's `onDragOver` and `onDrop` handlers.
- ⠿ handle: remove `draggable`, the `dataTransfer` seeding, and `onDragStart`;
  replace with `onPointerDown={(e) => controls.start(e)}` and add `touch-none`
  so it never hijacks scroll. Keep the `onClick` stopPropagation and the
  hover-reveal / `cursor-grab` styling.
- Replace the `onDragStart` / `onDropOn` props with a `pulse: boolean` prop,
  merged into the root className as `pulse && "ring-2 ring-warning ring-inset"`.

### `frontend/app/view/agents/agents.tsx`
- Import `Reorder` from `motion/react` (alongside the existing `motion` /
  `AnimatePresence`).
- Drop `reorderList` from the `./agentsviewmodel` import.
- Wrap the list in
  `<Reorder.Group as="div" axis="y" values={orderedIds} onReorder={setOrder}>`,
  containing the existing `<AnimatePresence mode="popLayout">` that maps
  `<AgentRow>` directly (no wrapper `motion.div`). Pass `pulse={pulseId === a.id}`.
- Delete the `dragId` state and the `onDragStart` / `onDropOn` callbacks.
  `setOrder` stays — `onReorder` supplies the reordered `string[]`.

### `frontend/app/view/agents/agentsviewmodel.ts` and `.test.ts`
- Remove `reorderList` and its `describe("reorderList", ...)` block.
  `mergeOrder` and its tests stay.

## Verification

No new pure logic to unit-test (one is removed), so verification is visual:
drag a row by the ⠿ handle in the dev app and confirm neighbors animate to their
new positions; confirm single-click, double-click, the terminal/dismiss buttons,
and the narration resize grip still work; confirm a manually-reordered row holds
its slot when its agent changes state. The remaining `agentsviewmodel` tests
must stay green after the `reorderList` removal.
