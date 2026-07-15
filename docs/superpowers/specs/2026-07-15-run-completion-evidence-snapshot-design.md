# Run completion — evidence snapshot — design

## Context

The imported Claude Design file `Wave-run-completion.dc.html` (project `wave`,
`claude.ai/design/p/76055164-…`) specifies a **run-completion surface**: a channel-scoped detail view
for a *finished* run, centred on an "Evidence snapshot" — an immutable, sealed record of what the run
produced (completion summary, files touched, verification results, artifacts, diff) plus a phase-history
timeline.

Today `RunBody` (`frontend/app/view/agents/runbody.tsx`) renders a terminal run with the same
live-oriented phase-rail it uses for a running run (header, compact stepper, `PhaseRail`, `ShipMarker`).
There is no dedicated completion view and no notion of a captured evidence record. This spec adds one.

The run engine lives in `pkg/jarvis`. A run's `Status` is derived by `recomputeStatus` from phase states;
`CompletePhase` marks a phase done and, when the last phase completes, `recomputeStatus` sets
`RunStatus_Done`. Completion is **reported by the caller** (`wsh jarvis complete` hook or a UI action),
not detected by the engine; the engine functions are pure (caller persists). `Run` is embedded in
`Channel` as `runs?: Run[]` (JSON-serialized inside the channel waveobj), so adding fields to
`Run`/`RunPhase` needs **no DB migration** — Go struct change + `task generate` only.

## Decision: full backend evidence snapshot (chosen over frontend-derive / mock-only)

The snapshot is derived server-side and **sealed once** at the moment a run transitions to `done`, then
frozen — matching the design's "sealed / immutable / hash" framing. This is the most faithful of the
three fidelity options considered; the frontend renders the sealed record and never recomputes it.

Rejected alternatives:
- **Frontend live-derivation + placeholder seams** — cheaper (no backend), but a re-derived snapshot is
  not "sealed", and verification/timing would be fabricated. Contradicts the design's core promise.
- **Mock-only visual port** — a static fixture, not wired to real runs. Not a usable feature.

## Data model (new Go; JSON-embedded in `Channel`, no migration)

Added to `pkg/waveobj` (the ORef object model), regenerated to `frontend/types/gotypes.d.ts` via
`task generate`:

```
Run.CompletedTs   int64          // set at seal; Duration = CompletedTs - CreatedTs (wall clock)
Run.Evidence      *RunEvidence   // nil until sealed; presence gates the completion view

RunPhase.StartedTs int64         // set when a phase enters running
RunPhase.DoneTs    int64         // set when a phase completes → per-phase timestamps + Runtime

RunEvidence {
  CapturedTs int64;  Hash string;                 // seal time + short content hash ("ev·…")
  Summary    string;                               // "" → the "no summary recorded" state
  Files      []EvidenceFile;  AddTotal, DelTotal int;
  Verifs     []EvidenceVerif;
  Artifacts  []EvidenceArtifact;
  RuntimeMs  int64;                                // Σ phase active spans (active compute)
  DurationMs int64;                                // wall clock
}
EvidenceFile     { Path string; Stat string /* "A"|"M"|"D" */; Add, Del int; By string /* worker */ }
EvidenceVerif    { Cmd string; Result string /* "pass"|"fail"|"unknown" */; Detail string }
EvidenceArtifact { Path string; Kind string /* doc|report|image|… */; Size int64 }
```

`Run.Status` remains derived by `recomputeStatus` (single source of truth). Timestamps are recorded where
state already transitions: `StartedTs` when a phase is set running (`NewRun` first phase, `CompletePhase`
successor start, `ApproveGate`/`SendBackGate`); `DoneTs` in `CompletePhase`; `CompletedTs` at seal.

## Backend

### 1. Sealing (`pkg/jarvis/evidence.go`, new; wired in the `AdvanceRun` handler)

- **`SealEvidence(ctx, run *waveobj.Run) error`** — idempotent: if `run.Evidence != nil` it returns
  immediately (immutable). Otherwise sets `CompletedTs`, derives the five sections (below), computes
  `Hash`, and attaches `run.Evidence`. It locates transcripts from the phases' `WorkerOrefs` and git data
  from `run.ProjectPath` (everything it needs is already on the run). Pure-where-possible: the derivation
  helpers that transform already-loaded data (verif classification, artifact kind/size mapping, hash) are
  split out and unit-tested; only transcript/git I/O touches the environment.
- **Seal point** — in the wshserver `AdvanceRun` (complete) path: after `CompletePhase` +
  `recomputeStatus`, if the status transitioned non-`done` → `done`, call `SealEvidence` before the
  channel is persisted. The snapshot rides the normal channel save.

### 2. Lazy backfill for pre-feature done runs

- **`SealRunEvidenceCommand(ctx, {ChannelId, RunId})`** (new RPC) — loads the run; if already sealed,
  no-op; else calls `SealEvidence`, persists (`wcore.SendWaveObjUpdate(channel)`), returns. Same
  derivation as the completion hook (DRY). The frontend calls it once when `RunCompletion` mounts on an
  unsealed done run, so historical runs seal on first view.

### 3. Derivation helpers (in `evidence.go`)

- **Summary** — final assistant text from the execute/lead worker's transcript, via `pkg/agentsessions`
  (the run's last non-skipped phase `WorkerOrefs`). Empty when none.
- **Files + diff** — reuse the Files-surface git derivation (`pkg/gitinfo`) for numstat, using the same
  base/range the Files surface already computes for the run's project (no new base logic — single source
  of truth for "what this run changed"); `By` = the phase-worker that produced them (single execute worker
  for pipeline; best-effort attribution for orchestrator/subagents).
- **Verifs** — scan the run's worker transcripts for `Bash` tool calls whose command matches a
  verification pattern set (typecheck / test / lint / build / e2e / smoke). Classify `pass`/`fail` by the
  tool result's exit; `unknown` = ran but result indeterminate. **Evidence-only**: commands that never
  ran are not invented (deliberate deviation from the mock's "never run → unknown" row).
- **Artifacts** — aggregate `phase.Artifacts` paths already recorded by `CompletePhase`; `Kind` by
  extension (`.md`→doc, `.html`→report, image exts→image, else file); `Size` via `os.Stat` under
  `run.ProjectPath` (0 / omitted if unreadable — never fatal).
- **Hash** — short sha256 of the serialized evidence for the `ev·…` chip.

## Frontend

### `frontend/app/view/agents/runcompletion.ts` (pure derivations, unit-tested)

Mirrors `runmodel.ts`: byte + duration formatting, `Stat`→tone, `Verif.Result`→badge (icon/colors/label),
`Kind`→chip colors, verif pass/fail/unknown counts, and the phase-history node model (elevating
`freshctx` to its own timeline node, with per-phase timestamps from `StartedTs`/`DoneTs`). No React,
no jotai.

### `frontend/app/view/agents/runcompletion.tsx` (the surface)

Renders `run.evidence`:
- Header: breadcrumb (`#channel / run <shortId>` — `shortId` derived from `run.id`), goal, "✓ Done" pill.
- Evidence snapshot card: sealed/hash header + Immutable badge; 4-stat strip (Status / Runtime /
  Duration / Completed); completion summary (worker avatar + final response, with the empty state);
  files-touched list; verification list + counts; artifacts chips; "Open repository diff" action reusing
  the existing Files→Diff path.
- Phase history: timeline from `run.phases` via `runcompletion.ts`.

### Integration in `runbody.tsx`

`RunBody` renders `<RunCompletion>` when `run.status === "done" && run.evidence`. When a done run has no
evidence, it fires `SealRunEvidenceCommand` once (backfill) and, until it arrives, degrades to today's
terminal phase-rail view. Failed/cancelled runs are unchanged (out of scope). The left channels/runs rail
(`channelrail`) is unchanged — it already provides the design's sidebar.

### Theming

Raw hex from the DC file maps to existing `@theme` tokens (`success` / `error` / `warning` / `accent` /
`accent-soft` / `accentbg` / `muted` / `edge-*`). The prototype's "evidence purple" is **not** carried
over as a new token — the sealed header, Immutable badge, diff button, and fresh-ctx tag use the existing
themed `accent` family so the surface adapts across the runtime theme presets (a fixed hex would clash on
non-default/light themes; adding it to all presets is scope creep for no real gain — the 🔒 icon +
"Immutable" badge already carry the "sealed" semantics). No new `--color-*` tokens, no raw hex, no new
SCSS (per project conventions).

## Confirmed decisions

- **Verification is evidence-only** — only commands that actually ran are listed; no invented
  "expected set". `unknown` means ran-but-indeterminate. (Deviation from the mock, aligned with the
  "ground claims / no invented specificity" principle.)
- **Status scope = `done` only** — no failed/cancelled evidence variants in v1 (YAGNI).
- **Runtime vs Duration** — Duration = wall clock (`CompletedTs - CreatedTs`); Runtime = Σ phase active
  spans (from the new phase timestamps). Both real.

## Testing

- **Go** (`pkg/jarvis/evidence_test.go`): verif classification (pass/fail/unknown from sample tool
  results), artifact kind/size mapping, hash stability, `SealEvidence` idempotence (second call is a
  no-op), timestamp recording through `CompletePhase`. `pkg/jarvis/run_test.go` extended for the new
  `StartedTs`/`DoneTs`/`CompletedTs` transitions.
- **Frontend** (`runcompletion.test.ts`): formatting, badge/tone mapping, verif counts, phase-history
  node model incl. the `freshctx` node and empty-summary path.
- **Visual** (CDP, per project convention): drive the dev app with a sealed done run and screenshot the
  completion surface against the DC mock.

## Out of scope (v1)

Failed/cancelled evidence variants; an in-app diff *viewer* (the button reuses Files→Diff); evidence on a
still-running run; per-subagent file attribution beyond best-effort; re-sealing / editing a sealed
snapshot.
