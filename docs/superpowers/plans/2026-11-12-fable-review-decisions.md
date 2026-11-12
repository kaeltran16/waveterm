# Fable review decisions, batch 10

**Effort:** effort:cfe52146-96e3-47a6-94b4-a3a2dabdf416
**Verify:** `node scripts/verify.mjs ./pkg/wavevault ./pkg/effortstore && cargo test --manifest-path src-tauri/Cargo.toml`
**Check:** `task check:ts`

Four design questions from the Fable reviews are decided (the decision is in each chunk's note on the effort).
Build each decision as stated. If the code shows a decision cannot work as stated, stop that task and say why
rather than inventing another design. Background reports: `C:\Users\kael02\IdeaProjects\credit-runs\` and
`C:\Users\kael02\arc-bench\review-2026-11-11\results\`.

For every task: reproduce the defect in a failing test first, fix the root cause with the minimal change, match
existing conventions, no unrelated refactors. Commit message body names the finding id.

No Final line: no CDP scenario can drive a live claude session's permission mode or a second app launch, so
Task 3 and Task 4 are proven by their unit tests only.

### Task 1: RT-R5, recover an interrupted vault merge without losing an edit
**Depends on:** none
**Chunk:** Decide: RT-R5, what an edited file becomes when an interrupted vault merge is recovered
**Files:** `pkg/wavevault/sync.go`, `pkg/wavevault/sync_test.go`

Today `commitAndMerge` (`pkg/wavevault/sync.go`, the MERGE_HEAD check) runs `git merge --abort`, which exits 128
("not uptodate") once a file the merge staged was edited, so this sync and every later one fail the same way.

Decision (b), keep the edit: when MERGE_HEAD exists, save the content of every stage-0 path whose worktree
differs from the index (deletions included), leaving out every path `git ls-files -u` lists as unmerged; reset
the tree to HEAD (`git reset --hard`, which also clears MERGE_HEAD), write the saved content back, then continue
into the normal commit + merge + resolver path. Unmerged paths are not saved: their worktree content holds
conflict markers, the reset returns them to HEAD's (ours) version, and the re-run merge conflicts on them again
and the resolver resolves them as it does any conflict. So an edit made to a file the interrupted merge
resolved cleanly is never lost, an edit made to a still-unmerged file is discarded (that file had no resolved
content to keep, and it is re-merged from both sides), and this path never commits conflict markers.

Test with a real git repo in `sync_test.go`'s existing style: an interrupted merge that both conflicts on one
file and cleanly stages another, an edit to the cleanly staged file, then a sync that succeeds, keeps the edit,
resolves the conflicted file as today, and leaves no MERGE_HEAD. The existing
`TestSyncRecoversInterruptedMerge` (a conflicted interrupted merge, expects "edited on b") must keep passing
unchanged. Prove it with `go test ./pkg/wavevault -run '^(TestSyncRecoversInterruptedMerge|<the new test names>)$'`.

### Task 2: RT-R7, merge effort scalar fields per field against the base
**Depends on:** none
**Chunk:** Decide: RT-R7, merge an initiative's scalar fields per field against the base?
**Files:** `pkg/wavevault/effortmerge.go`, `pkg/wavevault/effortmerge_test.go`, `docs/superpowers/specs/2026-10-01-vault-sync-design.md`

`MergeEffort(base, ours, theirs)` (`pkg/wavevault/effortmerge.go`) takes every scalar, and a chunk's status, stage
and owner, from the side with the newer UpdatedTs, so a field only the older side changed is lost. Sets already
merge against the base (`mergeByTs`, RT-R6).

Decision: merge per field against the base, for the effort's scalar fields (`Title`, `Project`, `Ticket`,
`Status`, `ParentOID`, `Jira`, `Meta`) and a chunk's status, stage and owner. Changed on one side only: that
side's value. Changed on both: the newer UpdatedTs wins (tie: ours, as today). `Jira` (a pointer) and `Meta` (a
map) are compared whole with `reflect.DeepEqual`, never field by field inside them. `Jira` is the last-seen copy
of `Ticket`'s issue, so when `ours.Ticket != theirs.Ticket` it comes from the same side the merged `Ticket` came
from, never paired with the other side's ticket. No base: today's newer-side rule for every field. Note that
`MergeEffort` replaces a nil base with `&Effort{}`: track `base == nil` before that, since per-field against an
empty base would let a one-sided value beat a newer empty one. Likewise a chunk absent from the base (new on both
sides) keeps today's newer-chunk rule. Update the rule in `docs/superpowers/specs/2026-10-01-vault-sync-design.md`
(the scalar list gains `Jira`), change the "scalars from the newer side" test's expectation to the new rule, and
add cases for an effort field and a chunk field only the older side changed, a nil base, and a `Ticket` change
whose `Jira` copy must not pair with the other side's ticket. `TestMergeEffortKeepsNewerJiraCopy` (nil base) must
keep passing unchanged. Prove it with `go test ./pkg/wavevault -run '^TestMergeEffort'`.

### Task 3: RH-R12, a second Arc on the same data dir exits instead of opening a dead window
**Depends on:** none
**Chunk:** Decide: RH-R12, single-instance guard for Arc?
**Files:** `src-tauri/src/main.rs`, `src-tauri/src/paths.rs`, `src-tauri/src/instancelock.rs`

wavesrv already takes a per-data-dir lock (`wavebase.AcquireWaveLock` in `pkg/wavebase/wavebase-win.go`, a
filemutex on `wave.lock` in the data dir) and exits when it is held, so a second Arc today opens a window whose
backend is dead.

Decision: the Tauri host checks that same lock for the data dir it is about to hand wavesrv, in `main()` before
`tauri::Builder` runs: Tauri creates the config windows (`tauri.conf.json`'s visible `main` window in packaged
builds) before the setup hook, so a check in setup would still flash a window. In `main()`, derive the data dir
the way setup does today, from `%LOCALAPPDATA%` joined with `context.config().identifier` (what
`app_local_data_dir()` resolves to on Windows), then `paths::data_base_for` and `paths::dev_data_base` with
`ARC_DEV_DATA_DIR`; compute it once in `main()` and hand that value to setup rather than deriving it twice. Init
`applog` there too (it is a OnceLock, so only one init may run). If another process holds the lock, log one line
through `applog` and exit. If `LOCALAPPDATA` is unset, skip the check and start as today. Key on the data dir,
never the app identifier: final-verify's isolated dev apps share the identifier with their own
`ARC_DEV_DATA_DIR` and must keep starting. Use the same OS lock the Go side uses (read filemutex's Windows
implementation; Rust std `File::try_lock` or the existing `windows`/`windows-sys` dependencies, adding only
features of those crates if needed) and release it before wavesrv starts so wavesrv can take it. No new crate,
and no focusing of the running window. Put the check in a new `src-tauri/src/instancelock.rs` unless it fits an
existing module better.

Unit tests in Rust: a lock held by another handle refuses the check; a free lock is allowed and released
afterwards (a second check then also passes). Prove it with
`cargo test --manifest-path src-tauri/Cargo.toml instancelock`, with no new compiler warnings.

### Task 4: fe-agent F1, the Shift+Tab cycle includes auto once any session has reported it
**Depends on:** none
**Chunk:** Decide: fe-agent F1, how Arc learns auto is in a session's permission cycle
**Files:** `frontend/app/view/agents/headercontrolsmodel.ts`, `frontend/app/view/agents/headercontrolsmodel.test.ts`, `frontend/app/view/agents/headercontrols.tsx`, `frontend/app/view/agents/session-models/agentstatusstore.ts`

`permissionCycle` (`headercontrolsmodel.ts`) adds auto only once this session has reported it
(`getSeenPermissionModesAtom`, set in `agentstatusstore.ts`), so the first wrap from plan in a new session lands
on auto while the chip says default. Auto's availability is an account/model gate, not per session.

Decision: persist an app-wide "auto seen" flag. Set it the first time any session reports permission mode auto
(where `agentstatusstore.ts` records seen modes), keep it across reloads with `atomWithStorage` (`jotai/utils`,
the frontend's existing persistence for small UI state), and define that atom in `agentstatusstore.ts` beside
`getSeenPermissionModesAtom`. Not in `cockpitprefsstore.ts`: it imports `./agents` (agents.tsx), and importing it
from `agentstatusstore.ts` risks an import cycle. Have the cycle include auto when this session has seen auto or
the flag is set. Keep the logic in the pure model; extend `headercontrolsmodel.test.ts` for: flag set and session unseen ->
auto in the cycle; neither -> no auto. Prove it with `npx vitest run frontend/app/view/agents/headercontrolsmodel.test.ts`.
