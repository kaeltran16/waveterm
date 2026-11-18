# Changes tab polish: every changed file in one scroll, by folder

**Verify:** `node scripts/verify.mjs ./pkg/gitinfo ./pkg/wshrpc/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/gitinfo ./pkg/wshrpc/...`
**Final:** `node scripts/cdp/final-verify.mjs workspace-changes workspace-pane`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\changes-tab-polish

The workspace pane's Changes tab (`frontend/app/view/agents/workspacechangestab.tsx`), rebuilt to the Main board of
the prototype (drawn at the pane's 600 px). The side file list and the Monaco diff leave the tab; every changed file
shows in one vertical scroll as a bordered block of hunks drawn with the transcript's diff rows. The Diff surface does
not change. What the tab keeps: the summary line (`changesLine`), Open on Diff landing on the agent's scope, the
loading / failed (Retry) / not-a-repo / No changes states, and `tab.selected` (now: that file scrolls into view).

Sizes, gaps and colors come from `Main.dc.html` and `DESIGN.md`; every color maps onto an existing `@theme` token in
`frontend/tailwindsetup.css` (no raw hex, no new token). The design's `feedback/001.png` is an older iteration (raw @@
lines, hunk tint): the board, not that image, is the spec.

## Decisions beyond the design

1. **The hunks come from git, through one new RPC, `GitPatchCommand`**, which returns the unified patch of the
   agent's whole change set (the rail's base ref, or HEAD, against the working tree, `--relative` to the cwd, untracked
   files appended as new-file entries). Why: the tab draws hunks, and git's own @@ header already carries the hunk's
   function or heading context the design labels hunks with; the alternative (load both texts of every file with
   `GitFileAtRefCommand` and diff them in the browser) needs a second diff algorithm the repo does not have and N×2
   reads per refresh. The frontend parses it with the existing `parseUnifiedDiff`, which the transcript already uses.
2. **The patch is capped at 2 MiB in total, cut at a whole file**, and says so (`truncated`); files past the cut read
   "Too large to show here" with the rest of the list intact. Why: the same cap the Diff pane's reads use
   (`MAX_DIFF_BYTES`), so one stray lockfile cannot stall the tab. No row virtualization: collapsed files draw no rows,
   and the cost of a long open file is measured before anything more is built.
3. **Hide whitespace is the Diff surface's `ignoreWsAtom`**, one preference for both views, sent to git as `-w`
   (GitHub's "Hide whitespace"). Why: one toggle under one name (both buttons read "Hide whitespace (⇧W)"); a second
   atom would let the two disagree for no reason. The tab never mounts Monaco, so it no longer publishes the Diff
   surface's hunk nav or split width.
4. **A hunk's label is the text after its @@ header's second `@@`**; when git found no context it reads `line N` (the
   new side's start, or the old side's when the new start is 0, as for a deleted file), and a new file's single hunk
   has no label row (as on the board). Why: an empty label row reads
   as a broken one. Git's default funcname rule applies (repo `.gitattributes` drivers win, as in any git diff); the
   tab does not install drivers of its own.
5. **A new file is status `A` or `?` (untracked)**: it starts collapsed, reads "new file", draws the letter `A` in the
   success color, and its rows carry no added tint (as on the board). Why: an agent's new files are usually untracked,
   and the board shows them as `A`. Deleted and modified files start open. Every other letter takes `statusColor`
   (`M`/`R`/`C` accent, `D` error), and a `+0` or `−0` count is dimmed to `text-muted` (the board dims `−0`; the
   transcript's file header dims both).
6. **Order:** files at the repo root first (no folder label), then one group per parent directory, groups sorted by
   path, files by name. The label is the directory path with a trailing `/` and "1 file" / "N files". A root file's
   header sticks at the top; a foldered file's header sticks under its folder label.
7. **The change counter walks hunks in display order across every file, collapsed ones included**, so the total does
   not move when files open or close; landing on a hunk in a collapsed file opens it. It reads `0/N` before the first
   step (the Diff surface's convention), wraps at both ends (as Monaco's does), and is hidden with no hunks. The
   previous/next buttons and Shift+P / Shift+N do the same step.
8. **Collapse state and the counter's position are per-agent atoms** (the Agent surface stays mounted; the tab
   unmounts when another tab shows), so they survive a tab switch and an agent switch. The patch is re-read when the
   rail state changes (it reloads on the agent's edits) or Hide whitespace flips, while the Agent surface is on screen;
   a re-read of the same files keeps the old rows until the new ones land (no skeleton flash), a new agent's read blanks.
9. **`tab.selected`, when it names a listed file, scrolls that file's header into view and opens it** (on mount and when
   the selection changes); the tab no longer writes it, since clicking a header collapses rather than selects.
10. **Open in Code opens the file at its first hunk's new-side line** (`openInCode`, as the Diff pane's button does).
    A deleted file has no Open in Code button: there is no file on disk to open.
11. **The patch read failing** (the list read worked) shows one band at the top of the scroll with the message and a
    Retry; the file headers still draw from the rail.
12. **Dead code goes with the old tab:** `DiffPane`'s `source` and `wrap` props, `paneOptions`' `wrap` parameter (and
    its test) and `changesShown` (and its tests) had the tab as their only user. The Diff surface renders exactly as
    before.

## Tasks

### Task 1: GitPatchCommand: the change set's unified patch
**Depends on:** none
**Files:** `pkg/gitinfo/patch.go`, `pkg/gitinfo/patch_test.go`, `pkg/wshrpc/wshrpctypes_git.go`, `pkg/wshrpc/wshserver/wshserver_git.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**What to build:** a git read that returns the unified patch of the working tree against a base, and the wshrpc
command that serves it (run `task generate` after adding the types). The diff is `ref` (or `HEAD` when `ref` is "")
against the working tree, `--relative` so paths match the rail's change list, with 3 lines of context, no color, no
external diff driver, `core.quotePath=false`, and `-w` when `ignorews` is set. Untracked files (the same `-uall`
listing `GetChanges` uses) follow as new-file entries in git's own form, which `parseUnifiedDiff` reads (it starts a
file only on the `diff --git` line): `diff --git a/<p> b/<p>`, `new file mode 100644`, `--- /dev/null`, `+++ b/<p>`,
then one `@@ -0,0 +1,N @@` hunk;
an untracked binary file emits git's `Binary files /dev/null and b/<path> differ` form. A repository with no commits
returns only its untracked entries, as `GetChanges` does for numstat. The whole output is capped at 2 MiB, cut at the
start of the first file that would cross it, with `truncated` set. Not a repository: `isrepo` false, no error. A
failed git read is an error naming the command and git's stderr (`describeGitError`).

**Interfaces:**
- Go: `gitinfo.GetPatch(ctx context.Context, cwd, ref string, ignoreWs bool) (*gitinfo.Patch, error)`, `Patch{Patch string; IsRepo bool; Truncated bool}`.
- wshrpc (in `GitCommands`): `GitPatchCommand(ctx, CommandGitPatchData) (*CommandGitPatchRtnData, error)`, wire name `"gitpatch"`.
  `CommandGitPatchData{Cwd string "cwd"; Ref string "ref,omitempty"; IgnoreWs bool "ignorews,omitempty"}`,
  `CommandGitPatchRtnData{Patch string "patch"; IsRepo bool "isrepo"; Truncated bool "truncated,omitempty"}`.
- TS: `RpcApi.GitPatchCommand(TabRpcClient, { cwd, ref, ignorews })`.

**Acceptance (Go tests on temp repos):**
- a modified file, an added-and-staged file, a deleted file and an untracked file each appear once, each under its
  own `diff --git a/<p> b/<p>` line, with paths relative to a subdirectory cwd when cwd is one
- an untracked file's entry has the `diff --git`, `new file mode`, `--- /dev/null` and `+++ b/<p>` lines and one
  `@@ -0,0 +1,N @@` hunk of N `+` lines
- a hunk whose edit sits more than 3 lines below a `func` line carries that line after the header's second `@@`
- with `ref` set to an older commit, a change committed since then is in the patch; with `ref` "" it is not
- a whitespace-only edit is in the patch without `ignorews` and has no hunk with it
- a binary file reads as git's `Binary files ... differ` line
- output over the cap stops at a file boundary with `truncated` true; under it `truncated` is false
- a non-repository cwd returns `isrepo` false and no error; a repo with no commits returns its untracked files

### Task 2: The tab's pure model: groups, file bodies, hunk labels, the hunk walk
**Depends on:** none
**Files:** `frontend/app/view/agents/workspacechangesmodel.ts`, `frontend/app/view/agents/workspacechangesmodel.test.ts`, `frontend/app/view/agents/unifieddiff.ts`, `frontend/app/view/agents/unifieddiff.test.ts`, `frontend/app/view/agents/agentsviewmodel.ts`

**What to build:** the pure half of the new tab in `workspacechangesmodel.ts` (beside the existing `changesView` and
`changesLine`, which stay as they are; `changesShown` stays until Task 3 removes it). From the rail's `GitChange[]`
and the parsed patch it returns what the tab draws: decision 6's groups, each file's display facts (decision 5's new
file rule, its open state from a per-file "toggled" flag) and its body per decisions 2 and 4, and decision 7's walk.
`parseUnifiedDiff` gains an optional `binary: true` on `EditFile` for a file whose patch says `Binary files ... differ`
(the transcript's renderers ignore it). A file's hunks are split from `EditFile.lines` at each `hunk` line.

**Interfaces** (names Task 3 and Task 4 use; shapes may gain fields, not lose these):

```ts
export type ChangesBody = "loading" | "hunks" | "binary" | "whitespace" | "toolarge" | "empty";
export interface ChangesHunk { label: string | null; newStart: number; rows: DiffLine[] } // label null: a new file's hunk
export interface ChangesFile { change: GitChange; name: string; letter: string; isNew: boolean; body: ChangesBody; hunks: ChangesHunk[] }
export interface ChangesGroup { dir: string; count: string; files: ChangesFile[] } // dir "" is the repo root
// patch null while the first read is pending
export function changesGroups(files: GitChange[], patch: EditFile[] | null, o: { truncated: boolean; ignoreWs: boolean }): ChangesGroup[];
export function fileOpen(f: ChangesFile, toggled: boolean): boolean;
export function hunkWalk(groups: ChangesGroup[]): { path: string; hunk: number }[]; // display order
export function stepHunk(at: number, total: number, dir: "next" | "previous"): number; // 1-based, 0 = none yet, wraps
```

**Acceptance (vitest):**
- root files come first with dir "", then one group per parent directory sorted by path, files by name; count reads
  "1 file" / "2 files"
- a hunk's label is the text after the second `@@` (`@@ -40,7 +41,11 @@ func Groups(bs []Bookmark)` → `func Groups(bs []Bookmark)`); with none it is `line 41`; a deleted file's (`@@ -1,5 +0,0 @@`) is `line 1`; a new file's hunk label is null
- `newStart` is the header's new-side start; a new file's rows all have sign `""` and their new-side numbers, so
  `DiffRow` draws them numbered with no tint
- status `A` and `?` are new (letter `A`, closed until toggled); `M` and `D` are open until toggled
- body: patch null → loading; hunks → hunks; binary flag → binary; no entry with `truncated` → toolarge (an empty
  patch `[]` with `truncated` gives every file toolarge, never loading); no entry or no hunks with `ignoreWs` →
  whitespace; otherwise empty
- the walk lists every hunk of every file in display order, collapsed files included; `stepHunk` goes 0 → 1 on next,
  0 → total on previous, and wraps at both ends
- `parseUnifiedDiff` marks a binary file and leaves every other file without the flag (its existing tests pass)

### Task 3: The new Changes tab
**Depends on:** Task 1 (calls `RpcApi.GitPatchCommand`), Task 2
**Files:** `frontend/app/view/agents/workspacechangestab.tsx`, `frontend/app/view/agents/workspacechangesstore.ts`, `frontend/app/view/agents/workspacechangesmodel.ts`, `frontend/app/view/agents/workspacechangesmodel.test.ts`, `frontend/app/view/agents/tooldetailbody.tsx`, `frontend/app/view/agents/diffpane.tsx`, `frontend/app/view/agents/diffoptions.ts`, `frontend/app/view/agents/diffoptions.test.ts`, `scripts/cdp/scenarios-workspace-changes.mjs`, `scripts/cdp/scenarios-workspace-pane.mjs`

**What to build:** the tab rebuilt to the Main board, with a new `workspacechangesstore.ts` holding the patch loader
and the per-agent atoms (decision 8). The loader calls `GitPatchCommand` with the rail's cwd and `ref`, the shared
`ignoreWsAtom` and an RPC timeout above the server's 10 s git timeout (the 5 s default would cut a slow read), parses
the patch with `parseUnifiedDiff` (whose `null` for an output with no file becomes `[]`, so an empty or wholly cut
patch never reads as a pending one), and drops a stale reply. The header row (44 px) holds the summary (`changesLine`:
"N files +A −D", then branch and scope dimmed; counts hidden when `lineCountsShown` is false), previous / counter /
next, Hide whitespace (`aria-pressed`), a divider and Open on Diff (unchanged target), all borderless and of one
style, titles "Previous change (⇧P)", "Next change (⇧N)", "Hide whitespace (⇧W)". Below it one scroll: folder labels
(sticky, 32 px), file blocks (bordered, 8 px radius, sticky 34 px header button: chevron, status letter, name,
"new file" while a new file is closed, +/− right-aligned, then an Open in Code icon button), and hunks drawn with the
transcript's `DiffRow` (export it from `tooldetailbody.tsx`; a new file's rows go through it with no sign, so they
carry no tint), each hunk after its label row (a dimmed `⋯` in the 42 px gutter, then the label). Bodies other than
hunks draw one quiet line: Binary file / Only whitespace changed / Too large to show here / No line changes; a
loading body draws skeleton lines. Clicking a header toggles the file (chevron turns 90°). The counter buttons step
the walk (`stepHunk`), open a collapsed target and scroll its hunk below the sticky headers. Export the step as
`stepChangesHunk(agentId: string, dir: "next" | "previous"): boolean` (false when the walk is empty), for Task 4's
keys. Decisions 9, 10 and 11 apply. Remove decision 12's dead code (grep each symbol across `frontend/` and
`scripts/` first) and `changesShown` with its tests.

Rewrite `scripts/cdp/scenarios-workspace-changes.mjs` to the new tab, keeping its arrange / teardown pattern. Its
fixture repo gets a root file, a file in a folder whose edit sits more than 3 lines under a function line, a second
hunk far down one file, a whitespace-only edit, a deleted file, an untracked new file, a modified tracked binary
file, and an untracked text file over 2 MiB whose path sorts after every other untracked path (so the cap cuts only
it: untracked entries follow the tracked diff). States the fixture cannot produce come from stubbing
`RpcApi.GitPatchCommand` on the page through a `/@fs` import of `frontend/app/store/wshclientapi.ts` (as
`scripts/cdp/transcript-fixture.mjs` imports a module), restored in the step and again in teardown. A rail reload
comes from editing a fixture file and bumping the block's `agent:lasteditts` meta (what `railReloadKey` watches). In `scripts/cdp/scenarios-workspace-pane.mjs`
the step "the Changes tab's diff wraps a long line…" asserts the same intent on the new rows (the long line wraps
inside its row, the number sits on its first visual row, the added tint and edge span every row, no sideways scroll),
without Monaco selectors.

**Acceptance (scenario `workspace-changes`, each a step):**
- the summary reads the rail's files and totals, and the blocks are the root file first, then each folder label with
  its count and its files by name; screenshot `workspace-changes-main.png` at the 600 px pane (the Main board)
- a hunk's label row shows the function line's text, and no row in the tab shows a raw `@@`
- diff rows carry `diff-line-added` / `diff-line-removed`, the gutter shows the new side's number (a removed line's old one)
- the untracked file's block is closed and reads "new file"; clicking its header opens it with untinted numbered rows;
  clicking a modified file's header closes it
- next from `0/N` moves the counter to `1/N` and scrolls the first hunk under the sticky headers; next on the hunk of a
  collapsed file opens it; previous from `1/N` wraps to `N/N`
- the binary file's block reads "Binary file"; the over-cap file's block reads "Too large to show here" while the
  files before it draw their hunks
- loading: with the stub delaying the reply, switching to agent B and back to A shows skeleton lines in the open
  bodies until the reply lands, then the hunks
- failure: with the stub rejecting, a re-read (Hide whitespace flipped) shows the band with the message and Retry above
  the file headers, which still draw; with the stub removed, Retry brings the hunks back and the band goes
- a rail reload (a fixture file edited, `agent:lasteditts` bumped) brings the edit's new line into its hunk with no
  skeleton sampled in any frame between
- a closed modified file and a counter at `2/N` are unchanged after another workspace tab is shown and the Changes tab
  comes back, and after agent B is focused and A again
- a modified file's Open in Code lands on the Code surface with that file open at its first hunk's new-side line; the
  deleted file's header has no Open in Code button
- Hide whitespace pressed: the whitespace-only file reads "Only whitespace changed" and N drops; pressed again, it returns
- setting `selected` to a lower file (through `updateWorkspaceTab`) scrolls its header into view, open
- Open on Diff lands on the Diff surface with the agent's scope; after the tab scrolls to another file the Diff surface
  still shows its own selection and pair
- a clean repo's tab reads "No changes"
- scenario `workspace-pane`: the long-line step passes on the new rows

### Task 4: Shift+N / Shift+P / Shift+W on the Changes tab
**Files:** `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `frontend/app/cockpit/footerhints.ts`, `frontend/app/cockpit/footerhints.test.ts`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios-workspace-changes.mjs`

**What to build:** three Agent-surface bindings, active while the focused agent shows Rendered and its workspace pane
is open (not collapsed) on the Changes tab, with focus outside an editable field and no modal: Shift+N and Shift+P call
`stepChangesHunk` (declining the key when it returns false), Shift+W flips `ignoreWsAtom`. Label them as the Diff
surface's are ("Next change", "Previous change", "Ignore whitespace"), group "Agent". The Diff surface's own bindings
stay unchanged; no other Agent binding uses these keys. The Agent footer (`SURFACE_HINTS.agent` in
`footerhints.ts`) gains one chip for the change step (`⇧N/⇧P`, "change"), shown only while those bindings are active.
Add the three to the Agent section of
`docs/keyboard-shortcuts.md`, scoped to the Changes tab. CDP `Input.dispatchKeyEvent` often never reaches the WebView
(it needs page focus), so the scenario step drives the keys the way the repo's other key steps do.

**Acceptance:**
- vitest (`bindings.test.ts`, beside its Diff Shift+W test): the three bindings are active with the Changes tab shown
  in an open pane of a Rendered agent, and inactive with another tab active, the pane collapsed, the Terminal view, an
  editable focus, or a modal open; Shift+N / Shift+P step the focused agent's counter and decline on an empty walk
- scenario `workspace-changes` step: Shift+N then Shift+N moves the counter to `2/N`, Shift+P back to `1/N`, Shift+W
  toggles Hide whitespace's pressed state; with another workspace tab shown, Shift+N leaves the counter where it was
- scenario `workspace-changes` step: the footer (`[data-hints-footer]`) shows the change chip while the Changes tab
  shows, and not while another workspace tab shows
