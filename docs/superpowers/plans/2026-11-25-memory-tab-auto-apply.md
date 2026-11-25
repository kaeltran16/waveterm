# Memory tab: Arc applies the routine, the tab asks only the big ones

**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\e21dcb40\docs\superpowers\specs\2026-11-23-memory-tab-usability-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/memhygiene ./pkg/jarvisvolunteer ./pkg/wshrpc/... ./cmd/wsh/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/memhygiene ./pkg/jarvisvolunteer ./pkg/wshrpc/... ./cmd/wsh/...`
**Final:** `node scripts/cdp/final-verify.mjs setup-memory`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\memory-tab-redesign\project\FlowAuto.dc.html

The copy on every row, line and stop state is the prototype's boards (`FlowAuto`, `AutoAll`, `AutoApplying`,
`AutoChanged`, `AutoNewer`, `AutoFailed`, `AutoApplied`, `AutoUndoRefused`, `AutoCleanup`, `AutoDigest`,
`AutoEmpty` in the Prototype's folder); copy it with the project, repo and count values filled in.

## Decisions beyond the spec

- **Routine = `trim`, `delete`, `merge`, `add-to-index`, in any group.** The judge only runs on a folder the
  project owns (its own, or its split's own folder), so these kinds never touch a shared memory or a checked-in
  file. `move-here`, `copy-here`, `remove-shared`, `settings` and `move-to-doc` always wait for the user.
  Why: it is exactly the spec's list, and the existing kinds already separate the anti-goals.
- **Auto-apply runs in the check's goroutine, right after a successful check stores** (`entryRun`), over every
  open routine change in the project's state, not only the ones that check proposed. Why: the 260 changes
  waiting since Nov 3 apply at each project's next check with no migration step.
- **A routine change whose apply errors (not a conflict) stays open, is recorded as skipped with its error,
  and the rest still apply.** A conflict is recorded as skipped with no error and left as the next check's
  (the existing conflict status, which `checkMerge` replaces). Why: one bad file must not block a project's
  tidy, and an error must not vanish.
- **A routine change whose files an earlier change in the same auto-apply already wrote is skipped with its
  own reason (`overlap`)**, not tried and not read as "changed after the check": it is marked `conflict` so the
  next check judges the memory as it now is. The line reads e.g. "1 trim skipped: another change Arc made
  touched its memory". Why: two proposals on one memory (a trim and a merge naming it) can't both apply, and
  blaming the user's edit would be false.
- **Every apply the new paths make is recorded as a batch** (`MemBatch` on the project state): one per
  routine auto-apply, one per project's split (created at its first Apply, extended by each resumed Apply,
  adopting shared changes applied one at a time before this change), one per cleanup Apply, one per move into
  a repo doc. "Arc did this week" and every Undo address batches. Why: one source of truth for what was
  applied together; changes from several checks can't otherwise be grouped per apply.
- **A batch's `at` is its last apply; a line shows while `at` is within 7 days** (the check interval), newest
  first across projects. A split batch shows only once its switch-over applied. A batch is dropped from the
  state once none of its changes is still applied (undone, or gone when `checkMerge` drops an applied change
  whose backup expired). Why: "this week" matches the weekly check, so each check's line lasts until the next.
- **An undone routine change becomes `kept`, not `open`**, through `entryUndo` (so `wsh memory decide undo`
  agrees). An undone split, cleanup or doc change becomes `open`, so its row waits again. Why: an open routine
  change would be re-applied by the next check, undoing the user's Undo.
- **Leave out / Bring back are the existing `keep` / `reopen` verdicts** on a shared-group move/copy (or a
  `remove-shared`). The switch-over gate (`OpenSharedChanges`) already ignores kept changes. Keep sharing is
  `keep` on the settings change; Keep them (cleanup) is `keep` on each of its open changes; Keep on a doc move
  is `keep`. Why: no new state for a choice the change status already records.
- **Counts on a split row are memories** (the sum of each change's `op.memories`), its full list is one entry
  per change (memories on one index line move together). "Stay" is the shared folder's memory count
  (`memories`) minus those coming over; a left-out memory moves from "come over" to "stay". Why: the
  prototype's 91 + 86 = 177 is the shared folder's memory count; a change is the unit apply can act on.
- **Split Apply is one synchronous RPC that applies change by change, each in its own `Update`**, so every
  step publishes `memhygiene:update`; the tab shows "Bringing over N of M" from the applied counts it re-lists
  while its call is in flight. The RPC gets a long timeout (minutes), and a cancelled context stops it between
  changes (the "N of M here" state). One row Apply per project at a time; a second is refused. Why: errors come
  back on the call, so nothing is stored for them ("a stopped Apply stores no error"), and no background job
  is needed for file copies that take seconds.
- **Stop states:** *changed* is derived from stored `conflict` statuses on the split's shared changes, so it
  survives a restart; *newer* and *failed* come only from the last Apply's result, held in a module atom.
  *Newer* = memory files in the shared folder with no entry in the state's `sort`. The switch-over gate in
  `entryApply` also refuses on newer memories, so the CLI can't switch past them either.
- **Undo refusal is computed in `List`** (`undoblock` on a split batch) and enforced by the undo itself, with
  one shared function: a split is blocked by any applied `remove-shared` in a cleanup batch of any registered
  project, on the same shared folder, that names a memory the split's applied `copy-here` changes name.
- **Cleanup never proposes or applies a left-out memory:** `checkRemoveShared` skips index-line groups with a
  member left out (kept move/copy) in any project's state for that folder, and the cleanup Apply re-checks
  the same rule at apply time (an older proposal can predate the leave-out) and marks such a proposal `kept`,
  since the user already kept that memory. A cleanup row and `Waiting` count only `open` removals; a removal
  found changed on disk is the next check's, as a routine conflict is. Why: otherwise `checkMerge` keeps the old
  open proposal (its files are unchanged) and the row never clears.
- **A split batch undoes only as a whole.** `UndoMemoryBatchCommand` refuses a `ChangeId` on a split batch.
  Why: undoing one move of a switched split puts that memory back in a shared folder the project no longer
  loads.
- **Keys:** `j`/`k` (and arrows) move focus through waiting rows then "Arc did" lines; `Enter` opens or closes
  the focused one; `Esc` closes the opened one; `a` runs the opened row's apply button, `x` its keep button,
  `u` the focused line's Undo. Each does nothing while its button is disabled.
- **Motion:** a row or line opening is moment 6b (`PaneReveal`); a waiting row leaving for "Arc did this week"
  on apply is moment 17 (`layoutId` morph) with moment 2 reflow; the "Waiting for you · N" count is moment 12
  (`TickNumber`); the progress line is moment 11 (`barFillClass`); an Undo refusal or stop is moment 13
  (`errorNudge`).
- **See changes lists each change's kind and title with its own Undo; evidence and diffs are not opened.**
  Why: the digest is for scanning and reversing; `wsh memory show` still has the diff.
- **Not built:** a place to reopen a kept-sharing project (it leaves the page; `wsh memory decide reopen`
  still does it), and any change to the `wsh memory` CLI beyond what `entryUndo`/`entryApply` change under it.
  Why: the prototype has no place for either, and both are YAGNI until asked.
- **`batches` is `omitempty`** on the wire (optional in TS; `List` and the tab treat absent as empty). Why:
  a required field would break every TS fixture that builds a `MemHygieneProject` for no behavior.
- **The Jarvis volunteer counts what waits** (the same row rule as the tab, in Go), not pending changes.
  Why: after auto-apply, pending routine changes are conflicts left for the next check, not decisions.

### Task 1: Wire contract for batches, row apply and batch undo
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_memhygiene.go`, `pkg/wshrpc/wshserver/wshserver_memhygiene.go`, `pkg/wshrpc/wshserver/snapshotguard_test.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/memhygiene/store_test.go`

**What to build:** the types and the two new commands every other task builds on, then `task generate`. The
server handlers refuse under a snapshot store (they write the real memory folders and repo settings, as
apply/undo do today) and otherwise return an error saying the command is not built yet; Tasks 2 and 3 replace
that line.

**Interfaces:**

```go
// on MemHygieneProject
Batches []MemBatch `json:"batches,omitempty"` // newest first

const (
	MemBatch_Routine = "routine"; MemBatch_Split = "split"; MemBatch_Cleanup = "cleanup"; MemBatch_Doc = "doc"
	MemRow_Split = "split"; MemRow_Cleanup = "cleanup"; MemRow_Doc = "doc"
	MemStop_Changed = "changed"; MemStop_Newer = "newer"; MemStop_Failed = "failed"
	MemSkip_Changed = "changed"; MemSkip_Overlap = "overlap"; MemSkip_Failed = "failed"
)

type MemBatch struct {
	Id          string        `json:"id"`
	Kind        string        `json:"kind"`        // MemBatch_*
	At          int64         `json:"at"`          // unix ms of its last apply
	ChangeIds   []string      `json:"changeids"`   // apply order
	Skipped     []MemSkip     `json:"skipped"`     // routine only
	IndexBefore MemIndexStats `json:"indexbefore"` // routine only: the index its changes edit
	IndexAfter  MemIndexStats `json:"indexafter"`
	UndoBlock   *MemUndoBlock `json:"undoblock,omitempty"` // filled by List, never stored
}
type MemSkip struct {
	ChangeId string `json:"changeid"`; Kind string `json:"kind"`; Title string `json:"title"`
	Reason   string `json:"reason"` // MemSkip_*
	Error    string `json:"error"`  // the apply's error, for MemSkip_Failed only
}
type MemUndoBlock struct { // the cleanup batch that must be undone first
	Project string `json:"project"`; BatchId string `json:"batchid"`; At int64 `json:"at"`; Memories int `json:"memories"`
}

ApplyMemoryRowCommand(ctx, CommandApplyMemoryRowData) (*MemRowResult, error)
type CommandApplyMemoryRowData struct { Project, Row, ChangeId string } // json: project, row, changeid (doc only)
type MemRowResult struct {
	Project MemHygieneProject `json:"project"`
	Stop    string `json:"stop"` // "" = done, else MemStop_*
	Here    int    `json:"here"`; Total int `json:"total"` // memories brought over / to bring (not left out)
	Changed int    `json:"changed"`; Newer int `json:"newer"` // memories
	Failed  string `json:"failed"`; Error string `json:"error"` // the change title that failed and why
}

UndoMemoryBatchCommand(ctx, CommandUndoMemoryBatchData) (*MemHygieneProject, error)
type CommandUndoMemoryBatchData struct { Project, BatchId, ChangeId string } // ChangeId "" = the whole batch
```

**Acceptance:**
- `task generate` output is committed and `ApplyMemoryRowCommand` / `UndoMemoryBatchCommand` exist in
  `wshclientapi.ts` and `wshclient.go`.
- Under a snapshot store both commands are refused with the snapshot refusal and the state dir is untouched
  (cases join `snapshotguard_test.go`).
- A stored state with `batches` round-trips through `ListMemoryHygieneCommand` unchanged.

### Task 2: Arc applies routine changes after each check, with batch Undo
**Depends on:** Task 1
**Files:** `pkg/memhygiene/auto.go`, `pkg/memhygiene/auto_test.go`, `pkg/memhygiene/entry.go`, `pkg/memhygiene/check.go`, `pkg/memhygiene/check_test.go`, `pkg/memhygiene/helpers_test.go`, `pkg/wshrpc/wshserver/wshserver_memhygiene.go`, `pkg/wshrpc/wshserver/snapshotguard_test.go`

**What to build:** after a successful check stores, Arc applies every open routine change in the project
(see Decisions) inside one `Update` and records one `routine` batch: the applied ids in order, the skips, and
the stats of the index those changes edit (the own folder's during an unswitched split, else `Folder`) before
and after. Nothing applied → no batch. `UndoMemoryBatchCommand` is built here for every batch kind: a whole
batch undoes in reverse apply order and stops at the first change that can't be undone; the state records
every undo that happened even when a later one fails, and the error says how many were undone and which change
stopped it and why. A `ChangeId` undoes one change of a routine, cleanup or doc batch and is refused on a
split batch. A routine change undone becomes `kept` (in `entryUndo`); other kinds become `open`.
Batches with no applied change left are dropped on undo and when a check stores.

**Interfaces:** `routineKind(kind string) bool`; `recordBatch(st *State, b wshrpc.MemBatch)` (adds or
replaces by id, newest first); `UndoBatch(project, batchID, changeID string) (*wshrpc.MemHygieneProject, error)`.
Task 3 uses all three.

**Acceptance:**
- A check that ends with open trim/delete/merge/add-to-index changes leaves them `applied` and one routine
  batch holding them; `move-here`, `copy-here`, `remove-shared`, `settings` and `move-to-doc` stay `open`.
- A routine change whose memory changed on disk is `conflict`, skipped with reason `changed`; one whose apply
  errors stays `open` and is skipped with reason `failed` and that error; the others still apply.
- A trim and a merge naming the same memory: the first applies, the second is `conflict` and skipped with
  reason `overlap`.
- An undo with a `ChangeId` on a split batch is refused and changes nothing.
- A failed check auto-applies nothing.
- Undoing a whole routine batch restores the files and leaves its changes `kept`; the next auto-apply does not
  re-apply them. Undoing one change of a batch leaves the rest applied and the batch listed.
- A whole-batch undo that hits a change it can't undo returns an error naming it and the count undone, and the
  changes undone before it read `open`/`kept` in the stored state.
- A batch whose changes are all undone is gone from the state.

### Task 3: Split, cleanup and doc rows apply as one decision
**Files:** `pkg/memhygiene/rows.go`, `pkg/memhygiene/rows_test.go`, `pkg/memhygiene/entry.go`, `pkg/memhygiene/check.go`, `pkg/memhygiene/check_test.go`, `pkg/memhygiene/split.go`, `pkg/memhygiene/split_test.go`, `pkg/memhygiene/helpers_test.go`, `pkg/memhygiene/store.go`, `pkg/memhygiene/store_test.go`, `pkg/wshrpc/wshserver/wshserver_memhygiene.go`, `pkg/jarvisvolunteer/memhygiene.go`, `pkg/jarvisvolunteer/memhygiene_test.go`

**What to build:** `ApplyMemoryRowCommand`.
- *split*: brings over every open shared-group move/copy not left out, each in its own `Update`, into the
  project's split batch (adopting shared changes already applied), then switches over by applying the settings
  change. It stops before switching when any shared change is `conflict` (`changed`, with the count), when the
  shared folder holds memories with no sort entry (`newer`, with the count), or when an apply fails (`failed`,
  naming the change and the error); a cancelled context stops it between changes with no stop reason.
  `Here`/`Total` count memories.
- *cleanup*: applies each open `remove-shared` into one cleanup batch, marking `kept` one whose memory any
  project left out of its split, skipping a conflict, stopping on a failure.
- *doc*: applies the named `move-to-doc` change into a one-change doc batch.
- The settings gate in `entryApply` also refuses while newer memories exist.
- `checkRemoveShared` never proposes a group with a member any project left out of its split.
- `List` fills `undoblock` on a split batch (Decisions), and `UndoBatch` refuses a blocked split batch with an
  error naming the cleanup.
- `Waiting(p wshrpc.MemHygieneProject) int`: one per pending split not kept sharing, one per project with
  `remove-shared` changes whose status is `open`, one per open `move-to-doc`, one when `lasterror` is set; the Jarvis volunteer's
  candidate counts and titles by it, and emits nothing when it is 0.

**Acceptance:**
- A split Apply over fixture folders moves/copies every not-left-out memory, then writes `autoMemoryDirectory`;
  the result has an empty stop and `Here == Total`; the project has one split batch holding every change.
- A memory file edited after the check: the rest come over, stop `changed` with its count, settings untouched;
  after a fresh check the next Apply finishes and switches.
- A memory file written to the shared folder after the check: stop `newer` with count 1, settings untouched;
  a direct `apply` verdict on the settings change is refused too.
- A failing copy: stop `failed` naming it with the error, the ones before it stay applied, nothing is stored
  for the error; Apply again resumes.
- A left-out memory stays in the shared folder after the split, is not counted in `Total`, and a later
  cleanup check proposes no removal of it; a cleanup Apply leaves an older open removal of it unapplied and
  `kept`, and after that Clear `Waiting` is 0 for the project.
- Undoing an applied split batch restores the settings and every moved/copied file and reopens the changes;
  with a cleanup batch that removed a memory the split copied, the undo is refused with the cleanup named, and
  `List` shows that cleanup in the batch's `undoblock`.
- A second row Apply on the same project while one runs is refused.
- `Waiting` and the volunteer agree on a table of project states (split, kept sharing, cleanup, doc, failed,
  only routine conflicts left → 0).

### Task 4: The page's model and store
**Depends on:** Task 1 (the generated MemBatch, MemRowResult types and the two new RPC client calls)
**Files:** `frontend/app/view/agents/memorymodel.ts`, `frontend/app/view/agents/memorymodel.test.ts`, `frontend/app/view/agents/memorystore.ts`, `frontend/app/view/agents/memorystore.test.ts`

**What to build:** the pure derivations and RPC actions the one-page tab renders, beside the old ones (Task 5
removes the old exports once nothing imports them; this task keeps every export `setupmemory.tsx`,
`bindings.ts` and `openref.ts` import today).
- Waiting rows in order splits, cleanups, doc moves, failed checks, each with the prototype's chip, title and
  sub-line, built by the same rule as Task 3's `Waiting` (comments mirror each other). The routine kinds are a
  constant mirroring `routineKind`.
- A split row's counts (come over, move, copy, stay, left out, here, total, changed), its four spot-check
  changes, its full list grouped Move here / Copy here, and its state: open, applying (with
  "Bringing over N of M"), partial ("N of M here"), changed, newer, failed, with the board's text.
- A cleanup row from its `open` removals only (its count, who took them and when, which projects still load the shared memory, its list).
- "Arc did this week" lines across projects (Decisions: 7-day window, newest first, split only once switched),
  each with when, counts by kind of changes still applied, skips by kind and reason (changed, overlap, failed), and for a split its came-over and
  left-out counts; a line's digest (each change, the index after/before text, "Undo all N"); the undo-refusal
  text from `undoblock`.
- The toolbar status ("N waiting for you", with " · N check failed" when any; "Nothing waits for you") and the
  empty text with the next check's day.
- Store: the opened row and focused item, the in-flight row Apply, the last `MemRowResult` per project, and
  actions `applyMemoryRow`, `undoMemoryBatch`, leave out / bring back, and keep for a row; the Apply passes a
  timeout of minutes, never the 5 s default; every failure lands in the existing error atom with context.

**Interfaces:** row key format, used by Task 5's `data-memory-row` and Task 6's selectors:
`<kind>/<project>` for split, cleanup and failed rows, `doc/<project>/<changeId>` for a doc move; line key
`<project>/<batchId>`.

**Acceptance:**
- A fixture set like the FlowAuto board yields its 7 rows in board order with its sub-lines and the toolbar
  text "7 waiting for you · 1 check failed"; with nothing waiting, "Nothing waits for you" and the next
  check's day.
- Leaving one memory out moves it from come-over to stay; kept-sharing projects give no row; a project whose
  only pending changes are routine conflicts gives none.
- Each split state's text matches its board for the counts given (applying, partial, changed, newer, failed).
- Did lines: a batch older than 7 days or a split batch not yet switched gives no line; counts follow undone
  changes; the digest's index line reads like AutoDigest's.
- `applyMemoryRow` stores its result and clears the in-flight mark on success and on a thrown error.

### Task 5: The one-page Memory tab
**Files:** `frontend/app/view/agents/setupmemory.tsx`, `frontend/app/view/agents/memorymodel.ts`, `frontend/app/view/agents/memorymodel.test.ts`, `frontend/app/view/agents/memorystore.ts`, `frontend/app/view/agents/memorystore.test.ts`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/store.test.ts`, `frontend/app/view/jarvis/openref.ts`, `frontend/app/view/jarvis/openref.test.ts`, `docs/keyboard-shortcuts.md`

**What to build:** replace the rail, index cards, table and detail column with the spec's centered column:
title, the one intro line, "Waiting for you · N", then "Arc did this week". A row opens in place under itself,
one at a time: a split shows its spot-check, Show all (the full list with Leave out / Bring back), Keep
sharing and Apply and switch over, and its stop states with Undo the N and Check now / Try again; a cleanup
its list with Leave out, Keep them and Clear N; a doc move its evidence and diff with Keep and
Move to <doc>; a failed check its reason with Check now. A did line opens See changes / See memories in place,
with per-change Undo and Undo all N; an Undo the model marks refused shows the refusal with Undo the cleanup.
Keys, motion and look per Decisions and `DESIGN.md` (existing `@theme` tokens only). `memhygiene:<project>`
addresses land on the tab with that project's first waiting row opened. Remove the old model/store exports,
bindings and their tests that nothing uses any more.

**Acceptance (DOM contract Task 6 relies on):** the waiting list is `[data-memory-waiting]`, each row
`[data-memory-row="<key>"]` with `data-open` when opened; inside an opened row `[data-memory-apply]`,
`[data-memory-keep]`, `[data-memory-showall]`, `[data-memory-item="<changeId>"]` with its
`[data-memory-leaveout]`, `[data-memory-progress]`, `[data-memory-stop]`, `[data-memory-undo]`,
`[data-memory-check]`; the did section is `[data-memory-did]`, each line `[data-memory-line="<key>"]` with
`[data-memory-see]`, `[data-memory-undo]`, `[data-memory-undo-refused]`; the empty state
`[data-memory-empty]`; errors `[data-memory-error]`.
- Task 6's setup-memory steps `memory-page`, `split-all-left-out`, `split-applying`, `split-changed`,
  `split-newer`, `split-failed`, `split-applied`, `undo-refused`, `cleanup-open`, `doc-open`, `digest-open`,
  `empty` and `keys` show each view, state and interaction this task builds.
- No project rail, index card or detail column renders; `docs/keyboard-shortcuts.md`'s Memory tab table
  matches the bindings.
- `openref.test.ts` covers the landing: a registered project opens its first waiting row; an unregistered one
  stays refused as today.

### Task 6: setup-memory scenario for every board
**Depends on:** Task 3 (the row apply and undo it drives), Task 5 (the page and DOM contract its steps select)
**Files:** `scripts/cdp/memory-fixtures.mjs`, `scripts/cdp/memory-fixtures.test.mjs`, `scripts/cdp/scenarios-settings.mjs`

**What to build:** rewrite the fixtures and the `setup-memory` scenario for the new page, replacing the old
rail/table steps. Fixture states (real hashes, as today, and a `sort` entry with its sha256 for every shared memory in each sharing state, so only the `split-newer` step, which writes a file after the fixture, meets an unsorted memory) give: three sharing projects on one shared folder
(one a split with enough memories that its Apply's progress can be caught), a former-shared project with a
cleanup and an applied cleanup batch that removed a memory a fixture split copied, a project with two open
doc moves, a failed check ("Check interrupted by a restart"), and routine batches inside and outside the
7-day window with skips. No step runs a check (a check calls a model). Each step screenshots and records its
state in `shots.json`.

**Acceptance:** the scenario passes in the dev app with these steps, one per board plus keys:
- `memory-page` (FlowAuto): rows in board order, toolbar count, did lines, the split opened with four memories.
- `split-all-left-out` (AutoAll): Show all, Leave out one, the row reads "1 left out" and the counts follow;
  Bring back restores them.
- `split-applying` (AutoApplying): the progress line while Apply runs, caught by a MutationObserver on `[data-memory-progress]` installed before Apply is clicked, never by polling.
- `split-changed` (AutoChanged): a memory edited on disk first; Apply stops with the changed text, Undo the N
  and Check now, and the settings file is unchanged.
- `split-newer` (AutoNewer): a memory written to the shared folder; Apply stops with the newer text.
- `split-failed` (AutoFailed): a copy made to fail; Apply stops naming it; Try again shown.
- `split-applied` (AutoApplied): a clean Apply leaves the waiting list, its line appears in Arc did with See
  memories and Undo; Undo restores the files and the row returns.
- `undo-refused` (AutoUndoRefused): Undo on the blocked split shows the refusal with Undo the cleanup, and no
  file changes.
- `cleanup-open` (AutoCleanup): the cleanup opened with its list, Leave out, Keep them and Clear N.
- `doc-open`: a doc move opened with its diff, Keep and Move to CLAUDE.md.
- `digest-open` (AutoDigest): See changes opened with per-change Undo, the index line and Undo all N; one
  change's Undo removes it from the counts.
- `empty` (AutoEmpty): with nothing waiting, "Nothing waits for you" and the next check's day.
- `keys`: `j`/`k` move focus, `Enter` opens and `Esc` closes a row.
- `memory-fixtures.test.mjs` covers the fixture's hashes and file names against the backend's rules as today.
