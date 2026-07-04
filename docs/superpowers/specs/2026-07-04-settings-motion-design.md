# Settings motion + shared popover reveal — design

Date: 2026-07-04
Surface: Settings (`settingssurface.tsx`), plus a new shared popover primitive adopted across the live cockpit popovers.

## Goal

Bring the Settings surface into the app-wide motion system and add the one motion primitive it
still lacks — an animated popover reveal — as a **shared** token + wrapper, then adopt it across
every *live* cockpit popover so dropdown open/close is consistent everywhere.

Settings was deliberately excluded from the original revamp as a config surface. This change reverses
that decision: Settings gets the standard load reveal plus the two functional in-surface moments it
actually has, and the popover work it motivates is generalized rather than one-off.

All motion follows the north star in `docs/superpowers/animation-revamp-tracker.md`: functional-first
(a moment ships only if it makes a state change more legible), fluid/calm feel, reduced-motion always
honored, no entrance cascade.

## Scope

### In scope
- New shared motion primitive: `popoverReveal` variant in `motiontokens.ts` + a `<PopoverReveal>`
  wrapper component.
- Retrofit **live** cockpit popovers to use it (list below).
- Settings surface moments: load reveal, runtime→flag-list crossfade, Memory Save settle,
  surface-root `MotionConfig`.
- Token test guard + tracker update.

### Explicitly out of scope
- The `element/` popover components (`popover.tsx`, `flyoutmenu.tsx`, `menubutton.tsx`,
  `emojipalette.tsx`). Survey confirmed they are imported nowhere in the cockpit — dead upstream
  code. Animating them is wasted work.
- Legacy block-view dropdowns (`term.tsx`, `waveconfig.tsx`, `preview-streaming.tsx`) — not cockpit
  surfaces.
- Theme preset recolor animation — recolor is already legible; functional-first rejects it.
- No new durations/eases/keyframes. Everything reuses existing `MOTION` tokens and the CSS `settle`
  keyframe.

## The shared popover primitive

Every live cockpit popover is the same shape today: `{open ? (<backdrop catcher/> + <absolute
panel/>) : null}` with instant show/hide and no exit.

### Token (`frontend/app/element/motiontokens.ts`)

```ts
// Popover / dropdown reveal. Opacity + scale only (never x/y — consistent with cardVariants);
// the panel scales from its anchor corner via a per-site transform-origin. Snappy in and out —
// a dropdown dismiss should not linger.
export const popoverReveal: Variants = {
    initial: { opacity: 0, scale: 0.96 },
    animate: { opacity: 1, scale: 1, transition: { duration: MOTION.durMicro, ease: MOTION.easeFluid } },
    exit:    { opacity: 0, scale: 0.96, transition: { duration: MOTION.durMicro, ease: MOTION.easeFluid } },
};
```

### Wrapper component (`frontend/app/element/popoverreveal.tsx`)

Wraps **only the panel**. Owns `AnimatePresence` + `MotionConfig reducedMotion="user"` + the variant
+ the `transform-origin`. It does **not** own positioning or the backdrop — those legitimately differ
per site (z-index, placement, whether a backdrop catcher exists), so callers keep their `absolute …`
classes and their `fixed inset-0` click-catcher unchanged.

Props:
- `open: boolean`
- `origin: string` — CSS `transform-origin` (e.g. `"top right"`, `"bottom left"`), so the panel grows
  from its anchor corner.
- `className?: string` — the caller's existing positioning + styling classes, applied to the animated
  panel div.
- `children: ReactNode`

Shape:

```tsx
<MotionConfig reducedMotion="user">
  <AnimatePresence>
    {open && (
      <motion.div
        variants={popoverReveal}
        initial="initial" animate="animate" exit="exit"
        style={{ transformOrigin: origin }}
        className={className}
      >
        {children}
      </motion.div>
    )}
  </AnimatePresence>
</MotionConfig>
```

Reduced motion drops the scale, keeps the fade — same behavior as `ModalShell`.

### Retrofit pattern (mechanical, per site)

Before:
```tsx
{open ? (
  <>
    <div className="fixed inset-0 z-50" onClick={close} />
    <div className="absolute right-0 top-full … shadow-popover">…</div>
  </>
) : null}
```

After:
```tsx
{open ? <div className="fixed inset-0 z-50" onClick={close} /> : null}
<PopoverReveal open={open} origin="top right" className="absolute right-0 top-full … shadow-popover">
  …
</PopoverReveal>
```

The backdrop stays a plain conditional (a transparent click-catcher should vanish immediately on
close; only the panel animates out via the wrapper's `AnimatePresence`).

### Live popovers to retrofit

| Site | Popover | `origin` |
|---|---|---|
| `settingssurface.tsx` | Term color-scheme dropdown (`TermThemeDropdown`) | `top right` |
| `newagentmodal.tsx` | Flag menu (`flagMenuOpen`) | `top` |
| `newagentmodal.tsx` | Branch picker (`branchListOpen`, opens upward via `bottom-full`) | `bottom left` |
| `projectswitcher.tsx` | Project dropdown | `top left` |
| `filessurface.tsx` | Source/scope dropdown | `top` |
| `agentrow.tsx` | Task popover (`TaskPopover`) | `top right` (confirm anchor + backdrop presence at impl) |

## Settings surface moments

All reuse existing tokens. Surface root wrapped in `<MotionConfig reducedMotion="user">` like every
other animated surface.

1. **Load reveal** — one-shot container fade on the `SettingsSurface` scroll root (opacity 0→1,
   `MOTION.durMacro`, `easeFluid`), gated by `useReducedMotion`. A single container fade — **no
   per-section cascade** (honors the no-cascade north star). Matches Sessions/Activity/Memory/Usage.

2. **Runtime → flag-list crossfade** (`NewAgentDefaultsSection`) — key the flag-list card content by
   `runtime`; m5-style opacity crossfade (the Files diff-pane idiom) on runtime switch. Height snaps
   between runtimes (flag lists are similar length, so it stays calm). Framer reduced-motion handled
   by the surface-root `MotionConfig`.

3. **Memory Save settle** (`MemorySection`) — trigger the existing CSS `settle` keyframe (moment 4) on
   the Save button when it flips to the saved state, with `motion-reduce:animate-none`. A one-shot
   completion cue confirming the write landed.

Theme preset selection stays an instant recolor — no animation.

## Reduced motion

- Load reveal: `useReducedMotion` gate → instant (opacity 1, no tween).
- Crossfade: surface-root `MotionConfig reducedMotion="user"`.
- Settle: `motion-reduce:animate-none` on the CSS keyframe.
- `PopoverReveal`: its own `MotionConfig reducedMotion="user"` (drops scale, keeps fade) — works even
  for popovers not under a surface `MotionConfig` (e.g. `projectswitcher`).

## Testing / verification

- `motiontokens.test.ts`: add a guard for `popoverReveal` values (durations, ease, opacity+scale
  endpoints).
- Visual verification via CDP screenshots of the live dev app (per CLAUDE.md): Settings load reveal,
  runtime tab switch crossfade, Save settle, and each retrofitted popover open/close (including the
  upward-opening branch picker and reduced-motion behavior).

## Tracker update

- Add a **Settings** row to the surface rollout table (flip to ✅ with the commit SHA).
- Note `popoverReveal` (token) + `PopoverReveal` (component) in the shared-foundation table.
- Reference this spec + its plan.

## Guardrails

- Token-first: `popoverReveal` lands in `motiontokens.ts` before any site uses it.
- Opacity/scale only; no x/y (perf + consistency with `cardVariants`).
- `PopoverReveal` abstracts motion only, never positioning — callers keep their `absolute`/z-index
  classes and backdrop.
- No new durations/eases/keyframes.
