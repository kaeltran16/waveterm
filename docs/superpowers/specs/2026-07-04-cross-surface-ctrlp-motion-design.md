# Cross-surface / Ctrl+P motion — design

Date: 2026-07-04
Surface: **Cross-surface tab transitions** + the Ctrl+P command palette (`command-palette.tsx`)
Tracker row: `docs/superpowers/animation-revamp-tracker.md` → "Cross-surface tab transitions"

## Summary

This surface resolves the tracker's long-open decision — *crossfade vs. none* for switching
between surfaces — as **none, by design**. The incoming surface's own entrance reveal is the
transition; the shell adds no competing container animation. The Ctrl+P palette, the other half
of this work, already gets its open/close motion from `ModalShell` and already hands off into the
arriving surface; the only buildable addition is a single optional selection-tint micro.

The honest shape of this design is *restraint*. The palette is a fast-feedback surface and the
surface swap is a whole-view replacement — in both, added motion reduces legibility rather than
improving it. Per the north-star's functional-first rejection test ("does it make a state change
more legible?"), most candidate animations fail and do not ship. Documenting that conclusion, and
closing the row, is the deliverable — not a volume of new motion.

**No new tokens. No new primitives. No shell restructuring.**

## Context (how switching works today)

- `cockpitshell.tsx` reads `model.surfaceAtom` and renders exactly one non-Agent surface via a
  ternary. Switching a surface **mounts the new one and unmounts the old** synchronously.
- The **Agent surface is the exception**: it stays permanently mounted and is hidden with
  `display:none` when off-surface, because its live terminal (xterm) cannot be torn down and
  re-fit without mangling the TUI.
- Every non-Agent surface already runs its **own entrance reveal** on mount (one-shot load reveal
  / container fade), gated by `<MotionConfig reducedMotion="user">`.
- **All triggers set the same atom** — nav rail, `[` / `]` keys (`cockpitsurface.tsx` `onKeyDown`),
  the Ctrl+P palette's "Go to X" commands, and inline buttons (`Details →`, `View all →`,
  `openFocus`, `openDiff`). The swap is structurally identical regardless of entry point.
- The palette (`command-palette.tsx`) is a fixed overlay rendered as a sibling of the shell in
  `cockpit-root.tsx`. It uses `ModalShell` for its backdrop fade + panel scale (already shipped in
  the Shared-modals surface). Its "Go to X" command does `globalStore.set(surfaceAtom, key)` then
  `close()`.

## Constraints that decide the design

1. **Must not fight per-surface entrances** (north-star hard rule). Every non-Agent surface already
   owns one arrival animation. Any shell-level crossfade would put a *second* animation on the same
   element, which then has to be actively managed not to collide.
2. **The Agent surface never unmounts**, so it structurally cannot participate in a mount/unmount
   crossfade. Any container-transition design needs a special path for it.
3. **Fast-feedback legibility.** Sessions/Activity/Files already treat *search/typing* as an instant
   zero-duration snap and animate only deliberate *filter* changes. The palette is the same class of
   surface: per-keystroke reflow would strobe, not clarify.
4. **No new vocabulary per surface** (north-star). There is no `layoutId` / sliding-highlight
   precedent in the codebase; the established selection micro (moment 7) is a `transition-colors`
   tint (shipped in AgentTree). A sliding highlight would be a new primitive and is rejected.

## Decisions

### 1. Surface swap — no container transition (the "none" resolution)

Keep the instant structural swap in `cockpitshell.tsx`. The arriving surface's own entrance reveal
is the cross-surface transition. This is the only option that cannot fight per-surface entrances
(exactly one animation plays, on one element), and it passes the functional-first test where a
container crossfade fails: the incoming reveal plus the active nav-rail item already communicate
"new surface" — an added blend is decoration.

Accepted inherent behaviors (documented, not bugs):
- Switching **to the Agent surface shows no arrival motion** (it was already mounted). Correct — a
  reveal over a live TUI is undesirable.
- Re-entering any other surface **remounts and re-reveals**. Consistent with today's behavior.

Rejected alternatives: *container crossfade with per-surface reveals suppressed* (invasive — touches
every surface's reveal gate, needs an Agent special-case); *outgoing fade via AnimatePresence exit*
(dual-mounts two heavy surfaces — transcript streams, data loads — for ~280ms on every switch).

### 2. Palette → surface hand-off — verify the emergent overlap

`run()` sets `surfaceAtom` **before** `close()`, so the new surface mounts underneath the palette
while `ModalShell` plays its exit (opacity 0 + scale 0.96 over `durExit` = 280ms, plus the backdrop
scrim fade). The arriving surface's reveal (~360ms) starts at the same instant. That overlap already
reads as "the palette dissolves into the arriving surface."

The work is to **verify** this composes cleanly (correct set-before-close ordering; the surface is
present and revealing as the panel fades). Expected outcome: **no code change**. If a gap is found,
the only permitted tuning is timing already expressed in `motiontokens.ts` — no new values.

### 3. Palette internals — keep instant, one optional micro

- **Results list:** remains an instant snap on typing (current behavior — plain re-render, no
  motion). We explicitly **do not** add per-keystroke reflow (`popLayout`/`layout`) or a per-item
  entrance cascade on open. Both are rejected on legibility grounds and by the no-cascade rule. This
  is a *deliberate non-change*, recorded so a future pass doesn't "fix" it.
- **Selection tint (optional):** replace the instant `bg-accentbg` toggle on the active row with a
  `transition-colors` micro at `durMicro` / `easeFluid`, reusing AgentTree's moment-7 selection
  pattern (no new token; `easeFluidCss` or the matching Tailwind duration).
  **Ship-gate:** on held arrow-repeat a color fade can smear across several mid-transition rows. If
  it smears in the live dev app, **drop it** and keep the instant tint. This micro ships only if it
  verifies clean.

## Moment vocabulary mapping

| Candidate | Vocabulary | Decision |
|---|---|---|
| Surface swap (container) | — | **None** — per-surface entrance is the transition |
| Palette open/close | modal (backdrop fade + panel scale) | Already shipped via `ModalShell` |
| Palette → surface hand-off | emergent overlap of modal exit + surface reveal | Verify only; no new motion |
| Palette results reflow on type | m2 (`popLayout`/`layout`) | **Rejected** — instant snap (fast-feedback) |
| Palette open item cascade | m1 (`cardVariants`) | **Rejected** — no-cascade rule |
| Palette selection highlight | m7 (`transition-colors` tint) | Optional; ships only if it verifies clean |
| Sliding selection highlight | (new primitive) | **Rejected** — no new vocabulary |

## Reduced motion

No new motion paths beyond the optional `transition-colors` micro. `ModalShell` already wraps the
palette in `<MotionConfig reducedMotion="user">`; the selection tint is a color transition (no
transform), so it is acceptable under reduced motion and needs no extra gate.

## Verification

Drive the live dev app over CDP (per `CLAUDE.md` visual-verification): inject a populated roster,
open Ctrl+P, and confirm:
1. Switching surfaces (rail, `[` / `]`, palette "Go to X") shows the arriving surface's own reveal
   and no double animation / no container crossfade.
2. Selecting "Go to X" reads as the palette dissolving into the arriving surface.
3. Typing filters the list as an instant snap (no reflow, no per-item cascade).
4. Arrow-key selection: if the tint micro is enabled, it tracks selection without smearing on held
   repeat; otherwise the tint is instant.

## Out of scope

- Any change to per-surface entrance reveals.
- Any change to `ModalShell` open/close motion (owned by the Shared-modals surface).
- The Memory surface (separate tracker row).
