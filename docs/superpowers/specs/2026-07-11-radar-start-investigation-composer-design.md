# Design — "Start investigation" handoff & pending Run composer

**Date:** 2026-07-11
**Status:** Design approved in conversation. Implementation not started.
**Parent spec:** `docs/superpowers/specs/2026-07-10-repo-radar-design.md` §"Start investigation handoff" + §"Frontend integration".
**Resumes deferred item:** `docs/deferred.md` → "Repo Radar — 'Start investigation' handoff composer (2026-07-11)".

## One line

Wire Radar's finding→Run handoff end-to-end: **Start investigation** prefills a reviewable, editable Run
draft in the Channels → Runs view; the user edits the goal, picks mode / plan-gate, and explicitly starts
it; the started Run carries structured radar origin (report / finding / fingerprint) for a future
finding-linked-outcome feature.

## Problem

Radar ships complete through findings + triage, and `radarmodel.buildRunDraft` already produces the
finding→Run payload (unit-tested, IDs kept distinct). But the handoff is inert: `radarfindingdetail.tsx`
renders **Start investigation** *disabled with a tooltip*, because there is no draft/review step anywhere —
`createRun` starts a run immediately from a single goal string. The parent spec (§"Start investigation
handoff") requires the action to navigate to Channels and open a *prefilled, reviewable* Run draft the user
edits and explicitly starts.

## Goals

- **Start investigation** navigates to Channels → Runs and opens a prefilled, editable Run composer.
- The composer shows the suggested mission (editable goal), affected files, evidence refs, and a Radar-origin
  banner; the user picks mode / plan-gate and explicitly starts.
- The started Run persists structured radar origin (report ID, finding ID, fingerprint) as distinct fields.
- One run-creation composer (the existing "Start a run" panel, generalized), not a second divergent path.

## Non-goals

- **Finding-linked outcomes** — marking a finding fixed / No-longer-detected from a Run result. The parent
  spec (§"Deferred extensions") defers this. This work *carries* the origin link but does not act on it.
- Backend persistence of the pending draft (it is ephemeral frontend state; see Draft storage).
- Any change to Radar's scan/collection/synthesis backend.
- Cross-project handoff: a finding hands off only to a channel bound to the finding's own project.

## Decisions (resolved while brainstorming)

1. **Draft storage — ephemeral frontend atom.** A `pendingRunDraftAtom` holds the draft between Radar and
   Channels; cleared on Start or Discard. No persistence, no backend object, no migration. A reload loses the
   draft, which is acceptable for a review-then-start step (KISS / YAGNI).
2. **Radar → run — structured origin on the Run.** Thread report / finding / fingerprint IDs onto the `Run`
   as structured fields (not folded into goal text), so a future finding-linked-outcome feature has the link.
   This is a deliberate, small backend change now; the outcome feature itself stays deferred.
3. **Composer shape — generalize the one panel.** The existing "Start a run" panel accepts an optional
   prefilled draft: blank today, prefilled + enriched (files / evidence / origin banner, editable goal) when a
   draft is present. Single source of truth for starting a run (DRY).

## Architecture

### Backend — structured radar origin on `Run` (Go)

- `pkg/waveobj/wtype.go`: add
  ```go
  type RunRadarOrigin struct {
      ReportID    string `json:"reportid"`
      FindingID   string `json:"findingid"`
      Fingerprint string `json:"fingerprint"`
  }
  ```
  and an optional field on `Run`: `RadarOrigin *RunRadarOrigin `json:"radarorigin,omitempty"``.
- `pkg/wshrpc/wshrpctypes.go`: add optional `RadarOrigin *waveobj.RunRadarOrigin `json:"radarorigin,omitempty"``
  to `CommandCreateRunData`.
- `pkg/wshrpc/wshserver/wshserver.go` `CreateRunCommand`: after `run := jarvis.NewRun(...)`, set
  `run.RadarOrigin = data.RadarOrigin`. **`jarvis.NewRun`'s positional signature is left untouched** — the
  set-after-construction approach avoids editing every other `NewRun` caller (KISS).
- Regenerate bindings with `task generate` → `wshclientapi.ts` (`CommandCreateRunData`) and `gotypes.d.ts`
  (`Run`, `RunRadarOrigin`, `CommandCreateRunData`) pick up the new fields. Never hand-edit generated files.
- **No DB migration.** `Run` is JSON-embedded in `Channel.Runs`; an added optional field is
  forward/backward-compatible in the persisted JSON. (Contrast the Radar backend, which added *new* top-level
  wave-object types and therefore needed `db_radarreport`.) Verify at implementation by round-tripping an
  existing channel with pre-existing runs.

### Frontend — pending-draft signal + goal composition

- `radarmodel.ts` (pure, unit-tested; no jotai/RPC/React):
  - `composeRunGoal(finding: RadarFinding): string` — the suggested mission plus a compact affected-files
    list and an evidence-refs note, forming the editable prefilled goal.
  - `toPendingRunDraft(report, finding): PendingRunDraft` — built on the existing `buildRunDraft`; carries the
    composed goal, files, evidence refs, the origin IDs, and the finding's project path for channel resolution.
  - The composer type is origin-agnostic so the composer never imports radar concepts:
    ```ts
    interface PendingRunDraft {
        goal: string;              // prefilled, editable
        files: string[];           // context, read-only in the composer
        evidenceRefs: string[];    // context, read-only
        radarOrigin?: { reportid: string; findingid: string; fingerprint: string };
        projectPath?: string;      // used to resolve the target channel on landing
    }
    ```
- `runactions.ts`:
  - `pendingRunDraftAtom = atom<PendingRunDraft | null>(null)` — the cross-surface signal (Radar sets it,
    Channels consumes it).
  - `createRun(channelId, goal, opts?)` gains `opts.radarOrigin`, threaded into `CommandCreateRunData`.

### Radar — activate Start investigation

- `radarsurface.tsx` passes `model` to `RadarFindingDetail`.
- `radarfindingdetail.tsx`: the button is enabled (disabled/tooltip/opacity styling removed). onClick:
  `globalStore.set(pendingRunDraftAtom, toPendingRunDraft(report, finding))` then
  `globalStore.set(model.surfaceAtom, "channels")`.

### Channels — consume the draft

- `channelssurface.tsx`: read `pendingRunDraftAtom`. One effect keyed to the draft's identity (e.g.
  `radarOrigin.findingid`) fires **once per new draft**:
  - resolve the target channel: `channels.find(c => sameProject(c.projectpath, draft.projectPath))`;
  - **found** → `selectChannel(oid)` + `setView("runs")`;
  - **multiple matches** → first match (the user can switch channels in the rail; the draft persists);
  - **zero matches** → open the existing new-channel picker (`setPicking(true)`); the draft persists so the
    composer prefills once a channel is created and selected.
  - It switches the view once per draft, not on every Channels visit, so a lingering draft never hijacks
    normal browsing.
- The pending draft is passed down into `RunsView`.

### RunsView — generalized composer

- `runssurface.tsx`: `RunsView` accepts `pendingDraft: PendingRunDraft | null` and a clear callback.
  - When a draft is present, force the new-run panel (`activeRunId === undefined`) and seed the goal textarea
    from `pendingDraft.goal`.
  - Render, above the existing `ComposerShell`, a "From Radar finding" origin banner + affected-files chips +
    an evidence-count line. The goal remains fully editable.
  - A blank draft renders today's minimal "Start a run" panel unchanged.
  - `startRun` passes `pendingDraft.radarOrigin` into `createRun`, then clears `pendingRunDraftAtom` on
    success. A **Discard** control clears the draft (composer returns to blank).

## Data flow

1. User clicks **Start investigation** on a Radar finding → `toPendingRunDraft` → `pendingRunDraftAtom` set →
   surface switches to `channels`.
2. Channels resolves the finding's project to a channel, selects it, switches to the Runs view, and opens the
   prefilled composer (or opens the channel picker if no channel matches).
3. User reviews/edits the goal, confirms mode / plan-gate, clicks **Start run** → `createRun(channelId, goal,
   { mode, planGate, radarOrigin })` → `CreateRunCommand` persists a normal Run with `RadarOrigin` set →
   `pendingRunDraftAtom` cleared. The run then behaves like any other run.

## Error handling / edge cases

- **No channel for the project** → the existing new-channel picker opens; the draft persists until a channel
  exists and the run is started, or the user discards.
- **Reload** loses the ephemeral draft — acceptable for a review step.
- **Navigating away without starting** keeps the draft pending (that is the point of a pending draft); a
  visible **Discard** is the explicit exit. The one-shot view switch prevents the draft from re-hijacking
  navigation.
- **Origin absent** (any non-radar run) → `radarOrigin` omitted; `run.RadarOrigin` stays nil; behavior
  identical to today.

## Testing

**Pure frontend (`radarmodel.test.ts`):**

- `composeRunGoal` includes the mission, the affected files, and an evidence-refs note.
- `toPendingRunDraft` keeps report / finding / fingerprint IDs distinct and maps them into `radarOrigin`, and
  carries the finding's project path.

**Backend (Go):**

- `CreateRunCommand` with a `RadarOrigin` persists `run.RadarOrigin` with the three IDs intact.
- `CreateRunCommand` without a `RadarOrigin` leaves `run.RadarOrigin` nil (no regression to the normal path).

**CDP visual verification (live dev app):**

- Finding → **Start investigation** lands in Channels → Runs with a prefilled, editable composer showing the
  origin banner, affected files, and evidence count.
- **Start run** creates a run that appears in the run tabs; **Discard** clears the composer to blank.
- No-matching-channel opens the channel picker.

## Consequences and trade-offs

- The structured origin is a small backend change (one struct, one optional field, one assignment, regenerated
  bindings, no migration) that unblocks the deferred finding-linked-outcome feature without building it now.
- Ephemeral draft storage keeps the slice frontend-heavy and reversible; the cost is that a reload discards an
  un-started draft, which is acceptable for a review step.
- Generalizing the one composer keeps a single run-start path; the cost is a slightly richer "Start a run"
  panel that must render correctly in both the blank and the prefilled state.
