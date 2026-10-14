# Storage report and Clear left over Implementation Plan

> **For agentic workers:** each task below carries its decisions, the files it owns, the interfaces other tasks rely on, and its acceptance tests. Write the implementation yourself, test first.

**Effort:** effort:58476148-9a97-4f64-9a17-49e86fb1c867
**Verify:** `node scripts/verify.mjs ./pkg/storage... ./pkg/orchestrate ./pkg/wshrpc/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/storage... ./pkg/orchestrate/ ./pkg/wshrpc/...`
**Final:** `node scripts/cdp/final-verify.mjs settings-storage surface-smoke`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/storage-report/project/Main.dc.html

**Goal:** a Storage section in Settings (Data group, after Headless AI) that shows what Arc and its agents keep on this machine, which run left each item, whether anything still needs it, and clears the left-over items that lose nothing. Skipped items get their own Delete anyway.

**Architecture:** wavesrv owns everything that touches disk: a new package `pkg/storagereport` scans in the background, classifies with a pure function, persists the last result, and clears or deletes as a background job. Four wshrpc commands expose it. The frontend polls a snapshot while a job runs (the Resource Manager's pattern) and never blocks. Pure frontend logic lives in `storagemodel.ts`; the view is a thin `storagesection.tsx` inside the existing Settings surface.

**Tech Stack:** Go (wavesrv, git CLI), wshrpc + `task generate`, React 19 + Tailwind 4 + jotai, vitest, CDP scenarios.

**Design source:** the canvas folder `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/storage-report/project/` is the spec. Boards: Main (the list), Confirm (Clear's confirm), DeleteOne (Delete anyway's confirm), and States (clearing, cleared with a held folder, scanning, a project that could not be read, nothing left over). Page draws every state through its `view` prop; AppBar and NavRail are parts. Copy text, sizes and layout from `Page.dc.html`; map its colors onto `@theme` tokens (no new tokens, no raw hex).

## Global Constraints

- Scan and clear run in wavesrv (Go), never in an agent. Classification is a pure Go function with table tests.
- Scope: Arc-owned and run-linked only. Not counted: build output of the user's own checkouts (`src-tauri\target`) and the WebView2 profile. The section says so in one line: "Not counted: build output of your own checkouts, such as src-tauri\target."
- Clear deletes only Left over items that lose nothing. It never touches In use or Kept items, or the items of a run that is not finished (finished = `done` or `cancelled`).
- A tracked tree is removed only through the engine's removal (`RemoveRunWorktree`), never a raw recursive delete. Every folder delete unlinks junctions and symlinks first. `.run` claim files are never touched.
- Clear and the engine never remove the same tree at once: both go through `treeRemovals`.
- A folder a process holds (Windows sharing violation, or git's "being used by another process") is reported on its row with how to free it, never retried silently.
- One background job (scan, clear or delete) at a time. Rescan is disabled while clearing; Clear is disabled while scanning.
- The last result persists in `<wave data dir>/storage-report.json`. Opening the section scans only when there is no result.
- Colors only from `@theme` tokens in `frontend/tailwindsetup.css`. Copy sizes and classes from `settingssurface.tsx` / `settingsmodel.ts`. Follow `DESIGN.md`.
- Never hand-edit generated files: change the Go types, then `task generate`.

## Review Focus

- A junction inside a cleared folder pointing into the main checkout (a run tree's `node_modules`): the delete must remove the link, never the target's files. Task 3 tests it.
- A run that resumes between the scan and the Clear (`done` to `executing`, or `blocked` resumed): Clear must skip its items. Task 3 tests it.
- A registered project whose path is gone or is no longer a git repo: a banner names it, its folders are left out, and the other projects still list. Task 2 tests it.
- A wave branch whose commits were squash- or cherry-picked onto the base branch: it loses nothing (git cherry), so Clear takes it. Task 2 tests it.
- A persisted report that is corrupt or from an older shape: the section treats it as no result and scans; nothing crashes. Task 1 tests it.

---

### Task 1: Wire contract, background job service, engine seam

**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_storage.go`, `pkg/wshrpc/wshrpctypes.go`, `pkg/wshrpc/wshserver/wshserver_storage.go`, `pkg/storagereport/service.go`, `pkg/storagereport/service_test.go`, `pkg/storagereport/maintest_test.go`, `pkg/storagereport/scan.go`, `pkg/storagereport/clear.go`, `pkg/orchestrate/storageseam.go`, `pkg/orchestrate/storageseam_test.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

Defines the contract every other task builds on, the job runner, and the few engine helpers the scan and the clear need. `scan.go` and `clear.go` hold only the stub functions below (each returns `errors.New("storage scan is not built yet")`), which Task 2 and Task 3 replace.

**Wire types** (`pkg/wshrpc/wshrpctypes_storage.go`; JSON tags are the lowercase field names, `omitempty` on optional fields):

```go
type StorageCommands interface {
	StorageReportCommand(ctx context.Context) (*StorageReportData, error) // snapshot, never blocks
	StorageScanCommand(ctx context.Context) error                         // starts a scan; ErrBusy while a job runs
	StorageClearCommand(ctx context.Context, data CommandStorageClearData) error
	StorageDeleteCommand(ctx context.Context, data CommandStorageDeleteData) error
}

const (
	StorageKind_RunTree     = "runtree"     // a folder under the worktree root (arc-wt)
	StorageKind_LegacyTree  = "legacytree"  // <project>\.waveterm\worktrees\<key>
	StorageKind_LegacyGroup = "legacygroup" // a project's emptied, untracked legacy folders of finished runs, one row
	StorageKind_Branch      = "branch"      // a wave/* branch with no tree
	StorageKind_FinalSlot   = "finalslot"   // %LOCALAPPDATA%\arc-final\target[-N]
	StorageKind_FinalStores = "finalstores" // %LOCALAPPDATA%\arc-final\stores[-N], one row
	StorageKind_FinalShots  = "finalshots"  // <data>\final-shots, one row
	StorageKind_FinalOut    = "finalout"    // hand-run Final output, one row per location
	StorageKind_Transcripts = "transcripts" // ~/.claude/projects or ~/.pi, one row each

	StorageGroup_Left  = "left"
	StorageGroup_InUse = "inuse"
	StorageGroup_Kept  = "kept"

	StorageSkip_Commits    = "commits"    // commits on no other branch
	StorageSkip_Dirty      = "dirty"      // uncommitted files in a tracked tree
	StorageSkip_Unreadable = "unreadable" // its run or git state could not be read

	StorageClear_Clearing = "clearing"
	StorageClear_Cleared  = "cleared"
	StorageClear_Failed   = "failed"
	StorageClear_Skipped  = "skipped" // changed since the scan
)

type StorageCommit struct{ Sha, Subject string }

type StorageItem struct {
	Id      string   // kind + ":" + full path, or kind + ":" + project path + ":" + ref for a branch; stable across scans
	Kind    string   // StorageKind_*
	Group   string   // StorageGroup_*
	Path    string   // full path; a grouped row's parent folder; "" for a branch-only row
	Paths   []string // a grouped row's members, deleted one by one
	Count   int      // members of a group; dags for finalshots
	Suffix  string   // a tree's key suffix: "", "-t-3", "-final"
	Harness string   // transcripts: "claude" | "pi"
	Slot    int      // finalslot / finalstores slot number

	ProjectName, ProjectPath string
	Branch, BranchTip        string // wave/<key> the row owns, and its tip sha

	RunId, RunChannelId, RunTitle, RunStatus, RunLandState string
	RunLandDismissed                                       bool
	RunTs                                                  int64 // completed ts, else created ts (ms)
	RunCount                                               int   // legacygroup: finished runs it holds

	Tracked     bool            // git worktree list of its project lists it
	HasGit      bool            // a .git entry exists (false = emptied)
	Dirty       int             // uncommitted files in a tracked tree
	OnlyCount   int             // commits on no other branch
	OnlyCommits []StorageCommit // the first 20 of them
	AlsoOn      string          // a branch that holds every commit, when OnlyCount == 0

	Size  int64 // bytes, junctions and symlinks counted as 0
	ModTs int64 // newest mtime under it, else the branch tip's commit time (ms)

	Clearable bool
	Skip      string // StorageSkip_* for a Left over row Clear skips

	ClearState string // StorageClear_*, set by a running or finished job
	ClearError string
	ClearHeld  bool // a process holds it
}

type StorageScanError struct{ ProjectName, ProjectPath, Error string }

type StorageClearFailure struct {
	Id, Path, Error string
	Held            bool
}

type StorageClearResult struct {
	Ts      int64
	Cleared int
	Freed   int64
	Failed  []StorageClearFailure
}

type StorageReportData struct {
	ScanTs      int64 // when the result finished; 0 = never scanned
	Scanning    bool
	ScanStartTs int64
	Clearing    bool
	ClearTotal  int
	ClearDone   int
	Items       []StorageItem
	Errors      []StorageScanError
	LastClear   *StorageClearResult
	JobError    string // the last job failing as a whole
}

type CommandStorageClearData struct{ Ids []string }
type CommandStorageDeleteData struct{ Id, Tip string }
```

Add `StorageCommands` to `WshRpcInterface` in `wshrpctypes.go` beside `ResMonCommands`. `wshserver_storage.go` is four one-line adapters onto the service.

**Service** (`pkg/storagereport/service.go`):

```go
var ErrBusy = errors.New("a storage scan or clear is already running")

func Snapshot() *wshrpc.StorageReportData   // a copy; loads the persisted result on first call
func StartScan() error                      // ErrBusy while any job runs
func StartClear(ids []string) error          // ErrBusy; rejects an id not in the result, or not Left over and Clearable
func StartDelete(id, tip string) error       // ErrBusy; rejects an id that is not Left over with Skip commits or dirty

// replaced by Task 2 and Task 3; package vars so service tests stub them
var scanFn = scan    // func scan(ctx context.Context) ([]wshrpc.StorageItem, []wshrpc.StorageScanError, error)
var clearFn = clearItem // func clearItem(ctx context.Context, item wshrpc.StorageItem, force bool, tip string) (freed int64, err error)

type ClearError struct { Msg string; Held bool; Skipped bool } // clearItem's typed failure
```

- A job runs on its own goroutine with `panichandler` and a context not tied to the RPC.
- While a scan runs, `Snapshot` keeps returning the previous items and `ScanTs`, with `Scanning` true.
- A clear marks each row `clearing` then `cleared`, `failed` (with `ClearError`, `ClearHeld`) or `skipped`, and updates `ClearDone`. When it ends, cleared rows leave `Items`, failed and skipped rows stay with their state, `LastClear` is set, and the result is persisted. No rescan follows.
- A scan replaces `Items` and `Errors`, sets `ScanTs`, clears `LastClear` and every row's clear state, and persists.
- Persisting writes a temp file then renames it over `filepath.Join(wavebase.GetWaveDataDir(), "storage-report.json")`. A file that fails to read or parse is logged and treated as no result; a failed write sets `JobError`.
- A test-only reset (`resetForTest`) clears in-memory state and points the file at a temp dir.
- `maintest_test.go` is the package's `TestMain`: a temp data dir and `wstore.InitWStore()`, as `pkg/orchestrate/maintest_test.go` does, so Task 2 and Task 3 tests can store runs.

**Engine seam** (`pkg/orchestrate/storageseam.go`); the layout knowledge stays in orchestrate:

```go
var ErrTreeBusy = errors.New("the engine is removing it")

func WorktreeRoot() string                       // worktreeRoot()
func LegacyWorktreesDir(projectPath string) string // <project>\.waveterm\worktrees
func FinalShotsRoot() string                     // finalShotsRoot()
func SplitRunKey(key string) (runID, suffix string, ok bool)
// RunKeyForTreeDir maps a folder name under the worktree root to its engine key: a full key as is, a
// <8-char prefix><suffix> name through the prefix's .run marker. ok=false: no marker, or not an engine name.
func RunKeyForTreeDir(root, name string) (key string, ok bool)
func UnlinkReparsePoints(dir string) error
// RemoveRunWorktreeExclusive removes a run tree and its wave/<key> branch through RemoveRunWorktree, holding
// treeRemovals with TryLock; ErrTreeBusy when the engine holds it. It refuses when worktreeDir(projectPath, key)
// is not wantPath, so it can never remove a tree other than the scanned one.
func RemoveRunWorktreeExclusive(ctx context.Context, projectPath, key, wantPath string) error
// RemoveDirExclusive deletes a folder no git tracks: UnlinkReparsePoints, then os.RemoveAll, under treeRemovals.
func RemoveDirExclusive(path string) error
func LockTreeForTest(path string) (unlock func())
```

Run `task generate` after the wire types compile.

**Acceptance** (focused tests):
- `go test ./pkg/storagereport -run 'TestService'`: a scan stubbed to block keeps `Snapshot` answering with the old items and `Scanning` true; `StartClear` during a scan returns `ErrBusy`; a clear of three ids where the stub clears one, fails one held and skips one leaves two rows with states `failed` (ClearHeld) and `skipped`, and `LastClear{Cleared:1, Freed:<size>}`; the result reloads after `resetForTest` keeps the file; a corrupt file loads as `ScanTs == 0` without error; `StartClear` rejects an In use id and an unknown id; `StartDelete` rejects a Clearable id.
- `go test ./pkg/orchestrate -run 'TestStorageSeam'`: `RunKeyForTreeDir` resolves `<8>`, `<8>-t-3` and full-key names through a marker and rejects a name with no marker; `RemoveRunWorktreeExclusive` returns `ErrTreeBusy` under `LockTreeForTest` and refuses a `wantPath` other than the resolved tree.

### Task 2: Scan and classification

**Depends on:** Task 1
**Chunk:** Decide: report scope (Arc-owned only, or also cargo targets / WebView cache) and home (wsh storage vs Usage section)
**Files:** `pkg/storagereport/scan.go`, `pkg/storagereport/scan_test.go`, `pkg/storagereport/classify.go`, `pkg/storagereport/classify_test.go`, `pkg/storagereport/gitfacts.go`, `pkg/storagereport/gitfacts_test.go`, `pkg/storagereport/size.go`, `pkg/storagereport/size_test.go`

Replace Task 1's `scan` stub, and add the single-item re-read Task 3 uses:

```go
func scan(ctx context.Context) ([]wshrpc.StorageItem, []wshrpc.StorageScanError, error)
// probe re-reads one item's facts from disk, git and the store, and classifies it. Task 3 calls it right before deleting.
func probe(ctx context.Context, item wshrpc.StorageItem) (wshrpc.StorageItem, error)
func classify(item *wshrpc.StorageItem) // pure: sets Group, Clearable, Skip from the facts
```

**What it scans:**
- Projects: every registered project (`wconfig` `projects.json` name and path), plus the project path of any run that owns a scanned tree. The name is the registered name, else the folder's base name. Per project, `git worktree list --porcelain` gives the tracked trees and `git for-each-ref refs/heads/wave/` gives the wave branches. A project whose path is missing or whose git call fails becomes a `StorageScanError` (Error: e.g. "git exited 128, not a git repository"), and its folders and branches are left out.
- Worktree root (`orchestrate.WorktreeRoot()`): every folder (never the `.run` files), keyed through `RunKeyForTreeDir`. The run is `wstore.DBGet[*waveobj.Run]` of the key's run id; `RunTitle` is the run's dag title (`DagORef`), else the first line of its goal. A folder with no key or no stored run has no run.
- Legacy trees: every folder under `orchestrate.LegacyWorktreesDir(project)`, named by its key. Emptied (no `.git`), untracked folders of finished runs collapse into one `legacygroup` row per project (`Paths`, `Count`, `RunCount`, `RunTs` = the newest). Every other legacy folder is its own `legacytree` row.
- A tree and its `wave/<key>` branch are one row (`Branch`, `BranchTip`). A wave branch with no tree folder is a `branch` row.
- Final stage: each `arc-final\target[-N]` is a `finalslot` row with `Slot`; every `arc-final\stores[-N]` folds into one `finalstores` row; `orchestrate.FinalShotsRoot()` is one `finalshots` row with `Count` = dag folders; `%LOCALAPPDATA%\arc-final-out-*` and `%TEMP%\arc-final-*` (folders and files) are one `finalout` row each. `scripts/cdp/final-verify.mjs` owns the `arc-final` layout; read it, not a guess.
- Transcripts: `~/.claude/projects` (Harness claude) and `~/.pi` (Harness pi), one `transcripts` row each.
- A tree row records `Tracked`, `HasGit`, and for a tracked tree `Dirty` (`git status --porcelain` count).

**Git facts** (`gitfacts.go`), for a branch: `OnlyCount` and `OnlyCommits` are the commits from `git rev-list <ref> --not --exclude=<ref> --branches --remotes`, minus those `git cherry <base> <ref>` marks `-` (patch-equal on the run's `BaseBranch`, when that branch exists). `AlsoOn` is a branch from `git branch -a --contains <tip>` other than the ref itself, the run's base branch first. Subjects come from `git log --format=%h%x00%s`.

**Size** (`size.go`): walk with `filepath.WalkDir` / Lstat. A junction (`ModeIrregular`) or symlink counts as 0 and is never followed. `ModTs` is the newest mtime seen, the folder's own included. A branch-only row's ModTs is the tip's committer time.

**Classify** (pure), in order:
1. `finalslot`, `finalstores`, `finalshots`, `transcripts` → Kept, not clearable.
2. A run whose status is not `done` or `cancelled` → In use, not clearable.
3. A known run id whose row or git state could not be read → Left over, Skip `unreadable`.
4. Otherwise Left over: `Dirty > 0` → Skip `dirty`; `OnlyCount > 0` → Skip `commits`; else Clearable. `finalout` and folders with no run are Left over.

**Acceptance:**
- `go test ./pkg/storagereport -run 'TestClassify'`: a table covering every rule above, including a done run with a held land and unique commits (Left over, Skip commits), a blocked run (In use), and a no-run untracked folder (Clearable).
- `go test ./pkg/storagereport -run 'TestGitFacts'` on temp repos: a branch whose commits are on another branch → OnlyCount 0 with AlsoOn set; a branch with 2 unique commits → OnlyCount 2 with their subjects; a branch squash-applied onto the base (same patch, new sha) → OnlyCount 0.
- `go test ./pkg/storagereport -run 'TestSize'`: a folder with a junction (Windows; a symlink elsewhere) to a 1 MB file outside counts only its own bytes.
- `go test ./pkg/storagereport -run 'TestScan'` with `UseWorktreeRootForTest`, a temp data dir and a temp project: an `<8>` folder with its marker resolves to its run and project; the 16-folder legacy case collapses to one `legacygroup` row; a registered project whose path is missing yields one `StorageScanError` while the other project's rows still list; `probe` of a row whose run moved from `done` to `executing` reclassifies it In use.

### Task 3: Clear and Delete anyway

**Depends on:** Task 2
**Chunk:** Fog: clear actions from the report
**Files:** `pkg/storagereport/clear.go`, `pkg/storagereport/clear_test.go`, `pkg/storagereport/held_windows.go`, `pkg/storagereport/held_other.go`

Replace Task 1's `clearItem` stub:

```go
func clearItem(ctx context.Context, item wshrpc.StorageItem, force bool, tip string) (freed int64, err error)
```

1. `fresh, err := probe(ctx, item)`. Without force, delete only if `fresh` is still Left over and Clearable; otherwise return `&ClearError{Skipped: true, Msg: <what changed>}` (e.g. "its run is executing again", "the branch has new commits", "it has uncommitted files"). With force, delete only if `fresh` is Left over with Skip `commits` or `dirty` and `fresh.BranchTip == tip`; otherwise refuse with `Skipped` ("the branch moved since you looked").
2. Delete by kind:
   - a tree or branch row with a known project and key: `orchestrate.RemoveRunWorktreeExclusive(ctx, project, key, path)`. It unlinks junctions, unregisters through git, deletes the folder, then the branch (also for an untracked folder or a branch-only row).
   - a folder with no run, project or key: `orchestrate.RemoveDirExclusive(path)`.
   - `legacygroup` and `finalout`: each member through `RemoveDirExclusive` (`os.Remove` for a file); one held member fails the row with "N of M couldn't be cleared".
   - Kept and In use kinds are unreachable here; return an error if one arrives.
3. Held detection lives in `isHeld(err error) bool`: `held_windows.go` (`//go:build windows`) checks `windows.ERROR_SHARING_VIOLATION` and `windows.ERROR_LOCK_VIOLATION` through `errors.Is`; `held_other.go` (`//go:build !windows`) returns false. Both also match git output containing "being used by another process".
   `orchestrate.ErrTreeBusy` → `ClearError{Msg: "the engine is removing it"}`. `isHeld(err)` → `ClearError{Held: true, Msg: "a process has it open"}`. No retry.
4. `freed` is `fresh.Size` of what went.

**Acceptance** (`go test ./pkg/storagereport -run 'TestClear'`, temp repos and `UseWorktreeRootForTest`):
- An untracked folder holding a junction (Windows; a symlink elsewhere) into a stand-in "main checkout" is cleared, and the stand-in's files are all still there.
- A tracked tree of a done run whose branch is merged is gone afterwards, as are its `git worktree list` entry and its branch.
- A row whose run is `executing` at clear time is skipped and stays on disk.
- A branch with a unique commit is skipped without force; with force and the shown tip it is deleted; with force and a stale tip it is refused and kept.
- Under `LockTreeForTest` the row fails with "the engine is removing it".
- On Windows, a file held open without delete sharing fails the row with `Held` true. Skip it elsewhere.
- No `.run` marker is removed by any of the above.

### Task 4: Frontend storage model and fixtures

**Depends on:** Task 1
**Files:** `frontend/app/view/agents/storagemodel.ts`, `frontend/app/view/agents/storagemodel.test.ts`, `frontend/app/view/agents/storagefixtures.ts`, `frontend/app/view/agents/storagefixtures.test.ts`, `frontend/app/cockpit/resmon.ts`, `frontend/app/cockpit/resmon.test.ts`

Pure derivations from `StorageReportData` (generated type). All copy comes from `Page.dc.html`. Sizes: `fmtMem` (`frontend/app/cockpit/resmon.ts`) rounds to MB, so it cannot print "8 KB" or "0 B". Add `fmtSize(bytes)` beside it: below 1 MiB it prints "0 B", "N B" or "N KB"; from 1 MiB up it returns `fmtMem(bytes)`. `fmtMem` itself is unchanged, so the Resource Manager's output does not move; a `resmon.test.ts` case pins `fmtSize` at 0, 512, 8192, 1 MiB and 14.6 GiB, and another pins `fmtMem` unchanged at 1 MiB and above. Idle: reuse `formatAgo` if it gives "9m", "2d", "now"; otherwise a local helper in `storagemodel.ts`.

```ts
export type StorageRowVM = {
    id: string; path: string; full: string; kind: string;
    owner: string; ownerMeta: string; run: OpenTarget | null; // { kind: "run", runId } when the row has a run
    size: string; barPct: number; idle: string; loses: string; losesMuted: boolean;
    tag: { text: string; tone: "muted" | "success" | "accent" | "error" } | null;
    canDelete: boolean;
};
export type StorageSectionVM = { group: "left" | "inuse" | "kept"; title: string; meta: string; rows: StorageRowVM[] };
export function storageSections(r: StorageReportData, now: number): StorageSectionVM[];
export function storageStats(r: StorageReportData): { group: string; label: string; value: string; sub: string }[];
export function clearPlan(r: StorageReportData): { ids: string[]; size: number; title: string; lines: string[]; skipped: { path: string; reason: string }[] };
export function deletePlan(item: StorageItem): { title: string; path: string; size: string; branch: string; commits: StorageCommit[]; dirty: number; cta: string };
export function clearButton(r: StorageReportData): { show: boolean; enabled: boolean; label: string };
export function rescanEnabled(r: StorageReportData): boolean;
export function scannedLabel(r: StorageReportData, now: number): string;
export function resultNotice(r: StorageReportData): { text: string; failure: string | null } | null;
export function scanErrorText(e: StorageScanError): string;
export function navSummary(r: StorageReportData | null): { count: string; pill: string | null };
export function shouldAutoScan(r: StorageReportData | null): boolean; // loaded, ScanTs 0, not scanning
export function pollWanted(r: StorageReportData | null): boolean;      // scanning or clearing
```

Rules, with the canvas's copy:
- Sections are Left over ("its run finished, or no run owns it"), In use ("a run is working in it"), Kept on purpose ("caches and history Arc reads"). Left over rows are ordered run trees, legacy, branches, Final outputs, each newest first; In use newest first; Kept largest first. An empty Left over shows "Nothing left over. Every folder here belongs to a live run or is kept on purpose."
- `path` is short: `arc-wt\<name>`, `.waveterm\worktrees\<name>`, `.waveterm\worktrees (16)`, `wave/<8>`, `Temp\arc-final-* (21)`, `arc-final-out-* (2)`, `arc-final\target-1`, `arc-final\stores-* (2)`, `data\final-shots (31)`, `.claude\projects`, `.pi`. `full` is the full path.
- `kind` line: tree role from Suffix (`""` landing tree, `-t-N` lane tree, `-final` final tree), then "emptied · not in git" / "in git" / for legacy "checkout, old in-project layout · clean" or "· N uncommitted files"; "branch only, no folder", or "branch only · held land you dismissed" when RunLandState is held and dismissed; the Kept and Final kinds as the canvas words them.
- `owner` is RunTitle, "N finished runs" for a group, "No run", "Final stage", "Claude Code" or "pi". `ownerMeta` is "<project> · landed HH:MM" (today) or "· cancelled MM-DD" / "· held MM-DD" / "· executing"; a group shows "before MM-DD".
- `loses`: "Nothing"; "Nothing: every commit is also on <AlsoOn>"; "N commits only on <branch>"; "N uncommitted files"; "The run's work in progress"; "The next Final on slot N builds the app cold"; "Usage history and Sessions for those sessions"; "Those runs' Final steps stop opening their screenshots". `losesMuted` when it starts with "Nothing".
- Tags: a Left over skipped row shows "Clear skips it" (muted) and `canDelete` when Skip is commits or dirty and no job runs; clear states show "Clearing…" (accent), "Cleared" (success), "In use by a process" (error, held). A held row's loses reads "Couldn't clear: a process has it open. Close the terminal or editor in it, then clear again."
- `clearButton`: hidden when there is nothing clearable and no clear runs; "Clear <size> left over"; "Clearing N of M…" disabled while clearing; disabled while scanning; "Clear again" after a clear that left a failed row clearable.
- `idle`: "—" for `transcripts` and `finalshots`, and for any row with ModTs 0; a group row (`legacygroup`, `finalout`, `finalstores` with Count > 1) shows its newest member's idle with "+" ("3d+"); otherwise the age of ModTs ("now" under a minute, "9m", "2d").
- `size`: "—" for a `branch` row; otherwise `fmtSize(Size)`. `barPct` is 0 for a branch row.
- `clearPlan`: `ids` and the progress count ("Clearing N of M…") are rows; the confirm's lines count member folders, a group row adding its `Paths.length` (canvas: 21 empty run folders = 5 arc-wt rows + a 16-folder legacy group; 23 output folders = a 21-folder and a 2-folder `finalout` row). Lines, each only when its count is above 0: "N empty run folders" (run and legacy tree rows and legacy groups), "N wave branches whose commits are on other branches" (branch rows; the human chose this over the board's "on your backup branches", which named only the sample), "N output folders of Finals run by hand" (`finalout`). The body is fixed text around them: lead "Deletes what no run needs and loses nothing:", then the list, then one sentence per skipped row ("Skips <path>: N commits are only on its branch." or "Skips <path>: it has N uncommitted files."), then the tail "Live runs and kept items are never touched." Title "Clear <size> left over?" where size is the clearable rows' sum.
- `deletePlan`: title "Delete <name> and its branch?"; CTA "Delete and lose N commits", or "Delete and lose N uncommitted files" for a dirty-only row.
- `resultNotice`: "Cleared N items, <size> freed." plus "1 couldn't be cleared: a process still has <path> open."
- `scanErrorText`: "Couldn't list the run trees of <project>: <error>. Its folders are left out until the project path is fixed."
- `navSummary`: count is the total size ("…" while the first scan runs); pill "<size> left over" when the Left over size is above 0.

`storagefixtures.ts` exports `STORAGE_SCENARIOS: Record<"storage" | "clearing" | "cleared" | "scanning" | "error" | "clean", StorageReportData>`, built from the canvas's sample rows (`Page.dc.html` `rows`): same paths, owners, sizes and states. Every row has a stable `Id`; the 9e473bf8 row carries a `BranchTip` and its two `OnlyCommits` (ad962fe1 "docs: drop the notes palette plan from this run", 01a08218 "docs: spec and plan for User notes in the palette"); run rows carry a `RunId` (dca34385 is executing). It is imported only by the DEV mock in Task 5.

**Acceptance** (`npx vitest run frontend/app/view/agents/storagemodel.test.ts frontend/app/view/agents/storagefixtures.test.ts`):
- The `storage` fixture derives the canvas's Main: three sections, 11 Left over rows, stats "363 MB" / "51 MB" / "14.2 GB", button "Clear 314 MB left over", the 9e473bf8 row tagged "Clear skips it" with `canDelete`.
- `clearPlan(storage)` lists the three kind lines and the 9e473bf8 skip; `deletePlan` of that row gives "Delete and lose 2 commits" with both commits.
- `clearing` gives "Clearing 7 of 10…" disabled and no `canDelete`; `cleared` gives the notice with "1 couldn't be cleared" and the held row's loses text; `scanning` gives "…" stats and `pollWanted` true; `error` gives the banner text and no cyber_anomaly_detector rows; `clean` hides the button and shows the empty Left over.
- `shouldAutoScan(null)` is false; with ScanTs 0 and not scanning it is true; while scanning it is false.
- `clearPlan(storage)` gives the lines "21 empty run folders", "2 wave branches whose commits are on other branches", "23 output folders of Finals run by hand", the lead and tail sentences, and `ids.length` 10.
- Rows of `storage`: the `.waveterm\worktrees (16)` row's idle is "3d+"; `.claude\projects`, `.pi` and `data\final-shots (31)` show idle "—"; `wave/021cb57c` shows size "—"; `arc-wt\bd67b1fe` shows size "8 KB".

### Task 5: Settings > Storage section and its CDP scenario

**Depends on:** Task 4
**Chunk:** Build: storage report - size, age, owning run, live or not, cost of clearing
**Files:** `frontend/app/view/agents/storagestore.ts`, `frontend/app/view/agents/storagestore.test.ts`, `frontend/app/view/agents/storagesection.tsx`, `frontend/app/view/agents/storagedevmock.ts`, `frontend/app/view/agents/settingsmodel.ts`, `frontend/app/view/agents/settingssurface.tsx`, `scripts/cdp/scenarios.mjs`

- `settingsmodel.ts`: a `storage` section, name "Storage", group "Data", after Headless AI, blurb "What Arc and its agents keep on this machine, which run left it, and whether anything still needs it.", no rows.
- `storagestore.ts`: a jotai atom holding the last `StorageReportData` (it survives the surface unmounting), `loadStorage()`, `startScan()`, `startClear(ids)`, `startDelete(id, tip)` over `RpcApi.Storage*Command(TabRpcClient)`, and a poll that refreshes every second while `pollWanted`. A fixture flag, set only by the DEV mock, stops polling and makes every action send no RPC; instead the action records itself on `window.__storageLastAction` (`{ kind: "scan" }`, `{ kind: "clear", ids }`, `{ kind: "delete", id, tip }`). While the flag is set, every RPC reply that arrives (a load started before the fixture, a late poll) is dropped, so it cannot overwrite the fixture. RPC errors show as a toast with the command's message, never swallowed.
- `storagestore.test.ts`, following `frontend/app/cockpit/resmonstore.test.ts`'s RPC mock: a load whose reply resolves after the fixture flag is set leaves the fixture in the atom; in fixture mode `startClear(["a","b"])` sends no RPC and records `{ kind: "clear", ids: ["a","b"] }`; outside fixture mode it calls `StorageClearCommand` with those ids.
- `settingssurface.tsx`: the Settings surface loads the report on mount so the index can show it. The Storage index row shows `navSummary` (total size in place of "N settings", and the pill in warning tone, styled like the "changed" pill). The section header takes section-specific actions: Storage puts the scanned label, Rescan (`data-storage-rescan`) and Clear (`data-storage-clear`) there; other sections keep Reset section. `SectionBody` renders `StorageSection` for `storage`.
- `storagesection.tsx`, thin over `storagemodel.ts`: the scan-error banner (`data-storage-error`), the result notice (`data-storage-result`), three stat tiles (`data-storage-stat`), the skeleton while the first scan runs (`data-storage-skeleton`), sections (`data-storage-group="left|inuse|kept"`) with rows (`data-storage-row=<id>`), the empty Left over (`data-storage-empty`), the foot line, Clear's confirm through `ConfirmDialog` (tone warning, CTA "Clear left over", `data-storage-confirm`), and Delete anyway (`data-storage-delete=<id>`) through `ConfirmDialog` tone danger (`data-storage-delete-confirm`). A row's owner link (`data-storage-run=<runId>`) opens its run through `openTarget(model, { kind: "run", runId })`, in fixture mode too, and in fixture mode also records `{ kind: "open", runId }` on `window.__storageLastAction`. Opening the section calls `startScan()` when `shouldAutoScan`.
- `storagedevmock.ts`: DEV-only `window.__setStorageScenario(name)`, installed by the Settings surface on mount the way `radarsurface.tsx` installs `__setRadarScenario`, so it exists before the Storage section opens. A scenario name loads `STORAGE_SCENARIOS[name]` into the atom and sets the fixture flag; `"live"` clears the flag and reloads.
- `scripts/cdp/scenarios.mjs`: a `settings-storage` scenario. Pin the viewport to 1600x950. Go to Settings and wait for `window.__setStorageScenario`; set the `storage` scenario before clicking `[data-section="storage"]`, so the auto-scan never fires against an empty result. Scope queries by where things sit: section content under `[data-settings-section="storage"]`; the header's Rescan and Clear by `[data-storage-rescan]` and `[data-storage-clear]`; the nav row by `[data-section="storage"]`; dialogs by `[data-storage-confirm]` and `[data-storage-delete-confirm]`. Close a dialog by clicking its Cancel button, never a key press. Reset `window.__storageLastAction` before each action step. One shot and assert per step:
  1. `storage` (board Main): 3 groups, the 9e473bf8 row has a `data-storage-delete` button, `[data-storage-clear]` reads "Clear 314 MB left over", and `[data-section="storage"]` shows "left over".
  2. `confirm` (board Confirm): click `[data-storage-clear]`; the dialog shows the three kind lines, the 9e473bf8 skip and the tail; click Cancel; the dialog is gone and no action was recorded.
  3. Clear CTA: click Clear again, then the dialog's "Clear left over"; the dialog closes and `__storageLastAction` is `{ kind: "clear" }` with the 10 clearable fixture ids.
  4. `deleteone` (board DeleteOne): click the 9e473bf8 `data-storage-delete`; the danger dialog lists 2 commits and "Delete and lose 2 commits"; click Cancel; it closes.
  5. Delete CTA: open it again and click "Delete and lose 2 commits"; the dialog closes and `__storageLastAction` is `{ kind: "delete" }` with the 9e473bf8 row's id and its fixture tip.
  6. Rescan: click `[data-storage-rescan]`; `__storageLastAction` is `{ kind: "scan" }`.
  7. Owner link: click the `arc-wt\dca34385` row's `data-storage-run`; `__storageLastAction` is `{ kind: "open" }` with that run id, and then either the surface left Settings or a toast is shown (the fixture run is not in the store). Go back to Settings > Storage and re-set the `storage` scenario.
  8. `clearing`: `[data-storage-clear]` reads "Clearing 7 of 10…" and is disabled; rows show Cleared and Clearing…; no `data-storage-delete` button.
  9. `cleared`: `data-storage-result` names the held folder; that row reads "In use by a process".
  10. `scanning`: `data-storage-skeleton` present, stats read "…".
  11. `error`: `data-storage-error` names cyber_anomaly_detector; no row of that project.
  12. `clean`: `data-storage-empty` present; no `[data-storage-clear]`.

  Teardown runs `__setStorageScenario("live")`. No step deletes or creates real files.

**Acceptance:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` is clean. The `settings-storage` scenario passes every step above against the dev app (Final runs it), each step's shot matching its board in the canvas. The `surface-smoke` scenario (Final runs it too) still passes its Settings step.
