# Cockpit motion system — Design

Date: 2026-07-03
Surface: **Cockpit tab** (`frontend/app/view/agents/cockpitsurface.tsx` grid + `agentrow.tsx` card, with a shared `frontend/app/element/motiontokens.ts`)

## Problem

The cockpit deliberately stripped its motion vocabulary to a clean baseline in `a1a2889d` (removed `fadeUp`,
`float-up`, the typing blink, the dead `caret` keyframe; kept only the `Reorder` drag interaction and the
`pulseDot` status pulse; kept CSS hover/state micro-transitions and the `TileLayout` engine). That strip was
explicit prep for **one** app-wide animation revamp built on a single source of truth instead of accreted
per-component keyframes.

This spec is that revamp, scoped to its highest-value surface. The cockpit is the one place where **the app
changes under you** — an external agent silently flips `working → asking` and now needs you, a worker finishes,
a new card appears, narration streams in. Today those transitions are hard cuts. Motion should make them
legible at a glance.

## North star

**Motion is functional first: it must make a state change more legible.** The headline moment is *"an agent
needs you."* Every candidate animation faces one rejection test — *does it make a state change more legible?*
If no, it does not ship. Responsiveness (micro-feedback) is the always-on baseline; delight is allowed only
riding on top of functional motion, never as standalone decoration.

## Locked decisions (from the brainstorm)

- **Feel = Fluid / calm.** Macro moments ~360ms on `cubic-bezier(0.22, 1, 0.36, 1)` (a gentle ease-out).
  Micro-interactions stay fast (~140ms). "Asking" is a **persistent breathing amber glow** — it keeps
  signaling until the ask is answered, not a one-shot pulse. (Chosen over a snappy/functional feel and a
  springy/playful feel in the visual companion.)
- **Framer Motion is the default tool** (`motion/react`, v12 — already shipped for `Reorder`). CSS is the
  fallback **only** where Framer would be messy: perpetual ambient loops (the breathing glow, `pulseDot`) and
  the hover/press micro-transitions that already exist as CSS (no point rewiring those through JS).
- **Scope = the Cockpit tab only.** Other tabs and cross-surface transitions are a follow-up pass that
  *reuses* these tokens — no new vocabulary. Out of scope here.
- **Single source of truth for motion tokens** in `frontend/app/element/motiontokens.ts` (a design-system
  primitive so the later rollout imports it). Status colors and the two CSS-side timing values go through
  `@theme` tokens in `tailwindsetup.css` — no raw hex.
- **The resize *mechanism* stays where it lives** (`computeGridLayout` + `CardPref` + row-divider drag +
  "Reset layout", already shipped). This revamp owns the resize *aftermath* (reflow, reset-snap), not the
  interaction. Live-resize drag is direct (1:1 with the pointer) and is never eased.

## The eight moments

Each passes the "makes a state change legible" test.

| # | Moment | Tool | Mechanic |
|---|---|---|---|
| 1 | **Card entrance** | Framer | `Reorder.Item` gets `initial`/`animate` — fade + `translateY` + subtle scale, macro token. Fires only for agents that appear *after* mount (see §Edge cases). |
| 2 | **Card exit + grid reflow** | Framer | Wrap the `shownAgents.map` in `<AnimatePresence mode="popLayout">`; each item gets an `exit` variant and the `layout` prop, so when a card leaves the live set the survivors slide into the reflowed grid (true FLIP). Integrates with the existing weight-driven `gridTemplateRows`; also animates the **Reset layout** snap and enter/leave renormalization. |
| 3 | **Working → asking** | CSS | Toggle the amber breathing-glow keyframe + dot color via the existing `asking` class path (`agentrow.tsx` card + `StatusDot`). Persistent until answered. |
| 4 | **Finished settle** | Framer/CSS | There is **no `done` state** (`AgentState = asking \| working \| idle`); "finished" = `working → idle`. A brief settle on that transition acknowledges completion before the card exits to the idle/backgrounded footer (#2). Reuses existing colors; a distinct success accent is an open question (default: no new color). |
| 5 | **Narration line** | Framer | New transcript lines fade in. `initial={false}` so existing lines don't animate on card mount; **opacity-only** (no `layout` on text nodes); short ~150ms + a burst guard so rapid streaming doesn't strobe. |
| 6 | **Composer reveal** | Framer | Height/opacity expand when a card is focused to reply (`agentcomposer.tsx`). |
| 7 | **`pulseDot` + micro** | CSS | Fold the existing status pulse and kept hover/press transitions onto the shared tokens. Housekeeping — no new visible motion. |
| 8 | **Reorder lift + drop** | Framer | Polish the existing `Reorder` drag: a lift (scale/shadow) on grab and a drop-settle on release, on the shared tokens, so drag matches the Fluid feel. |

## Motion tokens (`frontend/app/element/motiontokens.ts`)

A single module, the design-system primitive:

- **Durations:** `macro` (~360ms), `micro` (~140ms), `exit` (~280ms — things leave a touch quicker than they arrive).
- **Easing:** `fluid = [0.22, 1, 0.36, 1]` (cubic-bezier control points, the form Framer wants).
- **Variant presets:** `cardEnter`, `cardExit`, `narrationLine`, and the shared `transition` object; plus the
  reorder lift/drop values.

The two CSS-only motions consume matching `@theme` custom properties in `tailwindsetup.css` (breathing-glow
period; `pulseDot` already exists there). Status colors (`--color-warning` for asking, `--color-accent` for
working, `--color-muted` for idle — already used by `StatusDot`) stay as tokens. This duplicates a couple of timing
values across TS and CSS; that is called out here and left un-abstracted (no generator) per YAGNI.

## Edge cases (these make or break it)

- **Reduced motion.** Wrap the cockpit surface in `<MotionConfig reducedMotion="user">` so Framer drops
  transforms (keeps opacity) for users who ask for it; guard the CSS-side glow/pulse with
  `@media (prefers-reduced-motion: reduce)`.
- **No entrance cascade on tab open.** `initial={false}` at the `AnimatePresence`/group level so mounting the
  tab with N live agents does **not** fire N entrances — only agents that arrive after mount animate in. Same
  guard for narration.
- **`layout` must not fight the live row-divider drag.** The existing drag updates `heightWeight` on every
  pointer-move; if `layout` tries to animate each frame the handle feels laggy. Suppress layout animation
  while a divider drag is active (e.g. a `dragging` flag that zeroes the layout transition), and re-enable it
  for enter/leave/reorder/reset. Live-resize stays 1:1.
- **Perf.** `layout` only on card containers, never on streaming text nodes; animate transform/opacity only.
- **Reorder + AnimatePresence interaction.** `Reorder.Item` manages its own layout; exits with `Reorder`
  need `mode="popLayout"` and must be validated (a known-finicky combination) — see Testing.

## Files touched (all frontend; no `task generate`, no backend/RPC)

| File | Change |
|---|---|
| `frontend/app/element/motiontokens.ts` | **New.** Durations, easing, variant presets, reorder lift/drop values. |
| `frontend/tailwindsetup.css` | Add breathing-glow `@keyframes` + a `@theme` var for its period; ensure a finished/settle path uses tokens; `pulseDot` unchanged. |
| `frontend/app/view/agents/cockpitsurface.tsx` | Wrap `shownAgents.map` (`:746`) in `<AnimatePresence mode="popLayout" initial={false}>`; add `<MotionConfig reducedMotion="user">`; thread a `dragging` flag into the row-divider handlers to gate layout animation. |
| `frontend/app/view/agents/agentrow.tsx` | `Reorder.Item` (`:230`) gets `layout` + `initial`/`animate`/`exit` from tokens; asking breathing-glow class; finished settle; reorder lift/drop on the `∷∷` `useDragControls` handle (`:232`). |
| `frontend/app/view/agents/statusdot.tsx` | Add a color `transition` for state changes (asking↔working↔idle); keep `pulseDot`. |
| narration renderer (`markdownmessage.tsx` / feed) + `frontend/app/view/agents/agentcomposer.tsx` | Moments 5–6: new-line fade (`initial={false}`, opacity-only, burst guard) and composer reveal. |

## Testing / verification

- **Unit (`npx vitest run`):** the token module (values + variant shape) and the narration **burst-guard**
  helper (kept as a pure function — animation itself isn't unit-testable).
- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline clean; any
  error is ours).
- **Visual (CDP, per CLAUDE.md):** inject fixtures and screenshot/observe each moment — entrance (new agent),
  exit + reflow (agent finishes → survivors slide), working→asking breathing glow, finished settle, narration
  line fade under a fast stream (no strobe), composer reveal, reorder lift/drop, Reset-layout snap. Verify
  `prefers-reduced-motion` via emulation (transforms drop, opacity remains) and confirm **no** entrance
  cascade when opening the tab with several live agents.

## Non-goals

- Other tabs (Channels/Activity/Files/Usage/Memory) and cross-surface tab transitions — follow-up pass,
  reuses these tokens.
- The resize *mechanism* (drag-dividers, `fullWidth`, weights) — already shipped; this revamp only animates
  its aftermath.
- Decorative / playful motion; no springy character (Fluid was chosen).
- No new agent state (no `done`/green) unless the open question below says otherwise.

## Open questions (resolve in the plan, not blocking)

- **Finished settle color (#4):** reuse the idle/muted color (minimal, default) or add a one-shot success
  accent `@theme` token for the completion beat? Leaning: reuse existing, keep it a settle only.
- **Narration burst guard threshold (#5):** animate only the last appended line vs. cap concurrent
  animations vs. disable per-line fade above an append-rate threshold. Decide during the CDP pass with a real
  fast stream.
- **Reorder exit robustness (#2/#8):** if `Reorder.Item` + `AnimatePresence mode="popLayout"` proves flaky,
  fall back to animating exit without popLayout (accept a small reflow jump). Decide during the CDP pass.

## Commit note

Per repo convention this spec + its plan fold into the feature commit, not a separate docs-only commit;
nothing is committed without explicit approval.
