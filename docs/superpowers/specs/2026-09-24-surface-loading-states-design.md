# Surface Loading States — Design

**Date:** 2026-09-24
**Status:** Shipped (run 28caa81f, 2026-09-24)
**Builds on:** `2026-07-14-cross-surface-consistency-scaffold-design.md` (decision 5: loading is the
existing `Skeleton`/`SkeletonLine` behind a load gate, no new loading component)

## Problem

Two separate defects, both reported:

1. **False empty states.** Some surfaces show an "empty" claim before their data has arrived. The claim is
   not true, and it is replaced a moment later:
   - **Radar**: `classifyScanState(null)` returns `"never-scanned"`, so while the scope is still being resolved,
     the report list is still being fetched, or the selected report's WaveObj has not arrived, Radar says the
     project was never scanned. A failed `ListRadarReportsCommand` is swallowed into `[]` (`loadReports`) or
     `null` (`findNewestScannedProject`), and that also renders as "never scanned".
   - **Code**: `CodeBody` shows "No project selected" while the stored project is being restored, and renders
     "Listing files…" through `SurfaceEmptyState`, so it looks the same as an empty state.
   - **Cockpit / Agent**: the roster (`liveAgentBaseAtom`) only includes terminals whose `agent:status` atom is
     set. After a reload, each atom is seeded from event history asynchronously (`readRetainedStatus`), so the
     roster starts empty. Cockpit shows `CockpitEmptyState` ("no agents") and Agent shows `AgentLaunchHero`
     until the seeds land.
2. **Inconsistent loading visuals.** Sessions, Usage, Diff and the Jarvis Brief use content-shaped
   skeletons. Twelve inner panes show a bare `Loading…` string in varying sizes and colors instead.

## Goals

- No surface or pane reports "empty", "never scanned", "no project" or "no agents" before its data has loaded.
- Every cockpit loading placeholder is a content-shaped skeleton built from `Skeleton`/`SkeletonLine`.
- A load failure shows as an error with a retry, not as empty.

## Non-goals

- Legacy Wave block views that are not cockpit surfaces: `block/subblock.tsx`, `element/quickelems.tsx`,
  `treeview/treeview.tsx`, `view/aifilediff/aifilediff.tsx`.
- Loading feedback for in-flight *actions* (rescan, refresh index, retry buttons).
- A minimum skeleton duration or show-delay. Existing skeletons have neither. Add one only if flicker is
  measured.
- Surfaces that are already correct are not touched: Sessions list, Usage, Diff, Jarvis Brief.

## Decisions

1. **"Loading" means there is no data yet, on first load only.** A refetch or revalidation keeps the current
   data on screen and never brings a skeleton back.
2. **Store convention:** `null` means not loaded yet, and `[]` or a value means loaded. A load failure goes to
   its own error atom and never becomes `[]`/`null`. This is the convention `sessionsArchiveAtom` +
   `sessionsErrorAtom` already follow.
3. **One shared type**, in a new `frontend/app/view/agents/loadphase.ts`:
   `export type LoadPhase = "loading" | "empty" | "ready" | "error";`. It is not in `surfacescaffold.tsx`,
   which has in-flight edits from the Radar polish work.
4. **A pure phase function per surface that needs one**, in that surface's existing model file, unit-tested
   beside it. Components branch on the phase and add no conditions of their own. It returns `LoadPhase`
   unless the surface has more distinct states than those four (Code).
5. **Skeletons are shaped like the content they replace**, use only existing `@theme` tokens (through
   `skeletonClass`), and carry `aria-hidden` (already the case in `Skeleton`). No new design tokens.
6. **Shared skeletons are extracted only where there is more than one user.** `TranscriptSkeleton` has 3 users
   and `GraphSkeleton` has 4. Single-use skeletons stay inline in their component.

## Per-surface design

### Cockpit and Agent: roster seeded latch

- `agentstatusstore.ts`: `readRetainedStatus` records each oref as settled in an exported
  `seededOrefsAtom: Set<string>`, in a `finally`, so a failed or timed-out read settles too. The write
  happens after the `await`, so no atom is written during another atom's read. The wshrpc 5s default timeout
  means the read cannot hang.
- A new pure `rosterseed.ts` holds `isRosterSeeded(orefs, hasStatus, settled)`, which is true when every
  terminal oref either has a status or has settled, and a generic `latchWhenTrue(store, check, latch)`.
  `liveagents.ts` wires them up. It already imports both the sidebar model and the status store, so this
  creates no import cycle. The check also requires the layout to have loaded (`isLayoutLoaded`: the
  workspace, its tabs and their blocks, by their WOS loading atoms; a failed load counts as loaded), because
  `CockpitShell` mounts before those objects arrive. `rosterSeededAtom` is a primitive boolean latch. A store subscription flips it to
  `true` the first time the derived check passes, and it never goes back to `false`, so a terminal opened
  later in the session never reopens the skeleton. The latch is installed from a `CockpitShell` effect, not
  from boot: `setupAgentStatusSubscription` runs before the workspace is loaded, and at that point the
  sidebar has zero terminals, which would flip the latch immediately. With genuinely zero terminals it is
  seeded right away, and the real empty state shows.
- `cockpitsurfacemodel.ts`: `rosterLoadPhase(seeded, agentCount): LoadPhase` returns `"loading"` when not
  seeded and the count is 0, `"empty"` when seeded and the count is 0, and `"ready"` otherwise. Agents
  already in the roster render at once; the skeleton only covers the case where there is nothing to show.
- `cockpitsurface.tsx`: `"loading"` renders a skeleton card grid (a few card-shaped blocks in the existing
  column layout) in place of `CockpitEmptyState`.
- `agentsurface.tsx`: when `agent` is null, `"loading"` renders a skeleton tree column plus a pane in place of
  `AgentLaunchHero`.

### Radar

- `radarstore.ts`: a new `radarLoadErrorAtom: string | null`. `loadReports` and `findNewestScannedProject`
  set it on failure and leave `radarReportsAtom` as `null`, instead of writing `[]` / returning `null` as if
  nothing had been scanned. A successful load clears it. `initRadarScope(null)` (the case where nothing has
  ever been scanned) sets `radarReportsAtom` to `[]`, so `null` always means "not fetched yet".
- `radarmodel.ts`: `radarLoadPhase({ reports, currentReportId, report, loadError, scopeBlocked }): LoadPhase`
  returns:
  - `"error"` when `loadError` is set and nothing is on screen yet. A failure after reports are showing keeps
    them and adds the error banner above them.
  - `"ready"` when `scopeBlocked` is true, meaning `pickInitialScope` says `"wait"` because a persisted or
    filtered project is no longer in the registry. That case keeps today's scan-state panel, because an
    endless skeleton is as false as a false empty.
  - `"loading"` when `reports == null`, or `currentReportId` is set but `report` is still null.
  - `"ready"` otherwise, and the surface defers to `classifyScanState` as it does today. `"never-scanned"` is
    only reachable from a loaded state. Radar has no `"empty"` phase: its empty is the scan-state panel.
- Since `null` now always means "not fetched yet", no separate "scope resolved" flag is needed.
- `radarsurface.tsx`: `"loading"` keeps the subject bar and renders a findings-list plus detail skeleton in
  the body. `"error"` renders `SurfaceError` with Retry, which re-runs the failed load.

### Code

- A new pure `codeBodyPhase({ registry, project, stored, index, indexError })` in `view/code/codestore.ts`,
  beside `canRestoreProject` (which it uses), tested in `codestore.test.ts`. It returns the existing branches
  (`no-projects | no-project | error | loading | not-repo | ready`), and adds a rule: `project == null` while
  `canRestoreProject(stored, registry)` holds is `"loading"`, not `"no-project"`. This one returns a
  Code-specific union rather than `LoadPhase`, because Code has more than four distinct states.
- `CodeBody` switches on that result. `"loading"` renders a file-tree plus editor skeleton instead of
  `SurfaceEmptyState title="Listing files…"`.

### Settings

No gate. `bootWaveCore` awaits `GetFullConfigCommand` before the first render, so settings and the project
registry are always present when any surface mounts.

## Inner panes

| Pane | Today | Becomes |
|---|---|---|
| `agents/endedtranscript.tsx` | "Loading transcript…" | `TranscriptSkeleton`. "No transcript found" stays. |
| `agents/sessionssurface.tsx` transcript pane | "Loading transcript…" | `TranscriptSkeleton` |
| `agents/subagentinterior.tsx` | "Loading subagent transcript…" | `TranscriptSkeleton` |
| `jarvis/jarvisgraph.tsx` Suspense fallback | "Loading graph…" | `GraphSkeleton` |
| `jarvis/graphpeek.tsx` | "Loading graph…" | `GraphSkeleton` |
| `orchestrate/daggraph.tsx` | "loading dag…" | `GraphSkeleton` |
| `orchestrate/dagmodal.tsx` | "loading run route…" | `GraphSkeleton` |
| `agents/agentdetailsrail.tsx` files section | "Loading…" | inline file-row `SkeletonLine`s |
| `agents/planpreview.tsx` | "Loading plan…" | inline text-line `SkeletonLine`s |
| `jarvis/briefpeekview.tsx` title | "Loading…" | inline title-width `SkeletonLine` |
| `jarvis/chunksidebar.tsx` | "Loading the run…" | inline text-line `SkeletonLine`s |
| `jarvis/recordpicker.tsx` | "Loading records…" | inline row `SkeletonLine`s |
| `orchestrate/timelinerail.tsx` history body | "Loading history…" | inline event-row `SkeletonLine`s. The status pill's "loading…" stays, because it is a status label and not a placeholder. |

- `TranscriptSkeleton` goes in `agents/transcriptskeleton.tsx`: alternating message blocks of ragged widths,
  with a `className` for the container's padding.
- `GraphSkeleton` goes in `jarvis/graphskeleton.tsx`: a few node-shaped blocks, centered, filling its
  container. `orchestrate/` already imports from `jarvis/`, so this adds no new dependency direction.

## Testing

- Unit tests (vitest), each written to fail on the pre-change code:
  - `rosterLoadPhase`: not seeded with 0 agents is `"loading"`, never `"empty"`. Seeded with 0 is `"empty"`.
    Any agents is `"ready"`.
  - `isRosterSeeded` plus the latch: a failed seed read settles. A terminal added after the latch flips does
    not reopen loading. Zero terminals is seeded.
  - `radarLoadPhase`: each loading cause is `"loading"`, not never-scanned. A load error is `"error"`. A loaded
    empty list is still never-scanned.
  - `codeBodyPhase`: a restorable stored project with no current project is `"loading"`. A null index is
    `"loading"`. Every existing branch keeps its result.
  - `radarstore`: a failed `loadReports` sets `radarLoadErrorAtom` and leaves `radarReportsAtom` null.
- No render tests (repo convention). `task verify:ui -- surface-smoke` must pass. Take one CDP screenshot each
  of Cockpit, Radar and Code in the loading state to check the skeleton shapes.

## Sequencing

The Radar polish this was waiting on landed as `fd2965c8`, so every task builds on current `main` in the
engine's worktrees. Nothing waits on outside work.
