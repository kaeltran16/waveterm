# Jarvis autonomy control — collapse the ladder into a chip

**Date:** 2026-07-30 · **Surface:** Jarvis Stage header · **Scope:** one control, one CDP scenario, two docs

## 1. Why

Two complaints, both about the Stage header's autonomy control:

1. **Clicking Delegator shifts the layout.** The dispatch strip (`report | manage | fanout`) renders inside
   the same right-anchored container and only at Delegator (`autonomyladder.ts:38`), so selecting that tier
   grows the group ~140px and slides all three rungs left — the button you just clicked moves out from under
   the cursor.
2. **The group's size does not match the app.** Measured over CDP against the running dev app at a 1920px
   window: the group is **283 × 41 px** inside a **43 px** header band, filling it edge to edge, while its
   sibling `Graph` button is **53 × 27**. Nothing else in the app stacks a label over a bar, and the app's own
   idiom for a set of options is a single-row pill about 26px tall (`usagesurface.tsx:88`,
   `settingssurface.tsx:138`).

Both are inherited: the control was ported literally from the design source
(`wave-handoff/wave/project/Wave-jarvis-consolidated.dc.html:171-184`). This revisits that decision rather
than patching around it.

The shift already has a recorded downstream symptom. JC12
(`docs/jarvis-consolidation-open-issues.md:428`) is the title truncating to **0px at Delegator** *because*
the dispatch strip claims the space; it was mitigated with a title floor and a label-collapse order, not
cured.

## 2. Decision

The header carries a **fixed-width chip** naming the current tier. The three rungs, their blurbs and the
dispatch mode move into a **popover** the chip opens.

The chip's box is identical at every tier and every mode, so the shift is gone **by construction** — not
absorbed by a reserved gap and not smoothed by animation. Header footprint drops from 283px (420px at
Delegator) to a constant ~170px, which returns ~250px to the subject's title in the worst case.

Rejected alternatives, and why: reserving the strip's width inline costs ~140px of permanently dead header
space; moving the mode into the ⚙ drawer hides a Delegator-only setting behind an unrelated panel; a
fixed-width slot that swaps consequence text for the modes keeps the header wordy and still sets the group's
scale by its widest state.

## 3. The chip

A `<button>` in the same classes as its `Graph` sibling, so the header reads as one family — **27px tall**,
matching `Graph` and the `Grounded in:` chip:

```
flex-none cursor-pointer rounded-[7px] border border-border bg-surface px-2.5 py-1
text-[11px] font-semibold   ·   open: border-accent-700, text-primary
```

Contents, left to right:

| Part | Treatment |
|---|---|
| Glyph | three `w-[3px]` bars at 3/5/7px — the same shape the rungs use today. `bg-accent` up to the current tier, `bg-edge-mid` above it. |
| Tier name | `Concierge` / `Gatekeeper` / `Delegator`, plus ` · {mode}` at Delegator only (mode in muted mono, as today). |
| Chevron | `▾`, `rotate-180` when open. |

`min-w-[~170px]`, sized to the widest state (`Delegator · fanout`). **The exact value is pinned by a CDP
measurement during implementation, not guessed** — the estimate above is arithmetic on the type sizes, and a
min-width that is too small reintroduces the very shift this removes.

The glyph is the whole accumulation idea at 11px, and it is what keeps the header glanceable: the tier is
still readable without opening anything.

The `AUTONOMY` caption **leaves the header**. It is the single largest reason the group read as a
different-scale widget, and it becomes the popover's section label.

## 4. The popover

Same machinery as `TermThemeDropdown` (`settingssurface.tsx:510`), which is the proven cockpit-era pattern —
`useDismiss` means **both** Escape and an outside click close it, and `PopoverReveal` scales the panel from
its anchor corner with the shared motion token. No new dependency; `element/popover.tsx` is deliberately not
used (2025-era, SCSS-based).

**Correction, from implementation.** `useDismiss` was not sufficient for Escape on this surface. Escape is
bound surface-wide to "back to Cockpit" (`bindings.ts` `surface:back-home`) and the app's dispatcher runs on
window **capture**, calling `stopImmediatePropagation` on a claim — so floating-ui's document-level handler
can never pre-empt it, and one press both dismissed the panel and ejected the user from Jarvis. The panel
therefore publishes `autonomyPanelOpenAtom` and that binding stands down while it is open, which is what the
graph peek already does. Outside-click needed nothing.

```
useFloating({ open, onOpenChange, placement: "bottom-end",
              middleware: [offset(6)], whileElementsMounted: autoUpdate })
useInteractions([useClick(context), useDismiss(context)])
panel: w-[300px] rounded-[11px] border border-border bg-surface p-[5px]
       shadow-[0_12px_34px_rgba(0,0,0,.5)]   ·   PopoverReveal origin="top right"
```

**Tier rows.** One per tier: the same bar glyph, the name at `12.5px` semibold, and the blurb at
`11px text-muted` as *visible text* — today the blurbs exist only in `title` tooltips. Active row
`bg-surface-raised` with the name in accent and a `✓`; hover `bg-surface-hover`. Copy keeps the `+` form
already used in `docs/jarvis-tab.md`, so the nesting is stated and not merely implied by fill.

**Dispatch mode.** Still Delegator-only (`showsDispatchMode`), below a `border-t` divider with its own mono
caption, keeping the existing `bg-success/15 text-success` tone for the active mode. It stays *conditional*
rather than greyed out because the surface's own principle is that controls a subject cannot have are simply
not drawn. It appears inside a panel that grows **downward** from a top-anchored header, so nothing under the
pointer moves when you land on Delegator.

**The panel stays open** on both tier and mode changes. It is a small control panel, not a picker: after
switching to Delegator, setting the mode is the obvious next click. Only Escape, an outside click, or the
chip itself closes it.

**Keyboard and a11y.** `aria-expanded` on the chip; plain buttons with `aria-pressed` on the rows and the
modes; native Tab order. No roving arrow keys — `aria-pressed` buttons do not imply them, `role="radio"`
would, and six controls do not need it. This is strictly more operable than today, where the ladder had no
keyboard affordance beyond Tab.

**Known latency, unchanged.** `setChannelTier` (`channelsstore.ts:116`) is RPC-then-refetch with no
optimistic update, so a row's state flips after the round trip. Because the panel now stays open, that
settles in place instead of the control disappearing under the cursor.

## 5. Logic vs. view

Two additions to `autonomyladder.ts` (pure, already unit-tested):

- `RUNG_BAR_PX` — the bar heights as one exported const, so the chip glyph and the panel rows cannot drift
  apart. Replaces the inline `3 + i * 2`.
- `chipLabel(tier, mode)` — appends ` · {mode}` at Delegator only, and omits it when `mode` is empty, since
  `mode` is a free string off channel meta.

New vitest cases in `autonomyladder.test.ts` for both. No render tests: the established position on this
surface is that pure glue is extracted and unit-tested while "does it render" is verified over CDP.

## 6. Header consequences

The two `@container` rules inside the ladder go away with the elements they hid — `@max-[820px]:hidden` on
the rung labels and `@max-[640px]:hidden` on the dispatch strip (`autonomyladderview.tsx:38,49`). The title's
`min-w-[10ch]` floor, the subtitle's `@max-[640px]:hidden` and the `@container` on the gutter row all stay.

**No glyph-only collapse step is added up front.** At a constant ~170px it may never be needed. Measure the
title span at 1440 / 1000 / 860 and add that step only if the floor is actually reached.

JC12's cause is removed; its mitigation stays as belt-and-braces. The open-issues entry gets a note saying
so, rather than a rewrite.

## 7. Verification

| Check | Command |
|---|---|
| Pure logic | `npx vitest run frontend/app/view/jarvis/autonomyladder.test.ts` |
| Types | `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` |
| Live surface | `task verify:ui -- jarvis-fleet` |
| Measurements | CDP re-measure of the chip and title at 1440 / 1000 / 860 |

`scenarios.mjs:277` is the only assertion this breaks — it requires the body text to contain `AUTONOMY` *and*
`CONCIERGE` *and* `DELEGATOR`, and after this change the header carries only the current tier. `jarvis-fleet`
is rewritten to:

1. the chip renders, carrying the tier name;
2. clicking it opens a panel containing `AUTONOMY`, all three tier names, and a blurb;
3. **measure the chip's left edge, click the Delegator row, re-measure — the two must be identical**;
4. Escape closes the panel.

Step 3 is the regression test for the complaint that started this. The scenario already creates and deletes
its own channel, so writing a tier leaves no residue. `jarvis-collapse-order`, `jarvis-narrow` and
`jarvis-measure` probe column layout, not header internals, and are unaffected.

## 8. Files, coordination, scope

Six files: `autonomyladder.ts`, `autonomyladder.test.ts`, `autonomyladderview.tsx` (rewritten),
`stageheader.tsx` (deletes a comment that is now false — the call site is byte-identical),
`scripts/cdp/scenarios.mjs`, `docs/jarvis-tab.md` §8. Plus the JC12 note in
`docs/jarvis-consolidation-open-issues.md`.

The filename and the `AutonomyLadder` export are kept: the ladder still exists, it just lives in the panel
now, and renaming a frontend module while the dev app runs blanks the page.

**Coordination.** Nine files are dirty from in-flight work at the time of writing, three of which this
touches — `stageheader.tsx`, `scenarios.mjs`, `docs/jarvis-tab.md` — in different regions of each. Stage only
this change's own hunks; leave the ⚙-into-the-rail work, `collapsiblerail.tsx`, `stagerail.tsx`,
`profilepanel.tsx`, `jarvisstore.ts`, `stage.tsx` and `docs/jarvis-tour.md` untouched.

**Out of scope.** No optimistic tier write — add it only if the refetch reads as lag. Not consolidating the
two duplicate `Segmented` components in `usagesurface.tsx` and `settingssurface.tsx`: real duplication,
unrelated to this control.
