# Code surface review fixes (F1-F25) Implementation Plan

> **For agentic workers:** each task below is one worker's job. It carries its design decisions, files, interfaces
> and acceptance; you write the implementation. Logic goes in pure `.ts` files with a vitest test beside them;
> `.tsx` stays a thin consumer (AGENTS.md "Logic is extracted, not rendered"). The spec restates every finding's
> decision and why; the review report (`C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\code\report.md`,
> gitignored, screenshots beside it) is background. Every line number below is pre-edit, at `aafa0f87e`.

**Goal:** Fix the 25 findings (F1-F25) of the Code surface review; its "Tooling and procedure" section is out of
scope.

**Architecture:** A scenario scaffold lands first (Task 1). The three hub files (`codestore.ts`,
`codesurface.tsx`, `codeviewer.tsx`) are edited by a chain: session lifecycle (Task 2), then jumps (Task 3) and
the toolbar (Task 4) side by side, then viewer states and diff (Task 9), then the editor extras (Task 11). The
keys (Task 5), review and handoff (Task 6), Changed pane (Task 7), and blame mapping (Task 8) touch none of the
hubs and run beside the chain; classify/peek (Task 10) follows Task 3, which renames an atom its scenario reads.

**Tech Stack:** React 19, jotai, Monaco, Tailwind 4 (`@theme` tokens only), vitest, the CDP harness in
`scripts/cdp/`.

**Spec:** `docs/superpowers/specs/2026-11-05-code-review-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/gitinfo`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs code-session code-jumps code-toolbar code-keys code-handoff code-changed code-blame-draft code-diff-states code-editor code-peek code-diff code-blame code-review code-markdown code-stale-bar code-plain-dir code-git-status code-tree-on-arrival`

## Global Constraints

- Colors and spacing from existing `@theme` tokens in `frontend/tailwindsetup.css` only (DESIGN.md); no new tokens.
- Popovers use the project switcher's pattern: `useEscapeClose(open, close, triggerRef)` from
  `frontend/app/hook/useEscapeClose.ts` plus `{open ? <div className="fixed inset-0 z-50" onClick={close} /> : null}`
  under a `z-[60]` popover (`frontend/app/view/agents/projectswitcher.tsx:37,65`).
- Keyboard changes update `docs/keyboard-shortcuts.md` (Task 5 owns it); the cheat sheet is generated from the
  binding labels in `bindings.ts`, so a label change there is the cheat sheet change.
- `tsconfig.json` is `strict: false`: narrow unions with `"x" in y`, not a boolean flag.
- Scenario fixtures live in `os.tmpdir()` dirs the scenario removes; a project a scenario registers is deleted at
  teardown. Every task that changes a view, a visual state or an interaction fills the steps of its own scenario
  module (named in its Files) with the step that shows it, and takes a screenshot per step through `h.shot`.
- A snapshot dev app on :9222 / :5174 belongs to another review: never attach to it or stop it. Check a scenario
  with `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs <scenario>`, which starts its own app on its
  own ports.
- Lint/format only the files you touch (`npx eslint <paths>`, `npx prettier --check <paths>`); keep prettier off
  `scripts/*.mjs`. `task check:ts` takes ~2 min: give it a longer timeout.
- Comments say why, in lower case, only where needed. No new dependencies.

## Review Focus

- A pending jump whose file opened as binary, missing or an error must not fire later on another file (Task 3
  test `drops a jump whose file did not open as text`).
- Refresh with an unsaved draft open keeps the buffer, the expanded folders and history (Task 2 test
  `refreshIndex keeps the open file, expanded folders and history`).
- A session-created empty folder that is renamed keeps its row under the new name (Task 2 test
  `session dirs follow a rename`).
- Worktree mapping with backslashes and different drive-letter case still finds the project's folder (Task 2 test
  `maps a subfolder project across separators and case`).
- A by-path folder deleted from disk since the last launch restores to "No project selected", not an index error
  (Task 2 test `restoreKind is by-path for an unregistered stored folder` plus scenario step `code-session: a
  deleted by-path folder is not restored`).

---

### Task 1: Code scenario modules and kit
**Depends on:** none
**Files:** `scripts/cdp/scenarios.mjs`, `scripts/cdp/scenarios-code-kit.mjs`, `scripts/cdp/scenarios-code-session.mjs`, `scripts/cdp/scenarios-code-jumps.mjs`, `scripts/cdp/scenarios-code-toolbar.mjs`, `scripts/cdp/scenarios-code-keys.mjs`, `scripts/cdp/scenarios-code-handoff.mjs`, `scripts/cdp/scenarios-code-changed.mjs`, `scripts/cdp/scenarios-code-blame-draft.mjs`, `scripts/cdp/scenarios-code-diff-states.mjs`, `scripts/cdp/scenarios-code-editor.mjs`

- Nine scenario modules in the object style of `scenarios-code.mjs`, each exporting one scenario (surface `code`)
  named `code-session`, `code-jumps`, `code-toolbar`, `code-keys`, `code-handoff`, `code-changed`,
  `code-blame-draft`, `code-diff-states`, `code-editor`. Each stub's `assert` returns exactly one failing step
  `{ step: "<name>: steps not written yet", ok: false }`. Register them in `SCENARIOS` right after
  `codeStaleBarLook`.
- `scenarios-code-kit.mjs`, the helpers the nine share (later tasks only read it):
  - `makeCodeRepo(files: Record<string, string>, { git = true, branch = "main" } = {}) -> string`: a
    `mkdtempSync(join(tmpdir(), "verify-code-"))` dir with the files written (subdirs created); with `git`, init,
    a local user, and one commit of everything.
  - `removeCodeRepo(dir)`: recursive remove, tolerating a missing dir.
  - `openFolderInCode(h, dir) -> Promise<boolean>`: goes to Code and opens `dir` through the picker's path input,
    the way `code-stale-bar` does (`scenarios-code.mjs:1726-1737`); true once the tree shows a row.
  - `openFileInCode(h, rel) -> Promise<boolean>`: opens a file through the app's `openPath` (`mod(...)` import of
    `app/view/code/codestore.ts`), true once `[data-code-path="<rel>"]` shows.
  - `codeEval(h, body)`: `lookEval` re-exported, so modules get `mod`, `until`, `nap`, `flat` in one place.
- Acceptance: `node scripts/cdp/final-verify.mjs code-session` boots and reports the stub's one failing step (exit
  non-zero), proving the registration; `node --check` passes on every new module.

### Task 2: Session lifecycle (F1, F4, F5, F10, F11, F17 banner, F19, F25)
**Depends on:** Task 1
**Files:** `frontend/app/view/code/codestore.ts`, `frontend/app/view/code/codestore.test.ts`, `frontend/app/view/code/codesurface.tsx`, `frontend/app/view/code/codetree.ts`, `frontend/app/view/code/codetree.test.ts`, `frontend/app/view/code/codestalebar.tsx`, `frontend/app/view/code/codeworktrees.ts`, `frontend/app/view/code/codeworktrees.test.ts`, `scripts/cdp/scenarios-code-session.mjs`

Decisions (spec "Session lifecycle"):
- F1: `refreshIndex()` keeps `codeIndexAtom` until the refetch lands (fold `revalidateIndex`'s body into it; keep
  the in-flight guard only on `revalidateIndex`, the nav-return caller). The mount effect
  (`codesurface.tsx:137-142`) no longer calls `selectProject` for a selected project: it calls
  `ensureIndex(): Promise<void>` (exported from codestore), which loads the current project's index without
  resetting anything and does nothing while a load for that project is in flight.
- F4: `isCurrentPick(current: CodeProject | null, path: string): boolean` (pure, codestore). Every picker entry
  (Projects, Worktrees, Recent, typed path) closes the picker without reselecting when it is true.
- F5: `codeSessionDirsAtom: PrimitiveAtom<Set<string>>` (repo-relative). `createEntry` adds a created folder,
  reveals, expands and selects it. `buildTree(paths: string[], extraDirs?: Iterable<string>)` shows extra dirs as
  folder rows; `codeRowsAtom` passes the set. A dir leaves the set once the index lists a path under it; rename
  carries it (`renamedPath`), delete drops it, `selectProject` clears it.
- F10: New file, New folder and Refresh index header buttons are `disabled` without a project; `selectProject`
  sets `codeEditAtom` to null.
- F11: `worktreeFolders(projectPath: string, worktrees: GitWorktree[]): { label: string; path: string }[]` in
  `codeworktrees.ts`: the project's path relative to the worktree containing it (by `sameRepoPath` prefix), joined
  onto every worktree; label `branch`, else `<last path segment> (detached)`. The store stats each mapped path in
  parallel and publishes `codeWorktreeFoldersAtom: PrimitiveAtom<{ label: string; path: string }[]>` with only the
  directories (a failed stat is dropped and logged with `console.error`). `codeWorktreesAtom` keeps the raw list
  (the handoff uses its `ismain`). The picker's Worktrees section renders the folders; it shows only with more
  than one.
- F17 (banner half): a conflict in `saveCurrent` also sets `codeStaleAtom` to the file; `SaveBanner` renders only
  the error case. The stale bar, reading `codeSaveAtom`, says "<path> changed on disk — not saved; your unsaved
  edits are still here" for a refused save and keeps "Discard my edits and reload". Task 9 adds Compare.
- F19: `restoreKind(stored: CodeProject | null, registry): "registered" | "by-path" | "none"` replaces
  `canRestoreProject` (grep and update every caller). `codeBodyPhase` reports `loading` for both restorable kinds, and checks the
  stored project before the empty registry, so a by-path restore with no registered project is `loading`, not
  `no-projects`.
  The restore effect stats a by-path folder first (`statPathError`); a failure sets `lastCodeProjectAtom` to null.
- F25: `deletePath` clears the open file and cursor only when the delete succeeded.

Tests (`npx vitest run frontend/app/view/code/codestore.test.ts frontend/app/view/code/codetree.test.ts frontend/app/view/code/codeworktrees.test.ts`):
- `refreshIndex keeps the open file, expanded folders and history`: with an RPC mock, file/expanded/history atoms
  equal before and after, and `codeIndexAtom` is never null in between.
- `ensureIndex does not reset the session` and `ensureIndex does nothing while a load is in flight`.
- `isCurrentPick` true for the same path in another case or separator, false otherwise.
- `selectProject clears a pending create`.
- `a failed delete keeps the open file` / `a successful delete closes it`.
- `a refused save raises the stale bar`.
- `restoreKind is registered for a registry path`, `restoreKind is by-path for an unregistered stored folder`,
  `restoreKind is none without a stored project`; `codeBodyPhase is loading for a by-path restore`; `codeBodyPhase is loading for a by-path restore with an
  empty registry`.
- `buildTree shows an extra dir as an empty folder row`; `session dirs follow a rename`; `a session dir leaves
  once the index lists a file under it`.
- `maps a subfolder project across separators and case`; `labels a detached checkout by its folder`; `a project
  at the repo root maps to the worktree roots`.

Scenario `code-session` steps (temp repo from the kit), each with a shot: refresh keeps the open file, its
expanded folder and an enabled Back; rename of the open file keeps it open under the new name; New folder shows a
row for the empty folder, selected; re-picking the current project keeps the open file; with no project, New
file/New folder/Refresh are disabled; a subfolder project's Worktrees rows point at the subfolder in each
checkout (make a second worktree with `git worktree add`, remove it at teardown); a save over a disk change shows
one banner (the stale bar) and no `SurfaceError`; a by-path folder is restored after `polishReload`; a deleted
by-path folder is not restored.

### Task 3: Jumps land on their line (F2, F12)
**Depends on:** Task 2
**Files:** `frontend/app/view/code/codestore.ts`, `frontend/app/view/code/codestore.test.ts`, `frontend/app/view/code/codeviewer.tsx`, `frontend/app/view/code/codependingjump.ts`, `frontend/app/view/code/codependingjump.test.ts`, `frontend/app/view/code/codelink.ts`, `frontend/app/view/code/codelink.test.ts`, `frontend/app/element/markdown.tsx`, `frontend/app/cockpit/palette-files.ts`, `frontend/app/cockpit/palette-files.test.ts`, `frontend/app/view/code/codeoutline.ts`, `scripts/cdp/scenarios-codepeek.mjs`, `scripts/cdp/scenarios-code-jumps.mjs`

Decisions (spec "Jumps into Code"):
- `codePendingLineAtom` becomes `codePendingJumpAtom: PrimitiveAtom<PendingJump | null>` with
  `type PendingJump = { path: string; line: number } | { path: string; anchor: string }` (grep and update every
  reference: the palette test, the comment at `codeoutline.ts:19`, and the CDP evals that read it by name in
  `scripts/cdp/scenarios-codepeek.mjs:567-575,627-634`). Set by `openInCode`, `walkTo`, `goToLine`; `openPath(rel)` drops a
  pending jump for another path. The palette's bare `:123` (`palette-files.ts:146`) calls `goToLine(line)`.
- `resolvePendingJump(p: PendingJump, file: CodeFile, headings: { name: string; line: number }[]):
  { kind: "wait" } | { kind: "line"; line: number } | { kind: "drop" }` in `codependingjump.ts`: wait while the
  file is loading or another path is showing, drop when the target path opened as anything but text, an anchor
  maps through `slugHeadings`, an unknown anchor drops.
- The viewer applies a `line` result only for the path showing: the editor's `onMount` and the effect at
  `codeviewer.tsx:352-365`; in Preview, once the document's `.heading` nodes are present (wait otherwise, without
  clearing), via the existing `revealPreviewLine`.
- `slugHeadings(names: string[]): string[]` in `codelink.ts`: GitHub-style (lowercase, strip punctuation except
  `-` and `_`, whitespace to `-`, repeats get `-1`, `-2`). `DocLinkTarget` gains `anchor: string | null`;
  `resolveDocLink(fromRel, "#x")` returns `{ rel: fromRel, line: null, anchor: "x" }`, `doc.md#x` carries the
  anchor, `#L12` stays a line.
- `markdown.tsx` `Link`: `onClickLink` gets every href first; `#` falls back to `setFocusedHeading` only when it
  returns false (Code is its only caller).
- F12 folder: `revealFolder(rel: string): void` in codestore reveals the folder's ancestors and the folder,
  selects it, switches the sidebar to Files (`codeSearchModeAtom`), and touches neither the file nor history.
  The preview link handler calls it when the index lists a path under `rel/`; `openPath` calls it when the stat
  says directory (before the history push, so history is untouched).

Tests (`npx vitest run frontend/app/view/code/codependingjump.test.ts frontend/app/view/code/codelink.test.ts frontend/app/view/code/codestore.test.ts frontend/app/cockpit/palette-files.test.ts`):
- `waits while another file is showing`, `applies the line once its file is the text showing`, `drops a jump whose
  file did not open as text`, `resolves an anchor to its heading line`, `drops an unknown anchor`.
- `slugHeadings matches GitHub for punctuation and repeats` (e.g. `["The final stage", "A/B: test", "Setup",
  "Setup"]` → `["the-final-stage", "ab-test", "setup", "setup-1"]`).
- `resolveDocLink keeps an in-page anchor` and `carries a cross-file anchor`.
- `openInCode tags the pending jump with its path`; `opening another file drops a pending jump for a different
  path`; `openPath of a directory reveals the folder and leaves the file and history`.
- palette: `a bare :152 on Code goes through goToLine` (pending jump `{ path: <open file>, line: 152 }`).

Scenario `code-jumps` steps, each with a shot: a search hit in another file opens it at the hit's line (Monaco's
visible range contains it); F12 to a definition in another file puts the caret on the `def` line; a hit at a deep
line of another markdown file scrolls Preview to that section; Back across files returns to the earlier line; a
README link to a folder selects the folder in the tree and keeps the file open; an in-page `#anchor` link scrolls
to its heading; a `doc.md#anchor` link opens the doc at that heading.

### Task 4: Toolbar, tree dots, follow the app bar (F3 picker, F16, F18, F20)
**Depends on:** Task 2
**Files:** `frontend/app/view/code/codesurface.tsx`, `frontend/app/view/code/codetreepane.tsx`, `frontend/app/view/code/codedraft.ts`, `frontend/app/view/code/codedraft.test.ts`, `frontend/app/view/code/codefollow.ts`, `frontend/app/view/code/codefollow.test.ts`, `frontend/app/view/agents/surfacecontext.ts`, `frontend/app/view/agents/surfacecontext.test.ts`, `scripts/cdp/scenarios-code-toolbar.mjs`

Decisions (spec "Toolbar, tree, panes"):
- F3: the project picker gets `useEscapeClose` with a trigger ref and the backdrop.
- F16: `projectDraftPaths(drafts: ReadonlyMap<string, Draft>, projectPath: string): string[]` in `codedraft.ts`
  (repo-relative, sorted, by `sameRepoPath`-style prefix). A collapsed folder with drafts under it
  (`changedDirs` from `codestatus.ts` over those paths) shows the file row's unsaved dot (`bg-accent-soft`,
  `aria-label="Contains unsaved edits"`) beside the change dot. The toolbar shows `N unsaved`
  (`data-code-unsaved-count={n}`) while the project has drafts; it opens a popover (same pattern) listing them;
  a row opens the file with `openPath`.
- F18: `projectToFollow(prev: string, next: string, projects: CodeProject[], current: CodeProject | null):
  CodeProject | null` in `codefollow.ts`: the registered project named `next` when `next !== prev`, `next !==
  "all"`, and it is not `current`. `CodeSurface` keeps the previous filter in a ref (none on first render) and
  selects the result. `projectControlCopy("code", …)` title: "Set the project default; Code opens it".
- F20: the `no-projects` empty state reads "Add a project to browse its source here." with action "New project"
  setting `model.newProjectOpenAtom` to true.

Tests (`npx vitest run frontend/app/view/code/codedraft.test.ts frontend/app/view/code/codefollow.test.ts frontend/app/view/agents/surfacecontext.test.ts`):
`projectDraftPaths lists only this project's drafts, relative`; `projectToFollow ignores the first value, all, and
the current project`; `projectToFollow returns the registered project for a new name`; `Code's switcher title says
it opens the project`.

Scenario `code-toolbar` steps, each with a shot: the picker closes on an outside click and on Esc, and Esc does
not leave Code; a draft inside a collapsed folder shows the unsaved dot on the folder row; `N unsaved` lists the
draft and a row opens it; picking a registered project in the app-bar switcher while on Code opens it in Code;
the empty state's New project opens the New project dialog: the step empties the registry the surface reads by
setting `atoms.fullConfigAtom` (through the app's `globalStore`) to a copy with `projects: {}` and nulls the Code
project (`selectProject(null)`, and `lastCodeProjectAtom` to null), then restores both values in a `finally`.

### Task 5: Keys and shortcut docs (F7, F15, docs for F8, F13, F21)
**Depends on:** Task 1
**Files:** `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios-code-keys.mjs`

Decisions:
- F7: `code:diff` returns false in a plain folder (`codePlainAtom`), as `code:blame` does.
- F15: `code:back` / `code:forward` use the `code:definition` gate (`surface === "code" && !modalOpen`).
- Docs (the Code table): Alt+←/→ marked "(from the editor)"; `d` notes it needs a git repo; `b` turns blame on in
  Source, switching to it from Preview or Diff; `Alt`+`M` from Preview or Diff switches to Source first, and the
  editor's context menu has "Add review comment"; a new row "`↑` / `↓` in the Changed list: walk the rows, `Enter`
  opens". Labels in `bindings.ts` change only where the docs' wording for the same key changes.
- Another run (cad1a593) also edits `bindings.ts` and `docs/keyboard-shortcuts.md`; when its changes are on main
  first, keep both runs' behavior.

Tests (`npx vitest run frontend/app/store/keybindings`): in `bindings.test.ts`, `code:back and code:forward are
live on Code with focus in an editable field` (their `when` is true for `{ surface: "code", editable: true,
modalOpen: false }`) and `code:diff lets the key pass in a plain folder` (with `codeIndexAtom` set to
`{ paths: [], isRepo: false, truncated: false }`, `run()` returns false and the view mode is unchanged).

Scenario `code-keys` steps, each with a shot: `d` in a plain folder leaves the single editor (no
`[data-code-diff-target]`); Alt+← with focus in the editor walks Back to the previous file. Dispatch keys per
memory "CDP key events need page focus": focus the Monaco edit host first; if the key never arrives, run the same binding's
`run()` through the app's module (`mod("app/store/keybindings/bindings.ts")`, `buildCodeBindings`) and say so in
the step's detail, so the step still proves the behavior.

### Task 6: Path bar, review and handoff (F3 popovers, F8, F13 store/bar, F23, F24)
**Depends on:** Task 1
**Files:** `frontend/app/view/code/codepathbar.tsx`, `frontend/app/view/code/codereviewbar.tsx`, `frontend/app/view/code/codereviewstore.ts`, `frontend/app/view/code/codereviewstore.test.ts`, `frontend/app/view/code/codereview.ts`, `frontend/app/view/code/codereview.test.ts`, `frontend/app/view/code/codehandoff.ts`, `frontend/app/view/code/codehandoff.test.ts`, `frontend/app/view/code/codeblamestore.ts`, `frontend/app/view/code/codeviewmode.ts`, `frontend/app/view/code/codeviewmode.test.ts`, `scripts/cdp/scenarios-code.mjs`, `scripts/cdp/scenarios-code-handoff.mjs`

Decisions (spec "Review comments and handoff", F3, F8):
- F3: Send to agent and Send review popovers get `useEscapeClose` and the backdrop; `CodeReviewBar` sets
  `codeReviewSendOpenAtom` false on unmount.
- `showsSourceEditor(mode: "preview" | "source" | "diff", path: string): boolean` in `codeviewmode.ts`
  (`mode !== "diff"` and not `isMarkdownPath(path) && mode === "preview"`).
- F8: the Blame toggle is pressed only when blame is on and `showsSourceEditor`; `toggleBlame()` outside the
  source editor sets the mode to `source` and blame on (button and `b` share it).
- F13 store: `startComment()` outside the source editor sets the mode to `source` and
  `codeCommentPendingAtom: PrimitiveAtom<boolean>` true; `consumePendingComment(): void` (called by the viewer
  after the editor mounts, Task 11) clears it and runs `startComment()`. Reviews persist under localStorage key
  `code.reviews` with `parseStoredReviews(raw: string | null): Reviews` and `storedReviewsJson(r: Reviews): string`
  in `codereview.ts`, written debounced like drafts (`codestore.ts:156-165` pattern, including `pagehide`).
  Copy review keeps the review and shows Copied/Copy failed (`useCopyFeedback`); a send to an agent still removes
  what it sent. The review count is a button opening a popover (same pattern, `data-code-review-list`) listing
  `path:L<start>[-L<end>]` and the note per comment, sorted by path then line; a row opens it with `openInCode` at
  its line, a delete button (`aria-label="Delete comment"`) calls `removeComment`.
- F23: `send` awaits `AgentPromptCommand`: "Sending…", then "Sent to <name>" or "Could not send: <reason>" in
  `text-error`.
- F24: `handoffLine`'s signature stays (`{ rel, startLine?, endLine?, note? }`, also used by
  `agents/canvasmarks.ts:44`, which keeps relative paths); `codepathbar.tsx` passes the absolute path
  (`joinRepoPath(project.path, rel)`) in `rel`. `reviewMarkdown(projectName: string, checkout: string, comments)` puts `Checkout: <checkout>` under the
  title and keeps relative paths.
- Update `code-review` in `scenarios-code.mjs`: Copy review now keeps the count and shows Copied
  (`scenarios-code.mjs` around line 1489).

Tests (`npx vitest run frontend/app/view/code/codeviewmode.test.ts frontend/app/view/code/codereview.test.ts frontend/app/view/code/codereviewstore.test.ts frontend/app/view/code/codehandoff.test.ts`):
`showsSourceEditor is false for markdown Preview and for Diff, true for a Go file in preview mode`; `reviews
round-trip through storage`, `parseStoredReviews ignores malformed input`; `copying the review keeps it`; `a
failed copy keeps the review and reports it`; `startComment outside Source switches to Source and leaves a
pending comment`; `consumePendingComment starts the comment once`; `handoffLine keeps an absolute path it is given whole`;
`reviewMarkdown states the checkout`.

Scenario `code-handoff` steps, each with a shot: Send to agent and Send review close on an outside click and on
Esc; Send review is closed after leaving Code and coming back; Blame in markdown Preview is not pressed, and a
click shows Source with the blame column; the review list shows two comments and deleting one leaves one; Copy
review keeps the count and shows Copied; Copy reference puts the absolute path on the clipboard (read with
`navigator.clipboard.readText` where permitted, else assert the popover's composed line).

### Task 7: Changed pane keyboard (F21)
**Depends on:** Task 1
**Files:** `frontend/app/view/code/codechangedpane.tsx`, `scripts/cdp/scenarios-code-changed.mjs`

Rows become `button`s with roving `tabIndex` (0 on the cursor row); `onKeyDown` on the list walks with
`stepRow` from `codesearch.ts` (`↑`/`↓`), focusing the row; `Enter`/click opens as today. Focus ring per the search
pane's rows. Tests: `npx vitest run frontend/app/view/code/codesearch.test.ts -t stepRow` (the walk it reuses).
Scenario `code-changed` steps, each with a shot: Tab into the list, `↓` moves focus to the second row, `Enter`
opens it in the editor. Send the arrow and Enter as CDP keys after focusing a row; if they never arrive, dispatch
a bubbling `KeyboardEvent("keydown")` on the focused row (React's `onKeyDown` handles it) and say so in the detail.

### Task 8: Blame follows unsaved edits (F9)
**Depends on:** Task 1
**Files:** `frontend/app/view/code/codeblame.ts`, `frontend/app/view/code/codeblame.test.ts`, `frontend/app/view/code/codeblamecolumn.tsx`, `scripts/cdp/scenarios-code-blame-draft.mjs`

`mapBlameLines(saved: string, buffer: string): (number | null)[]` in `codeblame.ts`: for each buffer line, the
1-based saved line it is, or null for an inserted or edited line. Line-level LCS on the middle after trimming the
common prefix and suffix; when the middle exceeds 2,000,000 cells (`a.length * b.length`), the middle maps to
null. `CodeBlameColumn` reads the open file's draft from `codeDraftsAtom` and places each blame entry at its mapped
buffer line(s); unmapped lines draw nothing. Tests: `unchanged text maps every line to itself`; `an insert at the
top shifts every saved line down one`; `an edited line maps to null`; `a huge middle falls back to null without a
full diff`. Scenario `code-blame-draft` steps, each with a shot: in a temp repo with two commits, insert a line
at the top through `editDraft`; the first blame entry sits beside saved line 1's text, not the inserted line.

### Task 9: Viewer states and diff targets (F6, F14, F17 compare)
**Depends on:** Task 3, Task 6
**Files:** `frontend/app/view/code/codestore.ts`, `frontend/app/view/code/codestore.test.ts`, `frontend/app/view/code/codeviewer.tsx`, `frontend/app/view/code/codediffview.tsx`, `frontend/app/view/code/codedifftarget.ts`, `frontend/app/view/code/codedifftarget.test.ts`, `frontend/app/view/code/codestalebar.tsx`, `scripts/cdp/scenarios-code.mjs`, `scripts/cdp/scenarios-code-diff-states.mjs`

Decisions (spec "Viewer states and diff"):
- `codeDiffTargetAtom: "head" | "base" | "disk"`. `showDiffTarget(t: "head" | "base"): Promise<void>` resolves
  the base for `base` (as `cycleDiff`) and sets the atoms; `compareWithDisk(): void` sets mode `diff`, target
  `disk`; the disk side loads with `FileReadCommand` into `codeHeadAtom` with `ref: "disk"`. `nextDiffStep`
  treats `disk` like the last step (`d` returns to Source).
- F14: the diff header (`data-code-diff-target`) is a two-button control `HEAD` / `Branch base`
  (`data-code-diff-option`), Branch base disabled with the reason when the base is a skip; on `disk` it reads
  "Your edits against the copy on disk" with the two options still offered. `diffUnchanged(head: HeadText, text:
  string): boolean` in `codedifftarget.ts`; when true the pane shows "No changes against HEAD" / "No changes
  against the branch base" / "No changes against the copy on disk".
- F17: the stale bar gains "Compare with disk" (only with a draft), after the destructive button. Update
  `code-stale-bar`'s `querySelector("button")` reads (`scenarios-code.mjs:1736-1782`) to select buttons by label.
- F6: `missingView(status: CodeStatus | undefined, plain: boolean): "deleted" | "missing"` in
  `codedifftarget.ts`. A missing file with status `D` shows title "Deleted in the working tree" and
  `CodeDiffView` with `fixedTarget="head"` and empty text (all removed), no Refresh index.
- Update `code-diff` in `scenarios-code.mjs` for the header control.

Tests (`npx vitest run frontend/app/view/code/codedifftarget.test.ts frontend/app/view/code/codestore.test.ts`):
`diffUnchanged is true for equal text and false while loading`; `missingView is deleted for D in a repo and
missing otherwise`; `d from disk returns to source`; `showDiffTarget base on the default branch stays on HEAD`;
`compareWithDisk enters the disk target`.

Scenario `code-diff-states` steps, each with a shot: a deleted tracked file shows "Deleted in the working tree"
with the all-removed diff, from the tree and from the Changed row; the header's Branch base switches to the base
on a feature branch; an unchanged file says "No changes against HEAD"; a refused save's stale bar offers Compare
with disk, which shows the draft against the disk copy.

### Task 10: Binary classification and the peek's hint (F22 classify)
**Depends on:** Task 3
**Files:** `frontend/app/view/code/codeclassify.ts`, `frontend/app/view/code/codeclassify.test.ts`, `frontend/app/view/code/codepeekmodel.ts`, `frontend/app/view/code/codepeekmodel.test.ts`, `frontend/app/view/code/codepeekcard.tsx`, `scripts/cdp/scenarios-codepeek.mjs`

`classifyFile` checks the MIME before the size (a binary MIME over the limit is `binary`). `isImagePath(path:
string): boolean` (png, jpg, jpeg, gif, webp, svg, bmp, ico, avif; case-insensitive). The peek's binary message moves out of
`codepeekcard.tsx:62` into `binaryPeekMessage(path: string): string` in `codepeekmodel.ts`: "Image — open it in
Code" for images, "Binary file" otherwise; the card calls it. Update `scenarios-codepeek.mjs:480`, and add a small
`.png` fixture beside `blob.bin` with its own step. Tests
(`npx vitest run frontend/app/view/code/codeclassify.test.ts frontend/app/view/code/codepeekmodel.test.ts`):
`a large font is binary, not too large`; `a large text file is still too large`; `isImagePath`;
`binaryPeekMessage names an image and a plain binary`. Scenario `code-peek`: the binary step asserts "Binary
file" and a new step peeks the `.png` and asserts "Image — open it in Code", each with a shot.

### Task 11: Editor extras: comments and images (F13 editor, F22 view)
**Depends on:** Task 9, Task 6 (uses `consumePendingComment` and `showsSourceEditor`), Task 10 (uses `isImagePath`)
**Files:** `frontend/app/view/code/codeviewer.tsx`, `scripts/cdp/scenarios-code-editor.mjs`

- F13: `onMount` adds a Monaco action `arc.code.comment`, label "Add review comment", `contextMenuGroupId:
  "navigation"`, running `startComment`; it then calls `consumePendingComment()`. While a comment draft is open, a
  view zone after its end line (height of the input, measured) holds the input, so no code line sits under it;
  the zone is removed when the draft closes or the file changes.
- F22: the `binary` case renders an image for `isImagePath(file.path)` (fetched with `resolveRemoteFile` from
  `markdown-util.ts`, `{ connName: "local", baseDir: <file's dir> }`, the blob URL released on unmount, an error
  line if it fails), centered and fit to the pane; every binary and too-large state offers Copy path.
- Scenario `code-editor` steps, each with a shot: the editor's context menu lists "Add review comment" and it
  opens the comment input; with the input open, the commented line's next line sits below the input (its top is
  past the input's bottom); Alt+M in markdown Preview switches to Source and opens the input; a PNG renders as an
  `img` with natural width > 0; a binary file offers Copy path.
