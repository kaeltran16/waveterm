# File tab polish: wrapped Source, the Changes tab's hunk rows for Diff, images drawn

**Verify:** `node scripts/verify.mjs ./pkg/gitinfo ./pkg/wshrpc/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-file code-peek workspace-changes code-editor`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\file-tab-polish

The workspace pane's File tab (`frontend/app/view/agents/workspacefiletab.tsx`, which renders `CodePeekCard
variant="tab"` from `frontend/app/view/code/codepeekcard.tsx`), rebuilt to the prototype canvas. Its boards, drawn
at the pane's 600 px: **Main** (Source on a changed file), **Diff** (Diff on a changed file) and **Image**. The canvas
is the spec for layout, type and copy; colours come from the `@theme` tokens (no new ones). Settled with the user
11-19:

1. **Source**, in the File tab only: no minimap and long lines wrap, whatever `editor:minimapenabled` /
   `editor:wordwrap` say (the Code surface and the terminal's floating peek card keep the settings). Text at the diff
   rows' size, fixed in the tab: 12.5 px mono, 20 px lines. The cited line keeps its accent band and accent number
   (`peek-cited-line`). Header unchanged.
2. **Diff on a changed file**: no Monaco inline diff in the tab; the Changes tab's hunk rows instead (the transcript
   `DiffRow`, hunks labelled by function from git's `@@` context, one line-number column, +/- bands, wrapped),
   reusing that code and its data path (`GitPatchCommand` / `parseUnifiedDiff`), not a copy. The cited line's number
   is bold accent-soft; no extra band on its row. No Hide whitespace in the File tab.
3. **A file new since HEAD** offers no Diff mode in the tab (Source shows the same text, the header stat already says
   "new file"); with only Source left the mode switch hides, as it does today for one mode. The floating card keeps
   its modes.
4. **An image** is drawn fit to the pane with its size and Copy path under it, through the Code surface's `ImageView`
   (not a copy); no modes; Open in Code stays. Other binaries, loading, missing, folder and too-large keep today's
   notices.

## Decisions beyond the design

1. **One file's patch comes from the server, narrowed to its path.** `CommandGitPatchData` gains `path` (cwd-relative,
   forward slashes; "" keeps today's whole change set), and `gitinfo.GetPatch` passes it to git as a literal pathspec
   (`:(literal)<path>`, so `*` or `[` in a name is never a glob) on both the tracked `git diff` and the untracked
   `git status`. Rejected: picking the file out of the Changes tab's `changesPatchAtom`. That patch is the focused
   agent's change set against the rail's ref (a worktree's base, not HEAD), capped at 2 MB, so the cited file can be
   missing from it or diffed against another base than the header's stat, and it belongs to whichever agent is
   focused, not to the file's repo.
2. **The tab's Diff reads against HEAD** (`ref: ""`, `cwd: git.root`, `path: git.rel`, `ignorews` off), the same base
   the peek's HEAD read and its numstat stat use, so rows and the header's +/- agree.
3. **No cache:** the tab re-reads the one-path patch each time Diff mounts. A single path's local diff is cheap, and
   the rows then always match the file on disk; the peek itself re-reads the file on every open the same way.
4. **The hunk list moves to one shared component**, `DiffHunks` in `frontend/app/view/agents/diffhunks.tsx`, with the
   Changes tab's notes table, so both tabs draw hunks through one piece; `splitHunks` is exported from
   `workspacechangesmodel.ts`, beside a pure `isCitedRow` predicate, and `DiffRow` gains an optional `cited` flag.
   `DiffHunks` itself renders `data-changes-hunk={i}` and `data-changes-hunk-label` on every use, so both tabs'
   scenarios query the same markup. The Changes tab looks and behaves as before. Its 42 px numbered gutter wins over
   the Diff board's 48 px column: `DiffRow` is reused unchanged, and one gutter width across both tabs keeps them alike.
5. **Diff lands on the cited line:** on first draw the row whose number is the cited line is scrolled to the middle
   of the body, as Source centres it; with no such row (the line is outside every hunk) the body stays at the top.
   Which row that is comes from the pure body picker (decision 6), so the fallback is unit-tested.
6. **Diff's other states, in the tab:** a HEAD side that cannot be read (binary or too large at HEAD) keeps today's
   message; a failed read shows the tab's notice (`CircleAlert`) with the error's own text, never swallowed; a file
   with no hunks reads "No line changes", and a truncated patch without the file reads "Too large to show here"
   (both from the shared notes table). While the read is in flight the body is empty: a one-path local diff lands
   well inside the view swap's fade. Which body shows is one pure function beside `peekModes` in `codepeekmodel.ts`
   (`tabDiffBody`, Task 4), unit-tested for every state with the error text passed through; the scenario shows the
   rows and the "No line changes" state live. The read-failed and HEAD-unreadable notices are checked by that unit
   test only, since the scenario cannot make a local git read fail or a HEAD blob unreadable without a fixture repo
   built for it.
7. **New-file Diff is off in the tab through the pure model:** `peekModes(path, file, variant)` with
   `variant: "card" | "tab" = "card"` disables Diff for a tab when HEAD has no such file (`head.kind === "absent"`,
   untracked or staged-new alike). The store's `setPeekMode` keeps calling it without a variant: the tab never offers
   the button, and the card keeps all its modes.
8. **The tab's Source options are an override prop:** `CodeEditor` gains `options?: IEditorOptions`, applied over the
   settings-derived options. Only the tab passes it (`minimap.enabled: false`, `wordWrap: "on"`, `fontSize: 12.5`,
   `lineHeight: 20`); the card's Source and the Code surface pass nothing and read the settings as today.
9. **`ImageView` moves into its own module**, `frontend/app/view/code/codeimageview.tsx`, with `sizeLabel` and
   `copyPath`; its prop becomes the root path (`root: string | null`) instead of a `CodeProject`, so the peek card
   need not import the Code surface's module (and its module-scoped editor state). The Code surface renders the same
   component. In the tab, an image's root and path are the peek's `open.projectPath` / `open.rel`.
10. **The floating card is unchanged**, images included: it keeps "Image — open it in Code"; the goal scopes the image
    view to the File tab.
11. **Removed with the tab's Monaco diff:** `TAB_DIFF_OPTIONS`, `DiffView`'s tab branch (its `MonacoInsertedText` /
    `data-diff-new-file` path for the tab) in `codepeekcard.tsx`, and `paneOptions`' `wrap` parameter, which only the
    tab used (its test goes with it). `MonacoInsertedText` stays (the Code surface's diff uses it), and so does the
    `[data-diff-new-file]` CSS (the Diff surface uses it).
12. **Tests run in Verify:** `scripts/verify.mjs` runs the vitest files related to a merge's changed TS paths (and all
    of them in the final stage), so the frontend unit tests each task adds run at its merge with no extra command.
13. **Motion:** no new moments. A mode switch and the file landing keep the card's existing `ViewSwap` fade; the image
    keeps `ImageView`'s own `viewFade` as it lands over its blank.

### Task 1: GitPatchCommand narrowed to one path
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_git.go`, `pkg/gitinfo/patch.go`, `pkg/gitinfo/patch_test.go`, `pkg/wshrpc/wshserver/wshserver_git.go`, `frontend/types/gotypes.d.ts`

**What to build:** `GitPatchCommand` can return the patch of one path (decision 1). `task generate` writes the TS
type; no other generated file should change (check `git status` after it).

**Interfaces:**
- Go: `CommandGitPatchData` field `Path string`, tagged `json:"path,omitempty"`; `gitinfo.GetPatch(ctx, cwd, ref, path string,
  ignoreWs bool)`. TS: `CommandGitPatchData.path?: string`.

**Acceptance:**
- With `path` set to a modified tracked file, the patch holds that file's entry only, its hunks as git writes them
  (the `@@` line keeps git's function context).
- With `path` naming an untracked file, the patch holds that file's new-file entry only; with `path` naming an
  unchanged file, the patch is empty and not truncated.
- A path holding glob characters matches only that literal path.
- `path` empty returns today's whole change set (the existing GetPatch tests keep passing).

### Task 2: Source wraps at the diff rows' size, and an image is drawn, in the File tab
**Depends on:** none
**Files:** `frontend/app/view/codeeditor/codeeditor.tsx`, `frontend/app/view/code/codepeekcard.tsx`, `frontend/app/view/code/codeimageview.tsx`, `frontend/app/view/code/codeviewer.tsx`, `scripts/cdp/scenarios-workspace-file.mjs`

**What to build:** boards Main and Image. The tab's Source passes the fixed options (decision 8); the card's Source
does not. `ImageView` moves to `codeimageview.tsx` (decision 9) and the tab draws a binary file whose path is an image
(`isImagePath(open.rel)`) through it; every other non-text state keeps its notice in the tab, and the card is
unchanged (decision 10). In the scenario's repo, add a tracked file that is committed in the seed and then changed in
the working tree: one hunk sits inside a Go `func` far enough below its `func` line that git labels the hunk with it,
and the hunk adds a line longer than the 600 px pane can hold on one row; the reply cites that file at a line the
change added. Add a small real image (a valid PNG) to the repo and a reply link to it. Keep the file, its cited line
and the expected hunk label as named constants: Task 4's Diff step reuses them. Keep the scenario's existing steps
passing (adjust their link and tab counts for the new links); its "Diff on a file new since HEAD" step stays for now.

**Interfaces:**
- `CodeEditor` prop `options?: MonacoTypes.editor.IEditorOptions`, applied after the settings.
- `codeimageview.tsx` exports `ImageView({ root, path, size }: { root: string | null; path: string; size: number })`,
  `sizeLabel(bytes: number): string`, `copyPath(root: string | null, rel: string): void`.

**Acceptance:**
- Scenario `workspace-file`, new step "Source on a changed file: no minimap, the long line wrapped, 12.5 px text on
  20 px lines, the cited line in its accent band with its accent number (Main board)": the tab's editor has no
  visible minimap, the long line spans more than one view line, a view line's computed font size is 12.5 px and its
  height 20 px, and `.peek-cited-line` / `.peek-cited-line-number` sit on the cited line; screenshot.
- Scenario `workspace-file`, new step "An image is drawn fit to the pane, its size and Copy path under it, no modes,
  Open in Code (Image board)": the image has loaded (natural width > 0) and its box lies inside the tab's body, the
  size label and a Copy path button sit under it, Copy path puts the file's absolute path on the clipboard (stubbed,
  as other scenarios do), no `[data-peek-mode]` button shows, and `[data-peek-open]` is enabled; screenshot.
- Scenario `code-peek` passes unchanged (the floating card reads the editor settings as before).
- Scenario `code-editor` passes: the Code surface's image view renders through the moved component.

### Task 3: One hunk list for the Changes tab and the File tab
**Depends on:** none
**Files:** `frontend/app/view/agents/diffhunks.tsx`, `frontend/app/view/agents/workspacechangestab.tsx`, `frontend/app/view/agents/workspacechangesmodel.ts`, `frontend/app/view/agents/workspacechangesmodel.test.ts`, `frontend/app/view/agents/tooldetailbody.tsx`

**What to build:** a prefactor (decision 4). The Changes tab's hunk rendering (each hunk's `⋯` label row and its
`DiffRow`s, wrapped) moves out of `FileBody` into `DiffHunks`; the Changes tab's `NOTES` table moves with it as
`DIFF_NOTES`. `DiffHunks` renders `data-changes-hunk={i}` on each hunk and `data-changes-hunk-label` on each label
row itself; the Changes tab renders through it and keeps its own wrapper and its scroll margins (passed in through
`hunkClassName`). Whether a row is the cited one is the pure `isCitedRow`, which `DiffHunks` calls. `DiffRow`'s `cited` draws its gutter number
bold in accent-soft and marks the row `data-diff-cited`, with no change to the row's band.

**Interfaces:**
- `diffhunks.tsx`: `DiffHunks({ hunks, cited, hunkClassName }: { hunks: ChangesHunk[]; cited?: number | null;
  hunkClassName?: string })`, rendering `data-changes-hunk` / `data-changes-hunk-label` itself.
  `DIFF_NOTES: Record<"binary" | "whitespace" | "toolarge" | "empty", string>`.
- `workspacechangesmodel.ts`: `export function splitHunks(lines: DiffLine[], isNew: boolean): ChangesHunk[]`
  (unchanged behaviour); `export function isCitedRow(row: DiffLine, cited: number | null | undefined): boolean`.
- `tooldetailbody.tsx`: `DiffRow({ line, numbered, wrap, cited }: { ...; cited?: boolean })`.

**Acceptance:**
- `splitHunks` labels a hunk by git's `@@` context, falls back to `line N`, and gives a new file's hunk no label and
  untinted rows (unit-tested at the export).
- `isCitedRow` (unit-tested in `workspacechangesmodel.test.ts`): true for an added or context row whose `newNo` is the
  cited line; false for a removed row whose `oldNo` is that number, for any other row, and when `cited` is null or
  undefined.
- Scenario `workspace-changes` passes unchanged (the Changes tab looks and steps through hunks as before).

### Task 4: Diff in the File tab draws the hunk rows; a new file offers no Diff
**Depends on:** Task 1 (the `path` field on `GitPatchCommand`), Task 2 (shares `codepeekcard.tsx` and the scenario file, and adds the changed file the Diff step cites), Task 3 (`DiffHunks`, `DIFF_NOTES`, `splitHunks`)
**Files:** `frontend/app/view/code/codepeekdiff.tsx`, `frontend/app/view/code/codepeekcard.tsx`, `frontend/app/view/code/codepeekmodel.ts`, `frontend/app/view/code/codepeekmodel.test.ts`, `frontend/app/view/agents/diffoptions.ts`, `frontend/app/view/agents/diffoptions.test.ts`, `scripts/cdp/scenarios-workspace-file.mjs`

**What to build:** board Diff. In the tab, Diff on a changed tracked file reads the one-path patch (decisions 1-3)
with `PATCH_RPC_TIMEOUT_MS` from `workspacechangesstore.ts`, parses it with `parseUnifiedDiff`, splits it with
`splitHunks(lines, false)` and draws `DiffHunks` with the peek's cited line, in a scrolling body on the Changes tab's
hunk background, landing on the cited row (decision 5); its other states follow decision 6. The body is picked by the pure `tabDiffBody` (decision 6), which also names the row to land on. A file new since
HEAD offers no Diff in the tab (decision 7), so its mode switch hides. The card's Diff (Monaco) is unchanged; the tab's
Monaco path and `paneOptions`' `wrap` go (decision 11). In the scenario, the old "Diff on a file new since HEAD reads
as the plain file" step is replaced by the new-file step below, and the first step's `source === "true"` check on
stats.go (a new file, whose mode switch now hides) becomes "no `[data-peek-mode]` button". The scenario's dedupe.go
stays committed and unchanged, which the empty-state step relies on.

**Interfaces:**
- `codepeekmodel.ts`: `peekModes(path: string, file: PeekFile, variant: "card" | "tab" = "card")`.
- `codepeekmodel.ts`: `tabDiffBody(head: PeekHead, read: { kind: "loading" } | { kind: "failed"; message: string } |
  { kind: "read"; files: EditFile[]; truncated: boolean }, rel: string, cited: number | null)` returning
  `{ kind: "loading" } | { kind: "head"; message: string } | { kind: "error"; message: string } |
  { kind: "note"; note: "empty" | "toolarge" } | { kind: "hunks"; hunks: ChangesHunk[]; landOn: number | null }`
  (`landOn`: the cited row's index across the hunks' rows, null when none matches). The worker may adjust the exact
  shape; no other task uses it.

**Acceptance:**
- `tabDiffBody` (unit-tested in `codepeekmodel.test.ts`): a HEAD error gives its message; a failed read gives the
  error's own text; a read with the file's hunks gives them with `landOn` at the cited row, or null for a line outside
  every hunk; a read without the file gives "empty", or "toolarge" when truncated; a read whose entry for the file has
  no hunks gives "empty".
- `peekModes` with variant `"tab"` disables Diff for a file whose HEAD side is absent and enables it for a changed
  tracked file; with `"card"` (and with no variant) Diff stays enabled for both.
- Scenario `workspace-file`, new step "Diff on the changed file draws the Changes tab's hunk rows: a function label,
  one number column, +/- bands, the long line wrapped, the cited number bold accent-soft with no extra band (Diff
  board)": no `.monaco-editor` in the tab body, a `[data-changes-hunk-label]` reads the function the scenario's
  constant names, added and removed rows carry their bands, the long added line's row is taller than one 20 px line,
  exactly one `[data-diff-cited]` row whose number is the cited line, rendered bold in the accent-soft colour, and its
  background equals an uncited added row's; the cited row is in view; screenshot. Switching back to Source lands on
  the cited line.
- Scenario `workspace-file`, new step "A file new since HEAD offers no Diff mode in the File tab": its header shows
  "new file" in the stat and no `[data-peek-mode]` button at all; the first step's check on stats.go agrees.
- Scenario `workspace-file`, new step "Diff on a committed, unchanged file reads No line changes": on dedupe.go's
  tab, Diff shows the `DIFF_NOTES.empty` text, no hunk rows and no `.monaco-editor`; screenshot.
- Scenario `code-peek` passes unchanged (the floating card keeps Preview, Source and Diff, and its Monaco diff).
