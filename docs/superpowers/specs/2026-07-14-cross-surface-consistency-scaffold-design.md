# Cross-Surface Consistency Scaffold — Design

**Date:** 2026-07-14
**Status:** Approved (design) — ready for implementation plan
**Topic:** UX cohesion — make the ~9 cockpit surfaces feel like one product

## Problem

The cockpit's top-level surfaces (`frontend/app/view/agents/*surface.tsx`) were built by
different specs over time. An audit of all nine found **no shared surface scaffold**:
`cockpitshell.tsx` is only a router (nav-rail + a `switch(surface)` that drops each surface into
`<div className="relative min-w-0 flex-1 bg-background">`). Every surface hand-rolls its own header,
container, and empty/loading/error treatment. Concretely:

- **~6 different header implementations.** Title sizes span `text-[15px]` (channels), `text-[16px]`
  (files), `text-[20px]` (cockpit), `text-2xl` (radar), `text-[25px]` (sessions/usage/memory),
  `text-[26px]` (settings); weights `font-bold` vs `font-extrabold`; padding differs on every surface;
  some have a bottom border, some don't.
- **Empty states** range from one rich component (`CockpitEmptyState`) to a reused local helper
  (files `EmptyCenter`) to 4+ bespoke inline `text-[13px] text-muted` one-liners
  (channels/sessions/memory) with divergent padding and copy. No common component.
- **Loading** is done three ways: shared `Skeleton` + a `*LoadedAtom` gate (usage/files/memory),
  ad-hoc inline `"Loading…"` strings (channels/sessions/reviewsurface), or nothing
  (cockpit/radar/agent).
- **Error state is essentially unhandled.** Only usage has a real load-error affordance
  (`usageErrorAtom` → warning banner). Others silently render empty or swallow (`.catch(() => {})`).
  The existing `ErrorBoundary` primitive is wired into no surface.
- **Two competing text-color scales** — `ink-hi/ink-mid/ink-faint` (mainly files + memory) vs
  `primary/secondary/muted` (nearly everything else) — applied with no rule.
- **Root containers diverge:** some `absolute inset-0`, some `flex h-full w-full`, some
  `flex h-full flex-col`; only some set their own `bg-background`.

Shared primitives that *do* exist and are reused: motion tokens (`motiontokens.tsx`), the low-level
`Skeleton`/`SkeletonLine` (`element/skeleton.tsx`), `SectionHeader` (a list-row, not a page header),
and `ErrorBoundary` (`element/errorboundary.tsx`, unused by surfaces).

## Goals

- One shared scaffold that new surfaces adopt by default, so consistency is **durable** (drift can't
  return) rather than a one-time sweep.
- A single canonical header, empty state, container convention, and text scale for surface chrome.
- Give the load-bearing surfaces a real (lightweight) error affordance instead of silent failure.
- No regressions on the two structurally-different surfaces (agent TUI, files 2-pane) or the
  2-pane channels surface — they adopt only the pieces that fit.

## Non-goals (out of scope; documented follow-ups)

- **Interaction-pattern consistency** — keyboard nav / selection model across surfaces. Separate pass.
- **Repo-wide `ink-*` deprecation** — remapping every `text-ink-*` in the ~50 child components
  (agentrow, channelrail, etc.). This spec standardizes only the surface *chrome* it touches;
  `ink-*` stays valid elsewhere. Full deprecation is a later sweep.
- **Navigation / information architecture** — surface grouping and the cockpit/agent/sessions overlap.
  Explicitly deferred (a different, higher-risk project).
- Big-bang forcing agent/files/channels onto a shared page header (rejected: high regression risk on
  the fragile TUI and the 2-pane layouts, marginal gain).

## Canonical decisions (locked)

1. **Text scale:** `primary` (titles) / `secondary` (body) / `muted` (de-emphasized). This is the
   majority scale already. `ink-*` is the minority scale and is *not* remapped repo-wide here.
2. **Header title:** `text-[25px] font-bold tracking-[-0.02em] text-primary` — the spec already shared
   verbatim by sessions, usage, and memory.
3. **Header container:** `flex flex-none items-start justify-between gap-5 bg-background px-[28px] pb-4 pt-5`,
   with `border-b border-border` toggleable (default on).
4. **Surface root container:** `flex h-full min-h-0 flex-col bg-background` — every surface sets its own
   `bg-background` so it renders correctly even if mounted outside the shell.
5. **Loading:** standardize on the existing `Skeleton`/`SkeletonLine` + a `*LoadedAtom` gate. No new
   loading component.

**Broadly-visible normalizations (accepted):** cockpit + channels titles move 20px → 25px; settings
26px/extrabold → 25px/bold; radar's Tailwind-scale header → the arbitrary-px canonical. These are
intentional, not incidental.

## Architecture

One new co-located file: `frontend/app/view/agents/surfacescaffold.tsx`, exporting the shared chrome
primitives plus the documented container convention. Thin presentational components over existing
`@theme` tokens and the existing `Skeleton`. No new folder, no new framework, no new state.

## Components

### `SurfaceHeader`

```ts
props: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;   // right-aligned slot (filter chips, toggles, buttons)
  border?: boolean;      // default true
}
```

Renders decision #3 above: title (#2), subtitle `text-[13px] text-muted`, `actions` in the right slot.
Replaces the six hand-rolled headers on the "full-migration" surfaces.

### `SurfaceEmptyState`

```ts
props: {
  glyph?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: { label: string; onClick: () => void; hint?: string };
}
```

Generalizes the existing `CockpitEmptyState` (centered layout + `cardVariants` motion entrance).
`CockpitEmptyState` is refactored to call `SurfaceEmptyState` with its terminal-glyph + copy as props —
**no visual change to cockpit** — so sessions/memory/radar/placeholder can share the same component.

### `SurfaceError`

```ts
props: { message: string; onRetry?: () => void }
```

A minimal inline banner modeled on Usage's existing `usageErrorAtom` treatment — for the load-bearing
surfaces that currently fail silently. Deliberately lightweight (banner + optional retry), not a
per-surface error-model redesign.

### Loading (no new component)

Widen adoption of `Skeleton`/`SkeletonLine` + a `*LoadedAtom` gate to the surfaces that currently show
a bare `"Loading…"` string (channels, sessions, reviewsurface). Usage/files/memory already do this.

## Migration matrix

| Surface | Header | Empty | Loading | Error | Container |
|---|---|---|---|---|---|
| cockpit | `SurfaceHeader` (20→25px; filter chips → `actions`) | refactor to shared `SurfaceEmptyState` (no visual change) | — | — | conform |
| radar | `SurfaceHeader` (`text-2xl` → canonical) | keep `RadarScanStatePanel` | keep | add `SurfaceError` | conform |
| sessions | `SurfaceHeader` | `SurfaceEmptyState` | adopt `Skeleton` gate | add `SurfaceError` | conform |
| usage | `SurfaceHeader` (add border-b) | — | keep (already `Skeleton`) | keep (reference impl) | conform |
| memory | `SurfaceHeader` | `SurfaceEmptyState` | keep | add `SurfaceError` | conform |
| settings | `SurfaceHeader` (26/extrabold → canonical) | n/a (static form) | — | keep (field validation) | conform |
| placeholder | — | becomes `SurfaceEmptyState` | — | — | conform |
| **agent** | partial — no page header (full-bleed TUI); tokens + keep launch hero | keep hero | — | — | add `bg-background` |
| **files** | partial — header stays in the 2-pane sidebar; tokens + `EmptyCenter` → `SurfaceEmptyState` | shared | keep skeletons | add `SurfaceError` | keep |
| **channels** | partial — keep 2-pane `ChannelHeader` (per-channel chrome, not a page header); tokens + empty/error | `SurfaceEmptyState` | add `Skeleton` gate | add `SurfaceError` | keep |

Full migration: cockpit, radar, sessions, usage, memory, settings, placeholder (7).
Partial (tokens + fitting pieces only): agent, files, channels (3).

## Data flow

Purely presentational. No new atoms, no new RPC. Each surface keeps its own data atoms; the scaffold
only standardizes *how* title/subtitle/actions/empty/error/loading render. The single standardized
state pattern is the loading gate (`*LoadedAtom` → Skeleton vs content), already the convention on
usage/memory.

## Error handling

Give sessions, memory, radar, channels, and files a real error affordance via `SurfaceError` where an
RPC/load can fail, replacing the current silent `.catch(() => {})` / empty render. Usage stays the
reference implementation. Scope is deliberately narrow — surface the error and offer retry; do not
redesign each surface's error model.

## Testing & verification

The cockpit has **no jsdom/render-test harness** (CLAUDE.md — UI is verified via CDP screenshots).
Therefore:

- Scaffold components stay dumb/presentational; any class-composition logic worth testing is extracted
  into a pure helper covered by `vitest`.
- `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` stays clean (baseline is clean).
- `npx vitest` stays green.
- **CDP visual verification is a required step**, not optional: before/after screenshots of each
  migrated surface over `:9222` (`node scripts/cdp-shot.mjs`), given the repo's recurring
  "shipped CDP-unverified" pattern. Inject populated state first where needed
  (`node scripts/inject-live-agents.mjs`).

## Follow-ups (deferred, tracked)

- Interaction-pattern consistency (keyboard nav / selection model).
- Full `ink-*` → `primary/secondary/muted` deprecation across child components.
- Navigation / IA rethink (surface grouping, cockpit/agent/sessions overlap).
