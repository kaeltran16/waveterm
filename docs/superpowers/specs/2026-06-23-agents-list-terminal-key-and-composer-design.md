# Agents List View — `t`-to-Terminal + Smooth Composer Reveal

Date: 2026-06-23
Status: Approved (design)

## Problem

Two list-view interaction rough edges in the Agents tab:

1. **No `t` shortcut on the selected row.** The focus view already opens an
   agent's terminal tab with `t` (`agents.tsx:303-306`) and every row has a
   `↗ terminal` button (`onOpenTerminal` → `setActiveTab(a.id)`), but the list's
   keyboard handler has no `t` binding — so the cursor row can't jump to its
   terminal from the keyboard. The hint bar and the `?` help overlay also omit
   it.
2. **Composer reveal causes a layout snap.** The inline reply composer is gated
   on `isCursor` (`agentrow.tsx:221`) and its `motion.div` animates only
   `opacity` + `y` — **not height**. So selecting a row instantly grows it and
   the rows below snap down. Moving the cursor through the list reflows the
   whole list on every keystroke; it feels janky.

## Approach

Both are list-view interaction polish on the same surface (`agents.tsx` /
`agentrow.tsx`), so they share one spec.

- **`t`:** additive keybinding mirroring the focus view, plus a hint-bar chip and
  a help-overlay row. `agent.id` is the tab id everywhere here, so it reuses the
  already-imported `setActiveTab`.
- **Composer:** chosen fix is **animate the height** (approach 3 of the three
  considered). Rejected: (1) reveal-on-`r`-only — removes the shift entirely but
  hides the composer until a keypress, dropping discoverability; (2) a docked
  bottom composer — most stable but detaches the composer from the row and
  changes the interaction model. Approach 3 is the smallest change: keep the
  current on-select gating, just make the open/close a smooth slide. The list
  still reflows as the composer grows, but gracefully rather than snapping.

## Design

### `t`-to-terminal (`agents.tsx`)

- In `onKeyDown`, list-view branch (after the `r` handler), add:

  ```ts
  } else if (e.key === "t") {
      e.preventDefault();
      if (cur) {
          setActiveTab(cur.id);
      }
  }
  ```

  Works for any cursor row regardless of state (asking/working/idle) — every
  agent has a tab. No conflict with typing: `onKeyDown` already early-returns
  when the target is an `INPUT`/`TEXTAREA`, so `t` types normally in the composer.
- `HINTS` (`agents.tsx:94`): insert `["t", "terminal"]` immediately before
  `["esc", "back"]` (grouped with the row-action keys).
- `HelpOverlay` rows (`agents.tsx:105`): insert
  `["t", "open the highlighted agent's terminal tab"]` after the `r` row.

### Smooth composer reveal (`agentrow.tsx:220-240`)

Gating is unchanged (`isCursor && !hasQuestions`). Only the animation changes:

```tsx
<AnimatePresence>
    {isCursor && !hasQuestions ? (
        <motion.div
            key="composer"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            style={{ overflow: "hidden" }}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
        >
            <div className="mt-2 ml-[26px]">
                <AgentComposer
                    blockId={agent.blockId}
                    placeholder={`message ${agent.name}…`}
                    onEscape={onComposerEscape}
                    className="border-t-0 px-0 py-0"
                />
            </div>
        </motion.div>
    ) : null}
</AnimatePresence>
```

- `overflow: hidden` clips the composer while it grows/shrinks so content
  doesn't spill during the transition.
- The `mt-2 ml-[26px]` margin moves to the **inner** wrapper so the top margin
  collapses with the height (an outer margin would leave an ~8px gap at
  `height: 0`).
- Siblings move via normal document-flow reflow as motion drives `height`
  per-frame; `Reorder.Item`'s `layout` spring (drag-reorder) does not contend
  with it. **Fallback if jitter appears:** swap the height animation for a
  CSS grid-rows trick (`grid-template-rows: 0fr ↔ 1fr` + inner `overflow:hidden`,
  `transition: grid-template-rows 0.18s ease`), keeping `AnimatePresence` only
  for mount/unmount.

## Non-Goals

- No change to composer *gating* — it still appears on selection (not reveal-on-
  `r`), and `r` still focuses the already-rendered textarea (`focusRowComposer`).
- No docked/bottom composer.
- No change to the focus-view `t` handler or the per-row `↗ terminal` button
  (both already work).
- No new shortcuts beyond `t`.

## Testing

Both changes are thin React/DOM interaction glue (no pure logic added), verified
visually in the dev app (CDP on :9222):

- Cursor on a row → `t` switches the active tab to that agent's terminal.
- `t` while focused in the composer textarea types a literal `t` (no tab switch).
- `t terminal` chip appears in the hint bar before `esc back`; the `?` overlay
  lists the `t` row.
- Moving the cursor down/up: the composer slides open/closed smoothly and the
  rows below glide rather than snap.

## Implementation

1. `agents.tsx`: add the `t` branch in `onKeyDown`; add the `HINTS` entry and the
   `HelpOverlay` row.
2. `agentrow.tsx`: change the composer `motion.div` to animate `height`/`opacity`
   with `overflow:hidden`, and move `mt-2 ml-[26px]` to an inner wrapper.
3. Visual-verify in the dev app: `t` jumps to the terminal; smooth composer
   slide on cursor movement; no literal-`t` conflict while typing.
