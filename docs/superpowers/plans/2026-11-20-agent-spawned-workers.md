# Agents launch workers

**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\0c8b932c\docs\superpowers\specs\2026-11-20-agent-spawned-workers-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/... ./cmd/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/... ./cmd/...`
**Final:** `node scripts/cdp/final-verify.mjs agent-workers agent-tree cockpit-launch-stays agent-start-failed`

An agent runs `wsh agents start "<task>"` and gets back the tab id of a **worker**: an ordinary claude or pi agent
in its own tab, nested under its parent in the Agent tree. When the worker goes idle after a turn its parent
gave it, Arc pushes the parent a one-line notice; the parent reads the answer with `wsh agents read`/`wait`. Then
the worker's process stops and its tab stays; a message from the user or the parent resumes it. Workers go
through the memory gate on every start and resume.

New code lives in a new package `pkg/agentworker` (worker meta, launch composition, gate admission, lifecycle,
resume, boot). The wshrpc surface lands first (Task 1) so no later task touches generated files, and the worker
helpers land as their own small task (Task 5) so the start command, the lifecycle and resume build beside each
other.

## Decisions beyond the design

1. **CLI shape.** `wsh agents start [prompt] [--file <path>] [--harness claude|pi] [--model <id>]
   [--reasoning <level>] [--system-prompt <text>] [--append-system-prompt <text>] [--tools <list>]
   [--permission-mode <mode>] [--worktree <branch>] [--json]`. The prompt is the argument or `--file`, exactly
   one, as `wsh agents send` takes it. The spec's "effort" option is `--reasoning`, because `--effort` already
   means an initiative on `wsh runs start`. Stdout is the worker's full tab id and nothing else, so a parent can
   capture it; `--json` prints the RPC's return.
2. **Per-harness mapping.** The model goes through `runroute.Resolve`, the route code `wsh runs start` uses.
   Every other option maps to the harness's own flag as its `--help` prints it. An option the chosen harness
   has no flag for is refused with an error naming it, never dropped. Pi has no permission modes: a pi worker
   refuses an explicit `--permission-mode` and takes no default.
3. **Permission ladder.** `plan < dontAsk < default < acceptEdits < auto < bypassPermissions`. A claude worker
   defaults to its parent's rung and may name a stricter one. A looser one is refused. A pi parent counts as
   `bypassPermissions`, since pi asks no permission. A claude parent with no reported mode counts as `default`.
4. **Model default.** With the parent's harness, the worker takes the parent's reported model when
   `runroute.Resolve` accepts it. Otherwise it gets the harness default.
5. **Where it works.** The parent's directory is its reported cwd, or its block's `cmd:cwd` when it has none.
   `--worktree <branch>` calls `gitinfo.CreateWorktree` on that directory (a new branch off its HEAD). A branch
   that already exists is refused, because the design says a new branch.
6. **Gate key.** `memgate.Key{Project: orchestrate.MemProjectKey(cwd), Role: memgate.RoleWorker}`. A worker
   shares learned peaks with the same project's run workers: the same kind of work, with the same 3.5 GB
   default. Its Tag is `{Role: RoleWorker, TabId: <worker tab>}` with no RunId, so the loop may pause it and no
   run event is written. Admission goes through the non-blocking `TryAdmitOrWhy` (Task 2). Its refusal says how
   much is free, what the worker needs and which claims hold memory. The gate's "an empty book always admits"
   rule still applies. **Order:** the start opens the worker's tab unstarted on a ctx that collects updates,
   asks the gate with that tab's id, and on a refusal deletes the tab before the one flush. The UI therefore
   receives the create and the delete together and never shows the tab.
7. **State lives in meta, no new waveobj type.**
   - Tab meta `agent:parenttab` (the parent's tab id) marks a worker.
   - Block meta holds `agent:sessionid`, `agent:baseargs` (existing), `agent:noticeowed` (the running or last
     turn was the parent's and is not yet noticed) and `agent:noticeheld` (the notice is due but the parent had
     no process).
   - **Stopped** means the block is disarmed (`controller: ""`), as `jarvis.StopRunWorker` disarms. Every worker
     block has `cmd:keeponexit`, so its tab outlives its process.

   The keys are Go consts in `pkg/agentworker`. The frontend reads `agent:parenttab` as a literal, as it reads
   `session:*`. No migration is needed.
8. **The notice.** One line. It opens with `agentmsg`'s envelope prefix, so `agentmsg.IsAgentMessage` recognizes
   it and transcripts do not count it as the user's words. It names the worker and its tab and says to read the
   answer with `wsh agents read <tab>`. It is delivered with `orchestrate.SendToSession`.
9. **A held notice keeps no process.** A worker whose notice is held stops after the same 5 idle minutes. The
   notice is delivered at the parent's first status report while its shell runs, and the worker stops then if
   it is still running. When a notice comes due and the parent's tab is gone, it is dropped. There is no
   tab-close hook: a closed parent never reports again.
10. **Restart.** A worker counts as mid-task at boot when it is not stopped and its notice is owed (its
    parent's turn is unanswered). It resumes with `jarvis.ResumeNudge`. Any other running worker is disarmed. A
    user-typed turn cut off by a restart stays stopped until a message arrives. A boot resume the gate refuses
    leaves the worker stopped with its notice still owed, and the refusal is logged. Event history does not
    survive a restart, so the boot pass publishes an idle `agent:status` for every stopped worker so that the
    roster still lists it.
11. **Resuming on a message.** The message itself is the resume's prompt:
    `<bin> --resume <session> <baseargs> <message>` (`jarvis.ResumeWorkerArgs`). The baseargs are the first
    start's own launch flags, so the prompt cache prefix still matches. A send from the parent stays enveloped,
    as today.
12. **No close command.** The user closes a worker's tab in the cockpit, and the parent removes a worktree branch
    with git.
13. **The stopped look.** `AgentVM` gains a `stopped` flag rather than a new `AgentState`, so every existing
    state switch stays intact. The tree row and header pill read "stopped". The tab shows the transcript, and
    the agent box stays usable because a send resumes the worker.
14. **Launch primitive.** `jarvis.OpenAgentTab` (create the tab under its own name, set block and tab meta,
    which carries the caller's `session:project` tag) and `jarvis.StartAgentTab` (force-start the controller).
    Run workers, workers and the UI all go through them. The UI reaches them via `LaunchAgentTabCommand` with
    its own command line and tab name. That command returns the tab and block ids even when the start fails,
    with the refusal in `starterror`, because the UI keys "failed to start" by block id and keeps the tab.
    Publishing the initial "working" status remains a step for runs and workers only: a UI launch keeps its
    pending roster row.
15. **System prompts ride the command line** on every start and resume. Their combined size is capped at
    jarvis's inline prompt cap (16 KB) and refused past it. A long task prompt still moves to a file through
    `jarvis.LaunchPrompt`.
16. **Snapshot store.** A snapshot app refuses to start or resume a worker whose directory is outside its scratch
    dir (`wavebase.SnapshotMayStart`), as it refuses prompts (Tasks 6 and 8).
17. **A worker's own exit** reaches `pkg/agentworker` through a new hook var in `pkg/jarvis/onexit.go`, as
    `RunWorkerExitHook` reaches orchestrate. jarvis cannot import agentworker, which imports orchestrate and
    jarvis. The hook fires for every agent exit, so agentworker acts only on tabs with `agent:parenttab`.

### Task 1: The backend launch primitive and the wshrpc surface
**Depends on:** none
**Files:** `pkg/jarvis/runexec.go`, `pkg/jarvis/runexec_test.go`, `pkg/jarvis/resume_test.go`, `pkg/jarvis/designprompt_test.go`, `pkg/jarvis/claudetrust.go`, `pkg/jarvis/claudetrust_test.go`, `pkg/wshrpc/wshrpctypes_agents.go`, `pkg/wshrpc/wshserver/wshserver_agentlaunch.go`, `pkg/wshrpc/wshserver/wshserver_agentlaunch_test.go`, `pkg/wshrpc/wshserver/wshserver_agentstart.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**What to build:** move the tab-opening part of `SpawnRunWorker`/`StartRunWorker` into one backend primitive.
Run workers keep using it unchanged: spawning still records before it starts. Export the two helpers a worker
launch needs. Add the wshrpc surface the rest of the plan uses, then run `task generate`.
- `LaunchAgentTabCommand` (in `wshserver_agentlaunch.go`) is fully built: it opens and, when asked, starts.
- `AgentsStartCommand` is declared with a handler in `wshserver_agentstart.go` that returns the error
  "wsh agents start is not built yet". Task 6 replaces it.

**Interfaces:**
```go
// pkg/jarvis
type AgentTabSpec struct {
    WorkspaceId, TabName string
    TabMeta, BlockMeta   waveobj.MetaMapType // the caller's session:project tag goes in TabMeta
}
func OpenAgentTab(ctx context.Context, spec AgentTabSpec) (tabId, blockId string, err error) // deletes the tab on a failure; broadcasts when ctx collects no updates
func StartAgentTab(ctx context.Context, tabId, blockId string) error                         // force-starts the controller, publishes nothing
func LaunchPrompt(prompt, sessionId string) (string, error)                                    // today's launchPrompt, exported
func EnsureClaudeDirTrusted(cwd string) error                                                  // today's ensureClaudeDirTrusted, exported

// pkg/wshrpc
const AgentsState_Stopped = "stopped"
LaunchAgentTabCommand(ctx, CommandLaunchAgentTabData) (*CommandLaunchAgentTabRtnData, error)
type CommandLaunchAgentTabData struct {
    WorkspaceId string `json:"workspaceid"`; TabName string `json:"tabname"`
    TabMeta waveobj.MetaMapType `json:"tabmeta"`; BlockMeta waveobj.MetaMapType `json:"blockmeta"`
    Start bool `json:"start"` // false for a terminal, which starts when its pane first opens
}
type CommandLaunchAgentTabRtnData struct {
    TabId string `json:"tabid"`; BlockId string `json:"blockid"`
    StartError string `json:"starterror,omitempty"` // the start's refusal; the tab is kept
}
AgentsStartCommand(ctx, CommandAgentsStartData) (*CommandAgentsStartRtnData, error)
type CommandAgentsStartData struct {
    FromORef string `json:"fromoref"`; Prompt string `json:"prompt"`
    Harness, Model, Reasoning, SystemPrompt, AppendSystemPrompt, Tools, PermissionMode, Worktree string // json: lowercase, omitempty
}
type CommandAgentsStartRtnData struct { TabId string `json:"tabid"`; Harness string `json:"harness"`; Cwd string `json:"cwd"` }
```

**Acceptance:**
- the existing run-worker spawn tests pass. A run worker's tab, block meta and start order are unchanged: it is
  recorded before its process starts, and a spawn that fails part-way removes its tab
- `LaunchAgentTabCommand` makes a tab named `tabname` whose first block carries the given block meta and whose
  tab meta carries exactly the given keys. With `start` it starts the controller
- a start refusal returns the tab and block ids with `starterror` set, and the tab is kept. A failure before the
  start returns an error and leaves no tab
- `task generate` output is committed, and `AgentsStartCommand` returns its not-built error

### Task 2: The memory gate says why it refused
**Depends on:** none
**Files:** `pkg/memgate/gate.go`, `pkg/memgate/gate_test.go`, `pkg/memgate/reconcile_test.go`, `pkg/memgate/reconcile_other_test.go`

**What to build:** a non-blocking admission that, when it refuses, returns what the refusal needs to say. Callers
of `TryAdmit` are unchanged. `Tag` gains `TabId` for a tree an agent started outside any run. Such a tag has
no RunId, so it writes no run event and is never marked held. The positional `Tag{...}` literals in the memgate
tests gain the field.

**Interfaces:**
```go
type Tag struct{ RunId, TaskId, Role, TabId string }
type Holder struct { Tag Tag; Use uint64 }          // Use: its job's last reading, its estimate while starting
type Shortfall struct { Free, Need uint64; Holders []Holder } // Holders largest first
func TryAdmitOrWhy(r Request) (*Claim, *Shortfall)  // exactly one is non-nil
```

**Acceptance:**
- with free memory below the estimate and a live claim in the book, `TryAdmitOrWhy` returns a nil claim and a
  shortfall that lists that claim's tag with its use, largest first. With room, or with an empty book, it
  admits as `TryAdmit` does
- a refused request with no RunId leaves the book's held set empty and emits no event
- a claim whose Tag role is `RoleWorker` and that carries a TabId is pausable by the loop, as a run worker's is

### Task 3: A worker's command line
**Depends on:** none
**Files:** `pkg/agentworker/launch.go`, `pkg/agentworker/launch_test.go`

**What to build:** the pure composition of a worker's argv from the session options and its parent's facts,
following decisions 2, 3, 4 and 15. It offers no pass-through of raw arguments, so no option can drop claude's
hooks or pi's extensions (for example `--bare`, `--no-extensions`). Check each flag name against `claude --help`
and `pi --help` on this machine. `jarvis.ResumeWorkerArgs` appends the prompt straight after BaseArgs, and this
task cannot change it, so `ComposeLaunch` orders BaseArgs so that a variadic flag (claude's `--tools`) is never
last.

**Interfaces:**
```go
type SessionOptions struct { Harness, Model, Reasoning, SystemPrompt, AppendSystemPrompt, Tools, PermissionMode string }
type Parent struct { Harness, Model, PermissionMode string } // from the parent's latest agent status
type Launch struct { Harness, Bin string; BaseArgs []string }  // BaseArgs: every launch flag, no session id, no prompt
func ComposeLaunch(opts SessionOptions, parent Parent) (Launch, error)
func FirstStartArgs(l Launch, sessionId, prompt string) []string
```

**Acceptance:**
- harness and model default to the parent's (decision 4). A model `runroute.Resolve` rejects is an error
- for a claude worker the permission mode defaults to the parent's rung. A stricter one is accepted, a looser
  one is refused with both modes named, and a pi parent allows any. For a pi worker, a permission mode is
  refused
- every option a harness has a flag for appears in BaseArgs. One it lacks is refused, naming the option and the
  harness
- with `--tools` given, BaseArgs never end in a variadic flag or its values. A prompt appended to BaseArgs, as
  the first start does and as `ResumeWorkerArgs` does, is never read as a tool name
- system prompt plus appended system prompt over 16 KB is refused

### Task 4: UI launches go through the backend
**Depends on:** Task 1 (uses LaunchAgentTabCommand)
**Files:** `frontend/app/cockpit/cockpit-actions.ts`, `frontend/app/cockpit/cockpit-actions.test.ts`, `frontend/app/view/agents/session-models/sessionsidebarmodel.ts`, `frontend/app/view/agents/agentcontrollerstore.ts`, `scripts/cdp/scenarios-agent-start-failed.mjs`

**What to build:** `launchAgent` and `duplicateSession` each open their tab with one `LaunchAgentTabCommand`
instead of `WorkspaceService.CreateTab` followed by `SetMeta` calls and a resync.
- Each keeps the command line it builds today (`buildLaunchMeta`, `buildDuplicateBlockMeta`), its tab name and
  its tab meta. `launchAgent` keeps the free-text command, the flag catalog and every runtime. Duplicate names
  the tab after the source and copies only the session keys the source has.
- A terminal launches with `start: false`.
- A returned `starterror` is set on the block's start-error atom (`getStartErrorAtom`) and thrown, as the resync
  path does today. The tab stays.
- The pending roster row, focus and landing behaviour stay as they are.
- The `agent-start-failed` scenario makes its tabs the way the new path does.

**Acceptance:**
- the New Agent modal launch keeps a quoted argument whole in `cmd:args` (scenario `agent-tree`, its quoted
  startup command step)
- a launch from the Cockpit stays on the Cockpit and its row appears (scenario `cockpit-launch-stays`)
- a refused start reads "failed to start" (scenario `agent-start-failed`)
- Duplicate opens a fresh session with the source's launch flags and not its task (scenario `agent-tree`, its
  Duplicate step)

### Task 5: The worker's meta and helpers
**Depends on:** Task 2 (TryAdmitOrWhy, Tag.TabId)
**Files:** `pkg/agentworker/worker.go`, `pkg/agentworker/worker_test.go`

**What to build:** the shared vocabulary of a worker (decision 7) and the helpers that the start, the lifecycle,
resume and the boot pass all use.
- `Admit` asks the gate (decision 6) and words a refusal as "memory is short", with free memory, the worker's
  need and each holder (a run task by run and task id, a worker by tab id).
- `Bind` binds a claim to the block's job, with a cache expiry of the block's transcript's last write plus
  5 minutes.
- `PublishStatus` reads everything it publishes from the stored tab and block: the harness from tab
  `session:agent`, the cwd from block `cmd:cwd` and the transcript from block `agent:transcriptpath`. It
  publishes the retained `agent:status` the roster keys off.

**Interfaces:**
```go
const MetaParentTab = "agent:parenttab"; MetaSessionId = "agent:sessionid"
const MetaNoticeOwed = "agent:noticeowed"; MetaNoticeHeld = "agent:noticeheld"
func ParentOf(tab *waveobj.Tab) string                 // "" for a tab that is not a worker
func SetNoticeOwed(ctx context.Context, blockId string, owed bool) error
func Admit(cwd, tabId string) (*memgate.Claim, error)  // Key{MemProjectKey(cwd), RoleWorker}, Tag{Role: RoleWorker, TabId: tabId}
func Bind(c *memgate.Claim, blockId string)
func PublishStatus(ctx context.Context, blockId, state string) error
```

**Acceptance:**
- `Admit` with the gate refusing returns an error naming free memory, the need and each holder, and leaves no
  claim. With room it returns a claim tagged with the tab id
- a bound claim's cache expiry is the transcript's modification time plus 5 minutes. It reads as unknown
  while there is no transcript
- `PublishStatus` publishes the given state with the block's harness, cwd and transcript path, read from meta
- `ParentOf` and `SetNoticeOwed` round-trip through tab and block meta

### Task 6: `wsh agents start`
**Depends on:** Task 1 (OpenAgentTab, StartAgentTab, LaunchPrompt, EnsureClaudeDirTrusted and the RPC types; shares `wshserver_agentstart.go`), Task 3 (ComposeLaunch), Task 5 (Admit, Bind, PublishStatus and the meta keys)
**Files:** `pkg/agentworker/start.go`, `pkg/agentworker/start_test.go`, `pkg/wshrpc/wshserver/wshserver_agentstart.go`, `pkg/wshrpc/wshserver/wshserver_agentstart_test.go`, `cmd/wsh/cmd/wshcmd-agents.go`, `cmd/wsh/cmd/wshcmd-agents_test.go`, `cmd/wsh/cmd/wshcmd-agenthook.go`, `skills/runs/SKILL.md`, `cmd/wsh/cmd/claude-mod/skills/runs/SKILL.md`

**What to build:** the command end to end, from the CLI in decision 1 to a running worker tab.
1. **Who calls.** The handler resolves the caller from `FromORef`, as `senderTab` does. It refuses a caller that
   a run started (its block has `agent:runid`, or a run lists its tab), saying that runs delegate through their
   plan.
2. **The launch.** It reads the parent's latest status, composes the launch, and settles the directory or
   worktree. A snapshot app refuses a directory outside its scratch dir (decision 16).
3. **The worker block** carries exactly this launch meta. It is not `makeWorkerBlockMeta`, which sets
   `ARC_RUN_AGENT`: a worker is an ordinary agent that asks in its own terminal.
   - `view: term`, `controller: cmd`, `cmd` and `cmd:args` (`FirstStartArgs`), `agent:baseargs`,
     `cmd:shell: false`
   - `cmd:jwt: true`, so its hooks and a nested `wsh agents start` reach this wavesrv
   - `cmd:cwd`, `cmd:keeponexit: true`
   - `cmd:env` holding only `consult.PromptCacheTTLEnv` = `consult.ShortSessionCacheTTL`
   - `agent:sessionid`, `agent:noticeowed: true`
4. **The tab** carries `session:agent`, `session:project` (the parent's) and `agent:parenttab`, in the parent's
   workspace.
5. **The gate.** Open the tab unstarted on a ctx that collects updates, `Admit` with its id, and delete the tab
   on a refusal before the single flush (decision 6).
6. **The start.** Then `StartAgentTab`, `Bind` and `PublishStatus(working)`. A start that fails releases the
   claim.
7. **The CLI.** `agentsWaitUntil` treats `stopped` as settled, and `--until idle` is met by `stopped` too: Task 8
   makes the roster report it.
8. **Discovery.** Add `wsh agents start` to the session-start context line beside the other `wsh agents`
   commands, and to the runs skill's command list, worded neutrally. Run `task sync:claudemod`.

**Interfaces:** `func agentworker.Start(ctx context.Context, data wshrpc.CommandAgentsStartData) (*wshrpc.CommandAgentsStartRtnData, error)`.

**Acceptance:**
- from an agent tab, `wsh agents start "task"` prints a new tab id and nothing else. That tab is in
  `wsh agents list` as working, in the parent's project, with `agent:parenttab` set to the caller. Its block
  runs the composed argv with the prompt and its session id, in the parent's directory
- the worker block has `cmd:jwt` true, `cmd:shell` false, `cmd:keeponexit` true, and the 5-minute
  `consult.PromptCacheTTLEnv` in `cmd:env`. It has no `ARC_RUN_AGENT`
- `--worktree new-branch` runs the worker in a new worktree on that branch off the parent's HEAD. An existing
  branch is refused
- a caller with `agent:runid` on its block is refused with the run-delegation message, and no tab is made
- in a snapshot app, a start whose directory is outside the scratch dir is refused, and no tab is made
- with the gate refusing, the command fails at once with the shortfall message. No tab remains and no claim is
  left
- a start whose controller fails to start releases its claim
- a worker's claim is bound to its block and pausable (Tag role `RoleWorker`). Starting workers leaves the run
  worker slot count unchanged
- `wsh agents wait` returns for a target that reads `stopped`, under no `--until` and under `--until idle`
- the session-start context and `skills/runs/SKILL.md` name `wsh agents start`

### Task 7: The done notice and the worker's stop
**Depends on:** Task 5 (the meta keys, ParentOf, SetNoticeOwed)
**Files:** `pkg/agentworker/lifecycle.go`, `pkg/agentworker/lifecycle_test.go`, `pkg/agentmsg/agentmsg.go`, `pkg/agentmsg/agentmsg_test.go`, `pkg/wshrpc/wshserver/wshserver.go`, `pkg/jarvis/onexit.go`, `cmd/server/main-server.go`

**What to build:** what happens when a worker's turn ends, following decisions 8, 9 and 17. `publishEvent` hands
each agent status to `agentworker.NoteStatus`. The rules:

```
worker W idle (parent P):
  W has a worker of its own still running  -> nothing yet (W stays running and receives their notices)
  W's notice is owed:
      clear owed
      P's tab gone          -> drop the notice
      P's shell is running  -> deliver the notice to P, then StopWorker(W)
      otherwise             -> set held on W
  notice not owed           -> nothing (the idle sweep handles it)
W asking                    -> nothing
P reports a status while its shell runs -> deliver every held notice of P's workers, clear held,
                                           stop each of those workers that is still running and idle
a worker stops              -> re-check its parent W as if W had just gone idle
idle sweep (each minute)    -> stop every running worker idle for 5 minutes with no notice owed and no
                               running worker of its own
```

- `StopWorker` disarms the block as `jarvis.StopRunWorker` does and ends the process. The tab stays because of
  `cmd:keeponexit`, and the claim is released when the job closes.
- A worker whose process exits on its own is disarmed the same way, so a terminal remount never replays its
  first prompt. It is reached through a new hook var in `pkg/jarvis/onexit.go`, which `pkg/agentworker` sets at
  init and which ignores tabs without `agent:parenttab` (decision 17).
- Start the sweep in `main-server.go`.

**Interfaces:** `func StopWorker(ctx context.Context, tabId string) error`,
`func NoteStatus(ctx context.Context, data *baseds.AgentStatusData)`, `func StartIdleSweep(ctx context.Context)`,
`func agentmsg.WorkerNotice(workerName, workerTabId string) string`, and the new hook var
`jarvis.AgentExitHook func(ctx context.Context, tabId, blockId string)`.

**Acceptance:**
- a worker going idle with its notice owed, under a parent whose shell runs, delivers exactly one notice to the
  parent's block. `agentmsg.IsAgentMessage` is true for it and it names the worker's tab. Then the worker is
  disarmed and its tab kept
- a turn with no notice owed (the user typed it) delivers nothing. An asking worker delivers nothing
- with the parent's shell not running, the notice is held. The parent's next status report while running
  delivers it once
- with the parent's tab gone, nothing is delivered and nothing is held
- a worker with a running worker of its own does not notify or stop. It does both once that child has stopped
  and it is idle
- the sweep stops a worker that has been idle 5 minutes with nothing owed, and leaves one idle 4 minutes alone
- a worker whose process exits on its own ends up disarmed. An exiting agent tab that is not a worker is left
  as it was

### Task 8: Reaching a stopped worker
**Depends on:** Task 5 (the meta keys, Admit, Bind, PublishStatus, SetNoticeOwed)
**Files:** `pkg/agentworker/resume.go`, `pkg/agentworker/resume_test.go`, `pkg/wshrpc/wshserver/wshserver_agentmsg.go`, `pkg/wshrpc/wshserver/wshserver_agentmsg_test.go`

**What to build:** a stopped worker stays reachable by `wsh agents` and by the cockpit (decision 11).
- The roster lists a worker tab whose shell is not running as `AgentsState_Stopped`, with its harness, project
  and cwd.
- `AgentsReadCommand` reads its transcript from `agent:transcriptpath`.
- `AgentsSendCommand` to a stopped worker resumes it with the enveloped message as the resume's prompt.
  `AgentPromptCommand` to a stopped worker resumes it with the person's text.
- Every resume asks the gate and fails at once with the shortfall, as a start does. A snapshot app refuses to
  resume a worker outside its scratch dir (decision 16).
- A send whose sender is the worker's parent sets `agent:noticeowed`, whether the worker was stopped or running.

**Interfaces:** `func ResumeWorker(ctx context.Context, tabId, prompt string) error`. It re-arms the block
(`controller: cmd`, `cmd:args` = `jarvis.ResumeWorkerArgs(harness, agent:sessionid, agent:baseargs, prompt)`),
starts it with `jarvis.StartAgentTab`, binds the claim and publishes working.

**Acceptance:**
- the roster shows a disarmed worker as stopped, and `AgentsReadCommand` returns its last answer from its
  transcript
- a send from the parent to a stopped worker starts its process with `--resume <its session>`, its stored
  launch flags and the enveloped message. It sets the notice owed and reports a turn started
- a send from any other agent resumes the worker without setting the notice owed
- a cockpit prompt to a stopped worker resumes it with the text as the person's message
- with the gate refusing, the send fails at once with the shortfall message and the worker stays stopped
- in a snapshot app, a resume outside the scratch dir is refused and the worker stays stopped

### Task 9: Workers across an app restart
**Depends on:** Task 7 (StopWorker; shares `main-server.go`), Task 8 (ResumeWorker)
**Files:** `pkg/agentworker/boot.go`, `pkg/agentworker/boot_test.go`, `cmd/server/main-server.go`

**What to build:** a boot pass following decision 10, run in `main-server.go` beside `ResumeInterruptedLeads`,
before the frontend can resync a block. It resumes each mid-task worker with `jarvis.ResumeNudge`. It disarms
every other armed worker. It publishes an idle status (`PublishStatus`) for each stopped worker so that the
roster lists it.

**Interfaces:** `func ResumeWorkersAtBoot(ctx context.Context)`.

**Acceptance:**
- an armed worker with its notice owed is resumed in its own session with the nudge
- an armed worker without an owed notice ends disarmed, not started
- a worker that was already stopped stays stopped and is published idle with its cwd and transcript path
- a boot resume the gate refuses leaves the worker disarmed, with its notice still owed

### Task 10: Workers in the Agent tree
**Depends on:** Task 4 (shares `sessionsidebarmodel.ts`)
**Files:** `frontend/app/view/agents/session-models/sessionsidebarmodel.ts`, `frontend/app/view/agents/session-models/sessionviewmodel.ts`, `frontend/app/view/agents/session-models/sessionviewmodel.test.ts`, `frontend/app/view/agents/liveagents.ts`, `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/agentsviewmodel.test.ts`, `frontend/app/view/agents/agenttreemodel.ts`, `frontend/app/view/agents/agenttreemodel.test.ts`, `frontend/app/view/agents/agenttree.tsx`, `frontend/app/view/agents/agentstateview.ts`, `frontend/app/view/agents/agentstateview.test.ts`, `scripts/cdp/scenarios-agent-workers.mjs`, `scripts/cdp/scenarios.mjs`

**What to build:**
- The roster carries `agent:parenttab` from tab meta as `AgentVM.parentTabId`. A worker that is a tab with
  `agent:parenttab` whose term block is not armed (`controller` is not `cmd`) also carries `AgentVM.stopped`.
- `buildAgentTree` nests each worker under its parent's row, recursively with no depth limit, in roster order. A
  worker whose parent is not in the roster is a top-level row.
- A stopped worker's row and header read "stopped" in the muted tone. Its tab shows its transcript, and its
  agent box is not disabled.
- The nesting changes no row's focus order beyond placing the child under its parent.
- Add scenario `agent-workers` as a page fixture modeled on `agent-subagents`.

**Acceptance:**
- `buildAgentTree` puts a worker under its parent, a worker's worker under it, and a worker with a missing
  parent at the top level of its project. Group counts include workers
- scenario `agent-workers` shows a parent with a working worker, a stopped worker nested under it, and a second
  level below that worker, with a screenshot of the tree. Another step shows the stopped worker focused: its
  pill reads "stopped" and the box is enabled
