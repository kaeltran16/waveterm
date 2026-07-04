# Memory surface — motion design

Date: 2026-07-04
Surface: **Memory** (`frontend/app/view/agents/memorysurface.tsx`, `memgraph.tsx`)
Part of: app-wide animation revamp (`docs/superpowers/animation-revamp-tracker.md`)

## Context

Memory is the vault viewer: a header (search + Graph/List toggle + New), a `SyncStrip`, a
main pane that shows **List** or **Graph**, and a persistent 330px `DetailRail`.

The data is **snapshot-driven**: `loadMemory()` scans the vault once on mount and re-scans
after every mutation (save / create / delete / harvest). There is **no live fsnotify watch**
(`memstore.ts` header). This puts Memory in the Files/Sessions/Activity family — animate
**load + mutations + selection**, keep **search instant** — not the Agent/Channels live-feed
family.

The graph (`memgraph.tsx`) is a `react-force-graph-2d` d3-force sim that already owns its own
motion: damped warmup/cooldown settle, animated `zoomToFit`, and a label fly-in gated on
`onEngineStop`. Framer `layout`/entrance variants on the canvas or its nodes would fight the
sim, so graph motion is deliberately minimal.

## North star (inherited, unchanged)

Functional-first (motion must make a state change more legible); feel = Fluid/calm
(`durMacro` 360ms, `durMicro` 140ms, `durExit` 280ms on `easeFluid`); **no new vocabulary**
(reuse `motiontokens.ts` + `motionhooks.ts`); reduced-motion honored; **no entrance cascade**.

## Reused primitives (no new module)

Memory mirrors the **Sessions/Activity** grouped-list idiom exactly (they are its structural
twins): a `reflowProps(animated)` flag drives silent-vs-animated list changes, and a
`mountedEmpty` `useState` latch drives the one-shot load reveal. There is **no**
`computeEntrances` guard — the flag defaulting `false` on the populated mount *is* the
no-cascade guard (Sessions/Activity both rely on this).

| Primitive | Source | Used for |
|---|---|---|
| `reflowProps(animated)` | `motiontokens.ts` | silent search vs animated mutation reflow (drives `initial`/`exit`/`transition`, incl. `layout` duration) |
| `cardVariants` | `motiontokens.ts` | list row entrance/exit (m1/m2) |
| `MOTION` (`durMacro`/`durExit`/`easeFluid`) | `motiontokens.ts` | container load reveal + inline opacity crossfades (pane swap, detail content, edit swap) |
| `useSettle(done)` | `motionhooks.ts` | graph settle cue (m4) on sim cooldown |
| `<MotionConfig reducedMotion="user">` | `motion/react` | reduced-motion contract at the surface root |
| `mountedEmpty = useState(() => notes.length === 0)` | (idiom) | one-shot list load reveal, computed at surface mount |
| `animate-[settle_0.5s_ease-out] motion-reduce:animate-none` | `tailwindsetup.css` | applies the `settle` keyframe (reduced-motion handled by the Tailwind variant) |

**No new tokens or helpers.** The three opacity-only crossfades (pane swap, detail content,
edit swap) are the m5 idiom Files/Sessions already use inline; Memory inlines the same shape
with `MOTION` values. Promoting a shared named `fadeVariants` is deferred until a third
*surface* needs it (YAGNI) — not in this scope, and shipped Files code is left untouched.

One small piece of new **state** (not a motion primitive): a module-level
`memReflowAnimatedAtom` in `memstore.ts` so the mutation paths (create/delete/harvest — which
live in child components) can signal "animate the next re-scan" up to the surface, exactly as
Sessions' chip handlers call `setReflowAnimated(true)` locally. The search box sets it `false`.

## Moment map

### List pane

- **m1 load reveal** — one-shot container fade on first populate. A `mountedEmpty` latch
  (`useState(() => notes.length === 0)`) computed **at the `MemorySurface` level** wraps the
  list body in a `motion.div` that fades `opacity 0→1` on `durMacro`. Because `memNotesAtom` is
  module-level and persists across surface remounts, `mountedEmpty` is true only before the
  first-ever load; a tab re-entry with cached notes mounts non-empty and the reveal is
  suppressed. Surface-level (not pane-level), so a Graph→List toggle does not replay it.
- **m1/m2 entrance + exit + reflow** — rows use `cardVariants` inside
  `<AnimatePresence mode="popLayout" initial={false}>` with `layout`, grouped by scope
  (two-level, exactly like Activity). All motion props come from `rp = reflowProps(reflowAnimated)`.
- **Search = instant, mutations = animated** — a single `reflowAnimated` boolean gates
  everything, mirroring Sessions:
  - `reflowAnimated` starts `false` → the populated mount fires no cascade (the load-reveal
    fade covers first appearance).
  - The search box `onChange` sets it `false` → `rp` yields `initial={false}`,
    `exit={undefined}`, `transition={{duration:0}}` — so filtered rows (and the `layout`
    reflow) snap instantly; typing never strobes.
  - A mutation (create/delete/harvest) sets it `true` (via `memReflowAnimatedAtom`, since those
    handlers live in child components) → the next re-scan animates: new rows enter with
    `cardVariants`, deleted rows play the exit, siblings reflow on `layout`.
  - The flag is not reset after a mutation; the only subsequent list changes are another
    mutation (wants `true`) or a search keystroke (sets `false`), so leaving it is correct.
- **m7 selection micro** — the row already has `hover:border-edge-strong`; add
  `transition-colors` (with `MOTION.durMicro`-equivalent Tailwind duration) so selecting a note
  eases the border/background highlight rather than hard-cutting it.

### DetailRail

The rail is always mounted; its contents change on selection (async body load:
`null → "Loading…" → content`) and on Edit toggle.

- **m5 content crossfade on select** — the rail's content block is wrapped in
  `<AnimatePresence mode="wait">` and keyed on a composite `${selectedId}:${body==null?"load":"ready"}`
  so it crossfades (opacity-only, `durMacro` in / `durExit` out) both when the selection changes
  *and* when the async body resolves (`Loading… → content`), smoothing the load pop. The
  **Related-memory** list and the **Empty→content** placeholder ride *inside this same block*
  (they change with selection) — no separate machinery.
- **Edit ↔ view swap** — the same opacity crossfade idiom (`AnimatePresence mode="wait"`, keyed
  on `editing`) swaps the textarea for the rendered markdown, so the mode change reads as a
  calm crossfade rather than an instant substitution. (Opacity, not `composerReveal`'s
  height animation: the textarea and rendered block occupy similar space, so a height reveal
  would add jank without adding legibility.)

### Graph pane

- **Entrance** — the toggle crossfade (below) *is* the graph's entrance. No separate container
  fade is stacked on top (that would be the double-animation the north star forbids).
- **m4 settle cue** — a `cooled` `useState` flips `true` in the sim's existing `onEngineStop`
  (reset to `false` when `data` changes, alongside the existing `fitted`/`settled` reset);
  `useSettle(cooled)` then plays `animate-[settle_0.5s_ease-out] motion-reduce:animate-none` once
  on the graph container when the physics cools. Reduced-motion is handled by the `motion-reduce`
  Tailwind variant (same as every other `useSettle` site).
- **Physics untouched** — the sim is already damped (`d3VelocityDecay 0.5`,
  `d3AlphaDecay 0.035`, `warmupTicks 30`, `cooldownTime 4000`). Params are nudged **only if
  the settle reads as bouncy on inspection**, not preemptively.

### Toggle (List ↔ Graph)

- **Crossfade** — `<AnimatePresence>` keyed on `view`, opacity-only, `durMacro`. Owns the pane
  swap. Because each pane's own entrance is one-shot-per-mount, toggling never double-fires an
  entrance underneath the crossfade.

### Reduced motion

- One `<MotionConfig reducedMotion="user">` at the `MemorySurface` root disables all Framer
  motion (load reveal, list reflow, crossfades, toggle) when the OS setting is on. The graph's
  CSS `settle` keyframe is disabled by its `motion-reduce:animate-none` variant.

## Out of scope

- **NewMemoryModal** — modals are covered by the shipped shared-modals surface (`ModalShell`).
  Not re-animated here.
- **SyncStrip** — no dedicated moment this phase.
- **Graph physics rework** — only the settle cue + conservative param check; no re-layout,
  no Framer-driven node motion.
- **`fadeVariants` promotion to `motiontokens.ts`** — deferred (YAGNI); Files stays untouched.

## Success criteria

- Mounting the populated Memory surface fires **no** entrance cascade (guard verified).
- Typing in search does not strobe (instant filter, no enter/exit).
- Creating/harvesting a note animates the new row in; deleting animates the row out + reflow.
- Selecting a note crossfades the detail body (no hard "Loading…" pop).
- Toggling List/Graph crossfades the pane without a second entrance firing underneath.
- Graph physics feel unchanged except a single calm settle on cooldown.
- With OS reduced-motion on, all of the above degrade to no-op / instant.
- No new motion tokens, helpers, or module added; all values sourced from `MOTION`.

## References

- Tracker: `docs/superpowers/animation-revamp-tracker.md`
- Files/Diff motion design (nearest structural precedent): `docs/superpowers/specs/2026-07-04-files-diff-motion-design.md`
- Activity motion design (two-level grouped reflow, load reveal): `docs/superpowers/specs/2026-07-04-activity-motion-design.md`
- Usage motion design (`useDidBecomeTrue` load reveal): `docs/superpowers/specs/2026-07-04-usage-motion-design.md`
- Shared tokens: `frontend/app/element/motiontokens.ts`, `frontend/app/element/motionhooks.ts`
