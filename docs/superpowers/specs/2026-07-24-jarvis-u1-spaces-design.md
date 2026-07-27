# Jarvis second brain — U1: Presence C ("Spaces") design

**Date:** 2026-07-24
**Status:** Design complete; pending spec review, then implementation planning.
**Type:** Sub-project spec (sub-project **U1** of the [v2 meta spec](2026-07-24-jarvis-second-brain-v2-meta-spec.md)). One `spec → plan → implementation` cycle.

**Builds on (read first):**
- [Jarvis second brain — v2 meta spec](2026-07-24-jarvis-second-brain-v2-meta-spec.md) — v2 decomposition, the added invariants, the UX lane, and U1's responsibility boundary.
- [Jarvis second brain — v1 meta spec](2026-07-23-jarvis-second-brain-meta-spec.md) — the nine inherited invariants (esp. **8: Presence D**, **9: cockpit design language**) and the built A–G subsystems this consumes.
- [Jarvis second brain — design](2026-07-22-jarvis-second-brain-design.md) — the presence decision ("ship D, grow into C") and why C became a *UX preference, not a correctness requirement*.

This spec does not restate those invariants or decisions. It records the decisions left to U1, the engineering architecture, and the scope of this cycle.

## What U1 is

A **Space** is a task-focus lens over the existing cockpit. You pick an active task; the scoped surfaces re-lens to that task's work, switched like desktops. It is **strictly additive to Presence D**: with no Space active, the cockpit behaves exactly as it does today (D is the global default — v1 invariant 8). No rework of D, no new backend subsystem, and — per v2 invariant 10 — **no embedding dependency** (U1 is on the UX lane and consumes only already-built v1 subsystems).

The design doc demoted C from a correctness requirement to a UX preference (the hands-off attribution engine D already fills the edge graph globally, so focus is not needed for a trustworthy graph). U1 therefore *adds* "focus on a task" onto D; it does not rebuild anything.

## Decisions this cycle settled (during brainstorming)

1. **Cycle scope: lens + scoped lists.** Not a thin indicator-only lens — the scoped surfaces genuinely filter to the active task. This is the honest realization of "surfaces scope to it."
2. **Scoped surfaces: Agent roster + Channels only** (this cycle). Sessions and Radar are deferred (see §8). Jarvis recall and ambient cards additionally default to the task.
3. **Switch affordance: app-bar chip + Ctrl+P group.** The chip is the persistent "which Space am I in" indicator *and* the switcher; entering/switching is also a lead group in the existing `Ctrl+P` palette. No new global shortcut, no second command palette (v1 invariant 8).
4. **Scope behavior: filter + escape hatch.** A scoped surface shows only the Space's rows plus a persistent inline banner (`Focused: <objective> · N hidden · Show all`) that reveals the rest without leaving the Space.
5. **"Needs you" is never suppressed by focus.** The nav-rail ask badge stays global; a scoped-out asking agent still raises it. Focus changes what a *surface list* shows, never what the ambient signal layer reports.

## What a Space is

One vault dossier under `tasks/active`. **Focusable statuses:** `active` and `paused` (completed/archived are excluded from the switcher). Human-facing label = the dossier's `objective`; `ticket` renders as a secondary tag. Real dossiers already exist — `jarviscapture.CaptureRunDispatch` writes/updates one on every run dispatch — so the switcher is populated on day one without U2 (the Tasks editor).

## The seam — the space-scope contract

The one new contract. A Space resolves to a **scope bundle** the FE surfaces filter on. Go structs are the source of truth (regenerated via `task generate`); the TS shape below is illustrative.

```
SpaceSummary  { id; objective; ticket; status; updated }        // for the switcher + palette group
SpaceScope    { runOrefs: string[]; channelOids: string[]; tabIds: string[] }   // for surface filtering
```

- `runOrefs` — the task's attributed Runs (the raw edge set).
- `channelOids` — distinct `run.ChannelOID` across those Runs → **Channels** surface membership.
- `tabIds` — derived from `run.Phases[].WorkerOrefs` (worker tab orefs, e.g. `tab:<id>`) across those Runs, with the `tab:` prefix stripped, so they match the roster's `tabId` key → **Agent roster** membership.

The bundle is a **derived, rebuildable snapshot** — recomputed from D's edges, never persisted, never committed to the vault (v2 invariant 13 in spirit; U1 stores nothing durable).

## Backend — two new wshrpc commands

Both live in `pkg/wshrpc` (Go source of truth → `task generate` regenerates TS/Go bindings). Both are **pure reads**: no model call, no new WaveObj, no migration.

- **`ListDossiersCommand() → { spaces: SpaceSummary[] }`** — a `wavevault` frontmatter query over `tasks/active` filtered to `status ∈ {active, paused}`, newest-`updated` first. Cheap: no edge resolution. Feeds the switcher and the `Ctrl+P` group.
- **`ResolveSpaceScopeCommand(dossierId) → SpaceScope`** — computes the bundle from `jarvisattrib.EdgesFor(dossierId)` → the attributed Runs → their `ChannelOID` + the tab ids derived from `Phases[].WorkerOrefs`. Called **lazily**, only on enter/switch of a Space.

**Wiring fork (recorded).** An alternative returns `runOrefs` only and lets the FE derive `channelOids`/`tabIds` from live atoms (keeps the scope live, minimal wire). Rejected for this cycle: the roster VMs (`AgentVM`) carry no run→tab linkage, so the FE cannot map a run to its worker tabs without the Run's `Phases`; the backend already holds Runs + phases + D's edges as the single source of truth. Consequence: the scope is a **snapshot re-resolved on enter/switch** (and on switcher re-open); live push is a deferred refinement, not cycle-1 scope.

**Graceful degradation (v2 invariant 11 posture, applied even though U1 is not a semantic consumer):** if the vault is absent or a read fails, `ListDossiers` returns empty → the chip shows only "Global," the palette group is absent, and the cockpit is exactly Presence D. A `ResolveSpaceScope` failure leaves you in Global and is logged at the boundary; it never errors the cockpit.

## Frontend — state

A small module store at **`frontend/app/view/agents/spacestore.ts`** — placed under `view/agents/` (not `view/jarvis/`) because the scoped surfaces live in `view/agents/` and **agents must not import the jarvis view** (the established one-directional import rule; jarvis may import agents). Module-scope atoms (never component `useState`) so state survives the nav-switch unmount (the standing surface-unmount gotcha).

- `activeSpaceAtom: SpaceSummary | null` — `null` = Global (Presence D).
- `spaceScopeAtom: SpaceScope | null` — the resolved bundle; set on enter, cleared on exit.
- `spaceRevealAtom: Set<SurfaceKey>` — surfaces the user clicked "Show all" on (the escape hatch); reset on every Space switch.

Module mutators mirror `jarvisstore`/`channelsstore` conventions (`globalStore.set` at module scope): `enterSpace(summary)` (sets active + fires `ResolveSpaceScope` into `spaceScopeAtom`), `exitSpace()`, `revealSurface(key)`.

## Frontend — app-bar chip + switcher

A new `SpaceSwitcher` component mirroring **`ProjectSwitcher`** (`frontend/app/view/agents/projectswitcher.tsx`) verbatim — same `PopoverReveal` dropdown, same `variant="bar"` styling. Mounted in `frontend/app/cockpit/app-bar.tsx`, in the left cluster immediately after `ProjectSwitcher`, reading as a breadcrumb:

```
Arc / <project> / ◇ <space> ▾
```

- Collapsed (no Space): shows **"Global"** (muted); accent dot only when a Space is active.
- Dropdown: the active/paused task list (from `ListDossiers`) + an **"Exit focus"** row (shown only when a Space is active).
- **Relationship to the project filter:** an active Space is the *finer* lens and **wins** for the scoped surfaces; the project chip stays visible as context. Exiting focus returns you to the plain `projectFilterAtom` behavior.

## Frontend — Ctrl+P "Focus on task…" group

Mirror the existing **"Ask Jarvis"** lead group:
- Add `"focus-task"` to the `PaletteKind` union in `frontend/app/cockpit/command-palette.tsx` and inject it as a lead group in the default-scope branch (alongside `ask-jarvis`, reusing the accent-railed lead-block renderer at ~line 317 / ~395).
- A pure builder `frontend/app/cockpit/palette-focus.ts` mirroring `palette-ask.ts` — given the space list, returns the group's rows; each row's `run()` calls `enterSpace(summary)` and closes the palette. An **"Exit focus"** row appears when a Space is active.

## Frontend — scoping the surfaces

The roster already filters by `projectFilterAtom` in `cockpitsurface.tsx`; Channels the same in `channelssurface.tsx`. Add a Space pass in the same place, as a pure, unit-testable filter:

- **Agent roster** (`cockpitsurface.tsx`): when `spaceScopeAtom` is set and `agent` ∉ `spaceRevealAtom`, keep only rows whose `tabId ∈ scope.tabIds`; render the banner `Focused: <objective> · N hidden · Show all`.
- **Channels** (`channelssurface.tsx`): same pattern on `channelOid ∈ scope.channelOids`.
- **Jarvis recall** (`view/jarvis`): new conversations default their `JarvisScope` to the Space (mode `attached`, the task's dossier as the attached `SourceRef`) instead of `all`, when a Space is active.
- **Ambient cards**: unchanged mechanism (the `AmbientProvider` is queried per-oref already); a Space active simply makes the focused task's tags/cards the ones that read as "in this Space." No new ambient wiring.

The filter is **pure and extracted** (a `filterBySpace(rows, scope, revealed)` helper) so it is vitest-tested without a render harness (standing decision: no jsdom render tests; "does it render" is CDP).

## Edge cases

- **Empty scope** (a new/paused task with zero attributed Runs): scoped surfaces show the banner `0 in this Space · Show all` — never a blank void.
- **A Space's task completes/archives while focused:** it drops out of the switcher; the chip stays until you exit (you can still see its snapshot), then it is unselectable.
- **Switching Spaces** resets `spaceRevealAtom` (a fresh focus starts fully filtered).

## Testing

- **Vitest units** (pure logic): `filterBySpace` membership for roster + channels; banner hidden-count; reveal toggle; `SpaceSummary` → switcher/palette-row derivation; project-vs-Space precedence; the `ResolveSpaceScope` chunk → `spaceScopeAtom` mapping.
- **Go tests** (`go test ./pkg/...`): `ListDossiersCommand` frontmatter query (status filter + ordering); `ResolveSpaceScopeCommand` edge→bundle assembly (reuse D's test vault + runs).
- **CDP surface-smoke** (`task verify:ui` scenarios): (1) Global — cockpit unchanged; (2) Space active — roster filtered + banner; (3) "Show all" revealed; (4) empty-Space banner; (5) chip collapsed vs active + the dropdown.

## Internal decomposition (the implementation plan will order these)

1. Backend: `ListDossiersCommand` + `ResolveSpaceScopeCommand` (+ `task generate`) with Go tests. ← pins the scope contract.
2. `spacestore.ts` (atoms + mutators) + the `SpaceSwitcher` chip in the app bar; enter/exit/switch works end-to-end with the indicator (no surface filtering yet).
3. `Ctrl+P` "Focus on task…" group (`palette-focus.ts` + wiring).
4. Surface scoping: `filterBySpace` + roster banner + Channels banner + Jarvis recall default scope; unit + CDP.

Steps 1–2 are the contract-pinning core; 3–4 are the entry points and the payoff. Step 1 is independent; 2–4 layer on the store.

## Design constraints inherited (quick reference)

Dark mode only; preserve the 46px app bar and 78px nav rail (the chip is a non-destructive addition to the app bar's existing left cluster); colors are `@theme` tokens in `tailwindsetup.css` — never raw hex; existing cockpit fonts; restrained motion; must feel native to the cockpit. Do not build on `aiusechat` (U1 makes no model call anyway).

## Out of scope (this cycle)

- **Sessions & Radar scoping.** Sessions is a fast-follow on the same bundle; Radar findings don't attribute to tasks via Run edges (only the reverse `RunRadarOrigin` subset) — revisit once S2/S3's L4 semantic edges exist.
- **A keyboard quick-switch** for Spaces (would be a new global shortcut — v1 invariant 8 forbids it this cycle).
- **Live scope push** (scope is a re-resolved snapshot).
- **Per-surface deep scoping** beyond list filtering (e.g. scoping the Diff or Memory graph).
- Anything that makes task-focus the *only* mode — D stays the global default (v2 meta spec U1 "Out of scope").
- The Tasks dossier editor (U2) and the Graph surface (U3) — separate sub-projects.
