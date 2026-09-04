# Code surface — improvement scan (2026-09-04)

> 2026-09-04. Read-only scan of the Code surface (`frontend/app/view/code/`, 25 files / ~2.5k lines),
> its keybindings (`frontend/app/store/keybindings/bindings.ts` `buildCodeBindings`), and the backend
> readers it depends on (`gitinfo.ListFiles`, `gitinfo.Grep`). Prompted by "how can we improve it
> further" plus one reported bug. Sequencing is deliberately **not decided here** — this records
> problems only; each fix batch gets its own spec/plan against these findings.

## Provenance and confidence

- Findings marked **verified** were read in source, including the exact line cited.
- C0 is the exception: it was reproduced and its fix re-verified against the live dev app over CDP.
  Everything else is reasoned from source, not measured.
- The three shipping specs (`2026-08-03-code-browser-surface-design.md`,
  `2026-08-06-code-surface-navigation-and-handoff-design.md`,
  `2026-08-15-code-theme-sync-and-markdown-preview-design.md`) each carry an "explicitly out of
  scope" list. Where a finding below reopens one of those decisions, it says so — none of them is an
  oversight to be quietly reversed.

## Fixed in this pass

### C0. Bare-letter bindings fired while typing in the editor · verified · FIXED (uncommitted)

`isEditableTarget` (`frontend/app/store/keybindings/dispatcher.ts:31`) tested for
`INPUT`/`TEXTAREA`/`SELECT`/`contenteditable`. Monaco 0.52+ types into a
`<div class="native-edit-context">` (the EditContext API,
`monaco-editor/esm/vs/editor/browser/controller/editContext/native/nativeEditContext.js:59`), which is
none of those. On monaco-editor 0.55.1 under WebView2 the legacy textarea **does not exist at all** —
confirmed live: `.monaco-editor .native-edit-context` present, `.monaco-editor textarea.inputarea`
null. So `ctx.editable` was `false` for the entire time the caret sat in the Code editor, and every
binding gated on `!ctx.editable` fired mid-word, with the keystroke swallowed
(`dispatcher.ts:112-114` preventDefaults whatever a binding claims):

- `r` → `code:refresh`, re-running `git ls-files` and blanking the tree. The reported symptom.
- `g` → bare-prefix leader entry (`matcher.ts:73`), since `g x` bindings use `navigate` = `!editable`.
  Arms which-key and eats the next keystroke; `gf` navigates to Diff.
- `Escape` → `surface:back-home`; `code` is in `ESC_HOME_SURFACES` (`bindings.ts:76-84`) and the
  binding uses `navigateStrict` = `!editable`. Not observed pre-fix, but it reads the same flag that
  provably read false.

Second casualty of the same Monaco change: `code:focus-editor` (Alt+E) queried
`.monaco-editor textarea`, which now matches only the readonly `aria-hidden tabindex=-1` IME textarea
— so Alt+E focused an element that swallows every keystroke.

Fix: `isEditableTarget` also returns true when the focused element is inside `.monaco-editor`
(matching the container covers both edit-context implementations and any future swap of the focus
target); `code:focus-editor` targets `.native-edit-context, textarea.inputarea`; new
`dispatcher.test.ts` covers the predicate with the EditContext host as the named regression case.

Note `bindings.test.ts:452` already asserted `code:refresh` is inactive when `editable: true` — it
passed throughout. The lie was upstream in deriving the context, which had no test at all.

Verified live over CDP (7/7): `r` and `g` insert characters, the tree does not reload, Escape stays on
Code, and — the control that proves the gate was narrowed rather than disabled — Escape with the tree
focused still navigates home.

## Correctness / data integrity

### C1. Unsaved drafts do not survive a window reload · verified · S

`codeDraftsAtom` is a plain in-memory atom (`codestore.ts:72`). The comment above it
(`codestore.ts:69`) says losing typed-but-unsaved work to a nav click would be the worst kind of bug,
and the design is careful about exactly that: drafts are keyed by absolute path, survive a project
switch, survive a surface unmount, and `reloadFromDisk` is the only path that intentionally destroys
typed text. But a webview reload, a dev HMR reload, an app restart, or a crash drops every draft
silently, and there is no `beforeunload` guard anywhere in the app (grep: no `beforeunload`, no
`location.reload`).

Fix shape: `atomWithStorage` for the draft map (the same pattern `lastCodeProjectAtom` already uses at
`codestore.ts:57-62`), plus a `beforeunload` handler registered while any draft exists. Storage quota
is the one real constraint — a cap or an eviction rule is part of the design, not an afterthought.

Related and cheaper: a draft in a **non-current** project is completely invisible. The dirty dot
renders only in the open project's tree (`codetreepane.tsx`), and `SaveControls`' status reflects only
the open file. A count in the header with a popover listing dirty paths would close it.

### C2. Index truncation is invisible in the tree · verified · S

`gitinfo.ListFiles` caps at `maxListFiles` (20,000) and returns `Truncated`
(`pkg/gitinfo/gitinfo.go:851-857`). The only surface that says so is the finder palette footer
(`codefinderpalette.tsx:132-136`). The tree and the search pane say nothing, so on a repo that trips
the cap the tree silently lacks files and reads as complete.

## Keyboard / interaction

### C3. Search results are mouse-only · verified · M

`codesearchpane.tsx` renders result rows as bare `<div onClick>` — no cursor atom, no `j`/`k`, no
Enter, no `role`, no `tabIndex`. This is the one pane on the surface you must reach for the mouse in,
on a surface where the tree got an entire pure keyboard contract (`codetreekeys.ts`) precisely because
that mattered. The tree's `treeKeyAction` shape ports directly: rows × cursor × key → action.

Related, same file: `Ctrl+Shift+F` (`code:search`, `bindings.ts:866-877`) only sets
`codeSearchModeAtom` to `"search"`. Pressing it while already in search mode is a no-op, so the input
never refocuses — the pane's focus effect runs on mount only (`codesearchpane.tsx:26-28`).

### C4. Empty-query finder returns alphabetical noise · verified · S

`rankPaths` with an empty query returns `paths.slice(0, limit)` (`codefinder.ts:23`) — for this repo,
50 rows starting at `.github/`. `codeHistoryAtom` already holds exactly the right list (recently
opened files, most recent first, `codehistory.ts`). Seeding the empty-query state from history makes
the single most-used gesture on the surface useful instead of decorative.

## Capability gaps

### C5. Staleness is only discovered at save time · reopens an 08-15 decision · M

Agents rewrite this working tree while you read it. `conflictOf` (`codedraft.ts:34-46`) catches that
at write time and refuses, which is the right behavior — but until you press Ctrl+S there is no signal
at all that the buffer is a stale snapshot. A re-stat on surface re-entry / window focus plus a
"changed on disk — reload" bar reuses `conflictOf` verbatim.

Explicitly deferred: the 08-15 spec lists "the 'changed on disk' staleness bar (designed in chat
2026-08-15, shelved by user redirect)" as out of scope. Reviving it is a decision, not a bug fix.

### C6. Search is fixed-string, case-insensitive, unfilterable · verified · M

`gitinfo.Grep` hardcodes `-F -i` (`pkg/gitinfo/gitinfo.go:890`). No case-sensitive mode, no regex, no
whole-word, no pathspec filter. All four are flag-level changes to that one `exec` plus a toggle row
in the pane. The 500-match cap (`maxGrepMatches`) is fine; the missing **path filter** is what bites
on a large repo, because there is no way to narrow a noisy query.

Note the 08-06 spec explicitly scoped out "regex or whole-word search" — so at minimum the
case-sensitivity toggle and the path filter are the uncontested part.

### C7. The project picker cannot reach worktrees · verified · M

The picker lists registered projects only (`codesurface.tsx:62-66`, from `projectsAtom`).
`resolveJumpProject` (`codestore.ts:395-407`) already browses an unregistered path gracefully — that
is how a Diff row jumps into a run's worktree — but you can only *land* there via a jump, never pick
one. Agents run in worktrees; listing a project's live worktrees under it in the picker is the
cockpit-native equivalent of "open folder", and the plumbing already exists.

### C8. Code is a one-way destination · reopens an 08-15 decision · L

Two entry points exist: a Diff row (`filessurface.tsx:288`) and a Radar finding
(`radarfindingdetail.tsx:193`). Nothing goes the other way. The file you are reading does not say
whether it is modified vs HEAD, which run touched it, or offer "show me the diff" — and the header
comment states the posture deliberately: "deliberately unconnected to agents and runs — this answers
'what does this code look like', not 'what changed'" (`codesurface.tsx:6-7`).

That posture is defensible, and it is also the single thing keeping Code feeling like a bundled editor
rather than part of the cockpit. The 08-15 spec shelved the diff-vs-HEAD toggle alongside C5. Both are
the same decision and should be reopened (or not) together.

Adjacent, unbuilt: transcripts render no file paths at all (grep for `filePath` in `view/agents/*.tsx`
returns nothing), so "open the file this agent just edited" has no entry point to hang off.

## Polish

- Back/forward are text glyphs `←`/`→` (`codesurface.tsx:130-141`) in a header where everything else
  is a lucide icon.
- That header now carries the project picker, save status, save, discard, refresh, back and forward.
  It is crowded, and C1's "N unsaved" indicator would add to it.
- Search result rows and the search group headers have no `role`/`tabIndex` (see C3) — the tree pane
  is the only part of the surface that is a proper focus owner.

## Not proposed

Open-file tabs, a file watcher, go-to-definition / a symbol index, browsing non-git directories,
remote/SSH browsing, search-and-replace, a sidebar TOC, repo-relative image resolution in the markdown
preview, and light mode. Each is on an existing out-of-scope list and none of them came up as a felt
gap during this scan.
