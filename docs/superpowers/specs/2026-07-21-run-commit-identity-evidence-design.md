# Run commit identity for sealed evidence — design

**Status:** design · 2026-07-21 · scopes open-issue **#6a** (`docs/open-issues.md`).

## Problem

Sealed run evidence over-attributes files under delegator fan-out. `SealEvidence` computes a run's
"Files touched" by diffing the **shared** working tree against a frozen baseline:

```
gitinfo.GetChanges(ctx, run.ProjectPath, run.BaseCommit)   // pkg/jarvis/evidence.go
```

`run.ProjectPath` is the channel's shared repo and `run.BaseCommit` is its HEAD at run creation. Each
run worker does its work in its **own** `.claude/worktrees/gN`, commits, and merges back onto the branch
`ProjectPath` tracks. So by seal time the shared tree holds the **union of every sibling** merged since
`BaseCommit`. Confirmed in prod `#cyber_assistant`: run G2's snapshot listed G1/G3/G4's files. The
per-file `By` field compounds it — it stamps the single *last* worker on every file.

Root cause: **a run has no per-run commit identity.** Only the start baseline (`BaseCommit`) is stored;
there is no field for the commit that represents the run's finished work, and Wave never sees the
worktree the worker used (the worker's block `cmd:cwd` is the shared `ProjectPath`).

## Decision

**The run worker reports the commit it produced; Wave records it and scopes the evidence diff to that
run's own lineage.** (Chosen over Wave owning per-run worktrees.)

Rationale — this matches the existing architecture and the KISS/YAGNI/single-source-of-truth
principles:
- Wave already **never commits or merges** by design (worker self-supervision is delegated to the
  agent's `/goal` loop). The commit that defines a run's change set is produced by, and known only to,
  the agent inside the worker. The natural source of truth is that commit.
- Wave already **builds the run-worker prompts** (`BuildPhasePrompt` / `BuildQuickPrompt` /
  `BuildOrchestratePrompt` in `pkg/jarvis/run.go`), so instructing the worker to report its commit is an
  in-repo change — no external `~/.claude` prompt to touch.
- The report channel already exists: workers finish by calling `wsh jarvis complete`.
- Wave *owning* worktrees would be a large new responsibility (create/track/teardown), would break the
  shared-tree model multi-phase runs depend on, and Wave still would not merge — so integration stays
  the agent's job regardless. Not worth it.

## Design

### Identity field

Add one field to `waveobj.Run`:

```go
EndCommit string `json:"endcommit,omitempty"` // commit the worker reported as its finished work;
                                               // scopes the evidence diff to BaseCommit..EndCommit
```

`Run` is stored as JSON inside `Channel.Runs` (`wstore_channel.go`), so a new `omitempty` field needs
**no DB migration** (old rows decode it as `""`).

### Reporting path

`wsh jarvis complete` gains an optional `--commit <sha>` flag. The flag threads through the existing
report path with no new command:

```
wsh jarvis complete --commit <sha>
  → CommandReportRunPhaseData.Commit
  → ReportRunPhaseCommand → AdvanceRunCommand
  → CommandAdvanceRunData.Commit
  → stored on Run.EndCommit (only for the "complete" action, only when non-empty)
```

The three Wave-built completion instructions change from `wsh jarvis complete` to report the commit,
e.g.:

> When your work is committed, report completion with `wsh jarvis complete --commit $(git rev-parse HEAD)`
> (run it from your working tree so the SHA is the tip of your own work).

`$(git rev-parse HEAD)` run from the worker's own worktree is the tip of *its* commits (its branch
forked from `BaseCommit`), so `BaseCommit..thatSHA` excludes siblings.

### Scoped diff

New `gitinfo.GetRangeChanges(ctx, cwd, base, end)` computes a **commit-range** diff — `git diff
--name-status -z --relative base..end` + `git diff --numstat --relative base..end` — reusing
`nameStatusToStatusZ`. It never consults the working tree or untracked files, so it is immune to
whatever else landed on the shared tree. `--relative` keeps paths `ProjectPath`-relative, matching the
existing evidence + Files-surface path convention.

`SealEvidence` chooses the source:

```go
if run.EndCommit != "" && run.EndCommit != run.BaseCommit {
    ch, gerr = gitinfo.GetRangeChanges(ctx, run.ProjectPath, run.BaseCommit, run.EndCommit)
    if gerr != nil {                                  // bad/unresolvable SHA → don't seal empty
        ch, gerr = gitinfo.GetChanges(ctx, run.ProjectPath, run.BaseCommit)  // fall back
    }
} else {
    ch, gerr = gitinfo.GetChanges(ctx, run.ProjectPath, run.BaseCommit)      // today's behavior
}
```

Fallback rule, which preserves every case that is correct today:
- **EndCommit set & ≠ BaseCommit** (worker committed) → range diff, siblings excluded. *(fixes fan-out)*
- **EndCommit empty** (worker left uncommitted work; the common single-run case) → today's
  working-tree-vs-baseline diff, unchanged.
- **EndCommit == BaseCommit** (worker committed nothing) → same fallback (a `base..base` range is empty;
  the working-tree diff is what the run actually left).
- **EndCommit unresolvable** (garbage SHA) → `GetRangeChanges` errors → fall back rather than seal empty
  (consistent with the existing "a git failure must not freeze an empty file list" guarantee).

The existing seal-hardening is unchanged: a git failure or context timeout still returns an error and
leaves `Evidence` nil for the backfill to retry.

### Authorship (`By`)

Drop `EvidenceFile.By`. With the diff scoped to a run's own commits, every file in the range is that
run's work, so per-file authorship is uniform and redundant — and under fan-out each unit is now its own
run/card, so "who" is conveyed by *which card* you are looking at. The field only ever held the
misleading last-worker id. Remove it from the struct, stop populating it, regenerate types, and remove
its render.

### User-facing surface

`runcompletionsurface.tsx`:
- The "Files touched" caption reads *"derived from worker transcripts"* — inaccurate (files are
  git-derived). Change to an accurate label, e.g. *"git diff since run baseline"*.
- Remove the per-file `{f.by}` render (field dropped).

### Orchestrator-parent note (intended behavior)

A parent orchestrator lead reports `--commit $(git rev-parse HEAD)` after its dispatched child runs have
merged, so the **parent** run's evidence is the aggregate rollup of its children, while **each child**
run scopes to its own reported commit. The reported bug was at the child level (G2 showing siblings);
children now attribute correctly, and the parent's aggregate is a defensible "everything this goal
changed" summary. If a non-rollup parent view is ever wanted, that is a follow-up.

## Out of scope

- **#6b** (file-row click → in-app Diff tab) and **#6c** (verification detail / command-label
  truncation) — independent surface fixes tracked separately in `docs/open-issues.md`.
- Wave-owned worktree lifecycle, aggregation cards, and remote/WSL worker git routing (#5).

## Testing

- `gitinfo.GetRangeChanges` — a repo with base `B` and two branches each adding distinct files; assert
  `B..tipA` lists only A's files (directly reproduces + proves the fan-out fix); cover a rename (R→M
  path) via `nameStatusToStatusZ`.
- `SealEvidence` — extend `evidence_test.go`: EndCommit set/≠base → range (only the run's files);
  EndCommit empty and EndCommit==base → working-tree fallback (today's behavior); unresolvable EndCommit
  → fallback, non-empty when the tree has changes.
- Reporting path — `--commit` flag reaches `CommandReportRunPhaseData.Commit`; `AdvanceRunCommand`
  stores it on `Run.EndCommit` for the complete action and ignores it for others.

## Files

- `pkg/waveobj/wtype.go` — add `Run.EndCommit`; remove `EvidenceFile.By`.
- `pkg/gitinfo/gitinfo.go` — add `GetRangeChanges`.
- `pkg/jarvis/evidence.go` — source-selection in `SealEvidence`; stop stamping `By`.
- `pkg/jarvis/run.go` — commit-reporting in the three completion instructions.
- `pkg/wshrpc/wshrpctypes_runs.go` — `Commit` on the report + advance data types.
- `pkg/wshrpc/wshserver/wshserver_runs.go` — thread `Commit`; store `EndCommit` on complete.
- `cmd/wsh/cmd/wshcmd-jarvis.go` — `--commit` flag on `complete`.
- `frontend/app/view/agents/runcompletionsurface.tsx` — caption + drop `by` render.
- Generated: `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts` via `task generate`.
