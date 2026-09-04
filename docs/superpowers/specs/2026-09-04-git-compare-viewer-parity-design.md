# Diff surface: comparison and viewer parity

**Date:** 2026-09-04
**Status:** design approved, no plan written yet
**Scope:** read-only. Repository-mutating actions (checkout, cherry-pick, revert) are deliberately a
second spec — see "Not in this spec".
**Predecessors:** `2026-07-31-git-branch-comparison-design.md` (the compare state this extends),
`2026-08-03-git-review-history-reads-design.md` (history reads and the declined folding),
`2026-08-06-diff-scope-model-design.md` (the scope model this adds a field to).

## Why

The Diff surface can compare two refs, but it answers the comparison with a plain unified text list:
no syntax highlighting, no side-by-side, no word-level highlighting, no change navigation. The
reference point is a JetBrains-style branch comparison, and against that the surface has six gaps:
the diff renderer, the range form, ref freshness, swapping direction, file grouping, and repository
actions. This spec closes the first five.

It also fixes something older that only became visible while measuring the first: **the surface is
unusable at the window size the app actually ships.** `src-tauri/tauri.conf.json:14` opens the main
window at 1000x700. The history column is fixed at 460px and the commit column at 300px, so the diff
pane gets roughly 240px — about 30 characters. Every improvement to the renderer is polish on a pane
too narrow to read, so the layout is fixed first and the renderer second.

## What already exists — do not rebuild it

| Piece | Where | State |
|---|---|---|
| Divergence, merge base, aggregate and per-commit reads | `gitinfo.GetDivergence`, `CompareChanges`, `CompareDiff`, `CommitChanges`, `CommitDiff` | Shipped. Reused unchanged except where noted in decision 2. |
| Monaco diff editor | `frontend/app/monaco/monaco-react.tsx:127` `MonacoDiffViewer` | Shipped, lazy-loaded. Takes `original` / `modified` full texts, updates models on prop change (`monaco-react.tsx:176`) and options on prop change (`:191`). No remount per file needed. |
| Monaco theme bridge | `frontend/app/monaco/monacotheme.ts` `useSyncMonacoTheme` | Shipped, called by `view/code/codesurface.tsx:59`. The Diff surface calls the same hook. No new tokens. |
| Unified-diff parser | `frontend/app/view/agents/gitdiff.ts` | Shipped. Retained — see decision 4. |
| Scope model | `diffscope.ts`, `diffscopeatom.ts`, `agentdiffnav.ts` | Shipped. Gains one field (decision 2). |
| Changed-file list, per-file adds/dels | `changedfilelist.tsx`, `gitstatus.ts` `parseGitChanges` | Shipped. `GitChange` already carries `adds`/`dels`, so the diff header needs no extra read. |
| Local branch listing | `gitinfo.ListBranches` | Shipped, `refs/heads` only. Extended in section 1. |
| Failure panel and `GitFailure` shape | `gitinfo.failureOf`, `gitstatepanels.tsx` | Shipped. Fetch failures reuse it. |

## Resolved decisions

**1. The layout is fixed before the renderer, and the fix is one collapsible column.** The history
column collapses to a 44px rail showing short hashes and lane dots; the commit/file column keeps its
width. Collapse is width-driven: below a 1280px surface width the rail is the initial state, above it
the column is expanded. A manual toggle overrides the width default and persists for the session.
At 1000x700 this yields roughly 690px of diff pane (about 88 characters) instead of 240px.

*This revives a declined decision, deliberately and narrowly.* `docs/deferred.md:897` declined
narrow-window folding on the premise that "the cockpit runs at roughly 1600x950". The shipped default
window contradicts that premise, which is the new evidence. What is revived is one threshold on one
column. The rest of the declined cascade — dropping the author column, folding the graph to three
lanes, turning history into a drawer below 900px, comfortable/compact row density — stays declined,
and `historypane.tsx` keeps its single `ROW_H = 34`.

**2. The range form is part of the range, not a control beside it.** `DiffRange`'s compare variant
becomes `{ kind: "compare"; base; head; form: "mergebase" | "tips"; from }`, defaulting to
`"mergebase"`. `rangeKey` (`diffscope.ts:75`) includes the form, so switching it drops stale reads
through the token mechanism `comparestore.ts` already uses, and the surface keeps exactly one value
describing what it is showing. `"mergebase"` is `git diff base...head` (shipped `CompareChanges` /
`CompareDiff`); `"tips"` is the two-dot form and needs a flag threaded into both readers.

Three-dot stays the default because it is the only form whose file list corresponds one-for-one with
the "N ahead" commit list beside it. Two-dot is offered because "has base moved under me" is a real
question the surface currently cannot answer. The aggregate pane header names the active form, so
the file list can never silently disagree with the commit column.

**3. Remote-tracking refs are the answer to staleness; fetch is the smaller half.** `ListBranches`
returns `refs/heads` and `refs/remotes`, each tagged, `origin/HEAD` skipped. `DefaultBranch` then
prefers `origin/<name>` when it resolves, since the picker can finally show it — which removes the
stale-local-main caveat accepted in the 2026-07-31 spec's decision 4. Fetch ships as an explicit
button because a remote-tracking ref is only as fresh as the last fetch.

**4. Monaco replaces the diff pane in every state, and `parseUnifiedDiff` stays.** One pane serves
history, compare and the working tree, so the two cannot drift. The parser is retained as the source
of the no-text states (binary, pure rename) and as the patch source the actions spec needs for hunk
revert. If the actions spec is never written, the parser's `hunks` / `diffHeader` fields become dead
code and should be removed then, not now.

**5. Unified is the default renderer at every width; split is offered once the pane is wide enough.**
Monaco does both through `renderSideBySide`, so this is a toggle, not a second renderer. The gate is
the measured width of the diff pane itself (`SPLIT_MIN_PX = 900`), not the window: a collapsed
history column at 1000x700 leaves about 690px, and the same window maximized leaves well over 900px.
Keying on the window would make the toggle available in exactly the case it should not be. Below it, the
split option is rendered disabled and explains itself, following the range strip's existing idiom
for a control that cannot apply (`diffscope.ts:38`).

## 1. Backend

### `pkg/gitinfo/gitinfo.go`

```go
// FileAtRef returns one file's full content at a ref. The path is cwd-relative, matching every
// other reader in this package, so the ref spec uses the "./" form: `git show <ref>:./<path>`
// resolves relative to cwd, while `<ref>:<path>` resolves from the repo root and silently misses
// in a subdirectory checkout. Missing=true when the blob does not exist at that ref (a file added
// on one side, deleted on the other) — not an error, because one empty side is how the diff
// editor renders an add or a delete. Binary=true when the content is not valid UTF-8; Content is
// then empty, because the pane has a state for "no text to show" and Monaco has no use for bytes.
// maxBytes caps the transport: over it, TooLarge=true and Content is empty, so a 40 MB blob is
// never pushed over the wire to be discarded by the pane. Size is always the real size, because
// the refusal message names it.
func FileAtRef(ctx context.Context, cwd, ref, path string, maxBytes int64) (*FileContent, error)

type FileContent struct {
    Content  string `json:"content"`
    Binary   bool   `json:"binary"`
    Missing  bool   `json:"missing"`
    TooLarge bool   `json:"toolarge"`
    Size     int64  `json:"size"`
    IsRepo   bool   `json:"isrepo"`
}
```

Size comes from `git cat-file -s <ref>:./<path>`, which reads the blob header only, so the cap is
decided before any content is read.

```go
// Fetch updates remote-tracking refs. Uses runErr so a credential or network failure carries git's
// own stderr; the caller renders it through the shipped GitFailure panel rather than a blank
// column. Never touches the working tree, which is what keeps this spec read-only from the
// repository's point of view.
func Fetch(ctx context.Context, cwd, remote string) (*FetchResult, error)

type FetchResult struct {
    FetchedAt int64               `json:"fetchedat"` // unix seconds, for the freshness clock
    Failure   *GitFailure `json:"failure,omitempty"`
    IsRepo    bool                `json:"isrepo"`
}
```

**`ListBranches` gains remotes.** `for-each-ref --sort=-committerdate refs/heads refs/remotes`, with
`BranchInfo` gaining `Remote bool`. `origin/HEAD` is filtered out — it is a symbolic ref, not a
comparison target. Existing caller `newagentmodal.tsx` must keep seeing local branches only, so the
filtering happens at that call site or through an option; the plan picks one after reading it.

**`DefaultBranch`** prefers `origin/<name>` when `refs/remotes/origin/<name>` resolves, falling back
to the local name, then the `main`/`master` probe. The doc comment at `gitinfo.go:763` explaining why
it returns a local-only name is rewritten — that constraint is what this spec removes.

**`CompareChanges` / `CompareDiff` gain a form parameter** (`"..."` vs `".."`). The existing
three-dot rationale stays in the doc comment; the two-dot branch gets its own sentence saying what it
is for and why it does not match the commit column.

### `pkg/wshrpc/wshrpctypes_git.go`

New in the `GitCommands` interface, following the shape of the existing pairs:

- `GitFileAtRefCommand(cwd, ref, path)` -> `FileContent`
- `GitFetchCommand(cwd, remote)` -> `FetchResult`

`CommandGitCompareChangesData` and `CommandGitCompareDiffData` gain `Form string`. Implementations
land in `pkg/wshrpc/wshserver/wshserver_git.go` beside their siblings. `task generate` regenerates
`wshclientapi.ts` and `gotypes.d.ts` — never hand-edited.

`GitFetchCommand` is called with a raised client timeout (`RpcOpts{Timeout: 60000}`); the default 5s
budget binds the server context and would kill a fetch that is merely slow.

## 2. Layout

`filessurface.tsx` currently hardcodes `w-[460px]` and `w-[300px]`. The history column's width
becomes a function of one boolean.

- `historyCollapsedAtom` — module-level (surfaces unmount on nav switch; component state would be
  lost), holding `null` = follow the width default, or an explicit `true`/`false` from the user.
- The width default is read from a `ResizeObserver` on the Diff surface's own root — the window
  minus the nav rail, not `window.innerWidth` — compared against a `HISTORY_COLLAPSE_PX = 1280`
  constant. Pure resolution — `collapsed(explicit, surfaceWidth)` — lives
  in `difflayout.ts` with its test; the component only observes and renders.
- Collapsed renders `historyrail.tsx`: short hash, lane dot colour, selected tint, the same
  `onSelect`. It is a narrow presentation of rows the surface already has, not a second data path.
- A chevron toggles; `Shift+H` binds to the same action.

The compare column (`comparecolumn.tsx`) collapses on the same rule and the same atom — in compare
the left column is the divergence list, and the width problem is identical.

## 3. The diff pane

`CenterPane` moves out of `filessurface.tsx` (currently `:255`) into `diffpane.tsx`. It is not a reuse
of `view/codeeditor/diffviewer.tsx`, which resolves its options through `useOverrideConfigAtom(blockId, …)`
— block config is Electron-era and there is no block here.

**What it mounts.** A lazily-imported `MonacoDiffViewer` (same import shape as
`codeeditor/diffviewer.tsx:9`), kept mounted across file switches, since it updates its models on prop
change. Options: `readOnly: true`, `originalEditable: false`, `renderSideBySide` from the split
toggle, `minimap: { enabled: false }`, font from the cockpit's mono token. `useSyncMonacoTheme()` is
called once by the surface.

**The model URI is scope-qualified.** `MonacoDiffViewer` builds its URIs from the `path` prop
(`monaco-react.tsx:137`) and Monaco throws when a model is created at an existing URI. The pane
passes `${scopeKey(scope)}/${path}` so two states showing the same file cannot collide.

**Which two texts, per state:**

| State | `original` | `modified` |
|---|---|---|
| Working tree | `FileAtRef(HEAD or the range's anchor ref)` | `FileReadCommand` on disk (as `codestore.ts:256` does) |
| Commit row | `FileAtRef(commitBase(hash))` | `FileAtRef(hash)` |
| Compare, `mergebase` | `FileAtRef(mergeBase)` — already known from `compareSidesAtom`, no extra call | `FileAtRef(head)` |
| Compare, `tips` | `FileAtRef(base)` | `FileAtRef(head)` |

Both sides load in one `Promise.all` behind the same stale-token guard the stores already use. The
untracked-file case keeps working: `Missing` on the original side is an empty string, which Monaco
renders as a pure addition.

**Header.** Path, `+adds -dels` from the selected `GitChange` (no extra read), the split/unified
toggle, `Open in Code`, and `Open in editor` under its existing working-tree-only condition.

**Refusals, in order.** Binary on either side -> the shipped binary sentence. Both sides missing ->
nothing to show. `TooLarge` on either side -> "File too large to display (N MB)" with the
`Open in Code` button still live. The cap is 2 MB, which is a guess and is written down as one: the
plan measures Monaco's mount time on the largest files in this repo and adjusts.

**Loading.** The existing `DiffSkeleton` stays; Monaco mounts only once content has arrived, so the
lazy chunk load and the two reads overlap.

## 4. Comparison controls

- **Swap** — a control between the two fields in `refpicker.tsx`. Editing, it swaps the drafts;
  closed, it swaps the live refs and re-reads. Bound to `Shift+S` (bare letters near the surface's
  existing `c`, `/`, `G` are crowded, and `assertNoConflicts` is the referee).
- **Suggestions** group local above remote, each labelled, recency-ordered within a group. Free text
  still wins, so a tag or raw SHA works.
- **Form toggle** in the aggregate pane header: `••• merge base` / `•• tip to tip`, writing
  `range.form` through `setDiffRange`.
- **Fetch** in the subject bar, compare-only: a button, a spinner while in flight, a
  "fetched 4m ago" clock derived from `FetchedAt`. On success the branch list and the current
  comparison re-read. On failure the shipped `GitFailurePanel` renders git's stderr.

## 5. File list grouping

`filetree.ts`, pure: `GitChange[]` -> rows. A directory row carries its rolled-up file/add/del
counts; single-child directories collapse into one row (`retry/internal/` rather than two levels), a
detail worth testing because it is the difference between a tree and an indented list. Collapse state
and the tree/flat toggle live in module-level atoms.

`ChangedFileList` renders both shapes, so `CommitPane` and `AggregatePane` gain the tree together;
neither knows which shape it asked for.

## 6. Keybindings

Added to `buildFilesBindings` (`frontend/app/store/keybindings/bindings.ts:638`):

| Key | Action | When |
|---|---|---|
| `Shift+H` | Toggle history column | surface active |
| `Shift+S` | Swap compare refs | in compare |
| `Shift+D` | Toggle split / unified | a file is open, split available |

The existing Escape ordering (clear filters, else leave compare, else home) is untouched. Every
binding goes through `assertNoConflicts`, which the bindings test already enforces.

## Error handling

Nothing new in kind. A failed `FileAtRef` shows the pane's error state and leaves the file list
intact; a failed fetch renders the shipped failure panel with git's own words; a failed compare keeps
its existing "Couldn't compare X with Y" phrasing, which names the pair because an unresolvable ref
is the common cause. The consistent rule, unchanged from the predecessor specs: surface git's failure
rather than an empty view that reads as "no differences".

## Testing

**Go table tests** (`pkg/gitinfo/gitinfo_test.go`, `t.TempDir()` repos as the file already does):
`FileAtRef` for text, binary, missing-at-ref, root commit, and a subdirectory cwd — the last one is
the `./` regression; `ListBranches` with a remote present and `origin/HEAD` filtered; `DefaultBranch`
preferring the remote and falling back; `CompareChanges` two-dot returning the base side's changes
where three-dot does not; `Fetch` failure carrying stderr.

**Vitest:** `filetree.ts` derivation including single-child collapse; `difflayout.ts` collapse
resolution; `rangeKey`/`scopeKey` with the `form` field, which is what guards the stale-read drop.
No test for the store glue — repo convention is that pure derivation is tested and RPC plumbing is
not.

**CDP:** one `verify:ui` scenario for compare with the diff pane mounted, pinned at 1000x700 so the
layout claim in decision 1 is what gets asserted. The scenario deferred by the 2026-07-31 spec is
this one.

## Not in this spec

- **Repository actions** — checkout, cherry-pick, revert, staging. The whole reason for the two-spec
  split: everything here reads, that spec writes, and it needs its own confirmation design.
  `gitinfo.RevertFile` / `RevertHunk` stay orphaned until then (`docs/deferred.md:80`).
- Commit provenance, the "Produced by Run #148" line — excluded by the 2026-07-31 spec's decision 1.
- Keyboard navigation of the changed-file list. It has none today; the tree does not add one.
- The rest of the declined narrow-window cascade, per decision 1.
- Diff search, whitespace-ignore options, and per-hunk staging.

## Risks

- **Two reads per file selection instead of one**, plus a Monaco mount. The size cap is the
  mitigation and the number is unmeasured; the plan measures it.
- **The blast radius is the whole Diff surface**, not just compare. That is the intent — one pane, no
  drift — but history, working-tree and run scopes all change appearance in the same commit.
- **`ListBranches` has an existing caller.** `newagentmodal.tsx` must not start offering remote
  branches as agent targets; the plan reads it before choosing where the filter goes.
