# Code surface: a git-aware, mutable file tree

**Date:** 2026-09-04
**Status:** design approved, no plan written yet
**Design source:** none — no mockup. Follows the surface's existing two-pane shape, its column-mode
idiom, and the cockpit scaffold (`surfacescaffold.tsx`).
**Predecessors:** `2026-08-03-code-browser-surface-design.md` (the surface),
`2026-08-06-code-surface-navigation-and-handoff-design.md` (the tree cursor and column modes),
`2026-08-15-code-theme-sync-and-markdown-preview-design.md` (the view-mode toggle this extends).
**Reopens:** the 08-15 out-of-scope line "Diff-vs-HEAD toggle and the 'changed on disk' staleness bar
(designed in chat 2026-08-15, shelved by user redirect)". Both are in this spec.
**First of three.** Sibling specs, same date: `2026-09-04-code-search-and-symbols-design.md` (spec 2),
`2026-09-04-code-scope-beyond-registry-design.md` (spec 3). Implementation order is 1 → 2 → 3; spec 3
changes the data source both of the others sit on, so it goes last.

## Why

The Code surface reads and writes files in a git repository and knows nothing about git while doing
it. Three consequences, all felt in daily use:

**The tree cannot tell you what changed.** Every row looks identical whether the file is untouched,
edited by you, edited by an agent five minutes ago, or brand new. Orienting after an agent run means
switching to the Diff surface, reading the changed-file list there, and coming back to type the path
into the finder.

**The editor cannot show you a file's own change.** You can read the file as it is, and you can read
a unified diff on another surface, but not the file *against HEAD* in the place you are editing it.

**A file can change underneath an open buffer with no signal.** The store pins `size` and `modtime`
when it reads a file and compares them again at save time — so a conflict is caught, but only after
you have typed into a stale buffer and pressed Ctrl+S. Agents run against this same working tree, so
that is the normal case rather than the exotic one.

And a fourth thing, adjacent: **the surface can edit a file but not create, rename, or remove one.**
Every structural change means leaving for a terminal, and then pressing `r` because the index is a
snapshot.

## What already exists — do not rebuild it

| Piece | Where | State |
|---|---|---|
| Working-tree status, with per-file adds/dels | `gitinfo.GetChanges(ctx, cwd, ref)` → `GitChangesCommand` (`wshrpctypes_projects.go:13`) | Shipped. Returns `StatusZ` (porcelain -z) + `Numstat`. Already called with an arbitrary `cwd` by `filesstore.ts`. |
| Status parser | `parseGitChanges(statusZ, numstat)` → `GitChanges { files: GitChange[]; adds; dels }` in `frontend/app/view/agents/gitstatus.ts` | Shipped. `GitChange` is `{ path, status, adds, dels }`, `status` being a porcelain letter (`M`, `A`, `D`, `?`, `R`, `C`, …). Reused verbatim. |
| Monaco diff editor | `MonacoDiffViewer` in `frontend/app/monaco/monaco-react.tsx:127` | Shipped, lazy. Takes `original` / `modified` **full texts**, `language`, `path`, `options`; updates models on prop change without remounting. |
| Monaco theme bridge | `useSyncMonacoTheme` in `frontend/app/monaco/monacotheme.ts` | Shipped, already called by `codesurface.tsx:59`. The diff editor inherits it — no new tokens. |
| File mutation RPCs | `FileCreateCommand`, `FileMkdirCommand`, `FileMoveCommand`, `FileDeleteCommand` (`wshrpctypes_file.go:15-21`) | Shipped. `CommandDeleteFileData` is `{ path, recursive }`; `CommandFileCopyData` is `{ srcuri, desturi, opts }` and serves rename. |
| Stat with modtime | `FileInfoCommand` → `FileInfo.ModTime` (unix seconds), `.Size`, `.NotFound` | Shipped. Already the store's conflict input. |
| Conflict machinery | `conflictOf`, `conflictMessage`, `Draft`, `FileBase` in `codedraft.ts` | Shipped, pure, tested. The staleness check reuses `conflictOf` rather than inventing a second comparison. |
| Context menu | `ContextMenuModel.getInstance().showContextMenu(items, ev)` (`frontend/app/store/contextmenu.ts:136`), rendered by `ContextMenuHost` | Shipped. Items support `icon`, `enabled`, `type`, submenus. |
| Confirm dialog | `modalsModel.pushModal("ConfirmModal", { title, message, confirmLabel, destructive, onConfirm })` | Shipped. `memstore.ts:208` `confirmDeleteNote` is the pattern to copy. |
| Column-mode idiom | `codeSearchModeAtom` (`files` / `search`) + the tab strip in `codesurface.tsx` `CodePanes` | Shipped. Gains a third value. |
| View-mode idiom | `codeViewModeAtom` (`preview` / `source`) + `ViewModeToggle` in `codepathbar.tsx` | Shipped. Gains a third value. |
| Row source of truth | `codeRowsAtom` = `visibleRows(buildTree(index.paths), expanded)` | Shipped. Status is layered on top as a lookup, never as a second row list. |
| Status color tokens | `--color-success`, `--color-warning`, `--color-error`, `--color-muted` in `frontend/tailwindsetup.css` | Shipped. No new tokens; no raw hex, per the repo rule. |

## Resolved decisions

**1. `MonacoDiffViewer` needs the file's full HEAD content, which no shipped reader returns — so this
spec adds exactly one Go reader.** `gitinfo.GetDiff` returns unified diff *text* (`gitinfo.go:314`),
and reconstructing a full original from a diff is both lossy and pointless when git will print it.
`git show <ref>:<path>` is one subprocess call in the existing `run()` idiom.

*Rejected: render the diff with the Diff surface's row renderer instead.* That renderer (`DiffRow`,
`NoTextDiff`, the stat bar) is inline in `filessurface.tsx`, a 634-line file this working tree edits
from parallel sessions, and the in-flight `2026-09-04-git-compare-viewer-parity-design.md` is about
to replace it with `MonacoDiffViewer` anyway. Extracting it now would create a merge surface for no
gain and land on the losing side of that spec.

*Rejected: read HEAD content through `FileReadCommand` against a temp checkout.* More IO, more failure
modes, and a temp file to clean up, to avoid a fifteen-line reader.

**2. Status is a lookup keyed by repo-relative path, layered onto the existing rows — never a second
row list.** `codeRowsAtom` stays the single source of what rows exist; `codeStatusAtom` answers "what
is this path's status" and a derived roll-up answers "does anything under this directory have one".
The tree and the Changed tab therefore cannot disagree, for the same reason the tree and the finder
cannot: one array underneath both.

**3. Directory roll-up is a single neutral marker, not an aggregate letter.** A directory containing
one modified and one new file has no honest single letter, and inventing a precedence order (does `M`
beat `A`?) would be a rule the user has to learn. A dot means "something under here changed";
expanding shows what.

**4. The Changed tab opens the editor, not a diff.** It is a *navigation* aid inside a code browser —
the answer to "which of these files do I want to read next". The diff for the file you land on is one
toggle away in the path bar. A Changed tab that opened diffs would be the Diff surface with a worse
layout, and the surfaces would compete.

**5. Staleness is checked on window focus and on tree focus, not polled and not watched.** The three
prior specs all declined a file watcher, and this does not reverse that: a watcher means a backend
subscription, debouncing, and reconciling against expand state. A re-stat of the *one open file* when
the window regains focus costs a single `FileInfoCommand` and catches the case that actually bites —
an agent wrote while you were looking at another window.

**6. Staleness never replaces a buffer that has a draft, and never replaces one silently.** With no
draft, the bar offers Reload and the user presses it; with a draft, the bar says the disk copy moved
and Reload is labeled as discarding. Auto-reloading a clean buffer was considered and cut: the caret
position, scroll offset and selection would jump under a reader's eyes with no action of theirs, and
"the file I was reading changed" is information, not an annoyance to hide.

**7. Delete is confirmed with the recoverability stated, and there is no undo stack.**
`FileDeleteCommand` is a hard delete — no recycle bin, no trash. But git already answers the question
honestly, per file:

- Tracked (`status` absent, `M`, `R`, `C`) → "The committed copy stays in git history."
- Staged but never committed (`A`) → "Staged in git — `git checkout` restores it." The blob is already
  in the index, and `FileDeleteCommand` removes only the working-tree file, so the index entry
  survives.
- Untracked (`??`) → "This file is not in git. Deleting it cannot be undone."

The confirm names the file and carries that sentence. A directory takes the weakest sentence of the
files under it: one untracked file inside makes the whole delete unrecoverable, and saying otherwise
would be the one kind of wrong this sentence must never be. *Rejected: a one-step undo* — it means holding
deleted content in memory, a lifetime to manage, and a second source of truth for a file's bytes, all
for an action taken rarely and confirmed deliberately. *Rejected: routing tracked deletions through
`git rm`* — it stages a change the user did not ask to stage, and the Diff surface is where staging
decisions belong.

**8. A rename carries the open buffer, the cursor, the drafts and the history with it.** Renaming the
file you are reading and landing on a `missing` empty state would be a bug wearing a feature's
clothes. The store rewrites `codeFileAtom.path`, the draft key (drafts are keyed by absolute path),
`codeCursorAtom`, and every matching entry in the history stack, then refreshes the index. A rename of
a file you are *not* looking at touches only the drafts map and the history.

**9. Every mutation refreshes the index and the status; nothing optimistically patches the tree.**
`refreshIndex` already exists and already drops the per-project cache. A mutation is a user-initiated
action with a natural pause, so one extra `git ls-files` is cheap, and the alternative — splicing a
path into a cached array and hoping git agrees — is exactly the class of drift decision 2 exists to
prevent.

**10. Name validation is a pure module, and it validates against the index rather than the disk.**
`codemutate.ts` answers "is this a legal new name here" without IO: non-empty after trim, no path
separator, not `.` or `..`, no character illegal on Windows (`<>:"|?*` and control characters), not a
reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, with or without an
extension), and not already present in `codeIndexAtom.paths`. The last check reads a snapshot and can
be wrong — which is why the write still surfaces the backend's error rather than trusting the
pre-check.

## 1. Backend

### Reader, in `pkg/gitinfo/gitinfo.go`

```go
// ShowResult is the content of a path at a ref. Missing reports that the path does not exist at
// that ref — a file added since the ref — which is an answer, not an error.
type ShowResult struct {
    Content string
    Missing bool
}

// ShowFile returns the content of path at ref (e.g. "HEAD"), as `git show ref:path` prints it.
func ShowFile(ctx context.Context, cwd, ref, path string) (*ShowResult, error)
```

Uses the file's existing `run(ctx, cwd, args...)` helper and the package `gitTimeout` (10s), matching
every other reader here. `git show HEAD:<path>` exits 128 for a path absent at that ref; that case
returns `Missing: true` and a nil error. Every other nonzero exit is an error. The path is passed
with forward slashes exactly as the index holds it — git's own separator on every platform — and a
leading `./` is stripped so a `HEAD:./x` spec can never be constructed.

### Command, in `pkg/wshrpc/wshrpctypes_git.go`

```go
GitShowFileCommand(ctx context.Context, data CommandGitShowFileData) (*CommandGitShowFileRtnData, error)

type CommandGitShowFileData struct {
    Cwd  string `json:"cwd"`
    Ref  string `json:"ref"`
    Path string `json:"path"`
}

type CommandGitShowFileRtnData struct {
    Content string `json:"content"`
    Missing bool   `json:"missing,omitempty"`
}
```

Thin passthrough in `pkg/wshrpc/wshserver/wshserver_git.go`, shaped exactly like
`GitListFilesCommand`. Then `task generate` to regenerate `frontend/app/store/wshclientapi.ts` and
`frontend/types/gotypes.d.ts`. **Never hand-edit those.**

A 2 MB ceiling already gates what the surface will open (`MAX_VIEW_BYTES` in `codeclassify.ts`), and
Diff is offered only for a file already open as text, so no separate size guard is needed here.

No other backend work. Status, mutation and stat all use shipped commands.

## 2. Frontend

### Pure modules — each with a `.test.ts` beside it

**`codestatus.ts`** — status as a lookup, plus the directory roll-up.

```ts
export type CodeStatus = { status: string; adds: number; dels: number };

// repo-relative path -> status. Built from parseGitChanges; git emits forward slashes, matching the
// index, so no separator normalization is needed on either side.
export function statusByPath(changes: GitChanges): Map<string, CodeStatus>;

// the directories with at least one changed descendant, for the collapsed-row marker
export function changedDirs(paths: Iterable<string>): Set<string>;

// the porcelain letter -> the token class the row paints with, and the label a title reads
export function statusGlyph(status: string): { letter: string; className: string; label: string };
```

`statusGlyph` is the only place a status letter meets a color, and it returns a Tailwind class over a
`@theme` token — `text-success` for added, `text-warning` for modified, `text-error` for deleted,
`text-muted` for untracked, `text-secondary` for renamed and copied — never a hex value.

**`codemutate.ts`** — pure validation and the delete sentence (decisions 10 and 7).

```ts
export type NameError = "empty" | "separator" | "dots" | "illegal-char" | "reserved" | "exists";

// null means the name is usable
export function validateName(name: string, dir: string, existing: readonly string[]): NameError | null;
export function nameErrorMessage(e: NameError): string;

// where a new entry lands: the cursor directory, the cursor file's parent, or the repo root
export function targetDir(cursor: string | null, rows: readonly TreeRow[]): string;

// The honest recoverability line the confirm shows (decision 7). For a file, pass its own status;
// for a directory, the statuses of every file under it — the weakest one wins.
export function deleteWarning(
    rel: string,
    statuses: readonly (CodeStatus | undefined)[],
    isDir: boolean
): string;
```

`targetDir` is pure and tested because "where does New File go" is exactly the kind of rule that is
obvious until the cursor is on a collapsed directory, on a file at the root, or nowhere at all.

### State — additions to `codestore.ts`

```ts
export type HeadText =
    | { kind: "idle" }
    | { kind: "loading"; path: string }
    | { kind: "text"; path: string; text: string }
    | { kind: "absent"; path: string }   // the file is new since HEAD
    | { kind: "error"; path: string; message: string };

export const codeStatusAtom: PrimitiveAtom<Map<string, CodeStatus> | null>;  // null = not loaded yet
export const codeStatusDirsAtom: Atom<Set<string>>;                          // derived roll-up
export const codeHeadAtom: PrimitiveAtom<HeadText>;                          // the Diff original
export const codeStaleAtom: PrimitiveAtom<{ path: string } | null>;          // the staleness bar
```

`codeSearchModeAtom` widens to `"files" | "search" | "changed"` and `codeViewModeAtom` to
`"preview" | "source" | "diff"`. Both already reset on project switch inside `selectProject`, so the
new values need no new reset path — only the existing resets extended.

New loaders, all in `codestore.ts` beside their siblings:

```ts
loadStatus(): Promise<void>            // GitChangesCommand -> parseGitChanges -> statusByPath
loadHead(rel: string): Promise<void>   // GitShowFileCommand at HEAD
checkStale(): Promise<void>            // re-stat the open file; sets codeStaleAtom via conflictOf
createFile(dir: string, name: string): Promise<void>
createFolder(dir: string, name: string): Promise<void>
renamePath(rel: string, newName: string): Promise<void>
deletePath(rel: string, isDir: boolean): Promise<void>
```

Each mutation is `RPC → refreshIndex() → loadStatus()`, and each surfaces its failure through the
existing `SurfaceError` banner rather than a silent no-op. `loadStatus` runs with the index load, on
`r`, after every successful save, and after every mutation. It carries a guard token before its first
`await`, like every other loader in this module.

`checkStale` reuses `conflictOf(base, latest)` from `codedraft.ts` rather than comparing
`size`/`modtime` a second way: with a draft it compares against the draft's pinned base, and without
one it compares against the `size`/`modtime` the `text` variant already carries.

### Components

**`codetreepane.tsx`** — each file row gains a status letter in the trailing slot beside the existing
unsaved-edits dot; each collapsed directory row with a changed descendant gains a neutral dot. The row
gains `onContextMenu`, opening the mutation menu below. Nothing about row derivation changes.

**`codechangedpane.tsx`** (new) — the third column mode. Reads `codeStatusAtom` and renders one row per
changed file: status letter, path (directory dimmed, basename primary), `+adds −dels`. A row click is
`openInCode(model, { projectPath, rel })` — the same primitive the finder, the search pane and the two
cockpit entry points already use. Empty state: "No changes in the working tree."

**`codepathbar.tsx`** — the view toggle becomes three-way. `preview` stays markdown-only; `source` and
`diff` are offered for any text file. Choosing `diff` triggers `loadHead(rel)`.

**`codediffview.tsx`** (new) — renders `MonacoDiffViewer` with `original` = the HEAD text (empty when
`absent`), `modified` = `draft?.text ?? file.text` so **unsaved edits appear in the diff**, and `path`
= the repo-relative path so Monaco's model URIs stay unique per file. Options are read-only on both
sides, with `renderSideBySide` chosen from the pane width — inline below 900px, side-by-side above —
because the app window opens at 1000x700 (`src-tauri/tauri.conf.json:14`) and a 280px tree leaves a
side-by-side diff about 45 columns per side.

**`codestalebar.tsx`** (new) — a one-line bar under the path bar when `codeStaleAtom` is set:
"`<path>` changed on disk", with Reload. With a draft present the button reads "Discard my edits and
reload", matching the existing conflict banner's honesty about what it destroys.

**Mutation controls** live in two places, both driving the same store functions:

- A context menu on tree rows: New File, New Folder, Rename, Delete (danger), and Copy Path. Built
  with `ContextMenuModel.getInstance().showContextMenu(items, ev)`.
- A small header cluster beside Refresh: New File, New Folder — the affordance for an empty tree or an
  unfocused one, where there is no row to right-click.

Rename is an inline input on the row (Enter commits, Escape cancels, live validation from
`validateName`). New File and New Folder are the same inline input on a provisional row inside the
target directory. There is no modal for either: a modal to type eleven characters is friction, and the
inline row shows *where* the thing will land, which a modal cannot.

Delete goes through `ConfirmModal` with `destructive: true`, its message from `deleteWarning`, and for
a directory the count of files under it taken from the index.

### Keybindings — `frontend/app/store/keybindings/bindings.ts`

`buildCodeBindings()` gains four keys on the existing `inTree` predicate (the tree pane holds focus),
so they cannot fire while the caret is in Monaco:

| Key | Action |
|---|---|
| `F2` | Rename the cursor row |
| `Delete` | Delete the cursor row (confirms) |
| `n` | New file in the cursor's directory |
| `Shift:n` | New folder in the cursor's directory |

And one on the surface predicate (`on`), matching the existing `r`:

| Key | Action |
|---|---|
| `d` | Toggle the Diff view for the open file |

`store.test.ts` already evaluates every `when(ctx)` across every context to assert the Code bindings
conflict with nothing; these are covered by that existing assertion for free.

## 3. Failure modes

| Situation | What the user sees |
|---|---|
| `GitChangesCommand` fails | Rows render without status; a one-line note in the column header says status is unavailable, with retry. The tree stays usable — status is decoration, not the tree |
| Diff requested for a file added since HEAD | The diff renders with an empty original, which is the truth: the whole file reads as added |
| `GitShowFileCommand` fails | The diff pane shows the error and the toggle stays on Diff, so the user switches back deliberately |
| Open file changed on disk, no draft | Staleness bar, Reload |
| Open file changed on disk, draft present | Staleness bar naming the discard; the existing save-time conflict guard still refuses the write |
| Rename target already exists | Inline validation blocks it before any RPC; a race that beats the check surfaces the backend error in the banner |
| Delete of a directory | The confirm names the directory, its file count and the weakest recoverability of the files under it; the RPC passes `recursive: true` |
| Mutation RPC fails | `SurfaceError` banner with the message; the index is refreshed regardless, so the tree shows what is actually there |
| Not a git repository | Unchanged — the existing empty state. Status, Changed and Diff are simply never reached |

## 4. Testing

**Vitest**, beside each pure module, in the surface's established style:

- `codestatus.test.ts` — `statusByPath` keys by path and carries adds/dels; a rename entry keys by its
  new path; `changedDirs` marks every ancestor of a changed file and nothing else; `statusGlyph`
  returns a token class for each porcelain letter and a defined fallback for an unknown one.
- `codemutate.test.ts` — every `NameError` case, including the Windows reserved names with and without
  an extension; `targetDir` for a cursor on a directory, on a file, on a root file, and null;
  `deleteWarning` distinguishes tracked, staged-only and untracked, and for a directory takes the
  weakest sentence of the files under it — one untracked file makes the whole delete unrecoverable.

**Go**, in `pkg/gitinfo/gitinfo_test.go`, on the existing `t.TempDir()` + `git(t, dir, …)` harness:
`ShowFile` returns committed content at HEAD, returns `Missing` for a path added but not committed,
errors on a non-repository directory, and handles a path containing a space. Run with the
Windows-path CGO flag this repo requires:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/gitinfo/...
```

**No jsdom render tests** — that posture is settled for cockpit surfaces. Rendering is covered by CDP:

- The existing `surface-smoke` scenario, unchanged in shape.
- New `code-git-status` scenario in `scripts/cdp/scenarios.mjs`: pick the project, assert at least one
  tree row carries a status letter, switch to the Changed tab, assert rows with `+/−` counts, click
  one, assert the editor opened on that path.
- New `code-diff` scenario: open a modified file, press `d`, assert the Monaco diff editor mounted
  (`.monaco-diff-editor`), press `d` again, assert the single editor is back.

**Hand-format additions to `scenarios.mjs`** to its four-space style, and never run Prettier on it —
`.editorconfig` omits `.mjs`, so `--write` reindents the whole file to two spaces.

**Typecheck** with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`; bare `npx tsc`
stack-overflows on this repository. The baseline is clean, so any error reported belongs to this work.

**Prettier** on touched `.ts`/`.tsx` files only, and only files this work authored — `--write`
reorganizes imports and turns a small edit into a whole-file diff on drifted files.

## 5. Suggested phasing

1. `codestatus.ts` + tests, `codeStatusAtom` + `loadStatus`, tree row glyphs. Verified by Vitest and a
   dev-app look.
2. The Changed column mode. Verified by the `code-git-status` CDP scenario.
3. `ShowFile` + `GitShowFileCommand` + `task generate`, the three-way view toggle, `codediffview.tsx`.
   Verified by the Go test and the `code-diff` scenario.
4. `checkStale` + the staleness bar.
5. `codemutate.ts` + tests, then the context menu, inline rename and create, and the delete confirm.

Each phase is independently shippable, and phases 1–2 need no backend rebuild at all.

## 6. Explicitly out of scope

Staging, unstaging, committing, or reverting from this surface — the Diff surface owns repository
actions, and `2026-09-04-git-compare-viewer-parity-design.md` explicitly defers even its own to a later
spec. A file watcher. An undo stack for mutations (decision 7). Multi-select in the tree, and therefore
bulk delete or bulk move. Drag-and-drop move. Blame, per-line authorship, or history for the open file.
Diffing against any ref other than HEAD. Conflict-marker awareness during a merge. Everything already
out of scope in the 08-03, 08-06 and 08-15 specs stands, except the two items this spec explicitly
reopens.
