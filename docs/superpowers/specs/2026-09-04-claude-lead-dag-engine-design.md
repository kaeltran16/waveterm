# Claude Code as an orchestrator lead on the DAG engine — design

**Date:** 2026-09-04
**Status:** approved, not yet implemented

## Problem

"Orchestrator" means two different machines depending on a dropdown, and the dropdown is the model
picker.

`BuildOrchestratePrompt` (`pkg/jarvis/run.go:353`) forks on runtime:

- `runtime == "pi"` — the lead is told to create pi-tasks records and run `wsh jarvis dag
  import-tasks`. This is the only path that produces a `TaskGroup`, and therefore the only path that
  reaches `pkg/orchestrate` at all: the engine, managed worktrees, the merge gate, retry and
  escalation, the digest.
- `claude` / `codex` / `opencode` — the lead is told to "execute it adaptively by dispatching your own
  subagents". No `TaskGroup`, no engine, no worktrees.

Nothing structural forbids a Claude lead from driving the engine; the fork is a prompt string. The
goal is to make the engine available to a Claude Code lead as a first-class option, keep the adaptive
path available to both runtimes, and make the choice explicit instead of implied by a model id.

## What already works

Scope depends on this, so it is stated first. A Claude lead today already has complete CLI access to
the engine:

- `dagIds` (`cmd/wsh/cmd/wshcmd-jarvisdag.go:191`) resolves channel + run from the caller's block
  through `JarvisCtxCommand(BlockORef)`. It is runtime-neutral.
- Every `wsh jarvis dag` subcommand — `submit`, `status`, `merge`, `answer`, `asks`, `escalate`,
  `approve`/`sendback`/`retry`/`skip`/`cancel` — therefore works from a Claude session unchanged.
- `DagSubmitCommand` (`wshserver_dag.go`) validates the owner route and each task route through
  `validateHarness(..., harness.OperationRunWorker)`. `claude` is `RunWorkerCapable`
  (`pkg/harness/catalog.go:37`), so a Claude-owned DAG passes.
- Children of a DAG already run any runtime: `WorkerRoute` is validated the same way at both
  `CreateRunCommand` (`wshserver_runs.go:313`) and `DagSubmitCommand` (`wshserver_dag.go:60`), and
  `effectiveTaskRoute` (`engine.go:487`) resolves each child's pin from it. Claude workers under a pi
  lead is a shipped, first-class gesture.

Three things are missing, and only three.

1. **The prompt never tells it to.** The runtime fork above.
2. **No wake.** `NotifyLead` (`pkg/orchestrate/control.go:117`) delivers every control event by
   writing `<sessionId>.json` into `$WAVETERM_PI_CONTROL_DIR`, which pi's in-process extension
   watches (`pi/extensions/waveterm-tools.ts:290`). The session id comes from
   `baseds.AgentStatusData.SessionID`, which the Claude `agent-hook` never populates
   (`wshcmd-agenthook.go:430` builds the struct without it). Every notify for a Claude lead therefore
   returns `ControlFailureUnavailable`, and the lead is never woken.
3. **`import-tasks` is pi-shaped.** It reads `<cwd>/.pi/tasks/*.json` via `pitasks.Read`. The
   runtime-neutral alternative, `dag submit`, takes its JSON as a shell argv.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | The engine/adaptive fork becomes an explicit composer control, runtime-independent | It is the single most consequential decision in the flow. Hiding it in a model dropdown means a user changing models silently changes which machine executes their goal. Both modes stay reachable for both runtimes. |
| 2 | The Claude lead is woken by pulling — a blocking `wsh jarvis dag wait` | Needs no hook installed under `~/.claude`, no keystroke injection into a live TUI, and no new server plumbing: the eight `dag:*` events are already registered in `wps.AllEvents` and scoped to `run:<runid>`. Blocked time costs no tokens. |
| 3 | The Claude lead publishes its DAG through `dag submit --file` | Reuses the existing runtime-neutral submit RPC. Avoids quoting a large JSON blob through argv on Windows, and gives the lead `parallelism` and `mergerequired`, which `import-tasks` hardcodes. |
| 4 | `MaxTasks` 8 → 16, cap retained | 8 has no recorded rationale (see below). A typical plan exceeds it, and discovering that at submit time costs a blocking escalation. |

### On `MaxTasks = 8`

`pkg/orchestrate/dag.go:39` is a bare `const MaxTasks = 8` with no comment, directly beneath
`MaxConsecutiveFailures`, which does carry its rationale. It arrived in 205cb444 via the
safety-hardening plan, where it appears only as a checklist item ("add `MaxTasks = 8` and
`MaxParallelism = 8`"). The paired spec's sole statement is "1–8 tasks" under *The server owns initial
DAG state and limits*, plus "Do not add a capability/config API until the limits need to vary."

It was chosen to mirror `MaxParallelism = 8`, which has a real cost behind it. What actually scales
with task count:

- **Concurrency does not.** `scheduleLocked` spawns at most `Parallelism` children at a time,
  independent of total task count.
- **Disk barely does.** `CleanupTaskWorktree` (`cleanup.go:68`) removes a task's worktree on merge, so
  live worktrees are bounded by in-flight plus merged-but-uncleaned.
- **Tick and digest are O(tasks)** over an in-memory slice.
- **The `TaskGroup` row does.** Every task's label and description serialize into one waveobj blob
  rewritten on each version bump. Real, and the only genuine argument for a ceiling — but a long way
  from 8.

The defensible reason to keep a cap is blast radius, not resource exhaustion. 16 keeps that bound
while letting a normal plan import one node per numbered task. The const gains the comment it never
had. There is no frontend mirror to update: the `validateDraft` the safety-hardening plan described
was never built.

**Where the constant lives.** The engine prompt must state the ceiling, and `pkg/orchestrate` imports
`pkg/jarvis` (`dag.go:9`, `engine.go:12`, and three more), so `pkg/jarvis` cannot import
`pkg/orchestrate` back. The value is therefore declared once as `jarvis.MaxDagTasks = 16`, with
`orchestrate.MaxTasks = jarvis.MaxDagTasks` aliasing it at the enforcement site. One source of truth,
no cycle, no package moves.

## Design

### 1. `Orchestration` on the run

A new field carried composer → run → prompt.

```go
// waveobj.Run, beside WorkerRoute
// Orchestration selects which machine an orchestrator lead drives: "engine" publishes a TaskGroup
// and lets pkg/orchestrate schedule children; "adaptive" dispatches the lead's own subagents with no
// TaskGroup. Empty preserves pre-2026-09 behaviour (pi => engine, every other runtime => adaptive).
Orchestration string `json:"orchestration,omitempty"`
```

```go
// wshrpc.CommandCreateRunData
Orchestration string `json:"orchestration,omitempty"` // engine | adaptive (empty = legacy runtime fork)
```

Constants live in `pkg/jarvis` beside the run modes: `Orchestration_Engine = "engine"`,
`Orchestration_Adaptive = "adaptive"`.

`CreateRunCommand` persists it verbatim after the existing route resolution — no profile default, no
resolution step. This is deliberately **not** modelled on `PlanGate`, the apparent sibling:
`resolveRunPlan` (`wshserver_runs.go:251`) records that "new orchestrator runs are always ungated;
legacy gate fields remain readable for RPC compatibility but do not affect creation." `PlanGate` is
vestigial and is not a pattern to copy.

The field only shapes the prompt. It does not gate `DagSubmitCommand`: a lead that decides mid-run it
wants a DAG may still submit one, and an engine-mode lead that triages the goal as trivial may finish
without submitting. Making the field authoritative over submission would convert a prompt hint into a
contract error for no benefit.

`Run` is JSON-serialized inside the channel blob, so no `db/migrations-wstore` entry is needed. The
wshrpc and waveobj type changes do require `task generate`.

### 2. `wsh jarvis dag wait`

```
wsh jarvis dag wait [--timeout <seconds>]   # default 540
```

Resolves channel + run through the existing `dagIds`. Subscribes to the eight `dag:*` events scoped
to `run:<runid>` and blocks, following the established pattern at `wshcmd-editor.go:83`
(`RpcClient.EventListener.On` + `EventSubCommand` + block on a channel). All eight are already in
`wps.AllEvents`, so nothing new is registered. Blocking is entirely client-side, so the 5s default
wshrpc handler budget is never involved.

Order of operations, which matters — subscribe **before** the status read, or an event landing
between the two is lost:

1. Register the listener and subscribe.
2. Call `DagStatusCommand` once. `rtn.Group == nil` means the run has no `TaskGroup` — the lead called
   `wait` before submitting. That is a lead error, not a wake outcome, so it exits nonzero with
   `no dag for this run — submit one first`; a zero exit would let a lead loop forever on a run that
   has no DAG.
3. Evaluate `waitDecision` on the digest. If it says return, print and exit.
4. Otherwise block. Each `dag:*` event re-fetches the digest and re-evaluates; an event that does not
   satisfy `waitDecision` resumes blocking against the **same** deadline (the timeout is one deadline
   from invocation, not restarted per event). This is what keeps purely informational traffic —
   `dag:task-spawned`, or a `dag:child-done` whose successors the engine schedules on its own — from
   churning the lead, which is the "do not babysit" contract pi already has.

```go
// waitDecision reports whether the lead should be handed control now, and why. Pure: the blocking
// glue evaluates it against the initial digest and against the digest fetched after each event.
func waitDecision(d wshrpc.DagStatusDigest) (returnNow bool, reason string)
```

Rules, in order:

| Condition | Returns | Reason |
|---|---|---|
| `d.Next.Kind == "terminal"` or `d.Health` in {`done`, `cancelled`} | yes | `terminal:<terminalstatus>` |
| `len(d.Next.Actions) > 0` | yes | `action:<d.Next.Kind>` |
| otherwise | no | — |

`Next.Actions` is the digest's own single derivation of what needs the lead (`digest.go:25`); `wait`
must not re-derive it from task state. A pending child ask surfaces as `human-action` with `answer`;
the merge gate as `merge-ready` with `resolve-merge`; a stalled or failed child as `human-action`
with `retry`/`skip`/`escalate`.

Output reuses `dagStatusLines(rtn, now)` verbatim so `wait` and `status` speak one vocabulary, framed
by two lines the loop reads:

```
woke: action:merge-ready
<... dagStatusLines ...>
dagversion=12
```

On timeout the reason is `woke: timeout`; on a terminal DAG, `woke: terminal:done` — the line that
tells the lead to stop looping. Exit status is 0 for every wake outcome, including timeout: a nonzero
exit would read as a tool failure to the lead and provoke a retry. The single nonzero case is the
no-DAG error above, which is a real caller mistake.

**Default 540s** because Claude Code's Bash tool caps at 600s; a `wait` that outlives the tool is
killed and reported as a timeout, which is noise. The `--timeout` flag exists for other harnesses.

**The known sharp edge.** If `wait` returns "you have an action" and the lead does not take it, the
next `wait` returns immediately — a hot loop. Every lead action mutates the group and bumps its
version, so a lead following its prompt cannot spin. This is stated as a contract in the prompt
rather than defended with a throttle: the failure mode requires a lead that reads an instruction and
declines it, and `--timeout` bounds the cost either way. If it is ever observed in practice, the fix
is a minimum interval between identical actionable returns — not part of this design.

pi is untouched. It keeps push delivery through `NotifyLead`, and its prompt does not mention `wait`.

### 3. `dag submit --file`

`dagSubmitCmd` becomes `cobra.MaximumNArgs(1)` with a `--file` flag (`-` reads stdin). Exactly one
source must be supplied; zero or both is a usage error. The payload is the same
`wshrpc.CommandDagSubmitData` JSON the positional form already accepts, with `ChannelId` and `RunId`
overwritten from `dagIds` as they are today.

`import-tasks` is unchanged, and remains pi's documented path.

Beyond avoiding argv quoting on Windows, this hands the lead two fields `import-tasks` cannot set:
`Parallelism` (hardcoded to 2 at `wshcmd-jarvisdag.go:82`) and the group's merge requirement.

### 4. The prompt fork

```go
func BuildOrchestratePrompt(goal string, principles waveobj.PrincipleList, runtime, orchestration string) string
```

The fork moves from runtime to orchestration:

- **empty** — resolve to `engine` when `runtime == "pi"`, `adaptive` otherwise. Byte-identical output
  to today for both branches, so runs created before this change build the prompt they were created
  under.
- **`adaptive`** — today's non-pi text, now runtime-neutral (triage quick/plan, dispatch your own
  subagents, `AskUserQuestion` for consequential decisions, `wsh jarvis complete`).
- **`engine`** — a shared body plus one runtime-specific pair of paragraphs.

The shared engine body covers: size up the goal and triage trivial work directly; plan with the
writing-plans approach; one task per unit of work; each task description must pin the task-specific
goal, evidence, constraints, expected verification and decisions so the child never rediscovers the
broad goal; `AskUserQuestion` for consequential decisions and never a question in prose; the merge
gate is yours to resolve (`wsh jarvis dag merge <task-id>`) after reviewing each finished child;
`wsh jarvis complete --commit $(git rev-parse HEAD)` at the end.

It also states two constraints up front, which is new for both runtimes:

- a DAG holds at most `MaxTasks` tasks — compress while planning, not at submit time;
- one orchestrator run holds exactly one `TaskGroup` for its lifetime (`wstore.CreateDagForRun`
  returns the existing group when `run.DagORef != ""`, and a differing proposal fails with `dag
  conflict`), so a two-phase import is not available.

The live pi run captured in `docs/jarvis-orchestrator-plan-e2e.md` burned a blocking human escalation
discovering both facts at submit time, and its own recommended remedy was the two-phase import that
cannot work. A lead told up front simply plans within the limits.

Runtime-specific halves:

- **pi** — pi-tasks records + `wsh jarvis dag import-tasks`; the engine wakes you with control events;
  respond as they arrive, do not babysit. Unchanged from `buildPiOrchestratePrompt`.
- **every other runtime** — write the DAG JSON to a file, submit it with `wsh jarvis dag submit
  --file <path>`, then loop: run `wsh jarvis dag wait`, act on what it reports, wait again. Stop when
  it reports `terminal:`. Acting on a reported action is what lets the next wait block — an action
  left untaken returns immediately.

### 5. Composer control

A two-state segmented control (Engine / Adaptive) in the Lead → Workers tight row, under the same
visibility condition the worker picker already uses. Default **Engine**, for every runtime.

Following the surface convention, the logic is pure and unit-tested in `orchestratorpicker.ts` beside
the existing `orchestratorPickerState` and `workerPickerFace`; `channelcomposers.tsx` renders it, and
`runactions.ts:78` passes `orchestration` through the existing `opts` object on `createRun`.

State follows the neighbouring selections exactly: `useState` in `stagecomposer.tsx` beside `shape`
and `workerRoute` (`stagecomposer.tsx:251-253`), cleared by the existing reset-on-channel-change
effect. The Jarvis surface unmounts on nav switch, so this selection is lost on a surface switch just
as shape and worker route already are — accepted existing behaviour, and consistency beats
introducing a lone persisted atom for one control.

## Testing

| Area | Test |
|---|---|
| Prompt fork | Table over (`engine`,`pi`), (`engine`,`claude`), (`adaptive`,`*`), (`""`,`pi`), (`""`,`claude`). The two legacy cases assert byte-identical output to the current builders — that is the regression guard for existing runs. |
| `waitDecision` | Table over terminal health, terminal `Next.Kind`, non-empty `Actions` for each action set, and the quiet case. Pure function, no event loop. |
| `wait` glue | `rtn.Group == nil` exits nonzero; a non-satisfying event resumes blocking against the original deadline rather than restarting it. |
| `dag submit --file` | Source selection (file only, stdin only, neither, both), malformed JSON, and that `ChannelId`/`RunId` are overwritten from `dagIds`. |
| `MaxTasks` | `NewTaskGroup` accepts 16, rejects 17. |
| Composer | `orchestratorpicker.test.ts` for toggle visibility and label state. |
| Live | An actual `runtime=claude`, `orchestration=engine` run against a small real plan, driven to a merge gate and past it. |

The live run is the only test that proves the loop closes. Everything above is unit-testable and none
of it demonstrates a Claude lead actually reaching a merge gate — the same reason
`docs/jarvis-orchestrator-plan-e2e.md` exists for pi. There is no jsdom render harness for the
composer control; `surface-smoke` covers that it renders.

Note that `dag wait` cannot be exercised against a stale backend: `task build:backend` must run in the
checkout being tested, or the new command route-errors.

## Files

| File | Change |
|---|---|
| `pkg/orchestrate/dag.go` | `MaxTasks` aliases `jarvis.MaxDagTasks`, with the comment it never had |
| `pkg/waveobj/wtype.go` | `Run.Orchestration` |
| `pkg/wshrpc/wshrpctypes_runs.go` | `CommandCreateRunData.Orchestration` |
| `pkg/wshrpc/wshserver/wshserver_runs.go` | persist it; pass it to the prompt builder |
| `pkg/jarvis/run.go` | prompt fork on orchestration; engine body; constants |
| `cmd/wsh/cmd/wshcmd-jarvisdag.go` | `submit --file`; `wait`; `waitDecision` |
| `frontend/app/view/agents/orchestratorpicker.ts` (+ test) | toggle state |
| `frontend/app/view/agents/channelcomposers.tsx` | render the toggle |
| `frontend/app/view/agents/runactions.ts` | pass `orchestration` |
| generated | `task generate` after the waveobj/wshrpc changes |

## Out of scope

- **Push delivery to a Claude lead.** PTY keystroke injection (the mechanism `agentask` uses to drive
  Claude's picker) and a blocking `Stop` hook were both considered. Pull is sufficient, and neither
  alternative earns its risk: injection corrupts a picker the lead has open for its own
  `AskUserQuestion`, and a `Stop` hook lands in every Claude session on the machine.
- **`SessionID` in the Claude `agent-hook`.** Only needed for the pi control-file transport, which
  Claude does not use.
- **One-DAG-per-run.** Stated as a constraint in the prompt; not changed.
- **`import-tasks` parallelism.** Still hardcoded to 2. `--file` gives the Claude lead control; making
  it a flag on `import-tasks` is a separate, unrelated change.
- **Adaptive-mode improvements.** The adaptive branch's text is moved, not rewritten.
