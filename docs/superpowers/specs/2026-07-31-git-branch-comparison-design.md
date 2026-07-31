# Branch comparison for the Diff surface

**Date:** 2026-07-31
**Status:** design approved, no plan written yet
**Design source:** `wave-handoff/wave/project/Wave-git-review.dc.html`, the `compare` state (mockup markup at lines 373–450, its design notes at line 935, its hint footer at line 908). The brief is `docs/superpowers/briefs/2026-07-31-git-review-ui-design-brief.md`.

## Why

The Diff surface currently answers one question at a time: what does this one commit, or the working tree, contain. The mockup's `compare` state answers a second one — how do two refs differ — and it is the question a review surface exists for. It is one of thirteen states the mockup declares, and the only one whose backend already partly exists: `GitDivergenceCommand` shipped in commit `010fa7e9` and has had no caller since.

## What already exists — do not rebuild it

| Piece | Where | State |
|---|---|---|
| Divergent commit lists + merge base | `gitinfo.GetDivergence`, `GitDivergenceCommand` | Shipped `010fa7e9`. **No frontend caller.** This spec adds the first one. |
| Single-commit changed files and per-file diff | `gitinfo.CommitChanges` / `CommitDiff`, `GitCommitChangesCommand` / `GitCommitDiffCommand` | Shipped `a7c7c6cd`. Reused unchanged when a commit row is selected. |
| Local branch listing, recency-ordered | `gitinfo.ListBranches`, `ListBranchesCommand` | Shipped. Already consumed by `newagentmodal.tsx`. Returns `refs/heads` only — no remotes, no upstream tracking. |
| Lane colour palette | `frontend/tailwindsetup.css:94-100`, `--color-graphlane-1..6` and `-fold` | Shipped `a7c7c6cd`. Reused for the two side colours. No new tokens. |
| Unified-diff parse and render | `gitdiff.ts` and the surface's diff pane | Shipped. Untouched by this spec — the right-hand pane is shared between history and compare. |
| Two-ref aggregate file list, two-dot form | `gitinfo.GetRangeChanges` | Exists, but is **not** exposed over RPC and uses the wrong range form for this feature (see decision 2). Only `pkg/jarvis/evidence.go` calls it. Leave it alone. |

## Resolved decisions

**1. Scope is comparison only.** Commit provenance — the mockup's "Produced by Run #148" line — is excluded and gets its own spec. It shares no data path with divergence: it joins `Run` objects to commit hashes, and Runs reach the frontend only per-active-channel (`activeChannelRunsAtom` in `channelsstore.ts`), so the Diff surface has no Run list to join against and provenance needs its own backend read.

**2. The aggregate diff is anchored at the merge base — three dots, not two.** `git diff base...head` diffs from the merge base to head, so the middle pane's file list is exactly what head's own commits did, matching the divergent-commit list beside it one-for-one. The two-dot form `git diff base head` would include the base side's unique commits *inverted* — lines they added appearing as deletions — so the file list would match neither side's commit list and the totals would mix two unrelated stories. This is why `GetRangeChanges` cannot be reused: it hardcodes the two-dot form, which is correct for its own caller (a Run's base commit is an ancestor of its end commit, so the two forms agree there) and wrong here.

**3. The two refs are chosen in an inline two-field chip in the subject bar.** The surface's static ref-expression chip becomes editable in place: two text inputs with a recency-ordered branch suggestion list each, degrading to free text so a tag or a raw SHA works. One control serves both entry gestures the mockup names — press `c`, or click the ref expression — so there is no second overlay component and no duplicated ref-selection logic.

*Field order and focus, stated because they differ.* The chip displays **head first, then base** (`feature/idempotent-retries … main`), following the mockup, which orders it that way in both the chip (line 871) and the aggregate pane's arrow (lines 405–407) and is authoritative for composition. The sketch approved during brainstorming drew the reverse order; the mockup wins. Focus on entry lands on the **base** field regardless of its position, because head is almost always the branch you are already on and base is the ref you came to change.

**4. Compare opens on the checked-out branch against the repo's default branch.** That is the review question and the mockup's own example (`feature/idempotent-retries` against `main`), so `c` produces a useful read with no typing. When already on the default branch both fields stay filled and both sides come back empty, which reads correctly as "nothing diverges".

*Caveat accepted deliberately:* the default is resolved to the **local** branch name, so a stale local `main` overstates divergence. Chosen anyway because it is what the suggestion list can offer and what the mockup shows; the deferred Fetch button is the real answer to staleness. Document this at the reader.

**5. The aggregate is row zero of the commit column.** The mockup says selecting a commit on either side shows that commit and that the file list stays on the aggregate until you do, but never says how to get *back* — and `esc` is spoken for, it leaves compare. So a pinned Aggregate row sits above both sides and is just another selectable row: returning is selecting it, by click or by `j`/`k`, with no gesture to learn and no key whose meaning depends on invisible state. This mirrors the pattern commit `a7c7c6cd` established for history, where uncommitted work became row zero instead of a mode.

**6. Compare is a two-ref variant of the repo scope, not a new surface and not a mode.** The surface already has three scopes — run, repo, agent — selected by chips. Entering compare swaps the left column and the middle pane; the diff pane is untouched and shared. The scope chips stay visible and the repo chip reads as selected for as long as compare is active, matching the mockup; picking a different scope chip exits compare, because run scope and agent scope are single-ref reads by definition. Rejected alternatives: a separate cockpit surface (not in `SURFACE_ORDER`, and it would need its own copy of the diff pane), and a grouped variant of `historypane.tsx` (that component is coupled to the graph gutter and lane geometry, and compare draws no graph).

## 1. Backend

### Readers, in `pkg/gitinfo/gitinfo.go`

```go
// CompareChanges returns the per-file changes head introduces relative to base, anchored at their
// merge base (three-dot). Never consults the working tree. Paths are cwd-relative, matching
// GetChanges and GetRangeChanges. IsRepo=false when cwd is not a repo; errors on a git failure so
// the caller can name the ref that did not resolve.
func CompareChanges(ctx context.Context, cwd, base, head string) (*Changes, error)

// CompareDiff returns the unified diff of one path between base and head, anchored at their merge
// base. Unlike GetDiff there is no untracked-file branch: a two-ref diff cannot have one.
func CompareDiff(ctx context.Context, cwd, base, head, path string) (*Diff, error)

// DefaultBranch resolves the repo's default branch as a local branch name. Returns "" (not an
// error) when nothing resolves, so the ref picker degrades to an empty base field.
func DefaultBranch(ctx context.Context, cwd string) (string, error)
```

- `CompareChanges` runs `git diff --name-status -z --relative base...head` and `git diff --numstat --relative base...head`, then reuses the existing `nameStatusToStatusZ` helper — the same shape `GetChanges`, `GetRangeChanges` and `CommitChanges` all produce, so `parseGitChanges` on the frontend needs no change.
- `CompareDiff` runs `git diff base...head -- path`.
- `DefaultBranch` tries `git symbolic-ref --short refs/remotes/origin/HEAD` and strips the leading `origin/`; on failure it probes `git rev-parse --verify main`, then `master`; then returns `""`.

### RPC, in the git domain

Two new commands on `GitCommands` in `pkg/wshrpc/wshrpctypes_git.go`, with thin handlers in `pkg/wshrpc/wshserver/wshserver_git.go` matching the two commit-scoped handlers shipped in `a7c7c6cd`:

```go
GitCompareChangesCommand(ctx, CommandGitCompareChangesData{Cwd, Base, Head}) (*CommandGitCompareChangesRtnData{StatusZ, Numstat, IsRepo}, error)
GitCompareDiffCommand(ctx, CommandGitCompareDiffData{Cwd, Base, Head, Path}) (*CommandGitCompareDiffRtnData{Diff}, error)
```

Plus one **additive** field on the existing `CommandListBranchesRtnData` in `pkg/wshrpc/wshrpctypes_projects.go`:

```go
Default string `json:"default,omitempty"` // the repo's default branch, for the compare ref picker
```

populated in the existing `ListBranchesCommand` handler from `gitinfo.DefaultBranch`. This avoids a third command: the ref picker gets its suggestions and its default in one round trip. `newagentmodal.tsx` already calls that command and an added field cannot affect it.

Then `task generate`. Never hand-edit `wshclientapi.ts`, `gotypes.d.ts`, or `wshclient.go`.

### Backend tests

Table tests in `pkg/gitinfo/gitinfo_test.go` on temp-repo fixtures, following the existing pattern there:

1. `CompareChanges` on genuinely diverged refs lists only head's files — a file changed solely on the base side does not appear, and no addition appears inverted as a deletion. This is the test that would fail under the two-dot form, so it is the one that protects decision 2.
2. `CompareChanges` returns an empty file list, not an error, when the refs do not diverge.
3. `CompareChanges` returns `IsRepo:false` for a non-repo directory.
4. `CompareDiff` returns the diff of one path between two refs, and errors (not empty) on an unresolvable ref.
5. `DefaultBranch` resolves via `origin/HEAD` with the prefix stripped; via the `main` probe; via the `master` probe; and returns `""` when none of the three resolve.

Run with the Windows-path CGO flag from `CLAUDE.md`, or via `task build:backend` which sets it itself.

## 2. Frontend state

New `frontend/app/view/agents/comparestore.ts`. Deliberately not an extension of `githistorystore.ts` — that file is the history spine and compare is a distinct read with its own selection.

Every atom is module-level, so the state survives the surface unmounting on a nav switch. This is the same hazard the fix in commit `f8044bd4` addressed when it moved the picked project out of component state.

| Atom | Holds |
|---|---|
| `compareOnAtom` | whether compare is active |
| `compareRefsAtom` | `{ base, head }`, or null before first entry |
| `compareSidesAtom` | `{ ahead, behind, mergeBase }` from `GitDivergenceCommand` |
| `compareAggregateAtom` | the parsed aggregate `GitChanges` |
| `compareSelectionAtom` | the selected row id: the aggregate sentinel, or a commit hash |
| `compareSelectedFileAtom` | the open file path |
| `compareErrorAtom` | a failed compare read, naming the ref that failed |
| `compareBranchesAtom`, `compareDefaultAtom` | the ref picker's suggestions and default |

Loaders: `enterCompare(cwd, currentBranch)`, `setCompareRefs(cwd, base, head)`, `selectCompareRow(cwd, rowId)`, `selectCompareFile(cwd, path)`, `exitCompare()`.

`enterCompare`'s `currentBranch` is the branch the surface already holds in `filesStateAtom.branch`, which `GitChangesCommand` resolves for the change-list read — no extra git call to learn where you are. It becomes head; base comes from the `Default` field on the branches read.

**One selection model, two data sources.** Selecting the aggregate row calls the two new compare commands. Selecting a commit row on either side calls the already-shipped `GitCommitChangesCommand` / `GitCommitDiffCommand`, exactly as the history spine does — a commit's own contents mean the same thing whether you reached it from history or from a compare side.

The aggregate row's sentinel id is a distinct non-empty string, exported as `AGGREGATE` from `comparerows.ts` beside the row builder that produces it — the same way `WORKING_TREE` is exported from `historyrows.ts`. It is deliberately **not** history's `WORKING_TREE = ""`: the two row models stay independent, and nothing has to reason about whether an empty id means the working tree or the aggregate.

`exitCompare()` clears `compareOnAtom` and the compare selection but leaves the history store's own selection untouched, which is what makes `esc` restore the previous history view for free.

## 3. Components

**`comparerows.ts`** — pure, unit-tested, the same role `historyrows.ts` plays for history. Flattens the two sides into one ordered row list: the aggregate row, then the head side's group header and its commits, then the base side's. Group headers are not selectable, so the module also exports the selectable-id list that `j`/`k` walks, and a `sideJumpTarget(rows, fromId)` that resolves `Tab` to the first commit of the other side. Each side carries its colour token and its commit count.

Vitest cases: row order with both sides populated; the aggregate row is always first and always selectable; group headers are excluded from the selectable ids; per-side counts; one side empty; both sides empty; the selectable-id list is what list-nav consumes, in order; and `sideJumpTarget` from the aggregate row, from each side, and with the other side empty.

**`changedfilelist.tsx`** — the changed-file renderer extracted from `commitpane.tsx:88-126` (status letter, truncated path, `+adds` / `−dels`, selected-row tint). `CommitPane` imports it; the new aggregate pane reuses it. Pure refactor, no behaviour change, no new props beyond what `CommitPane` already passes.

**`comparecolumn.tsx`** — renders the rows, plus the merge-base note at the bottom of the column as the mockup draws it. Side colours reuse the shipped lane palette: head is `--color-graphlane-2`, base is `--color-graphlane-1` — the mockup's own two colours. No graph gutter; compare draws no graph.

**`aggregatepane.tsx`** — header showing `head → base` in those side colours, the file count, and the `+` / `−` totals, then `ChangedFileList`.

**`refpicker.tsx`** — the subject-bar chip. Read-only display when compare is off. When editing, two text inputs with a recency-ordered suggestion dropdown from `compareBranchesAtom`; Enter applies and triggers the read, Escape cancels the edit **without** exiting compare. Free text is accepted so a tag or a raw SHA works.

Column widths are unchanged from the history state — 460 for the left column, 300 for the middle, remainder for the diff — so this is a content swap, not a layout change.

## 4. Keys, errors, and what gets tested

**Keys**, registered in the existing keybinding registry beside the surface's current bindings, with hint-footer entries matching the mockup's compare footer (`↑↓ commit`, `⇥ switch side`, `⏎ open file`, `c change refs`, `esc back to history`, `⌃P palette`):

- `c` — enter compare, base field focused and pre-filled. While already in compare, `c` reopens the picker.
- `esc` — exit compare, restoring the previous history selection. One meaning, always.
- `j` / `k` — walk selectable rows in column order: the aggregate row, then head's commits, then base's, skipping the two group headers.
- `Tab` — move the selection to the **first commit of the other side**, so it is a jump between groups rather than a focus change. From the aggregate row it goes to head's first commit. When the other side has no commits it does nothing.
- `Enter` — open the selected file in the diff pane.

**Errors:**

- A failed compare read sets `compareErrorAtom` and the column shows it, naming the ref that did not resolve. Surfacing git's failure beats an empty column that looks like "no differences".
- Refs that do not diverge at all show "these refs do not diverge" plus the merge base — a stated result, not an empty list.
- Not-a-repo keeps the surface's existing one-line treatment. The mockup's *full-pane* error and not-a-repo panels, each with the failing command and its stderr, remain deferred to the remaining-states work.

**Tests:** the five Go table tests above; vitest for `comparerows.ts`. No test for `comparestore.ts` — it is thin RPC glue, and the repo convention is that pure derivation is tested while plumbing is not (`githistorystore.ts` and `filesstore.ts` both have no test). Composition is checked once by a Chrome DevTools Protocol screenshot against the mockup's compare state; the repeatable `verify:ui` scenario stays deferred.

## Not in this spec

Each is a state or control the mockup declares, so the surface will visibly lack it. All were deferred in the surface plan (`docs/superpowers/plans/2026-07-31-git-review-surface.md`) and stay deferred here:

- Commit provenance, the "Produced by Run #148" line — excluded by decision 1, gets its own spec.
- The Fetch button and its freshness clock, which is also the real answer to the stale-local-default caveat in decision 4.
- The filter row (author, path, free text) and history pagination.
- Full-pane "not a repository" and "the Git read failed" panels.
- History scroll-offset persistence and the "Restored" banner.
- Narrow-window folding and row density.
- The Unified / Split diff toggle, and the desaturated diff-text tints `--color-diff-add-ink` / `--color-diff-del-ink`.
- A `verify:ui` scenario in `scripts/cdp/scenarios.mjs`.
