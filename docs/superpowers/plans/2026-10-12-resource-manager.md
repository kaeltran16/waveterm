# Resource Manager Implementation Plan

**Verify:** `node scripts/verify.mjs ./pkg/util/jobobject ./pkg/resmon ./pkg/shellexec ./pkg/blockcontroller ./pkg/orchestrate ./pkg/wshrpc/...`
**Check:** `go vet ./pkg/util/jobobject/ ./pkg/resmon/ ./pkg/shellexec/ ./pkg/blockcontroller/ ./pkg/orchestrate/ ./pkg/wshrpc/... && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs resmon-main resmon-footer resmon-states`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\resource-manager\project\Main.dc.html

**Goal:** A footer readout plus a popover showing the CPU and memory of Arc itself and of every agent's process tree, with kill actions for runaway agent subprocesses.

**Architecture:** Every process Arc spawns already sits in a Windows job object (block shells: `pkg/shellexec/conninterface.go` MakeCmdWrap; engine plan commands: `pkg/orchestrate/plancmd_windows.go` runShellCmd). A registry in `pkg/util/jobobject` records each live job and its owner. `pkg/resmon` samples the members of every registered job, plus Arc's own processes (by a ppid walk from the Tauri host), every 2s while the frontend polls, and groups the result by owner. Three wshrpc commands expose a snapshot, kill and kill-children. The frontend polls the snapshot every 2s into jotai, draws the readout in both footers, and draws one popover in the always-mounted shell.

**Design:** no spec file. The design canvas on the Prototype line (boards Main, Footer and States, in the same folder) plus the decisions below are the spec.

## Global Constraints

- Windows-only attribution. Off Windows `jobobject.Members` returns nil, the snapshot has `supported: false` and the readout hides. No Unix process-group support.
- Out of scope: heuristic orphan detection (cwd or env scans), Docker or WSL VM processes, any change to orchestrator kill semantics.
- Owner kinds: `arc` (App, read-only), `agenttab` (Agent tab), `runworker` (Run worker), `runcmd` (Run command, read-only). Only `agenttab` and `runworker` are killable.
- CPU is a share of the whole machine (Task Manager semantics): CPU-time delta between samples / wall delta / logical cores × 100. Memory is the working set (RSS) in bytes.
- Sampling: every 2s; it stops after 10s with no snapshot call. The frontend skips a poll while `document.hidden`.
- Busy: the sum of every group's CPU >= 80% for 3 consecutive samples → `busycpu`; the sum of every group's memory >= 75% of physical RAM → `busymem`. These are constants, not settings.
- Agent core (never killed, shown with a tag instead of a kill button): in a block whose tab has `session:agent` meta, the job's root process. While a core process is a launcher image (`cmd.exe`, `bash.exe`, `sh.exe`, `pwsh.exe`, `powershell.exe`) and has exactly one child other than `conhost.exe`, that child joins the core. The deepest core process is tagged `agent` and the ones above it `launcher`. A `conhost.exe` whose parent is a core process is tagged `console`. In a block without `session:agent`, only the root is core, tagged `shell`.
- Arc group: the Tauri host (`os.Getppid()` of wavesrv) and its descendants by ppid walk, plus wavesrv's descendants that are in no registered job (ConPTY conhost hosts, git calls), which sit under the Backend row. A walk guards against pid reuse: a child counts only if its create time is at or after its parent's. Role names: Host, WebView browser (msedgewebview2 with no `--type`), Renderer (`--type=renderer`), GPU (`--type=gpu-process`), Network service (`--utility-sub-type=network.mojom.NetworkService`), Storage service (`--utility-sub-type=storage.mojom.StorageService`), Crash handler (`--type=crashpad-handler`), Backend (wavesrv); any other process shows its image name.
- Labels (resolved on the server): agent tab = the tab's name; run worker = run title · Task <id> (or · lead / · reviewer for those roles); run command = run title · <Kind>, as `run title · Task <id> Verify` when it runs at a task's merge. Run title = the dag's plan title, else the first line of the run's goal (the rule of `runTitle` in `frontend/app/view/agents/runlineage.ts`).
- Text: readout `Arc <cpu>% CPU · <mem>`, CPU as an integer; `Arc –` until the snapshot is ready. Busy pill words: `high CPU`, `high memory`, `high CPU and memory`. Row and group CPU have one decimal (`28.9%`). Memory is in binary units: under 1000 MB as whole MB (`486 MB`), else GB to one decimal (`1.9 GB`). Age: `45s`, `42m`, `3h 12m`, `2d 4h`. An unavailable value (-1) shows `–`.
- Tokens only, from `frontend/tailwindsetup.css` `@theme`; no new tokens. Busy uses `warning` / `warning-soft`; confirms and alerts use `error` / `error-soft`; runtime swatches use `rt-claude` / `rt-pi`. DESIGN.md applies.
- Never hand-edit generated files. Run `task generate` after changing wshrpc types.

## Review Focus

1. **A pid that exits or is reused between the snapshot and the kill.** It must come back `gone` or `refused`, never terminate a stranger. Task 2 tests it at the primitive; Task 3 at the RPC.
2. **An agent-core pid sent to kill** (a stale UI, or a launcher chain such as pi's `cmd.exe` → `node.exe`). The backend answers `protected` without terminating it, and kill-children leaves every core process alive. Task 3 tests both.
3. **A job closing while a sample runs** (a block closes). The sample neither queries a closed handle nor fails, and the group is gone from the next snapshot. Task 2 tests `Close` against `LiveJobs`.
4. **A process the sampler cannot open** (access denied, an elevated child). It still shows as a row, with -1 CPU and memory, rendered `–`, and the sample does not fail. Task 3 tests the -1 path; Task 5 tests the formatting.
5. **Kill or kill-children aimed at a read-only group** (an Arc pid, a run-command pid) through the RPC. It is refused without terminating anything. Task 3 tests it.

---

### Task 1: Wire contract for the Resource Manager RPCs
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_resmon.go`, `pkg/wshrpc/wshrpctypes.go`, `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`

This task fixes the types every other task builds on. The server dispatches by reflection and has no compile-time assertion that `WshServer` implements the interface, so declaring the commands here without handlers compiles; Task 3 adds the handlers.

- Extend the existing unused `wshrpc.ProcessInfo` (`pkg/wshrpc/wshrpctypes.go`) rather than adding a parallel type. Add `Name string json:"name,omitempty"` (image name, e.g. `claude.exe`), `CreateTs int64 json:"createts,omitempty"` (epoch ms), `Depth int json:"depth"` (tree depth in its group, 0 = root), `Role string json:"role,omitempty"` (Arc role name), `Tag string json:"tag,omitempty"` (`agent` | `launcher` | `console` | `shell`). Keep `Command` (the full command line), `Cpu` (% of the whole machine, -1 unavailable) and `Mem` (working-set bytes, -1 unavailable). Update the type's doc comment to say it now backs the Resource Manager.
- New `pkg/wshrpc/wshrpctypes_resmon.go`, embedded as `ResMonCommands` in `WshRpcInterface`:

```go
type ResMonCommands interface {
	ResMonSnapshotCommand(ctx context.Context, data CommandResMonSnapshotData) (*ResMonSnapshotData, error)
	ResMonKillCommand(ctx context.Context, data CommandResMonKillData) (*ResMonKillRtnData, error)
	ResMonKillChildrenCommand(ctx context.Context, data CommandResMonKillChildrenData) (*ResMonKillRtnData, error)
}

const (
	ResMonOwner_Arc       = "arc"
	ResMonOwner_AgentTab  = "agenttab"
	ResMonOwner_RunWorker = "runworker"
	ResMonOwner_RunCmd    = "runcmd"

	ResMonKill_Killed    = "killed"
	ResMonKill_Gone      = "gone"      // the target had already exited
	ResMonKill_Refused   = "refused"   // not a member of a killable job of that owner (it left the job, or the owner is gone or read-only)
	ResMonKill_Protected = "protected" // the pid is a core process of the agent (agent, launcher, console or shell)
	ResMonKill_Failed    = "failed"    // the OS refused; Error holds its text
)

type CommandResMonSnapshotData struct{}

type ResMonGroup struct {
	Key       string        `json:"key"`               // "arc", or "job:<rootpid>:<root createts>"; stable for the job's life
	OwnerKind string        `json:"ownerkind"`         // ResMonOwner_*
	OwnerId   string        `json:"ownerid,omitempty"` // block id (agenttab, runworker), run id (runcmd), "" for arc
	Label     string        `json:"label"`
	Runtime   string        `json:"runtime,omitempty"` // claude | pi: the tab's session:agent, for the swatch
	Killable  bool          `json:"killable"`
	Cpu       float64       `json:"cpu"`
	Mem       int64         `json:"mem"`
	Rows      []ProcessInfo `json:"rows"` // pre-order tree; Depth from 0
}

type ResMonSnapshotData struct {
	Supported bool          `json:"supported"` // false off Windows: the readout hides
	Ready     bool          `json:"ready"`     // false until a second sample gives CPU deltas
	Ts        int64         `json:"ts"`
	Cpu       float64       `json:"cpu"` // sum over every group
	Mem       int64         `json:"mem"`
	TotalMem  int64         `json:"totalmem"`
	BusyCpu   bool          `json:"busycpu"`
	BusyMem   bool          `json:"busymem"`
	Groups    []ResMonGroup `json:"groups"`
}

type CommandResMonKillData struct {
	OwnerId string `json:"ownerid"` // the block id of the group the row was shown in
	Pid     int32  `json:"pid"`
	Tree    bool   `json:"tree"` // also kill the pid's descendants inside the same job
}

type CommandResMonKillChildrenData struct {
	OwnerId string `json:"ownerid"`
}

type ResMonKillRtnData struct {
	Outcome string `json:"outcome"` // ResMonKill_*
	Killed  int    `json:"killed"`  // processes terminated
	Error   string `json:"error,omitempty"` // set only for failed: the OS error text. The frontend builds every other note itself
}
```

- `pkg/resmon/doc.go` already exists on the base (the package doc comment, added so the Verify and Check patterns resolve before this task). Leave it as it is.
- Run `task generate`, and commit the three generated files it changes.

Acceptance: `go build ./...` passes. `frontend/types/gotypes.d.ts` declares `ResMonSnapshotData`, `ResMonGroup`, `ResMonKillRtnData` and `ProcessInfo` with the new fields. `frontend/app/store/wshclientapi.ts` has `ResMonSnapshotCommand`, `ResMonKillCommand` and `ResMonKillChildrenCommand`. `go vet ./pkg/wshrpc/... ./pkg/resmon/` is clean, and `task check:ts` is clean.

### Task 2: Job registry, membership and the in-job kill primitive
**Depends on:** Task 1
**Files:** `pkg/util/jobobject/jobobject_windows.go`, `pkg/util/jobobject/jobobject_other.go`, `pkg/util/jobobject/registry.go`, `pkg/util/jobobject/jobobject_windows_test.go`, `pkg/util/jobobject/registry_test.go`

The single source of truth for which jobs are live and who owns them.

Interface (`registry.go` is cross-platform; the OS calls sit in the `_windows` and `_other` files):

```go
const (
	OwnerKind_Block  = "block"  // a block shell: agent tab or run worker
	OwnerKind_RunCmd = "runcmd" // an engine plan command
)

type Owner struct {
	Kind string // OwnerKind_*
	Id   string // block id, or the run id that owns the dag
	Cmd  string // run commands: "Setup" | "Verify" | "Check" | "Final"
	Task string // run commands at a task's merge: the task id; else ""
}

func WithOwner(ctx context.Context, o Owner) context.Context
func OwnerFrom(ctx context.Context) (Owner, bool)

// Register records job (already attached to the process rootPid) as owned by o.
func Register(job uintptr, rootPid int, o Owner)

type LiveJob struct {
	Owner   Owner
	RootPid int
	Members []int // pids currently in the job
}

// LiveJobs queries every registered job's members under the registry lock. nil off Windows.
func LiveJobs() []LiveJob

// Members lists the pids in job (QueryInformationJobObject, JobObjectBasicProcessIdList, growing the buffer
// while the list is truncated). nil, nil off Windows.
func Members(job uintptr) ([]int, error)

var (
	ErrNotMember = errors.New("not a member of the job") // includes: no live job for that owner
	ErrGone      = errors.New("process has already exited")
)

// TerminateMember opens pid, checks IsProcessInJob against a live job registered for o on that same handle,
// then terminates through it (exit code 1). The open handle pins the process, so a reused pid cannot be hit.
func TerminateMember(o Owner, pid int) error
```

- `Close(job)` unregisters the job, taking the registry lock, before it closes the handle, so `LiveJobs` and `TerminateMember` never touch a closed or reused handle. Callers keep calling `Close` exactly as today; there is no separate Unregister.
- `KillTree` is unchanged.
- Off Windows, `Register` is a no-op, `LiveJobs` returns nil and `TerminateMember` returns `ErrNotMember`.
- An OpenProcess failure meaning "no such process" (ERROR_INVALID_PARAMETER) maps to `ErrGone`. Other OS errors are returned wrapped with the pid.

Tests (Windows-tagged ones in `jobobject_windows_test.go`; `WithOwner` / `OwnerFrom` in `registry_test.go`):
- `TestMembersIncludesOrphanedGrandchild`: start `cmd /c start /b <long-lived child>` (or the test binary re-executing itself as a helper), attach, wait until the middle process exits, and assert the grandchild's pid is still in `Members`.
- `TestLiveJobsDropsClosedJob`: Register, see it in `LiveJobs`, `Close`, and it is gone. Run `LiveJobs` in a loop on another goroutine during `Close` without error or panic.
- `TestTerminateMemberRefusesNonMember`: a process that is not in the job → `ErrNotMember`, and it is still running afterwards.
- `TestTerminateMemberGone`: a member that already exited → `ErrGone`.
- `TestTerminateMemberKills`: a member is terminated, and the job's other members survive.
- `TestOwnerContextRoundTrip`.

Run: `go test ./pkg/util/jobobject -run 'TestMembersIncludesOrphanedGrandchild|TestLiveJobsDropsClosedJob|TestTerminateMember|TestOwnerContextRoundTrip'`

### Task 3: pkg/resmon sampler, grouping, kill, and the RPC handlers
**Depends on:** Task 2
**Files:** `pkg/resmon/resmon.go`, `pkg/resmon/sample_windows.go`, `pkg/resmon/sample_other.go`, `pkg/resmon/group.go`, `pkg/resmon/group_test.go`, `pkg/resmon/kill.go`, `pkg/resmon/kill_windows_test.go`, `pkg/resmon/sample_windows_test.go`, `pkg/wshrpc/wshserver/wshserver_resmon.go`, `pkg/wshrpc/wshserver/wshserver_resmon_test.go`

Consumes `jobobject.LiveJobs`, `jobobject.TerminateMember`, `jobobject.Owner*` (Task 2) and the `wshrpc.ResMon*` types (Task 1). Do not edit `pkg/resmon/doc.go`.

Package API (consumed by the handlers only):

```go
// OwnerInfo is what the server knows about an owner that the registry does not.
type OwnerInfo struct {
	Kind    string // wshrpc.ResMonOwner_*
	Label   string
	Runtime string // claude | pi | ""
	Agent   bool   // the block's tab has session:agent: decides the core rule
}
type Resolver func(ctx context.Context, o jobobject.Owner) OwnerInfo

func Snapshot(ctx context.Context, resolve Resolver) wshrpc.ResMonSnapshotData
func Kill(ctx context.Context, resolve Resolver, data wshrpc.CommandResMonKillData) wshrpc.ResMonKillRtnData
func KillChildren(ctx context.Context, resolve Resolver, data wshrpc.CommandResMonKillChildrenData) wshrpc.ResMonKillRtnData
```

Design decisions:
- **Sampler:** a goroutine started by the first `Snapshot` call ticks every 2s. It exits when 10s pass with no `Snapshot` call; the next call restarts it. `Snapshot` returns the latest sample grouped (Ready false before the second tick). Each tick takes one toolhelp snapshot (`windows.CreateToolhelp32Snapshot`) for every pid's ppid and image name. It reads times, working set and create time only for tracked pids (job members plus the Arc group). Command lines are cached per (pid, create time) and dropped when that pair disappears. A process that cannot be opened keeps its row, with Cpu and Mem at -1 and no error. Total RAM comes from gopsutil `mem.VirtualMemory`, cores from `runtime.NumCPU()`.
- **Grouping (pure, in `group.go`, so it is testable without real processes):** one group per live job, plus the Arc group (`Key` "arc"). A job group's rows are its members in pre-order by ppid, rooted at the job's root pid; a member whose parent is outside the job becomes a root, after the main root, by create time. Apply the core and tag rule and the Arc role names from Global Constraints. Busy counting lives here as a small state over consecutive samples.
- **Killability:** `runcmd` and `arc` groups are read-only (`Killable` false) because `jobobject.KillTree` exits with code 1, which `killedFromOutside` (`pkg/orchestrate/plancmd.go`) does not recognise: a killed merge-time Verify would read as a real test failure and trigger bisect reruns.
- **Kill:** resolve the owner by `OwnerId` among live `OwnerKind_Block` jobs. If there is none, or its kind is not killable, the outcome is `refused`. If the pid is a core process (computed from a fresh membership read with the same core rule as the sampler), the outcome is `protected`. With `Tree`, also kill the pid's descendants within the same job (from a fresh `LiveJobs` plus toolhelp ppids), deepest first, never a core process. Every termination goes through `jobobject.TerminateMember`. Outcomes: the target hit `ErrGone` → `gone`; it hit `ErrNotMember` → `refused`; any other error → `failed`, with the OS text in Error; otherwise `killed`, with the count including the target. Error is set only for `failed`; the frontend writes every note's text.
- **KillChildren:** terminate every member of that owner's job except its core, using a fresh membership read; the outcome is `killed` with the count (0 is still `killed`).
- **Handlers** (`wshserver_resmon.go`): thin, passing a Resolver built from the store. Block → tab → `ownerRunForBlock` (`wshserver_ctx.go`) picks `runworker` or `agenttab`. The tab's `session:agent` gives Runtime and Agent. Labels follow Global Constraints; for runcmd owners, resolve the run by id. An unresolvable owner gets kind `agenttab` (for a block) and label "Closed tab", never an error.
- **Cost measurement:** `BenchmarkSample` in `sample_windows_test.go` starts 10 jobs of about 4 long-lived processes each and benchmarks one tick. Record the result (ms per tick, and the % of one core it means at a 2s interval) in the comment on the interval constant, as the reason the interval is cheap, and in this task's completion summary.

Tests:
- `group_test.go` (pure, fixed process tables): `TestGroupTreeOrder` (pre-order and depth), `TestCoreClaudeRoot` (claude.exe root = agent, conhost child = console), `TestCorePiLauncherChain` (cmd.exe → node.exe: launcher then agent; bash children not core), `TestCoreNonAgentBlockIsShellOnly`, `TestArcRoles` (each WebView2 flag maps to its role; wavesrv = Backend; non-job descendants of wavesrv under Backend), `TestArcWalkSkipsReusedPid` (a child older than its parent is excluded), `TestBusyNeedsThreeSamples` (2 hot samples are not busy, the 3rd is, one cool sample resets), `TestBusyMemory`, `TestUnavailableRowKept` (-1 values kept, totals skip them).
- `kill_windows_test.go` (real processes in a registered job): `TestKillTreeKillsSubtreeOnly`, `TestKillCoreIsProtected` (outcome `protected`, nothing terminated), `TestKillRefusesReadOnlyOwner` (an `OwnerKind_RunCmd` job and an Arc pid: `refused`, nothing terminated, Error empty), `TestKillGone`, `TestKillFailedCarriesOSText` (Error set only here), `TestKillChildrenSparesCore`.
- `wshserver_resmon_test.go`: `TestResMonResolverLabels` (agent tab name, run worker `title · Task 2`, run command `title · Verify`, an unresolvable block becomes "Closed tab").

Run: `go test ./pkg/resmon -run 'TestGroup|TestCore|TestArc|TestBusy|TestUnavailable|TestKill' && go test ./pkg/wshrpc/wshserver -run 'TestResMonResolverLabels' && go test ./pkg/resmon -run '^$' -bench BenchmarkSample -benchtime 20x`

### Task 4: Register every spawned job with its owner
**Depends on:** Task 2
**Files:** `pkg/shellexec/conninterface.go`, `pkg/shellexec/shellexec.go`, `pkg/shellexec/conninterface_windows_test.go`, `pkg/blockcontroller/shellcontroller.go`, `pkg/orchestrate/plancmd.go`, `pkg/orchestrate/plancmd_windows.go`, `pkg/orchestrate/plancmd_other.go`, `pkg/orchestrate/plancmd_owner_windows_test.go`, `pkg/orchestrate/basecheck.go`, `pkg/orchestrate/engine.go`, `pkg/orchestrate/final.go`, `pkg/orchestrate/land.go`, `pkg/orchestrate/verify.go`, `pkg/wshrpc/wshserver/wshserver_dag.go`

Consumes `jobobject.Register`, `jobobject.WithOwner`, `jobobject.OwnerFrom` and `jobobject.LiveJobs` (Task 2).

- **Block shells:** add `BlockId string json:"-"` to `shellexec.CommandOptsType`. `pkg/blockcontroller/shellcontroller.go` sets it to `bc.BlockId` before `StartLocalShellProc`. `MakeCmdWrap(cmd, cmdPty, isShell, blockId string)`: after a successful `jobobject.Attach`, call `jobobject.Register(job, pid, Owner{Kind: OwnerKind_Block, Id: blockId})` when blockId is not empty. The existing `Close` paths unregister.
- **Plan commands:** `runShellCmd(c *exec.Cmd, owner jobobject.Owner)` (windows and other). `execPlanCommandEnv` reads `jobobject.OwnerFrom(ctx)` and passes it on. After Attach, register only when an owner is present.
- **Each `runPlanCommand` / `RunSetup` / `runFinalCommand` call site** wraps its ctx with `jobobject.WithOwner(ctx, Owner{Kind: OwnerKind_RunCmd, Id: <the run id that owns the dag>, Cmd: <kind>, Task: <task id when it runs at a task's merge>})`. The sites: `basecheck.go` (Setup, Check), `engine.go` (Setup), `final.go` (Check, Setup, Final, and the final-stage whole-suite Verify that `runVerifyCommand` runs on the merged result, with Cmd "Verify" and no task), `land.go` (Check, Verify), `verify.go` (Verify, with the task id), and `wshserver_dag.go`'s `orchestrate.RunSetup` call (Setup). Do not change exit codes, timeouts or kill behaviour.
- Engine tests stub `runPlanCommand`; keep its signature so they still compile and pass unchanged.

Tests:
- `pkg/shellexec/conninterface_windows_test.go` `TestMakeCmdWrapRegistersBlockOwner`: start a long-lived command, `MakeCmdWrap(..., "block-1")`, and `LiveJobs` holds an Owner with Kind block and Id "block-1" whose members include the pid. After `Kill` + `Wait` it is gone. With blockId "" nothing is registered.
- `pkg/orchestrate/plancmd_owner_windows_test.go` `TestPlanCommandRegistersRunOwner`: `execPlanCommandEnv` with an owner ctx (Verify, task "3") runs a command that sleeps about 2s. While it runs, `LiveJobs` holds that owner; after it returns, the owner is gone.

Run: `go test ./pkg/shellexec -run 'TestMakeCmdWrapRegistersBlockOwner' && go test ./pkg/orchestrate -run 'TestPlanCommandRegistersRunOwner'`

### Task 5: Frontend model and store
**Depends on:** Task 1
**Files:** `frontend/app/cockpit/resmon.ts`, `frontend/app/cockpit/resmon.test.ts`, `frontend/app/cockpit/resmonstore.ts`, `frontend/app/cockpit/resmonstore.test.ts`

Consumes the generated types and `RpcApi.ResMon*Command` (Task 1). Pure logic in `resmon.ts`; the store and polling in `resmonstore.ts`. Task 6 renders exactly what these produce, so it holds no logic of its own.

`resmon.ts` exports:

```ts
export function fmtCpu(pct: number, digits?: 0 | 1): string; // 28.9% (digits 1, default) | 61% (0); -1 → "–"
export function fmtMem(bytes: number): string;                // 486 MB | 1.9 GB (binary units); -1 → "–"
export function fmtAge(createTs: number, now: number): string; // 45s | 42m | 3h 12m | 2d 4h; 0 → "–"
export function busyWords(s: ResMonSnapshotData): string | null; // "high CPU" | "high memory" | "high CPU and memory" | null
export function readout(s: ResMonSnapshotData | null): { visible: boolean; ready: boolean; cpu: string; mem: string; busy: string | null; aria: string };
export function orderGroups(groups: ResMonGroup[]): ResMonGroup[]; // arc first, the rest by cpu desc, ties by label
export function ownerKindWords(kind: string): string; // the group header: "App, read-only" | "Agent tab" | "Run worker" | "Run command, read-only"
export function ownerNoun(kind: string): string;      // notes: "Arc" | "agent tab" | "run worker" | "run command"
export function rowLabel(row: ProcessInfo): { name: string; cmd: string }; // Arc rows: role, then image + --type flag; others: image, then args without the executable path
export function subtreeSize(rows: ProcessInfo[], index: number): number; // descendants after rows[index] (deeper, contiguous)
export function killConfirmText(row: ProcessInfo, children: number): string;
// "Kill orchestrate.test.exe (18311)? It has no child processes." | "... and its 3 child processes?"
export function killChildrenTargets(g: ResMonGroup): ProcessInfo[]; // rows with no tag
export function killChildrenConfirmText(g: ResMonGroup): string;
// "Kill 5 processes under waveterm? claude.exe and its console keep running."
export function outcomeNote(r: ResMonKillRtnData, target: { name: string; pid: number } | null, g: ResMonGroup): { text: string; tone: "note" | "alert" };
// The single owner of every note's text: the backend sends only the outcome, the count, and the OS text for failed.
// killed, row: "Killed orchestrate.test.exe (18311)." when r.killed is 1, else
//   "Killed go.exe (18244) and 1 child process." / "... and 3 child processes." (children = r.killed - 1)
// killed, group (target null): "Killed 5 processes." / "Killed 1 process."
// gone: "node.exe (21890) had already exited."
// refused: "Not killed: pid 22590 no longer belongs to this <ownerNoun(g.ownerkind)>. The list refreshes in 2s."
// protected: "Not killed: claude.exe (14820) is the agent's own process. Kill children stops what it started."
// failed: "Could not kill jarvis.test.exe (22590): <r.error>. It is still running." (r.error with any trailing period trimmed)
// tone: "note" for killed and gone, "alert" for refused, protected and failed
export interface ResMonUi {
    cursor: string | null;                  // "<groupKey>" or "<groupKey>/<pid>"
    expanded: Record<string, boolean>;      // default: arc collapsed, every other group expanded
    confirm: { kind: "row"; key: string; pid: number } | { kind: "group"; key: string } | null;
    notes: Record<string, { text: string; tone: "note" | "alert" }>;
}
export type ResMonAction =
    | { type: "move"; delta: 1 | -1; groups: ResMonGroup[] }
    | { type: "toggle"; key?: string } // undefined = the cursor's group
    | { type: "askKill"; groups: ResMonGroup[] }     // x: a row cursor on a killable, untagged row
    | { type: "askChildren"; groups: ResMonGroup[] } // ⇧X: the cursor's group, when it is killable and has targets
    | { type: "cancel" }
    | { type: "note"; key: string; note: { text: string; tone: "note" | "alert" } }
    | { type: "close" }; // clears confirm, notes and cursor; keeps expanded
export function resmonReduce(ui: ResMonUi, a: ResMonAction): ResMonUi;
export function cursorRows(groups: ResMonGroup[], ui: ResMonUi): string[]; // the keys ↑↓ walk: each group header, then its rows when expanded
```

`resmonstore.ts` exports:

```ts
export const RESMON_POLL_MS = 2000;
export const resmonSnapshotAtom: PrimitiveAtom<ResMonSnapshotData | null>;
export const resmonOpenAtom: PrimitiveAtom<boolean>;
export const resmonUiAtom: PrimitiveAtom<ResMonUi>;
export function startResMonPolling(): () => void; // polls now and every RESMON_POLL_MS, skips while document.hidden or a fixture is pinned; returns the stop
export function dispatchResMon(a: ResMonAction): void;
export function confirmResMon(): Promise<void>; // runs the pending confirm (kill with tree: true, or kill-children), writes the outcome note, clears the confirm, reloads
```

- A poll error logs once per error streak and leaves the last snapshot in place; before any snapshot the readout reads `Arc –`.
- DEV-only seam in `resmonstore.ts`, shaped like `window.__narrationFeedFixture`: `window.__resmonFixture = { set(s: ResMonSnapshotData | null), killOutcome(r: ResMonKillRtnData), open(), clear() }`. `set` pins the snapshot (polling stops overwriting it; `null` pins "not loaded yet"). `killOutcome` makes the next confirm resolve to `r` without an RPC. `open` sets `resmonOpenAtom`. `clear` unpins, closes and resets the UI state.

Tests (`resmon.test.ts`, `resmonstore.test.ts`): the format edges (-1, 999 MB vs 1000 MB, 59s/60s, 24h), every busy combination, readout before ready and when unsupported (not visible), Arc pinned first however low its CPU, ties, the confirm texts (0, 1 and several children; the pi launcher chain names node.exe as the survivor), every outcome note (a row kill with 0, 1 and 3 children, a group kill of 1 and 5, refused naming each owner noun, protected, failed with and without a trailing period in the OS text), the reducer (move across a collapsed Arc group, toggle, `x` on a tagged row or in a read-only group does nothing, `⇧X` on a read-only group does nothing, close keeps expanded), and the store (the fixture pins the snapshot against a poll; `killOutcome` resolves a confirm without the RPC; polling skips while hidden).

Run: `npx vitest run frontend/app/cockpit/resmon.test.ts frontend/app/cockpit/resmonstore.test.ts`

### Task 6: Readout, popover, keybindings, docs and CDP scenarios
**Depends on:** Task 5
**Files:** `frontend/app/cockpit/resmonreadout.tsx`, `frontend/app/cockpit/resmonpopover.tsx`, `frontend/app/cockpit/hints-footer.tsx`, `frontend/app/view/agents/cockpithelp.tsx`, `frontend/app/cockpit/cockpit-root.tsx`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `frontend/app/store/keybindings/dispatcher.ts`, `frontend/app/store/keybindings/dispatcher.test.ts`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios.mjs`

Consumes everything `resmon.ts` and `resmonstore.ts` export (Task 5). Match the boards Main, Footer and States in the Prototype folder; they are the visual spec. Read DESIGN.md first.

- `resmonreadout.tsx`: `ResMonReadout()` is the button: pulse icon, `Arc`, CPU, `CPU`, `·`, memory. At rest it has an `edge-mid` border; open, an accent border and fill; busy, the `warning` pill with the busy words. Before ready it shows `Arc –` in muted text. It renders nothing when `readout().visible` is false. Clicking it toggles `resmonOpenAtom`. It carries `data-resmon-readout` and an aria-label from `readout().aria`.
- `hints-footer.tsx`: the readout sits at the right end (`ml-auto`) in all three postures (rest, leader, terminal-focused). Only the chips dim to 60% in the terminal-focused posture, never the readout: move the dim from the bar onto the chip container. On the Cockpit surface at rest the footer still renders nothing.
- `cockpithelp.tsx`: `HintsBar` renders `<ResMonReadout/>` after its `?` button.
- `resmonpopover.tsx`: `ResMonPopover()`, mounted once in `cockpit-root.tsx` beside the pollers, which also calls `startResMonPolling()` in an effect. It is fixed bottom-right (`right-3`, above the footer) and 700px wide, with a max height of 760px; it grows upward through `PopoverReveal` (origin "bottom right"), non-modal. It carries `role="dialog"`, `aria-label="Resource Manager"` and `data-resmon-popover`. Inside:
  - a header with `N owners · M processes` and `updated every 2s`;
  - the column header Process / PID / Running / CPU / Memory / (action);
  - per group (`data-resmon-group=<key>`): the chevron, the swatch (rt-claude or rt-pi by runtime; Arc and run commands in neutral text tokens), the label, `kind · N processes`, CPU, memory, and a `Kill children` button only when the group is killable and has targets;
  - rows (`data-resmon-row=<pid>`) indented 14px per depth with a `└` elbow; tagged rows show the tag chip, untagged rows in a killable group show the × button;
  - the inline confirm rows (`data-resmon-confirm`) with the texts from Task 5 and the buttons `Kill` / `Kill N` and `Cancel`;
  - the outcome notes (`role="status"` for the note tone, `role="alert"` with the error icon for the alert tone);
  - the loading body `Reading agent processes…` when the snapshot is null or not ready, and the empty body `No agent processes` / `Agent tabs, run workers and run commands show here while they run.` when only Arc's group exists;
  - the bottom hint strip ↑↓ move, ⏎ expand, x kill, ⇧X kill children, esc close.
  
  The cursor row is highlighted.
  - A pointerdown outside the popover and outside the readout closes it (non-modal: no backdrop, the click still reaches what it lands on).
- **Key ownership while open** (`dispatcher.ts`): `deriveKeyContext` counts `resmonOpenAtom` into `modalOpen`, as it already counts `petPeekOpenAtom` and `finalShotsViewerOpenAtom`. Every surface binding guarded by `!ctx.modalOpen` (`navigate`, `navigateStrict`, the Agent surface's arrows, Enter and Escape, the `g` chords) then stands down while the popover is open. The popover's own bindings in `bindings.ts` do not test `modalOpen`; they are active when `resmonOpenAtom` is set, focus is not editable, and no other overlay is open (`!anyModalOpen()` and the palette closed), so a palette opened over the popover keeps its own keys.
- `bindings.ts`: `g m` (`id: "go:resmon"`, group "Go to", label "Resource Manager", `when: navigate`) opens the popover. The popover bindings, in a "Resource Manager" group: `ArrowUp` / `ArrowDown` move; `Enter` confirms when a confirm is open, else toggles the cursor's group; `x` asks kill; `Shift:X` asks kill children; `Escape` cancels an open confirm, else closes.
- Tests: in `dispatcher.test.ts`, `deriveKeyContext().modalOpen` is true while `resmonOpenAtom` is set. In `bindings.test.ts`, with the popover open on the Agent surface and focus not editable, `Escape`, `Enter`, `ArrowDown` and `x` each resolve to the Resource Manager binding and not to an Agent-surface one; with it closed, `g m` is active and the popover bindings are not.
- `docs/keyboard-shortcuts.md`: add `g` `m` to the Go-to table, and a Resource Manager section listing the popover keys and saying that while the popover is open its keys take precedence.
- **Scenarios** in `scripts/cdp/scenarios.mjs` (one per board). They seed data only through `window.__resmonFixture`, with fixtures modelled on the canvas data: the Arc group of 9 rows; waveterm with the claude.exe agent, a conhost console and a go test subtree (bash.exe → go.exe → orchestrate.test.exe); a pi run worker with a `cmd.exe` launcher chain; a read-only Verify run command; obsidian-notes. Pin the viewport at 1600x950 first, and scope every query to a `data-resmon-*` container (or to the footer for the readout). Each teardown calls `__resmonFixture.clear()`. Keys: send them with `Input.dispatchKeyEvent`; if a probe shows they do not reach the page, dispatch the `KeyboardEvent` on `window` instead, and use the same path for every key step. Every step below performs its interaction, asserts its result, and takes a shot.
  - `resmon-footer`:
    1. Agent surface at rest: the readout is the footer's last child and reads `Arc 61% CPU · 7.4 GB`.
    2. Press `g`: the leader posture keeps the readout, and the continuation list shows `m Resource Manager`.
    3. Press `m`: the popover opens (`data-resmon-popover` present).
    4. Press Esc: the popover closes.
    5. With focus in an editable element, the chip container's computed opacity is 0.6 and the readout's is 1.
    6. Cockpit surface: the readout sits in the cockpit hints bar, after `?`.
    7. `busycpu`: the readout shows `high CPU`.
    8. `busymem`: it shows `high memory`.
    9. Both: it shows `high CPU and memory`.
    10. Pinned `null`: it shows `Arc –`.
    11. `supported: false`: there is no `data-resmon-readout` in either the footer or the cockpit hints bar.
  - `resmon-main`:
    1. Click the readout over the Agent surface: the popover is 700px wide and anchored bottom-right; Arc is first and collapsed; the other groups are sorted by CPU; core rows show their tags and other rows the ×; the Verify group shows no action.
    2. Click Arc's chevron: Arc expands, and a second click collapses it.
    3. ↓ moves the cursor highlight; ⏎ on the Arc header expands it.
    4. Click the × on `orchestrate.test.exe`: the confirm reads `Kill orchestrate.test.exe (18311)? It has no child processes.`
    5. Esc removes the confirm and leaves the popover open.
    6. Move the cursor onto `go.exe` and press `x`: the confirm reads `Kill go.exe (18244) and its 1 child process?` With `killOutcome({outcome: "killed", killed: 2})` armed, press ⏎: the note `Killed go.exe (18244) and 1 child process.` shows.
    7. Esc closes the popover.
  - `resmon-states`:
    1. Pinned `null`: the loading body.
    2. Arc only: the empty body.
    3. Cursor on the waveterm header, press ⇧X: the confirm reads `Kill 5 processes under waveterm? claude.exe and its console keep running.` Cancel closes it.
    4. Click waveterm's `Kill children` button: the same confirm opens. With `killOutcome({outcome: "killed", killed: 5})` armed, click `Kill 5`: the note `Killed 5 processes.` shows.
    5. Gone: arm `{outcome: "gone"}`, click the × on the pi worker's `node.exe` (21890), click `Kill`: the note `node.exe (21890) had already exited.` shows.
    6. Refused: arm `{outcome: "refused"}`, open a row's confirm with `x` and confirm with ⏎: the alert reads `Not killed: pid … no longer belongs to this run worker. The list refreshes in 2s.`
    7. Protected: arm `{outcome: "protected"}`, confirm a kill the same way: the alert names the agent's own process.
    8. Failed: arm `{outcome: "failed", error: "Access is denied."}` and confirm: the alert reads `Could not kill … : Access is denied. It is still running.`

Acceptance: `task check:ts` is clean, and `npx vitest run frontend/app/cockpit frontend/app/store/keybindings` passes. `ARC_FINAL_OUT=<a temp dir> node scripts/cdp/final-verify.mjs resmon-main resmon-footer resmon-states` exits 0; it starts its own dev app from this tree, and the Final line runs the same three scenarios.
