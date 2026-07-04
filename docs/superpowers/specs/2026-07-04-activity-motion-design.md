# Activity surface motion — Design

Date: 2026-07-04
Surface: **Activity** (`frontend/app/view/agents/activitysurface.tsx`), a surface in the app-wide
animation revamp (`docs/superpowers/animation-revamp-tracker.md`). Reuses the cockpit motion tokens
(`frontend/app/element/motiontokens.ts`) — no new durations/eases/keyframes. Promotes one existing pure
helper (`reflowProps`) from `sessionsmotion.ts` into the shared token module so a second surface can use it.

## Problem

The Activity surface is a cross-project event feed with **zero** motion. The list snaps in when it loads,
and clicking a type-filter chip (`Asked` / `Errored` / …) hard-cuts the whole feed to a different subset —
whole project groups vanish and the rest jump up with no continuity. Against a Sessions surface that reflows
its list on chip filter (`b3ccce07`-era work) and a Channels feed that animates, Activity reads as inert, and
the filter's effect is illegible: you can't see *what* the chip removed or kept.

## Surface as-built

A single scrolling column (`max-w-[820px]`): a header, a row of filter chips (`All events`, `Asked`,
`Errored`, `Committed`, `Started`, `Finished`), then the feed **grouped by project**. Each group is a
header (project name, a divider, an optional amber "`N` need you" badge counting `asked` events, a total
count) followed by its event rows (relative time, a type-colored dot, `agentName` + summary text, a type
label, and — for a live session only — a `Jump →` button). Empty state: "No recent activity."

Two facts shape what motion is possible:

1. **The feed is a snapshot.** `loadActivity` runs once on mount (`useEffect([model])`); there is no
   polling or streaming. `activityEventsAtom` is module-level, so it persists across surface remounts — it
   is empty only on the first-ever visit, populated thereafter. There is **no** steady-state "new event
   arrived" moment.
2. **The only user-driven mutation is the filter chip.** `applyFilter` narrows the event set by type;
   `groupByProject` re-derives groups. So filtering changes the feed at **two nesting levels** — project
   groups appear/disappear, and rows within surviving groups appear/disappear.

Locked by brainstorm (`Snapshot-only` scope): motion covers what actually changes — the async load and the
filter reflow. No polling / per-row live-arrival entrance is added (that would be a data-layer feature, out
of scope). `activitystore.ts` / `activityevents.ts` are untouched.

## North star (inherited from the revamp)

**Motion is functional first: it must make a state change more legible.** The genuine state changes here are
*the feed finished loading* and *you refiltered by type*. Each maps to an existing moment; nothing decorative
is added. No entrance cascade on mount. Reduced motion honored.

## Locked decisions (from the brainstorm)

- **Scope = snapshot-only.** Two moments: a one-shot **load reveal** (container fade) and **filter reflow**
  (m2) at both the group and row level. No live feed, so no m1/m5 per-row arrival entrance and no no-cascade
  streaming guard — those are moot without arrivals-after-mount.
- **First populate is silent; only chip refilters animate rows.** The async load fades the *container* once;
  it must not fire a per-row cascade. Per-row/-group enter/exit turns on only after the first chip click.
- **No attention glow on the "N need you" badge.** These are *historical* events — Jump is live-only, so an
  ask cannot be resolved from this surface. A persistent `breatheGlow` would be false signal, not a legible
  actionable state. Excluded on functional-first grounds.
- **No live-dot pulse / per-row entrance.** No live feed to justify it.
- **Reduced motion** via `<MotionConfig reducedMotion="user">` at the surface root (Framer drops the scale
  offset; the load fade degrades to opacity, which reduced-motion also neutralizes to instant).

### Out of scope

- **Polling / live event arrivals.** Data-layer feature; belongs in its own task. If added later, the shared
  no-cascade guard (`computeEntrances` in `motiontokens.ts`) is the tool, exactly as Channels/Files use it.
- **`Jump →` cross-surface navigation.** Jumping to the Agent surface is a surface switch; that motion
  belongs to the tracker's *Cross-surface tab transitions* row.
- **Chip hover/press, empty-state.** Hover/press micro is pre-existing and unchanged. The empty state is a
  single static line — no motion.
- **Search-vs-chip split.** Sessions needed it (search updates instantly, chips reflow). Activity has no
  search box, so the only animated path is the chip; no instant path to branch for.

## Moment mapping

Onto the revamp's existing eight-moment vocabulary:

| Activity state change | Moment | Primitive |
|---|---|---|
| Feed finishes its async load | — (one-shot reveal) | container opacity fade at `durMacro`/`easeFluid` (Sessions load-reveal) |
| Chip refilters → groups appear/disappear | m2 (list reflow) | `AnimatePresence mode="popLayout"` + `layout` on group wrappers |
| Chip refilters → rows appear/disappear | m2 (list reflow) | nested `AnimatePresence popLayout` + `layout`, rows keyed by `e.id` |
| First populate | — (silent by design) | `initial={false}` on rows/groups until the first chip click |

## Mechanism

### 1. Scaffold

Wrap `ActivitySurface`'s returned tree (the outer `absolute inset-0 overflow-y-auto`) in
`<MotionConfig reducedMotion="user">`. Framer then keeps opacity and drops scale/transform offsets under
reduced motion with no per-variant work.

### 2. Shared primitive — promote `reflowProps` to `motiontokens.ts`

`reflowProps(animated)` (currently `frontend/app/view/agents/sessionsmotion.ts`) maps a boolean to the
Framer props a reflowing list item spreads: `{ initial, exit, transition }` — `"initial"`/`"exit"`/
`durMacro` when animating, or `false`/`undefined`/zero-duration for a silent snap. A second surface now
uses it, so move `reflowProps` + `ReflowProps` into `motiontokens.ts` (single source of truth, same
extraction already done for `computeEntrances`). `sessionsmotion.ts` becomes a thin re-export so Sessions'
import path is unchanged (mirrors `channelsmotion.ts`).

### 3. Load reveal

A `mountedEmpty` flag captured once at mount via `useState(() => events.length === 0)`. The feed container
gets `initial={mountedEmpty ? { opacity: 0 } : false}` / `animate={{ opacity: 1 }}` at
`durMacro`/`easeFluid`. First-ever visit: the atom is empty at mount → fade in when it populates. Revisits:
the atom is already populated at mount → no fade (even though `loadActivity` re-sets the atom, the flag was
captured at mount and does not re-trigger). Verbatim reuse of Sessions' load-reveal.

### 4. Filter reflow — m2 (two levels)

A `reflowAnimated` flag starts `false`; every chip click sets it `true`. `const rp = reflowProps(reflowAnimated)`.

- **Groups:** `<AnimatePresence mode="popLayout" initial={false}>` around `groups.map(...)`; each group is a
  `motion.div key={g.project} layout variants={cardVariants} initial={rp.initial} exit={rp.exit}
  transition={rp.transition} animate="animate"`. When a filter drops every event in a project, that group
  exits; survivors reflow via `layout`.
- **Rows:** inside each group, `<AnimatePresence mode="popLayout" initial={false}>` around `g.events.map(...)`;
  each row is a `motion.div key={e.id} layout variants={cardVariants} initial={rp.initial} exit={rp.exit}
  transition={rp.transition} animate="animate"` wrapping the existing row markup.

`cardVariants` is opacity+scale only (no x/y — guardrail); `layout` sits only on the group/row **wrappers**
(containers, never text nodes). Because `reflowAnimated` is `false` on first populate, `rp.initial` is
`false` → no per-row/-group cascade; the container fade (#3) covers the first paint. After the first chip
click every group/row enter/exit animates. Rows keyed by the stable `e.id` (`${sessionPath}#${index}`) so a
row that survives a refilter reconciles in place and only truly-removed rows exit.

The per-second `nowAtom` re-render (relative-time labels) does not move layout, so it triggers no spurious
`layout` animation.

## Isolation / boundaries

- **No new logic.** The only extracted code is the existing pure `reflowProps`, relocated (its unit coverage
  moves/extends with it); everything else is declarative Framer wiring.
- **`cardVariants` / `reflowProps` stay the single source of list feel** — Activity reuses them verbatim; the
  `reflowAnimated` flag toggles *whether* enter/exit plays, never *what* it looks like.
- **No store, action, data, or token-value changes.** `activitystore.ts`, `activityevents.ts`, and the token
  *values* are untouched; `motiontokens.ts` only gains the relocated `reflowProps`.

## Reduced motion & no-cascade (revamp guardrails)

- **Reduced motion:** `<MotionConfig reducedMotion="user">` drops scale/transform for the reflow and
  neutralizes the load fade. No CSS keyframe loops are added on this surface.
- **No cascade:** `reflowAnimated` starts `false`, so first mount / first populate fires zero group or row
  entrances; the container fades once instead. `AnimatePresence initial={false}` is the second belt.

## Testing

- **Unit (vitest):** extend `frontend/app/element/motiontokens.test.ts` to cover the relocated `reflowProps`
  — the `animated: true` branch returns `"initial"` / `"exit"` / `durMacro`+`easeFluid`; the `animated:
  false` branch returns `false` / `undefined` / zero-duration. The existing `sessionsmotion.test.ts` stays
  as-is (it now exercises the re-export path). This mirrors `computeEntrances`, which is covered in both
  `motiontokens.test.ts` and the re-export's `channelsmotion.test.ts`.
- **Visual (CDP screenshot harness on the live dev app):** first-ever load → feed fades in as one block (no
  per-row cascade); click a type chip → non-matching project groups exit and rows reflow up; click back to
  `All events` → groups/rows animate back in; revisit the surface → populated feed appears with no re-fade;
  reduced-motion degrades to instant. No jsdom render harness exists for the cockpit (per `CLAUDE.md`) — use
  `scripts/inject-live-agents.mjs` + `scripts/cdp-shot.mjs`.

## Files

| File | Change |
|---|---|
| `frontend/app/element/motiontokens.ts` | Add relocated `reflowProps` + `ReflowProps` (moved from `sessionsmotion.ts`). |
| `frontend/app/view/agents/sessionsmotion.ts` | Becomes a thin re-export of `reflowProps` / `ReflowProps` from `motiontokens.ts` (import path for Sessions unchanged). |
| `frontend/app/view/agents/activitysurface.tsx` | `MotionConfig` wrap; `mountedEmpty` load-reveal on the feed container; `reflowAnimated` flag set on chip click; group + nested row `AnimatePresence mode="popLayout" initial={false}` with `motion.div` wrappers (`cardVariants` + `layout` + `reflowProps`). |
| `frontend/app/element/motiontokens.test.ts` | Extend to cover `reflowProps` both branches (co-located with its new home; `sessionsmotion.test.ts` unchanged, now exercises the re-export). |

## Tracker update

On landing, flip the **Activity** row in `docs/superpowers/animation-revamp-tracker.md` to ✅ with the commit
SHA and a one-line note (load reveal + two-level filter reflow via `reflowProps` promoted to `motiontokens`).
