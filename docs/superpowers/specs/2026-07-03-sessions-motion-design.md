# Sessions surface motion — Design

Date: 2026-07-03
Surface: **Sessions** (`frontend/app/view/agents/sessionssurface.tsx`), a surface in the app-wide
animation revamp (`docs/superpowers/animation-revamp-tracker.md`). Reuses the cockpit motion tokens
(`frontend/app/element/motiontokens.ts`) — no new tokens, no new files.

## Problem

The Sessions surface is a hard cut. The archive of past sessions loads once, renders as a static list,
and every state change after that is instantaneous: the list snaps into existence when data arrives, rows
snap out of the list when a filter narrows it, and the "No sessions found" message appears with no
transition. Against a cockpit that now moves with intent (`b3ccce07`), the surface reads as inert.

## Surface as-built (not as the tracker sketched it)

The tracker's candidate note said "Resume hero + list." That hero does not exist. The surface as built is:
page header → search input → two rows of filter chips (runtimes, projects) → a bordered list of session
rows (runtime badge, task, meta line, age, Resume button / read-only tag). This design targets the surface
that actually ships.

Two facts shape what motion is even possible here:

1. **Data loads once.** `loadSessionsArchive` fires on mount and writes a module-level atom
   (`sessionsArchiveAtom`). There are no live arrivals and no server push — nothing enters or leaves the
   list except through user filtering.
2. **The surface remounts on every tab switch** (`cockpitshell.tsx` conditionally renders it), but the atom
   is module-scoped, so on re-entry the data is already present — the list renders immediately with no
   loading flash.

## North star (inherited from the revamp)

**Motion is functional first: it must make a state change more legible.** The one genuine state change on
this surface is *filtering* — the user toggles a chip and the list narrows. Motion makes "what survived the
filter" legible instead of a jump-cut. Everything else (load arrival, empty state) gets at most a single
subtle fade so the surface stops feeling inert, never a decorative flourish, and never an entrance cascade.

## Locked decisions (from the brainstorm)

- **Chips animate, search is instant.** Toggling a runtime/project chip animates the reflow (rows fade/scale
  out and in, list settles). Typing in the search box updates the list instantly — no per-row exit — so
  fast typing cannot strobe. Rationale: chip toggles are discrete, intentional acts worth making legible;
  search-as-you-type changes membership on every keystroke and animating it reads as busy, not legible.
- **Load reveal = one-shot container fade.** When the list data first arrives, the whole list container
  fades in once (a single opacity fade, **not** a per-row cascade). Revisiting the surface with cached data
  does **not** re-fade.
- **Empty-state fades in.** The "No sessions found" message fades/scales in (`cardVariants`) when a filter
  yields nothing. The "Loading…" text stays instant.
- **No entrance cascade.** Mounting a populated list fires zero staggered row entrances (`initial={false}`).
- **Reduced motion honored** via `<MotionConfig reducedMotion="user">`.

### Out of scope

- **Resume → surface switch.** Clicking Resume launches/focuses an agent and switches surfaces; that
  cross-surface motion belongs to the tracker's *Cross-surface tab transitions* row, not here.
- **Filter chip micro-interactions.** Chips keep their existing hover/press styling. Their active-state class
  swap stays instant. No new chip motion (that is the Channels row's "rail selection micro").
- **New tokens or shared primitives.** No `<MotionList>` extraction — the only shared part is a ~5-line
  wrapper and the row bodies differ per surface. Extract later if a real pattern emerges across surfaces
  (YAGNI).

## Moment mapping

Onto the revamp's existing eight-moment vocabulary:

| Sessions state change | Moment | Primitive |
|---|---|---|
| Filter chip toggle → list reflow | m2 (item exit + list reflow) | `<AnimatePresence mode="popLayout">` + `cardVariants` exit + `layout` |
| Empty state appears | m1 (item entrance) | `cardVariants` |
| Load arrival (loading → loaded) | m1 variant (one-shot container reveal) | opacity fade at `MOTION.durMacro` |
| Search typing | — (instant by design) | gated off (see mechanism) |

## Mechanism

All motion lives in `sessionssurface.tsx`. Structure changes:

**1. Scaffold.** Wrap the returned tree in `<MotionConfig reducedMotion="user">`. Under reduced motion,
Framer keeps opacity and drops the scale/transform offset automatically — no per-variant work.

**2. Row list — two nested layers.** A single `motion.div` cannot serve both the one-shot load reveal
(needs a `durMacro` opacity transition) and the gated layout reflow (needs `duration: 0` on search) — one
`transition` prop cannot be both. So:

- **Outer reveal wrapper** — a `motion.div` that animates opacity only (see #4). No `layout`.
- **Inner list box** — a `motion.div layout style={{ position: "relative" }}` carrying the existing
  `overflow-hidden rounded-[12px] border …` classes, with `transition` gated by `reflowAnimated` (so its
  height eases on chip reflow, snaps on search). `position: relative` is required: `popLayout` pops the
  exiting row to `position: absolute`, so the layout-animated parent must be a positioned context for the
  remaining rows to reflow.

Wrap the `shown.map(...)` in `<AnimatePresence mode="popLayout" initial={false}>` inside the inner box. Each
row becomes a `motion.div` with `key={`${s.runtime}:${s.id}`}` (already unique), `variants={cardVariants}`
and `layout`. Rows are `motion.div` directly (not custom components), so `popLayout`'s `forwardRef`
requirement does not apply.

**3. Chips-animate / search-instant gate.** A single `reflowAnimated` boolean, reused across all rows,
decided by the source of the last change:
- Chip handlers (`setRuntime` / `setProject`) also set `reflowAnimated = true`.
- The search `onChange` sets `reflowAnimated = false`.

Rows read the flag through props only — `cardVariants` is reused unchanged, and timing comes from the
`MOTION` tokens, so no motion values are inlined:
- `initial={reflowAnimated ? "initial" : false}` — gates the *enter* animation. When `false`, a row added
  during search appears instantly; the `cardVariants.animate` transition (`durMacro`) plays only when `true`.
- `exit={reflowAnimated ? "exit" : undefined}` — gates the *exit*. With `mode="popLayout"`, omitting `exit`
  removes the row instantly (Motion's documented way to gate exits per-change); when present, the
  `cardVariants.exit` transition (`durExit`) plays.
- `transition={reflowAnimated ? { duration: MOTION.durMacro, ease: MOTION.easeFluid } : { duration: 0 }}` —
  controls the `layout` **reflow** timing only. `layout` is not a variant, so it reads the component-level
  `transition` (variant-embedded transitions never apply to it); `{duration: 0}` makes the search-driven
  reflow snap. Enter/exit timing is unaffected by this prop — those come from the variants and are gated by
  `initial`/`exit` above.

The gate is a pure mapping from a boolean to that props set; that mapping is the unit-testable surface.

**4. Load reveal.** Capture the mount-time load state once:
`const [mountedEmpty] = useState(() => sessions == null)`. The **outer reveal wrapper** animates
`initial={mountedEmpty ? { opacity: 0 } : false}` → `animate={{ opacity: 1 }}` with a fixed
`transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}`. On the first-ever load the wrapper
mounts while `sessions == null` renders the loading branch, then fades in when data arrives; on any revisit
with cached data it mounts with `initial={false}` and does not fade. (Fixed transition here is correct — the
reveal is always `durMacro`; only the inner box's reflow is gated.)

**5. Empty state.** Render the "No sessions found" branch as a `motion.div` with `cardVariants`
(`initial="initial" animate="animate"`) so it fades/scales in when a filter empties the list. "Loading…"
stays a plain node.

## Isolation / boundaries

- **Single file of change:** `sessionssurface.tsx`. No store change, no token change.
- **The gate is the only new logic.** It is a pure function of "was the last change a chip?" → animation
  props. Everything else is declarative Framer wiring that mirrors `idlesection.tsx`.
- **cardVariants stays the single source of the card/list feel** — Sessions reuses it verbatim; the gate
  toggles *whether* it plays, never *what* it looks like.

## Reduced motion & no-cascade (revamp guardrails)

- **Reduced motion:** `<MotionConfig reducedMotion="user">` wraps the surface. Framer drops scale/transform
  and keeps opacity for the reveal, empty-state, and reflow. No CSS keyframe loops are added, so there is
  nothing to guard with `@media`.
- **No cascade:** `AnimatePresence initial={false}` guarantees a populated list (first load *or* cached
  re-entry) fires no staggered entrances. Only rows added/removed *after* mount — i.e. chip-driven reflow —
  animate.

## Testing

- **Unit (vitest):** extract the reflow gate as a small pure helper and assert it maps change-source →
  `{ initial, exit, transition }` correctly (chip → animated variants + fluid transition; search → `false` /
  `undefined` / `{duration: 0}`). Mirrors the `motiontokens.test.ts` precedent of guarding the one piece of
  real logic.
- **Visual (CDP screenshot harness on the live dev app):** loading→loaded container fade; chip toggle
  reflow; search typing instant (no row fade); empty-state fade; reduced-motion degrades to opacity-only.
  There is no jsdom render harness for the cockpit (per `CLAUDE.md`).

## Files

| File | Change |
|---|---|
| `frontend/app/view/agents/sessionssurface.tsx` | `MotionConfig` wrap; outer reveal wrapper + inner `layout` list box (`position: relative`); `AnimatePresence mode="popLayout" initial={false}`; rows → `motion.div` + `cardVariants` + `layout`; `reflowAnimated` gate on chip/search handlers; empty-state `motion.div`. |
| `frontend/app/view/agents/sessionsmotion.ts` + `.test.ts` | Pure `reflowProps(animated)` gate helper + unit test. |

## Tracker update

On landing, flip the **Sessions** row in `docs/superpowers/animation-revamp-tracker.md` to ✅ with the
commit SHA and a one-line note (reflow on chip filter, instant search, load reveal, empty-state fade).
