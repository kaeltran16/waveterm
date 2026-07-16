# Run evidence — base-anchored diff — design

## Context

The run-completion surface (`2026-07-15-run-completion-evidence-snapshot-design.md`,
`frontend/app/view/agents/runcompletionsurface.tsx`) shows a sealed evidence snapshot for a finished run:
completion summary, files touched (`+adds −dels`), verification list, artifacts, and an "Open repository
diff" button. The predecessor spec assumed the files/diff derivation would "reuse the Files-surface git
derivation … using the same base/range the Files surface already computes (no new base logic)". That base
logic never existed — the Files surface and the seal both call `gitinfo.GetChanges`, which computes
`git diff --numstat --relative HEAD` (+ untracked): **working tree vs. current `HEAD`**.

Consequence: the instant a run's work lands in a commit, `git diff HEAD` is empty. So the evidence badge
reads `+0 −0` with an empty file list, and the "Open repository diff" button — which today is wired to
`getApi().openExternal(run.projectpath)`, i.e. it opens the project folder in the OS file explorer, not a
diff at all — has nothing meaningful to point at anyway.

Two other surfaces share the same HEAD-anchored git RPCs and the same blind spot: the **Diff tab** (the
agents `"files"` surface, `filessurface.tsx` + `filesstore.ts`) fetches via `GitChangesCommand`
(file list) and `GitDiffCommand` (per-file), both `HEAD`-only (`CommandGitChangesData`/`CommandGitDiffData`
carry only `Cwd`/`Path`). The Diff tab has two behaviours over that data: a read-only **Diff** view
(`CenterPane`) and a mutable **Review** mode (`reviewstore.ts` → `GitRevertCommand`, accept/reject hunks) —
both fundamentally "current uncommitted state".

This spec adds a base-commit anchor so evidence diffs survive commits, and wires "Open repository diff" to
open the run's changes in the Diff tab.

## Decision: base-commit anchor + optional `Ref` on the git RPCs (Approach 1)

Capture the project's `HEAD` at run creation as the run's baseline; let the existing git commands diff
against that baseline instead of live `HEAD`; add a read-only run source to the Diff tab and point the
button at it. Diff **content** is computed live on demand (not frozen into the snapshot).

Rejected alternatives:
- **Freeze the full diff into `RunEvidence`** — fully immutable, but per-file patch text can be megabytes;
  bloats the channel-embedded object and breaks the "evidence is compact metadata" design. Still needs the
  base capture anyway.
- **Reconstruct changes from the worker transcript** (parse Edit/Write tool calls) — reinvents git,
  imprecise with overlapping edits, produces no real diff content.

### Diff-range semantics (confirmed: base → working tree, live)

`git diff <base>` compares the base commit to the **current working tree**, spanning committed *and*
uncommitted changes since the run started. It degrades to today's exact behaviour when nothing is
committed (base == HEAD-at-start). Accepted trade-off: if the user keeps working *after* the run
completes, the diff grows to include that later work — it is "since run start", not "frozen at
completion". A frozen `base..tip` snapshot is a clean future follow-up if drift ever bites; not v1.

## Data model (new Go field; JSON-embedded in `Channel`, no migration)

Added to `waveobj.Run`, regenerated to `frontend/types/gotypes.d.ts` via `task generate`:

```
Run.BaseCommit string `json:"basecommit,omitempty"` // HEAD of ProjectPath at run creation; "" when unresolved
```

`omitempty` → backward-compatible; runs created before this feature carry `""`. `Run` is embedded in
`Channel` (`runs?: Run[]`), so this is a struct change + `task generate` only — no DB migration.

## Backend

### 1. Git layer (`pkg/gitinfo`) — the load-bearing change

Add an optional base ref to both entry points; **`ref == "" ` reproduces today's exact behaviour** (this is
what leaves the live Diff tab and Review flow byte-for-byte unchanged).

- `CommandGitChangesData.Ref`, `CommandGitDiffData.Ref` (new fields; regenerate `wshclientapi.ts`).
- `GetChanges(ctx, cwd, ref string)`: when `ref != ""`, derive the file list from
  `git diff --name-status <ref>` (A/M/D/R letters) + `git diff --numstat <ref>` (adds/dels), **plus the
  existing untracked augmentation** (so uncommitted-new files in a mixed run still appear). Name-status
  output is normalized into the same status shape (`XY path`) that `parseNumstatStatus` (Go, evidence) and
  `parseGitChanges` (TS, Diff tab) already consume, so both parsers are reused unchanged. When `ref == ""`,
  the current `git status` + `git diff HEAD` path runs verbatim.
- `GetDiff(ctx, cwd, path, ref string)`: `git diff <ref> -- <path>`; keep the untracked → plain-file-view
  fallback (`d.untracked`) for uncommitted-new files. `ref == ""` → today's `git diff HEAD -- path`.

Normalization (name-status → porcelain-ish status) is the one genuinely new bit of parsing; everything
else is threading `ref` through existing code.

### 2. Run lifecycle

- `CreateRunCommand` (`pkg/wshrpc/wshserver`): capture `git rev-parse HEAD` of `ch.ProjectPath` into
  `run.BaseCommit` right after `NewRun`. Failure (no commits yet / not a repo) → leave `""`; non-fatal
  (the run still creates and works, evidence degrades gracefully).
- `SealEvidence` (`pkg/jarvis/evidence.go`): when `run.BaseCommit != ""`, derive `files` / `addtotal` /
  `deltotal` via the base-anchored `GetChanges(ctx, run.ProjectPath, run.BaseCommit)`; else fall back to
  the current HEAD path. This fixes the `+0 −0` badge for committed runs. Idempotence and the sealed-once
  contract are unchanged.

## Frontend

### Diff tab — run source (`filesstore.ts`, `filessurface.tsx`)

- `filesstore.ts`: add `loadFilesForRun(runId, cwd, baseCommit)` alongside `loadFilesForAgent` /
  `loadFilesForProject`. Token `run:<id>`. It records the base ref on `FilesState` and threads it into
  `GitChangesCommand`/`GitDiffCommand` (both `loadChangesForCwd` and `selectFile` pass `ref`). When
  `baseCommit == ""` it passes no ref → degrades to the live HEAD diff.
- `filessurface.tsx`: a **read-only run mode**. Reuses the file list + `DiffRow` rendering, but suppresses
  the Review/accept-reject entry and per-file revert affordances — a committed change is not
  working-tree-revertable, and the run view is a read-only record ("Snapshot is read-only"). The live
  agent/project modes keep Review + revert exactly as today.

### Button wiring (`runcompletionsurface.tsx`)

Replace the "Open repository diff" handler `openExternal(run.projectpath)` with: set the agents surface to
`"files"` (`globalStore.set(model.surfaceAtom, "files")`) and call
`loadFilesForRun(run.id, run.projectpath, run.basecommit)`. Keep the `+{ev.addtotal} −{ev.deltotal}` badge
(now non-zero for committed runs). The OS-folder-open behaviour is dropped.

## Confirmed decisions

- **Semantics = base → working tree, live** (`git diff <base>`); drift after completion accepted (see
  above). No frozen snapshot in v1.
- **Reuse the whole Diff tab**, not a bespoke inline viewer — the button lands in the real `"files"`
  surface with a new run source. Matches "use the Diff tab" and the existing `surfaceAtom` navigation.
- **Run mode is read-only** — no Review, no revert; committed changes aren't revertable and the record is
  immutable.
- **`ref == ""` is the compatibility contract** — existing callers pass no ref and get today's behaviour,
  guaranteed by a regression test.

## Error handling & edges

- **Old runs / no base** (`BaseCommit == ""`): the run source passes no ref → live HEAD diff (may be empty
  if already committed). No new empty-state UI; acceptable degradation for pre-feature runs.
- **No commits at run start** (`git rev-parse HEAD` fails) / **not a repo**: `BaseCommit == ""` → same
  fallback; the Diff tab shows its existing "not a repo" state where applicable.
- **Worktrees**: base is `rev-parse HEAD` of `ProjectPath` at start and we later diff that same path, so
  it is self-consistent even when workers use a separate worktree. Anything beyond that is out of scope.

## Testing

- **Go** (`pkg/gitinfo/gitinfo_test.go`): ref-mode — commit a change under a temp repo, assert
  `GetChanges(ref=base)` lists it with the right letter/counts and `GetDiff(ref=base, path)` returns the
  patch; assert `ref == ""` output is unchanged (regression guard on the live path). Untracked-in-ref-mode
  still counted. `pkg/jarvis/evidence_test.go`: seal with a `BaseCommit` + a committed change yields
  non-empty `files` and correct `addtotal`/`deltotal`.
- **Frontend**: `filesstore` `loadFilesForRun` sets the run source + threads `ref`; `gitstatus` parse of a
  name-status-derived status payload; `filessurface` run mode hides Review/revert.
- **Visual** (CDP, per project convention): a sealed done run whose work is committed — open its diff via
  the button and confirm the Diff tab shows the changes (not an empty tab).

## Out of scope (v1)

Frozen `base..tip` snapshots (drift mitigation); failed/cancelled run diffs; per-subagent file attribution;
revert/Review from the run-scoped view; changing the live Diff tab's HEAD-anchored behaviour.
