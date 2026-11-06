# Leftovers review fixes (F1-F21) Implementation Plan

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.
> The spec carries every design decision with its reason; read the spec section a task names before starting.

**Goal:** Fix the 21 findings of the 2026-11-06 leftovers review (graph peek, Profile principles editors, pet,
toasts, terminal block, palette notes).

**Architecture:** Eight independent slices by area. Go changes stay in their packages (graph bloom in
`jarvisattrib` + `wshserver_jarvis.go`, note revisions in `notestore`); frontend logic is extracted into pure
models with vitest beside them; each rendered change gets a step in the existing CDP scenario for its surface.
Tasks 2, 3 and 4 all add steps to `scripts/cdp/scenarios-brief.mjs`, so they run in that order; the rest run
beside them.

**Tech Stack:** Go, React 19 + jotai, xterm.js, vitest, CDP scenarios.

**Effort:** effort:fdea6d43-219b-4cf2-b4ce-51758338103b
**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\115f3492\docs\superpowers\specs\2026-11-06-leftovers-review-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/jarvisattrib ./pkg/storagereport ./pkg/notestore ./pkg/waveobj ./pkg/wshrpc/...`
**Check:** `go build ./... && go vet ./pkg/jarvisattrib ./pkg/storagereport ./pkg/notestore ./pkg/wshrpc/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs brief-contextual-map brief-profile jarvis-peek notification-toasts brief-act code-peek term-link-tooltip agent-tree-rail palette-notes surface-smoke`

## Global Constraints

- The review report is `C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\leftovers\report.md` (gitignored;
  shots beside it, named by the numbers the findings cite). Its line numbers are approximate; find code by
  symbol.
- Logic is extracted, not rendered: pure `foo.ts` + `foo.test.ts`, thin `.tsx`.
- Colors and spacing from the `@theme` tokens in `frontend/tailwindsetup.css` only; no new tokens.
- Every new scenario step runs at the width the finding was seen (1600x950 is the harness default; set
  1000x700 with `Emulation.setDeviceMetricsOverride` where the task says so, and restore it in the same step).
  Run your scenario yourself with `task verify:ui -- <scenario>` against your own dev app before completing.
- Lint/format only the files you touched; keep prettier off `scripts/*.mjs`.
- Never stop `wave-tauri.exe` / `wavesrv.x64.exe` by image name; never touch the user's packaged Arc or its
  store, except a `VACUUM INTO` copy for Task 1's measurement.
- Run 0432111d may land beside this run and edits `petview.tsx` (pet hidden under modals) and
  `wshserver_jarvis.go`: rebase onto it if it lands first and keep its behavior.

## Review Focus

- Graph: a record whose bloom fails, then succeeds on Retry, must replace `Couldn't load edges` with its edges
  (Task 4 store test).
- Profile: a draft dirty in both scopes, saved, where the project save fails after the global one landed: global
  reads saved, project stays dirty with its error in the footer (Task 2 test).
- Brief toast: two deletes pending, then an error toast: one `Undo 2` cancels both and neither commits (Task 5).
- Terminal: a wrapped path whose first row is itself a continuation (three rows) links as one range covering all
  three (Task 6 test).
- Notes: a note saved twice in one editor session (no conflict the second time) uses the rev the first save
  returned, not the opened one (Task 8 test).

---

### Task 1: Graph bloom: one run load per call, measured fix, readable node labels (F3 server, F15 labels)
**Depends on:** none
**Files:** `pkg/jarvisattrib/lifecycle.go`, `pkg/jarvisattrib/edgesfor_test.go`, `pkg/jarvisattrib/alledges_test.go`, `pkg/jarvisattrib/claims_test.go`, `pkg/jarvisattrib/liveprobe_test.go`, `pkg/wshrpc/wshserver/wshserver_jarvis.go`, `pkg/wshrpc/wshserver/wshserver_graph_test.go`, `pkg/storagereport/scan.go`

Spec: "F3" (server part) and "F15".

- [ ] `EdgesFor(ctx, v, dossierID)` returns `([]AttributedEdge, []*waveobj.Run, error)`: the runs it already
  loaded. Update both callers in `wshserver_jarvis.go` so neither loads runs twice: `ResolveDossierEdgesCommand`
  builds `byORef` from the returned runs and drops its own `DBGetAllObjsByType`; `ResolveFocusScopeCommand` loads
  runs up front for every kind today, so move that load into the non-task branches and have the `task` branch
  build `byORef` from the runs `EdgesFor` returns. Update the test callers.
- [ ] Add `TestLiveEdgesForStages` to `liveprobe_test.go` (build tag `liveprobe`): times each stage of one
  `EdgesFor` (runs load, `taskDossiers`, `claimedRuns`, `assembleEdges` incl. git ranges) cold and warm for 5
  records. Run it against a `VACUUM INTO` copy of `%LOCALAPPDATA%\dev.arc.app\data\db\waveterm.db` (vault root
  from that profile's `memory-vault-root.txt`) as the file's header describes. Record the numbers in your
  completion summary.
- [ ] Fix the stage that dominates after the single load, with the least machinery. If you add a cache, key it on
  data that changes with every write it depends on (runs: `SELECT count(*), sum(version) FROM db_run`), never a
  TTL, and test that a write invalidates it. Acceptance: warm call under 1 s on the copy; report before/after.
- [ ] Export `storagereport.RunTitle(ctx, run) string` (rename of `runTitle`, behavior unchanged; update its
  caller in `scan.go`).
- [ ] `nodeLabel`: a decision is labelled by frontmatter `summary`, then `title`, then id. `buildDossierGraph`
  labels a run `<RunTitle> · <first 8 chars of the run OID>`; it stays pure by taking titles from the caller
  (e.g. a `map[string]string` oref→title the handler fills with `storagereport.RunTitle` for the bloomed runs
  only).
- [ ] Tests in `wshserver_graph_test.go`: `TestNodeLabelDecisionSummary` (summary wins over title and id; id when
  neither), `TestBuildDossierGraphRunLabel` (`"Workflow scan · 21c7720e"` from a goal `"Workflow scan\nYou are…"`
  with no dag title; dag title wins when given). In `edgesfor_test.go`: `TestEdgesForReturnsRuns` (the runs
  returned are the ones the edges reference). Run
  `go test ./pkg/wshrpc/wshserver -run 'TestNodeLabel|TestBuildDossierGraph' && go test ./pkg/jarvisattrib -run 'TestEdgesFor'`.

### Task 2: Profile modal: blank rows, both drafts, discard confirm, identical customize, removed principles (F1, F2, F11, F12)
**Depends on:** none
**Files:** `frontend/app/view/jarvis/profilemodel.ts`, `frontend/app/view/jarvis/profilemodel.test.ts`, `frontend/app/view/jarvis/briefprofileview.tsx`, `frontend/app/view/jarvis/principleseditor.tsx`, `frontend/app/view/jarvis/globalprincipleseditor.tsx`, `scripts/cdp/scenarios-brief.mjs`

Spec: "Principles editors". All new logic is pure in `profilemodel.ts`:
- `normalizePrinciplePatch(patch: PrinciplePatch | undefined, global: Principle[]): PrinciplePatch | undefined`:
  drops replacements equal to the global text, then cleans. Used by `isDirty` callers (via the modal), by
  `principleSummary`'s rows, and on save.
- `blankPrinciples(projectRows: PrincipleRow[], global: Principle[] | null): { scope: "project" | "global"; index: number; id: string }[]`
  (1-based index as the editor numbers rows) and `blankMessage(...)` → `"Principle 3 is empty"`.
- `unsavedScopes(projectDirty: boolean, globalDirty: boolean): ("Project" | "Global")[]` and the footer copy
  `Unsaved changes · Project and Global`, `Discard unsaved changes to Project and Global?`.
- `principleNote` takes the global text and ignores a replacement equal to it.
- `removedPrincipleNotes(loaded: Principle[], draft: Principle[], projects: ProjectOverride[]): { id: string; text: string }[]`
  with the spec's `Removed "<text>" · disabled in X` / `· X uses its own wording` copy.
- `staleRowText(row: PrincipleRow): string` with the spec's two wordings (no raw id).
- `saveScopes(io: { global?: () => Promise<void>; project?: () => Promise<void> }): Promise<{ saved: ("global" | "project")[]; error?: { scope: "global" | "project"; message: string } }>`:
  runs global then project, stops at the first failure; the modal calls it with only the dirty scopes.

- [ ] Vitest in `profilemodel.test.ts` for each function above, including: Customize with unchanged text is not
  dirty and not counted as customized; a blank project addition and a whitespace-only replacement are both found
  with their row numbers; `unsavedScopes(true, true)` copy; a deleted global principle disabled by one project
  yields its note; a missing-disabled stale row never contains its id; `saveScopes` with global resolving and project rejecting
  reports `saved: ["global"]` and the project error, and a global failure never calls project.
- [ ] Modal (`briefprofileview.tsx`): footer shows save errors (no `Error: ` prefix) and the blank message, Save
  disabled while any row is blank; Save writes every dirty scope, global first, one toast, closes on full success;
  a failing scope stays dirty with its error. Cancel/Esc/backdrop with unsaved changes, and a chip switch with a
  dirty project draft, arm the footer confirm (`Keep editing` / `Discard`). Chip switch keeps the global draft.
  `error` clears on any edit and scope change. Blank rows get the error edge and `Empty: write it or delete it`
  in both editors.
- [ ] `brief-profile` scenario, new steps at 1600: (a) add a blank project principle → Save disabled, footer reads
  `Principle N is empty`, no `[data-jarvis-brief-modal-state="error"]` above the viewport; (b) edit a project
  principle, switch to Global → footer reads `Unsaved changes · Project`; Esc → discard confirm shows, `Keep
  editing` keeps the modal; (c) Customize without editing → summary has no `customized`, footer `No changes`;
  (d) global scope: delete a principle the fixture project disabled → its removed note shows; (e) with a
  project override written (RPC) that disables a principle id missing from the global set, the project scope
  shows `This project disabled a principle that was removed from the global set.` and the row text contains no
  raw id; (f) with a dirty project draft and a second fixture project, a chip click arms the discard confirm and
  `Discard` switches to the clicked project with a clean draft. Restore every
  profile the scenario wrote in teardown.
- [ ] Run `npx vitest run frontend/app/view/jarvis/profilemodel.test.ts`, then `task verify:ui -- brief-profile`.

### Task 3: Pet: workflow-scan Decide, honest count, row labels (F6, F9, F10)
**Depends on:** Task 2
**Files:** `frontend/app/view/jarvis/petacts.ts`, `frontend/app/view/jarvis/petacts.test.ts`, `frontend/app/view/jarvis/petpeekmodel.ts`, `frontend/app/view/jarvis/petpeekmodel.test.ts`, `frontend/app/view/jarvis/petpeek.tsx`, `frontend/app/cockpit/palette-needs.ts`, `frontend/app/cockpit/palette-needs.test.ts`, `scripts/cdp/scenarios-brief.mjs`

Spec: "Pet" F6, F9, F10. Runs after Task 2 (both edit `scenarios-brief.mjs`).

- [ ] Export one pure `workflowScanOref(item: { kind: string; oref?: string }): string | null` from
  `petacts.ts` (keeps petacts pure); `needsTarget` in `palette-needs.ts` and `actsForAttention` both use it.
  `actsForAttention` on a `workflow-scan` item with an oref returns an Open escort to that oref.
- [ ] `ROW_KIND_LABEL` + `ROW_DOT` entries per the spec; the peek header copy moves into a pure
  `peekTitle(n: number): string` in `petpeekmodel.ts` (`No runs or questions waiting`,
  `1 run or question waiting`, `3 runs or questions waiting`).
- [ ] Vitest: `petacts.test.ts` workflow-scan → `workflowscan:<id>` target; `palette-needs.test.ts` unchanged
  behavior; `petpeekmodel.test.ts` `rowKindLabel("workflow-scan")`, `rowKindLabel("run-unverified")`, `peekTitle`.
- [ ] `jarvis-peek` scenario: update the existing `Nothing waiting on you` assertions to the new copy; add steps at
  1600 with a busy queue holding a `workflow-scan` and a `run-unverified` item (use the
  `wave:dev-attention-items` localStorage hook, since `setAttention` is overwritten by the next poll; remove it
  in teardown): rows read `Workflow scan · …` and `Unverified · …` with a non-grey dot; the workflow-scan row's
  Decide/Open lands on Usage › Workflow, not a run sheet.
- [ ] Run `npx vitest run frontend/app/view/jarvis/petacts.test.ts frontend/app/view/jarvis/petpeekmodel.test.ts frontend/app/cockpit/palette-needs.test.ts`, then `task verify:ui -- jarvis-peek`.

### Task 4: Graph peek: bloom states, linked-only canvas, deduped edges, Shift+G close, find, labels (F3 client, F4, F7, F13, F14, F15 client)
**Depends on:** Task 1 (its decision and run labels are what the scenario asserts), Task 2, Task 3
**Files:** `frontend/app/view/jarvis/jarvisgraphstore.ts`, `frontend/app/view/jarvis/jarvisgraphstore.test.ts`, `frontend/app/view/jarvis/jarvisgraphderive.ts`, `frontend/app/view/jarvis/jarvisgraphderive.test.ts`, `frontend/app/view/jarvis/graphpeek.tsx`, `frontend/app/view/jarvis/jarvisgraph.tsx`, `frontend/app/view/jarvis/jarvisstore.ts`, `frontend/app/view/jarvis/briefsurface.tsx`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `scripts/cdp/scenarios-brief.mjs`

Spec: "Graph peek" F3 (client), F4, F7, F13, F14, F15. Waits on Tasks 2 and 3 because all three edit
`scenarios-brief.mjs`.

- [ ] Store: `BLOOM_RPC_TIMEOUT_MS = 15000` for `ResolveDossierEdgesCommand`; `graphBloomStatusAtom:
  Map<string, "loading" | "failed">`; `focusDossier` sets loading, writes the bloom with a functional setter
  (latest map), sets failed on error and logs it (`console.warn` with the dossier id); `retryBloom(id)`.
  Tests in `jarvisgraphstore.test.ts`: two overlapping focuses both land in the map; a rejected call leaves
  status `failed` and no bloom; retry after failure lands the bloom and clears the status.
- [ ] Derive: `mergeGraph` dedupes wikilinks by unordered pair; `visibleGraph(merged, selectedId)` returns the
  nodes with a link plus the selected node, and the links among them; `presentKinds(nodes)`;
  `nodeTitle(label)` = first line through `truncateTitle`; `matchNodes(nodes, q)` matches on `nodeTitle`. Tests:
  A→B + B→A gives one link; an isolated node is hidden unless selected; a query found only past the title line
  does not match.
- [ ] Canvas (`jarvisgraph.tsx`) draws `visibleGraph`, the legend lists `presentKinds`; the empty copy from the
  spec when nothing is linked or selected. Header: `<shown> of <total> nodes` when some are hidden.
- [ ] Panel (`graphpeek.tsx`): Edges shows `Loading edges…` / `Couldn't load edges` + Retry / the empty line only
  for a landed empty bloom; rows keyed by `linkKey`, each a button selecting the other node; `Open` section only
  when it has an action; a pick from the match list shows the selected node with `Back to N matches`.
- [ ] `closeGraphPeek()` and `toggleGraphPeek()` in `jarvisstore.ts`; the Shift+G binding calls the toggle,
  `briefsurface.tsx`'s close uses `closeGraphPeek`. `bindings.test.ts`: Shift+G closing clears
  `briefGraphRecordAtom`.
- [ ] `brief-contextual-map` scenario, new steps at 1600 (keep the existing `\d+ nodes` check passing): open from a
  record with runs → Edges shows `Loading edges…` or its run rows, never `No edge reaches this node` (hold the
  RPC with `holdRpc` to see the loading state, then a failed one shows Retry); a decision fixture linked both
  ways lists one edge row, labelled by its summary; clicking an edge row selects the neighbour; Find with a
  query, pick a match → the selected-node panel shows; Shift+G close then Shift+G open → no record selected.
  F4 step at 1600: with the fixture vault holding isolated records, the header reads `<shown> of <total> nodes`
  with shown < total, an isolated record is not drawn, and picking it from Find draws it on the canvas (read the
  canvas's node data through the graph's dev hook or `graphSelectedIdAtom` plus the drawn set from
  `visibleGraph`). One step at 1000x700: the legend lists only present kinds.
- [ ] Run `npx vitest run frontend/app/view/jarvis/jarvisgraphstore.test.ts frontend/app/view/jarvis/jarvisgraphderive.test.ts frontend/app/store/keybindings/bindings.test.ts`, then `task verify:ui -- brief-contextual-map`.

### Task 5: Toasts: clear of the bubble, Brief error styled and bounded, error lifetime, pending-delete Undo (F8, F17, F19)
**Depends on:** none
**Files:** `frontend/app/cockpit/toaststack.ts`, `frontend/app/cockpit/toaststack.test.ts`, `frontend/app/cockpit/notificationstore.ts`, `frontend/app/cockpit/notificationtoasts.tsx`, `frontend/app/view/jarvis/brieftoast.tsx`, `frontend/app/view/jarvis/briefundo.ts`, `frontend/app/view/jarvis/briefundo.test.ts`, `frontend/app/view/jarvis/petbubble.tsx`, `frontend/app/view/jarvis/petstore.ts`, `scripts/cdp/scenarios-cockpit.mjs`

Spec: "Toasts".

- [ ] `toaststack.ts` (new, pure; imports types only, so the avatar reach is passed in rather than importing
  `petview.tsx`): `toastStackBottom(corner: PetCorner, bubbleHeight: number | null, avatarReach: number): number`
  (bottom-right: `avatarReach + STACK_GAP_PX`, plus `10 + bubbleHeight` while a bubble shows;
  bottom-left: footer + gap) and `ERROR_TOAST_TTL_MS = 12000`. Tests for both corners with and without a bubble.
- [ ] `petstore.ts`: `petBubbleHeightAtom: number | null`; `petbubble.tsx` writes its rendered height
  (ResizeObserver) and null on unmount. `notificationtoasts.tsx` uses `toastStackBottom`; exports its level map
  (`TOAST_LEVEL`) for the Brief toast. `pushToast` keeps an error toast `ERROR_TOAST_TTL_MS`.
- [ ] `briefundo.ts`: `BriefToast` gains `pendingUndo?: { count: number; undo: () => void }`; every toast shown
  while a delete is pending carries it, and the toast stays until the last pending delete commits or is undone;
  an error toast lives `ERROR_TOAST_TTL_MS`. Tests in `briefundo.test.ts`: schedule, then `error` → the error
  toast carries `pendingUndo.count === 1` and calling it cancels the commit; two schedules then `notify` with its
  own undo → both undos present, `count === 2`; two schedules then `error` → `pendingUndo` cancels both and
  neither commit runs; the toast clears only after the last pending delete commits.
- [ ] `brieftoast.tsx`: error uses `TOAST_LEVEL.error` icon + edge; `max-w-[min(560px,90%)]`, wraps; renders
  `Undo` / `Undo N` for `pendingUndo` beside its own Undo.
- [ ] `notification-toasts` scenario, new steps at 1000x700 and 1600x950: with a pet bubble shown
  (`petBubbleAtom` via the dev store hook) and toasts pushed, no toast rect intersects the bubble rect; on the
  Brief, `briefUndo.error(<150-char text>)` renders an icon with `aria-label="Error"`, wraps, and its width is at
  most 560 px; an error toast is still present after 7 s; F19: schedule two deletes through `briefUndo.schedule`
  with no-op commits that record a call, then `briefUndo.error("…")` → the toast shows `Undo 2`; clicking it
  hides the toast and neither commit has run after the undo window. Keep `brief-act`'s toast steps passing.
- [ ] Run `npx vitest run frontend/app/cockpit/toaststack.test.ts frontend/app/view/jarvis/briefundo.test.ts`, then `task verify:ui -- notification-toasts brief-act`.

### Task 6: Terminal links: wrapped paths, prompts and folders, one hint grammar (F5, F16, F18)
**Depends on:** none
**Files:** `frontend/app/view/term/termfilelinks.ts`, `frontend/app/view/term/termfilelinks.test.ts`, `frontend/app/view/term/termwrap.ts`, `frontend/app/view/term/term-tooltip.tsx`, `frontend/app/view/code/codepeekhost.tsx`, `frontend/app/view/code/codepeekmodel.ts`, `frontend/app/view/code/codepeekmodel.test.ts`, `frontend/app/view/code/codepeekstore.ts`, `frontend/app/view/code/codepeekstore.test.ts`, `frontend/app/view/code/codepeekcard.tsx`, `scripts/cdp/scenarios-codepeek.mjs`, `scripts/cdp/scenarios-agent.mjs`

Spec: "Terminal block".

- [ ] `termfilelinks.ts` (pure): `findWrappedFileLinks(rows: { text: string; cells: number[] }[], target: number): { match: FileLinkMatch; range: { start: { x: number; y: number }; end: { x: number; y: number } } }[]`
  where `rows` is the logical line's buffer rows (string plus each char's starting cell) and `target` the row the
  provider was asked for; returns the matches that touch `target`, with 1-based multi-row ranges.
  `findFileLinks` skips a prompt cwd (`PS <path>>`, `<user>@<host>:<path>$`/`#` at row start) and a rooted
  extensionless path on an HTTP-log row. Tests: `…/IdeaProjects/wa` + `veterm/frontend/app/view/jarvis/briefsurface.tsx`
  wrapped at 40 cols gives one link `…/waveterm/frontend/…` with a two-row range from either row; a three-row
  path; a wide character before the path maps by cell; `PS C:\Users\x\repo>` gives no link; `GET /api/sessions/10/turn 200`
  gives no link; `src/a.ts:12:3` still links.
- [ ] `termwrap.ts` builds the logical line from `isWrapped` rows (untrimmed text for every row but the last) and
  calls `findWrappedFileLinks`. The file hint also shows on plain hover after `HoverDelayMs`: export that
  constant from `term-tooltip.tsx` (it is private today) and use it, never a second 600.
- [ ] One hint content in `term-tooltip.tsx` (`<Kbd>{modKey}</Kbd> + click to {verb}`), used by the URL tooltip
  (`open link`) and `codepeekhost.tsx` (`peek`).
- [ ] Peek: `PeekFile` gains `{ kind: "folder"; open: PeekOpen }`; `loadFile` returns it when `FileInfo.isdir`;
  the card reads `Folder` with `Open folder in Code`. Tests in `codepeekstore.test.ts` (isdir → folder) and
  `codepeekmodel.test.ts` (modes disabled for folder).
- [ ] `code-peek` scenario, new steps at 1600: a path printed long enough to wrap → Ctrl+click on its second row
  peeks the right file (not `No such file`); a printed `PS <repo dir>>` row yields no link; Ctrl+click a printed
  folder path → card reads `Folder`. The existing plain-hover check (`without Ctrl there is no hint…`, sampled
  400 ms in) stays true: it samples before the delay. Add a step after it: plain hover held 800 ms shows the
  hint (`[data-peek-hint]`) with still no underline and no recolor. Update the held-hint check's expected text if
  the wording changes. `term-link-tooltip`: update the expected text to the new
  hint and assert the `<kbd>` chip.
- [ ] Run `npx vitest run frontend/app/view/term/termfilelinks.test.ts frontend/app/view/code/codepeekstore.test.ts frontend/app/view/code/codepeekmodel.test.ts`, then `task verify:ui -- code-peek term-link-tooltip`.

### Task 7: Avatar bottom-left: the Agent tree makes room (F20)
**Depends on:** Task 6
**Files:** `frontend/app/view/jarvis/petview.tsx`, `frontend/app/view/agents/agenttree.tsx`, `scripts/cdp/scenarios-agent.mjs`

Spec: "F20". Waits on Task 6 only because both edit `scenarios-agent.mjs`.

- [ ] `agenttree.tsx`: the tree's scroll list gets `paddingBottom: AVATAR_SURFACE_REACH_PX + 20` while
  `petCornerAtom` is `bottom-left` (the Brief/Usage pattern), none otherwise.
- [ ] `petview.tsx`: correct the corner comment (bottom-left sits over the bottom of the Agent tree; the tree
  makes room). Comment only; keep run 0432111d's modal behavior if it has landed.
- [ ] `agent-tree-rail` scenario, new step at 1600: set the corner to bottom-left (restore in teardown), scroll the
  tree to its end → the last row's rect does not intersect the avatar's (`[aria-label="Jarvis condition"]`).
- [ ] Run `task verify:ui -- agent-tree-rail`.

### Task 8: Notes: refuse a save over a note changed since it was opened (F21)
**Depends on:** none
**Files:** `pkg/notestore/notestore.go`, `pkg/notestore/notestore_test.go`, `pkg/waveobj/wtype.go`, `pkg/wshrpc/wshrpctypes_note.go`, `pkg/wshrpc/wshserver/wshserver_note.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `frontend/app/cockpit/palette-notes.ts`, `frontend/app/cockpit/palette-notes.test.ts`, `frontend/app/cockpit/palette-notesstore.ts`, `frontend/app/cockpit/palette-notesstore.test.ts`, `frontend/app/cockpit/use-note-editor.ts`, `frontend/app/cockpit/palette-notesview.tsx`, `scripts/cdp/scenarios-palette.mjs`

Spec: "Palette notes".

- [ ] Go: `UserNote.Rev string` (`json:"rev,omitempty"`), the first 12 hex chars of sha256 of the file bytes,
  set by `List` and `Add`; `CommandNoteUpdateData.BaseRev string` (`json:"baserev,omitempty"`);
  `notestore.Update(id, title, body, baseRev string) (string, error)` returns the new rev, and returns an error
  wrapping exported `ErrNoteConflict` when `baseRev != ""` and differs from the current file's rev.
  `NoteUpdateCommand` returns the new rev (change its return to `(*waveobj.UserNote, error)` or a small rtn
  struct; your call, one shape). Then `task generate`.
- [ ] Go tests: `TestUpdateRefusesStaleRev` (write the file behind the store, update with the old rev → `errors.Is(err, ErrNoteConflict)`, file unchanged), `TestUpdateEmptyBaseRevOverwrites`, `TestListSetsRev`.
- [ ] Frontend: `NoteDraft` gains `rev`; `saveNoteDraft` sends `baserev` and stores the returned rev on the draft;
  a conflict is recognised by the error text containing `changed since it was opened` (pure
  `isNoteConflict(err): boolean`); the editor keeps the draft and arms `Changed elsewhere since you opened it ·
  Ctrl+Enter again to overwrite`; the second Ctrl+Enter saves with no `baserev`. Tests for `isNoteConflict`, the
  arm/fire transition, and the second save in a session using the returned rev.
- [ ] `palette-notes` scenario, new step at 1600: open a note in the editor, rewrite it behind the editor with
  `NoteUpdateCommand` (no baserev), edit and Ctrl+Enter → the conflict line shows and the note keeps the outside
  text; Ctrl+Enter again → the editor's text is saved.
- [ ] Run `go test ./pkg/notestore -run 'TestUpdate|TestListSetsRev'`, `npx vitest run frontend/app/cockpit/palette-notes.test.ts frontend/app/cockpit/palette-notesstore.test.ts`, then `task verify:ui -- palette-notes`.
