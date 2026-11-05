# Code surface review fixes (F1-F25): design

Source: the Code surface review of 2026-11-05 (`cdp-shots/review/code/report.md` in the main checkout,
gitignored, screenshots beside it). Its "Tooling and procedure" section, including "Seen in passing", is out of
scope. Every cause below was checked against the code at `aafa0f87e`; where the code disagrees with the report,
the code wins and the difference is stated.

Constraints that hold for every decision: logic goes in pure `.ts` files with a vitest test beside them, `.tsx`
stays a thin consumer; colors and spacing come from existing `@theme` tokens only (DESIGN.md); every popover uses
the project switcher's pattern (`useEscapeClose(open, close, triggerRef)` plus a `fixed inset-0` click-catcher
under the popover, `projectswitcher.tsx`); keyboard changes update `docs/keyboard-shortcuts.md`, and the cheat
sheet is generated from the binding labels in `bindings.ts`; no new dependencies.

## Session lifecycle

**F1 (refresh, create, rename, delete reset the session).** Confirmed: `refreshIndex` nulls `codeIndexAtom`, the
mount effect in `codesurface.tsx` reads "project, no index, no error" as a cold start and calls `selectProject`,
which resets everything. Decision: both halves. `refreshIndex` keeps the index on screen until the new one lands
(the body `revalidateIndex` already has; one function, with the in-flight guard kept only for the nav-return
caller so a mutation's refresh is never skipped). The mount effect stops calling `selectProject` for a selected
project: it loads the index for the current project without resetting anything, and only when no load for it is
in flight. Why both: the first removes the trigger, the second removes the trap for any other path that nulls the
index (selectProject itself sets it null while loading, which today re-enters selectProject from the effect).

**F4 (re-picking the current project resets).** Confirmed. Decision: every picker entry (Projects, Worktrees,
Recent, typed path) resolves its target first and, when it is the project already shown (`sameRepoPath`), only
closes the picker. A pure predicate decides; `selectProject` keeps its reset semantics for real switches.

**F10 (New file with no project leaves a pending create).** Confirmed. Decision: New file, New folder and Refresh
index are disabled without a project, and `selectProject` clears `codeEditAtom`.

**F25 (failed delete closes the open file).** Confirmed. Decision: the open file and cursor are cleared only when
the delete succeeded.

**F19 (a folder opened by path is not restored).** Confirmed. Decision: a pure `restoreKind(stored, registry)`
returns `registered`, `by-path` or `none`. Registered restores as today. An unregistered stored path restores when
a stat says it is still a directory, under the name `selectPath` gives it; a failed stat clears
`lastCodeProjectAtom` and shows "No project selected". `codeBodyPhase` reports `loading` for both restorable
kinds, so no false "No project selected" flashes. Why: the old rule existed so a renamed registered project does
not reopen under a stale name; a path the user typed has no name to go stale, and the stat stops a deleted folder
from reopening.

**F5 (New folder creates a folder the tree never shows).** Confirmed (`git ls-files` lists no empty folder).
Decision: folders created this session are kept in a session set merged into the tree (`buildTree(paths,
extraDirs)`), selected and expanded after creation, until a file lands under them; the set is cleared on project
switch and follows renames and deletes. Why not "open the new-file input inside it": the user may want the folder
only, and the input trick still leaves no row once cancelled.

**F11 (Worktrees of a subfolder project open the repo root).** Confirmed. Decision: a pure function maps each
worktree to the project's folder inside it (the project's path relative to the worktree that contains it, joined
onto each other worktree), and the store drops entries whose mapped folder does not stat as a directory (stats in
parallel, failures dropped and logged). A detached checkout is labelled `<folder name> (detached)` instead of
"detached HEAD", since `GitWorktree` carries no sha. No Go change.

**F17 (save conflict stacks two banners).** Confirmed. Decision: one banner. A refused save raises the stale bar
(`codeStaleAtom`) and `SaveBanner` stops rendering the conflict (it keeps the save-error case). The stale bar is
the single "the disk moved" banner: with a refused save it says the save was refused and the edits are kept, and
its destructive button keeps the wording "Discard my edits and reload". A "Compare with disk" action (diff of the
draft against the current disk copy) joins it; see the diff section.

## Jumps into Code

**F2 (a jump to a line in another file lands on line 1).** Confirmed: the pending line is a bare number set before
`openPath`, and the viewer consumes it against whatever file is showing. Decision: the pending entry carries its
path: `{ path, line } | { path, anchor }`. A pure resolver decides, from the pending entry, the file showing and
its outline, whether to wait, apply a line, or drop it (target opened as binary/missing/error, or a different file
was opened meanwhile). The viewer applies it only when that path is the text file showing: in the editor's
`onMount` and effect, and in Preview once the document's headings are in the DOM. Every way in goes through it:
`openInCode` (search, F12, Diff "open in Code", palette `path:line`, peek, doc links), Back/Forward
(`walkTo`, which had the same bug), `goToLine`, and the palette's bare `:123`, which now calls `goToLine` instead
of writing the atom.

**F12 (folder link shows "Binary file -1 B"; anchor links do nothing).** Folder: confirmed (a directory stat
classifies as binary). Decision: a link to a folder, and `openPath` of anything that stats as a directory, reveals
and selects the folder in the tree, switches the sidebar to Files, and leaves the open file and history as they
were. Anchor: the report's cause is wrong. `codelink.ts` returning null for `#…` is never reached, because
Markdown's `Link` handles `#` hrefs itself before calling `onClickLink`, and that handler is what fails. Decision:
`Link` offers every href to `onClickLink` first (Code is its only user), and Code turns `#slug` and
`doc.md#slug` into the pending `{ path, anchor }` above; the resolver maps the slug to a heading line through the
outline with a GitHub-style slug (lowercase, punctuation stripped, spaces to `-`, `-1`/`-2` for repeats), so an
anchor works in Preview and Source alike and across files.

## Viewer states and diff

**F6 (deleted tracked file opens to "File no longer exists").** Confirmed. Decision: when the open file is missing
and git status says `D`, the viewer shows "Deleted in the working tree" with the HEAD copy as an all-removed diff
(the diff view with an empty right side, fixed to HEAD), and no Refresh index button, since refreshing cannot
help. The tree row stays (it is in the index, with its `D` letter); the Changed pane's `D` row lands on the same
view. A plain missing file keeps today's state.

**F14 (branch-base diff hard to reach; unchanged diff says nothing).** Confirmed. Decision: the diff header
becomes a two-option control, HEAD and Branch base; Branch base resolves the base on click (the same
`resolveDiffBase`), is disabled with its reason when the base does not apply (on the default branch), and shows
the existing error state when it fails. When the committed copy equals the buffer, the pane says "No changes
against HEAD" (or "against the branch base") instead of two identical columns. The Diff button still enters on
HEAD; `d` still cycles.

**F17 (compare with disk).** The diff target union gains `disk`: the left side is the file as it is on disk now
(read fresh), the right side the draft. The stale bar's "Compare with disk" enters it; the header names it, and
`d` from it returns to Source.

**F22 (binary files are a dead end).** Confirmed. Decisions: `classifyFile` checks the MIME type before the size,
so a large font is "Binary", not "too large". Image files (by extension: png, jpg, jpeg, gif, webp, svg, bmp,
ico, avif) render as an image, at any size, fetched through the Markdown image path (`resolveRemoteFile`, blob
URL released on unmount). Every binary and too-large state offers Copy path. No "Open externally": the app's
external opener refuses anything but web and mail addresses, and adding a native file opener is out of scope.
The peek says "Image — open it in Code" for images and "Binary file" otherwise.

**F8 (Blame offered and shown as on where no column draws).** Confirmed. Decision: a pure predicate says whether
the source editor is showing (`mode !== "diff"` and not a markdown file in Preview). The toggle shows pressed
only when the column is visible; turning it on outside Source switches the view to Source and turns blame on
(button and `b` alike), so the press always shows a column.

**F9 (blame misaligned with unsaved edits).** Confirmed. Decision: map blame through the edit. A pure line mapping
from the saved text to the buffer gives each buffer line its saved line or none; unchanged lines keep their blame,
inserted or edited lines show none. Its cost is bounded for files up to the 2 MB view limit (a full line diff for
moderate sizes, a common prefix/suffix fallback above a size threshold). The column reads the draft itself, so the
viewer does not change for it.

## Toolbar, tree, panes

**F3 (popovers ignore outside click and Esc).** Confirmed for the project picker, Send to agent and Send review.
Decision: all three get `useEscapeClose` and a backdrop. Send review's open flag stays a module atom (Alt+Shift+M
opens it) but is reset when the review bar unmounts, so leaving Code closes it.

**F16 (unsaved edits invisible in a collapsed folder).** Confirmed. Decision: a collapsed folder holding drafts
shows the unsaved dot (the file row's accent dot), beside the change dot when both apply. The toolbar shows
"N unsaved" while the project has drafts; it opens a popover listing their paths (including files no longer in
the index), and a row opens the file.

**F18 (app-bar switcher does not change Code's project).** Confirmed. Decision: Code follows a change of the
app-bar project made while Code is showing: picking a registered project there selects it in Code (unless Code
already shows it). The initial value and "All projects" change nothing, and the persisted Code pick still wins on
arrival. The switcher's title on Code says it opens the project here. Why not the reverse (Code's picker setting
the app-wide default): that would re-scope the other surfaces as a side effect of browsing.

**F20 ("Register a project in Settings").** Confirmed. Decision: the empty state reads "Add a project to browse
its source here." with a "New project" action that opens the New project dialog (`model.newProjectOpenAtom`).

**F21 (Changed pane has no keyboard).** Confirmed. Decision: the search pane's walk: rows become focusable
buttons, `↑`/`↓` walk them (`stepRow`), `Enter` opens.

**F15 (Back/Forward don't work from the editor).** Confirmed. Decision: Alt+←/→ use the same gate as F12
(surface is Code, no modal), so they work from the editor.

**F7 (`d` diffs in a plain folder).** Confirmed. Decision: `code:diff` returns false (lets the key pass) in a plain
folder, as `code:blame` does.

## Review comments and handoff

**F13 (review comments half-supported).** Decisions:
- The editor's context menu gets "Add review comment" (a Monaco action running the same `startComment`).
- Alt+M outside Source switches to Source and opens the comment input on the caret line once the editor has
  mounted, instead of doing nothing.
- The comment input no longer covers code: a Monaco view zone under the commented line makes room for it.
- The review count opens a popover listing the project's comments (`path:line`, note), each opening its line and
  deletable on its own (`removeComment`).
- Copy review keeps the review and shows "Copied" feedback; only a send to an agent removes what it sent.
- Reviews persist across restarts in localStorage, the way drafts do (pure parse/serialize, debounced write).

**F23 (Send to agent says "Sent" before the send).** Confirmed. Decision: the send is awaited; the button shows
"Sending…", then "Sent to X" or the error in the error tone.

**F24 (handoff path relative to the browsed checkout).** Confirmed. Decision: Send to agent hands over the
absolute path (`look at C:\…\src\x.py:12`), which is right for an agent in any checkout; agents are still matched
by project name. The review document states its checkout root once ("Checkout: <path>") and keeps relative paths
under it. Why not match agents by checkout: interactive agents carry no cwd in `AgentVM`, and the absolute path
needs none.

## Verification

Each task fills its own CDP scenario module (`scripts/cdp/scenarios-code-*.mjs`, scaffolded by the first task)
with a step per fixed view, state or interaction, with a screenshot. Existing scenarios whose expectations the
fixes change are updated by the task that changes them (Copy review no longer clears: `code-review`; the binary
peek message: `code-peek`; the diff header and stale bar buttons: `code-diff`, `code-stale-bar`). Final runs the
new scenarios plus the existing Code scenarios these fixes touch.
