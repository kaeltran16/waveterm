# Repo Radar — Frontend Surface Design

**Date:** 2026-07-11
**Status:** Design approved in conversation. Implementation not started.
**Parent spec:** `docs/superpowers/specs/2026-07-10-repo-radar-design.md` (the full feature design — backend + frontend). This doc scopes and pins down the **frontend surface** implementation and the decisions made while brainstorming it. Where the two agree, the parent spec is the source of truth for *intent*; this doc is the source of truth for *what we build now*.
**Visual source of truth:** `wave-handoff/wave/project/Wave-repo-radar.dc.html` (dark-only mockup; this surface must additionally support light mode via `@theme` tokens).
**Backend status:** complete and committed (`147127fd`). All five RPC commands are live: `StartRadarScanCommand`, `CancelRadarScanCommand`, `ListRadarReportsCommand`, `SetRadarFindingDispositionCommand`, `RetryRadarClusteringCommand`. Generated bindings (`wshclientapi.ts`, `gotypes.d.ts`) already carry `RadarReport`/`RadarSignal`/`RadarFinding`/`RadarDisposition`.

## Goal

Ship the Repo Radar tab: a first-class cockpit surface that lets the user scan a registered repository for evidence-backed correctness risks, review grouped findings with their evidence, and triage them (dismiss/suppress/undo) — all against the already-shipped backend.

## Scope

**In scope (this plan):**

- New `radar` surface added to the cockpit shell, preserving every existing surface.
- The full scan lifecycle UI: all eight states from the mockup.
- Master/detail results view: grouped findings list + finding detail with evidence.
- Finding dispositions: dismiss, suppress, and their undo/reopen, with dismissed history visible.
- Scan controls: scan, cancel, retry-clustering.
- Repository scope owned by the surface, initialized from the global project selection.
- A dev fixture (`radardevmock.ts`) covering all eight states, for CDP visual verification.

**Deferred (follow-up, recorded in `docs/deferred.md`):**

- The full **"Start investigation" → Channels pending-Run composer** handoff (parent spec §"Start investigation handoff"). Building the prefilled, reviewable Run draft is new work in the *Channels* surface (`createRun` starts a run immediately today — there is no draft/review step). The Radar side builds the draft payload (`radarmodel`, unit-tested), but the Channels consumer is out of scope. See the interim behavior below.

**Out of scope (parent spec, unchanged):** all backend behavior; any repository mutation; running tests/commands/agents; background scans.

## Interim "Start investigation" behavior

The finding detail renders a **Start investigation** action, but it does not perform the handoff. It ships **disabled with a tooltip** explaining the investigation handoff is not yet wired — matching the existing precedent on the Agent surface (Pause/Resume shipped disabled "coming soon" before their RPC existed). `radarmodel.buildRunDraft(...)` still produces the draft payload and is unit-tested (report/finding/fingerprint IDs kept distinct), so only the button is inert; the data contract is ready for the composer when it lands.

## Module structure

All new files live under `frontend/app/view/agents/` (the cockpit surface package).

**Edits to existing files (additive, 5 sites):**

- `agents.tsx` — add `"radar"` to the `SurfaceKey` union and insert it into `SURFACE_ORDER` after `channels` (order becomes Cockpit, Agent, Channels, Radar, Sessions, Files, Memory, Usage). Ctrl+N surface shortcuts follow `SURFACE_ORDER`.
- `navrail.tsx` — add a `radar` entry to `ICON` (lucide `Radar` or `ScanSearch`) and to `ITEMS` (label `"Radar"`).
- `cockpitshell.tsx` — add a `surface === "radar"` branch rendering `<RadarSurface>`.

**New files:**

- `radarstore.ts` — jotai atoms + RPC action wrappers. Holds: selected repository scope, report summaries/list, current report id, current report object. Wraps the five RPC commands. Subscribes to `RadarReport` WOS updates so an in-flight scan streams status/phase/coverage without polling.
- `radarmodel.ts` — **pure** functions, no side effects (the unit-tested core): finding grouping (New / Recurring / No longer detected / Dismissed / Suppressed), default-collapse rules, canonical signal and source counts derived from IDs, selection fallback, coverage/partial-state derivation, and Run-draft construction.
- `radarsurface.tsx` — surface shell: header (scope label + selector, scan button reflecting current state), and the master/detail vs. panel layout switch.
- Small components, only where they isolate a meaningful unit:
  - `radarfindingslist.tsx` — grouped, collapsible findings master list.
  - `radarfindingdetail.tsx` — the detail pane (risk, why, evidence, actions).
  - `radarscanstatepanel.tsx` — the non-results panels (never-scanned, collecting, clustering, no-findings, model-failed, cancelled).
- `radardevmock.ts` — dev fixture producing one `RadarReport` per scan state, scenario-selectable, mirroring the existing `devmock.ts` pattern. Dev/verification only.

## Scope model

Radar initializes its scanned-repo scope from the cockpit's global project selection, then owns an explicitly-labelled scope atom in `radarstore`. Changing Radar's scope never mutates other surfaces. Scope selection reuses the existing project-registry state and canonical-path validation — no new picker logic and no second path validator.

## Data flow

- **On open:** `ListRadarReports(projectPath)` populates the report list; the newest report becomes current. `radarmodel` derives groups, counts, and the initial selection purely from the current report.
- **Scan lifecycle:** scan controls call the RPCs via `radarstore`. The running `RadarReport` streams `status`/`phase`/`coverage` updates through the WOS subscription (the backend already calls `SendWaveObjUpdate` on every mutation), so `collecting → clustering → completed | partial | failed | cancelled` transitions render live.
- **Dispositions:** dismiss/suppress/reopen/unsuppress call `SetRadarFindingDisposition`; the updated report round-trips back through WOS. Dismissed history and undo are surfaced.
- **Retry:** the model-failed panel offers Retry clustering (reuses retained candidates via `RetryRadarClustering`) and Discard signals.

## The eight states

Driven by `RadarReport.Status`/`Phase` (+ coverage), rendered by `radarscanstatepanel` or the results layout:

1. `never-scanned` — intro + "what Radar examines" + Scan button.
2. `collecting` — collector checklist, Cancel.
3. `clustering` — collector checklist + Radar-payload budget meter, Cancel.
4. `results` — master/detail findings.
5. `partial` — results + partial banner and coverage ✗ markers; Re-run full scan.
6. `no-findings` — clean-scan panel; Scan again.
7. `model-failed` — Retry clustering / Discard signals (signals cached from this scan).
8. `cancelled` — cancelled panel; previous report unchanged and still available.

Labels/wording follow the mockup's state config; the parent spec's "Radar payload" relabel (not "Model budget") applies.

## Results layout

Master/detail, from the handoff:

- **Left (master):** findings grouped by lifecycle. New and Recurring open by default; No longer detected, Dismissed, and Suppressed start collapsed.
- **Right (detail):** risk statement, delta note, why-it-matters, then **Evidence** — linked signal chips, affected files, signals timeline, and a **verbatim diff specimen** rendered through the *existing* diff renderer (no second diff parser). **Radar interpretation is rendered visually distinct from source facts** (separately labelled block). Actions row: suggested mission, Start investigation (disabled placeholder), dismiss/suppress.
- The redundant "Inspect evidence" button from the mockup is removed — the detail pane already shows evidence.
- All signal and source counts derive from canonical signal IDs, never from rendered section counts.

## Styling

Tailwind + existing `@theme` tokens only; never raw colors. The mockup is dark-only, so the surface must be authored token-first to render correctly in light mode as well (parent spec §"Frontend integration").

## Testing

**Pure model tests (`radarmodel.test.ts`):**

- Grouping and default-collapse behavior.
- Filtering and selection fallback.
- Canonical signal and source counts (from IDs, not rendered sections).
- Coverage and partial-state derivation.
- Dismissed-history visibility.
- `buildRunDraft` keeps report, finding, and fingerprint IDs distinct.
- Navigation preserves every existing surface (`SurfaceKey`/`SURFACE_ORDER` invariants).

**CDP visual verification** (live dev app, per parent spec §"CDP verification", using `radardevmock.ts` scenarios):

- Every scan state.
- Dismissal and undo; suppression and unsuppression; No-longer-detected semantics.
- Small-window NavRail scrolling.
- Theme switching (dark and light).
- Long findings, timelines, paths, and diffs render without clipping.

## Open questions

None. Scope, module structure, interim handoff behavior, and dev-data strategy are settled above.
