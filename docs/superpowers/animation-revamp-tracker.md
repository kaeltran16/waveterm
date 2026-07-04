# App-wide animation revamp — tracker

> Living tracker for the cockpit-app motion revamp. One vocabulary, one token source,
> rolled out surface by surface. Update the status table as each surface lands.

Last updated: 2026-07-04

## Goal

A single, coherent motion layer across every surface of the app, built on **one shared
token source** instead of accreted per-component keyframes. The baseline strip in
`a1a2889d` (removed `fadeUp`/`float-up`/typing-blink/dead `caret`; kept only `Reorder`
drag + `pulseDot`) was explicit prep for exactly this — one revamp, not scattered motion.

## North star (applies to every surface)

- **Functional-first.** Motion must make a state change more legible. Rejection test for
  any candidate animation: *does it make a state change more legible?* If no, it does not
  ship. Delight only rides on top of functional motion, never standalone decoration.
- **Feel = Fluid / calm.** Macro moments ~360ms on `cubic-bezier(0.22, 1, 0.36, 1)`;
  micro ~140ms; exits ~280ms (leave a touch quicker than they arrive).
- **No new vocabulary per surface.** New surfaces *reuse* the tokens and moment patterns
  below. If a surface genuinely needs a new primitive, add it to the token module first,
  then use it — never inline a one-off duration/ease/keyframe.
- **Reduced-motion is not optional.** Every surface honors it (`<MotionConfig
  reducedMotion="user">` for Framer + `motion-reduce:animate-none` on CSS loops).
- **No entrance cascade.** `initial={false}` at the `AnimatePresence`/list level so
  mounting a populated view does not fire N staggered entrances — only items that arrive
  *after* mount animate.

## Shared foundation (the single source of truth)

| Artifact | Role |
|---|---|
| `frontend/app/element/motiontokens.ts` | Durations (`durMacro`/`durMicro`/`durExit`), `easeFluid`, and variant presets (`cardVariants`, `reorderLift`, `composerReveal`) + the `shouldFadeEntry` burst guard. **Import from here; do not inline motion values.** |
| `frontend/tailwindsetup.css` | CSS-only ambient loops: `@keyframes pulseDot`, `breatheGlow`, `settle`. Token-colored via `color-mix(... var(--color-*) ...)` — no raw hex. |
| `frontend/app/element/motiontokens.test.ts` | Guards token values + the burst-guard helper. |
| `frontend/app/element/collapsiblerail.tsx` | Reusable right-rail (icon strip ↔ 300px scroll panel) shared by Cockpit/Agent/Channels; owns the rail-reveal moment + fixes titlebar/rail divider alignment by construction. |

Framer (`motion/react`, v12) is the default tool; CSS is the fallback **only** for
perpetual ambient loops (glow, pulse) and pre-existing hover/press micro-transitions.

## The moment vocabulary (reference patterns to reuse)

These eight moments were designed and shipped on the Cockpit tab. Other surfaces map
their own state changes onto this same vocabulary.

| # | Moment | Tool | Reusable primitive |
|---|---|---|---|
| 1 | Item entrance | Framer | `cardVariants` (opacity+scale only — never x/y) |
| 2 | Item exit + list reflow | Framer | `<AnimatePresence mode="popLayout">` + `exit` variant + `layout` |
| 3 | Attention / "needs you" | CSS | `breatheGlow` (persistent, token-amber, until resolved) |
| 4 | Completion settle | CSS | `settle` (one-shot soft scale on finish) |
| 5 | Streaming text line | Framer | opacity-only fade + `shouldFadeEntry` burst guard |
| 6 | Inline reveal (composer/panel) | Framer | `composerReveal` (height+opacity) |
| 7 | Status pulse + micro | CSS | `pulseDot` (unified 1.6s) + kept hover/press |
| 8 | Drag lift + drop | Framer | `reorderLift` (`whileDrag`) + `dragTransition` drop-settle |

## Surface rollout

Surfaces are the switchable views (`SurfaceKey` order in `cockpitsurface.tsx`), plus
cross-surface transitions and shared modals.

| Surface | Status | Notes |
|---|---|---|
| **Cockpit** | ✅ Shipped `b3ccce07`; chrome gaps + shared rail (2026-07-03) | 8 card moments + rolling counts, section-header entrance, grid→footer handoff, CollapsibleRail. |
| Agent | ◐ Rail only | DETAILS rail now `CollapsibleRail` (alignment fixed, "just now idle" text fixed). Remaining: AgentTree roster entrance/reflow + AgentHeader status motion (m1/m2/m3/m4/m7). (m5 narration is moot — the center is the live TUI, not a narrated transcript; there is no inline composer on this surface, so m6 does not apply.) |
| Activity | ☐ Not started | Cross-project feed. Candidates: line entrance (m1/m5), no-cascade guard. |
| Channels | ✅ Shipped (2026-07-04) | Message entrance + no-cascade guard (`channelsmotion.ts`), streaming settle, escalation glow, rail selection micro + attention-dot pulse. |
| Sessions | ✅ Shipped (2026-07-03) | Chip-filter reflow (m2 popLayout), instant search, one-shot load reveal, empty-state fade. No hero (surface is header+search+chips+list). |
| Files / Diff | ✅ Shipped (2026-07-04) | Browse: file-list entrance/reflow (m1/m2) + no-cascade guard (shared, extracted to `motiontokens.ts`; source→key via `filesmotion.ts`), diff-pane crossfade (m5-style opacity), row selection micro (m7). Review: hunk/file completion settle (m4), progress-bar width transition, hunk-pane crossfade on file switch, applied-screen reveal (m1). One `<MotionConfig reducedMotion="user">` at the FilesSurface root. SHA: _pending Task 4/5 commits_. |
| Memory | ☐ Not started | Vault viewer + force-graph. Candidates: detail reveal (m6); graph has its own physics — audit for conflicts. |
| Usage | ☐ Not started | Bars/donuts. Candidates: value/bar transitions (m7 micro); avoid decorative-only motion. |
| **Cross-surface tab transitions** | ☐ Not started | Switching surfaces (`[`/`]`, rail). Design decision pending: crossfade vs. none. Must not fight per-surface entrances. |
| **Shared modals** (Settings, New Agent, Help) | ✅ Shipped (2026-07-03) | Backdrop fade + panel scale via `ModalShell`; generic `FlexiModal` stack animated; Settings excluded (surface); WhichKeyBar excluded. |

Legend: ✅ shipped · ◐ in progress · ☐ not started

## Guardrails / conventions

- Read `motiontokens.ts` before adding motion to a surface. Reuse; don't reinvent.
- `layout` only on container elements, never on streaming text nodes. Animate
  transform/opacity only (perf).
- CSS keyframes must be token-colored (`var(--color-*)` + `color-mix`) — no raw hex
  (project convention).
- Any live-drag / 1:1-with-pointer interaction stays un-eased (never animate the drag
  itself; only its aftermath — reflow, settle, snap).
- Each surface's landing = its own spec + plan (fold into that surface's feature commit),
  then flip its row here to ✅ with the commit SHA.

## References

- Cockpit design spec: `docs/superpowers/specs/2026-07-03-cockpit-motion-system-design.md`
- Cockpit implementation plan: `docs/superpowers/plans/2026-07-03-cockpit-motion-system.md`
- Baseline strip that prepped this work: commit `a1a2889d`
- Cockpit motion system shipped: commit `b3ccce07`
- CollapsibleRail + cockpit motion-gap design: `docs/superpowers/specs/2026-07-03-collapsible-rail-and-cockpit-motion-gaps-design.md`
- CollapsibleRail + cockpit motion-gap plan: `docs/superpowers/plans/2026-07-03-collapsible-rail-and-cockpit-motion-gaps.md`
- Channels motion design spec: `docs/superpowers/specs/2026-07-04-channels-motion-design.md`
- Channels motion implementation plan: `docs/superpowers/plans/2026-07-04-channels-motion-system.md`
- Files/Diff motion design spec: `docs/superpowers/specs/2026-07-04-files-diff-motion-design.md`
- Files/Diff motion implementation plan: `docs/superpowers/plans/2026-07-04-files-diff-motion-system.md`
