# Orchestrator redesign — design

**One line:** A goal-first orchestrator. The lead works the goal with the human through the brainstorming skill. Architectural goals go to a deterministic engine, which runs the plan in lanes and wakes the lead only when something needs judgment.

**Status:** Design approved in conversation 2026-09-14. Slices 1-3 built (149be624, 680da968, 27228cb9). Slice 4 is split into 4a-4d (§13).

**Evidence:** `docs/superpowers/briefs/2026-09-14-orchestrator-redesign-measurements.md` (commit 426211c9), plus the transcript and run-event probes summarized under [Measurements](#measurements-that-shaped-the-design).

**Supersedes:**
- `docs/superpowers/specs/2026-09-09-orchestrator-plan-gate-design.md` (the plan gate is deleted)
- pipeline run mode
- adaptive orchestration

---

## Problem

Run 1b missed the owner's bar: Arc is a day-to-day tool, and a run over an hour is not acceptable. The time went to:
- 45m19s of lead planning, spent transcribing a spec that already existed
- 8m39s waiting at the plan gate
- 5m40s sealing
- a 40m12s longest child
- 74.9 worker-minutes in total

The structure causes most of this:

1. **The lead is on the mechanics path.** It polls with `dag wait`, reads status, and merges. Those turns are token spend on work code can do.
2. **Planning happens twice.** The lead re-plans an approved spec, then the plan gate adds a second human wait.
3. **Child questions barely work.**
   - `forwardChildAsk` forwards only `questions[0]` (`pkg/wshrpc/wshserver/wshserver_ask.go:164`).
   - `dag asks` prints `TaskId: Question` (`cmd/wsh/cmd/wshcmd-jarvisdag.go:448`).
   - The Gatekeeper escalates every multi-question ask unjudged (`docs/deferred.md`).
   - No child asked anything across 26 children, so none of this has been exercised.
4. **The pi lead wake never worked.** `NotifyLead` (`pkg/orchestrate/control.go:117`) writes control files for a watcher that needs `WAVETERM_PI_CONTROL_DIR`, and nothing sets that variable. `PiSendControlCommand` writes under `DataHome_VarCache/pi-control` instead.
5. **Two ways to name a model.**
   - legacy route tiers (`runroute.NormalizeLegacy`, `resolveLegacyTier`)
   - automatic context-window escalation up a tier (`outcome.go:132`, `retry.go:62`)
   - frontend tier fallbacks, alongside exact model pins
6. **Four harnesses claim run-worker support.** Only Claude Code and pi are used.
7. **Two silent engine faults** (see [Fixes](#11-fixes)): a false stall and a schedule failure that records nothing.

## Goals

- Save tokens without lowering quality.
- A run-1b-sized goal finishes in under an hour of wall clock.
- The orchestrator answers child questions, and escalates to the human only when it can't decide.
- Code does the mechanics (scheduling, worktrees, merges, retries, tests). The model only judges.

## Non-goals

- codex and opencode as run workers (deferred, see [Harness scope](#8-harness-scope)).
- Duration estimates.
- Re-planning or adding tasks mid-run.
- Changes to consult tiers (`pkg/consult`).
- The Gatekeeper's multi-question limitation for non-DAG asks. It stays recorded in `docs/deferred.md`; DAG children stop reaching the Gatekeeper at all.
- Serializing merges of generated outputs (brief §8). A merge conflict wakes the lead instead. Revisit if conflict wakes recur.

## Measurements that shaped the design

| Measurement | Value | Consequence |
|---|---|---|
| Run 1b breakdown | planning 45m19s, gate 8m39s, seal 5m40s, longest child 40m12s, 74.9 worker-min | delete re-planning and the plan gate |
| Goal-led runs, start to first worker | 10.4m, 11.0m, 16.7m | brainstorming a goal is a fixed cost; small goals need Quick |
| Brainstorm to spec | p50 16.9m (n=5); plan writing 13.7m (n=1) | the lead's interactive phase fits inside the bar |
| Lead context at spec write / plan write | p50 162k / p50 206k, max 245k | the lead compacts near handoff, so compaction must be deliberate |
| Compaction | 23 of 75 sessions; auto at ~205-210k; 121s p50, 155s max; same transcript file | context rules; the hung threshold must exceed 155s |
| Fresh lead context | 33,254 tokens in the repo cwd, 11,042 in a neutral cwd | accepted cost: the lead needs the repo (G1) |
| Plan shape (19 plans, 185 tasks) | at most 2.64 tasks/wave; 1 plan fully serial; sizes 3-26 tasks | lanes; lift the 16-task cap |
| Warm lane vs fresh worker per task (5 sessions, 39 tasks) | warm 10.2M token-equivalents vs fresh 2.8M (worst case 8.9M); median carried context 120k | a fresh worker per task, even inside a lane |
| Child task duration | Claude 1.1-1.5 min, pi 5.6-11.2 min | the 15m stall threshold is safe for both |
| Engine events | 0 task-failed / task-retried, 38 cancellations | failure paths are unexercised; test them directly |

The brief's verdict (§8) recommended running the lead from a neutral cwd. This design does not: the lead brainstorms against the code and implements bounded goals in place. The extra ~22k tokens are paid once per session and then read from cache. The brief's "keep the worker alive through verify" is adopted as per-task tests owned by the worker (§4).

## Design overview

```
+ Run: goal or plan path, shape
  |
  +-- Quick -----------> one fresh worker, no lead, no skill
  |
  +-- Orchestrator, goal
  |     lead (project checkout): superpowers:brainstorming with the human
  |       spike ---------> report the answer, `wsh jarvis complete`
  |       bounded -------> human's yes, implement, tests, commit, `wsh jarvis complete --commit`
  |       architectural -> spec, human review, writing-plans (plan format)
  |                        `wsh jarvis dag submit --plan P --spec S`, stop
  |                        engine types the handoff /compact
  |
  +-- Orchestrator, plan path
        engine submits the plan itself; no lead session until the first judgment event

engine: parse plan -> lanes -> lane worktree (+ Setup) -> fresh worker per task
        worker: task tests pass -> commit -> `wsh jarvis complete --commit`
        lane tip: squash merge into the project checkout -> Verify
        judgment event -> wake the lead (typed into the idle lead)
          questions | task failing after retry | worker hung | merge conflict | Verify failed | run finished
        lead dead, or a question past its deadline -> the human
```

---

## 1. Run shapes

+ Run offers two shapes. `pipeline` is removed from `frontend/app/view/agents/runconfig.ts:78`.

| Shape | Picked by | What runs |
|---|---|---|
| Quick | the human, for small goals | One fresh worker. No lead, no skill. `QuickPlaybook` (`pkg/jarvis/run.go:97`), `BuildQuickPrompt` (`run.go:379`). |
| Orchestrator | the human | A lead session. From a goal, the lead brainstorms. From a plan path, the engine starts at once (G5). |

**Quick** adds one line to its prompt:
> If this turns out to be more than one change or needs a design decision, stop and ask with `<tool>` instead of pushing on.

`<tool>` is chosen by runtime: `AskUserQuestion` for Claude, `ask_user_question` for pi.

**Orchestrator from a plan path (G5).**
- + Run takes an absolute plan path and parses it before start.
- It shows the plan shape: task count, lane count, longest chain.
- A parse error blocks start and shows the parser's message.
- A plan with no `**Depends on:**` or `**Verify:**` lines shows "serial, unverified" before start.
- The engine submits the plan at run start. No lead session exists until the first judgment event. Then the engine launches the lead with the orchestration rules as its launch prompt, followed by the wake message.

For goal runs, the plan shape appears on the run card after `dag submit`.

**Removed:**
- Pipeline mode: `DefaultPlaybook` (`run.go:79-85`), `BuildPhasePrompt`'s headless "make reasonable assumptions" path (`run.go:362`), and the phase gate helpers (`HoldPhase` `run.go:255`, `ApproveGate` `:310`, `SendBackGate` `:331`). A helper is deleted only if no caller remains once pipeline and the plan gate are gone; the plan checks each one.
- Adaptive orchestration: `Orchestration_Adaptive`, `ResolveOrchestration` (`run.go:48-51`, `:394`), `buildAdaptiveOrchestratePrompt` (`:423-434`), triage verdicts (`:71-75`), `wsh jarvis triage` (`cmd/wsh/cmd/wshcmd-jarvis.go:78`), and the frontend orchestration toggle.

Existing pipeline and adaptive runs stay readable in history. None can be started.

## 2. The lead

### Lifecycle

1. **Start.** + Run (Orchestrator, goal) spawns the lead in the project checkout (`owner.ProjectPath`) with the launch prompt. Its tab outlives the process as today (`keepOnExit`, `pkg/jarvis/runexec.go:94`).
2. **Brainstorm.** The lead runs `superpowers:brainstorming` interactively with the human in its terminal. The skill's own classification picks the path.
3. **Spike or bounded.** The lead finishes through `wsh jarvis complete`; the engine is not involved.
4. **Architectural.**
   - The spec is written and the human reviews it.
   - The plan is written with `superpowers:writing-plans` in the [plan format](#3-plan-format-and-parser).
   - The lead runs `wsh jarvis dag submit --plan <abs path> --spec <abs path>` and stops.
   - There is no plan gate: the human already approved the spec.
5. **Handoff.** The engine validates and persists the dag. When the lead goes idle, it types the handoff compaction (§7).
6. **Idle.** The lead stays idle until a [judgment event](#judgment-events) wakes it.
7. **Finish.** On `run finished` the lead reports and runs `wsh jarvis complete`. If the goal isn't fully met, it asks the human instead of adding tasks (G4).

### Launch prompt (goal runs)

```
Goal: <goal>
Work this goal with the superpowers:brainstorming skill; the human is at this
terminal. Put every question and every approval through <AskUserQuestion |
ask_user_question>, never plain text, which does not reach the cockpit.
- spike: report the answer, then `wsh jarvis complete`.
- bounded: after the human's yes, implement it here, get the tests passing,
  commit, `wsh jarvis complete --commit $(git rev-parse HEAD)`.
- architectural: after the spec is approved, write the plan with
  superpowers:writing-plans in this format: <plan format>. Don't commit the spec
  or plan and don't execute the plan: run
  `wsh jarvis dag submit --plan <plan path> --spec <spec path>` and stop. The
  engine wakes you when something needs judgment.
```

- `<plan format>` is the `PlanFormat` constant next to the parser (§3).
- A Claude question asked in plain text doesn't render in the cockpit (`run.go:429`), hence the ask-tool rule (G7).

### Orchestration rules

These are injected after every compaction of a lead session (§7), and they are the launch prompt for plan-input leads.

```
You are the lead for run <id>. Spec: <path>. Plan: <path>. The engine schedules,
merges and tests. Each wake names an event and the command that shows it;
re-read only what the event needs.
- questions: answer from the spec and plan; check code with Read/Grep when they
  don't settle it; `dag answer`. A product or scope call, or spec, plan and code
  disagreeing: `dag forward <task> "<what you checked, what you recommend>"`.
- task still failing, or worker hung: retry, retry on another model, skip, or forward.
- merge conflict, or tests failed at a merge point: fix it in the project tree,
  commit, `dag merge <task> --continue` (the engine re-runs Verify).
- run finished: write the report (landed, unverified, answered, forwarded). If
  the goal isn't fully met, say what's missing and ask the human; don't add tasks.
Never re-plan and never do a task's own work.
```

For a plan-input run without a spec, the `Spec:` clause is omitted.

### Judgment events

Each event wakes the lead with one self-contained line: the event plus the command that shows it. Events that arrive while the lead is working are joined into one wake message, one line each.

| Event | Wake line | Lead's commands |
|---|---|---|
| Questions waiting | `wake: 2 questions waiting. wsh jarvis dag asks` | `dag answer`, `dag forward` |
| Task failed with its automatic retry spent, or with a non-retryable kind | `wake: task 4 failed (tests), retry spent. wsh jarvis dag status` | `dag retry`, `dag escalate --model`, `dag skip`, `dag forward` |
| Worker hung (§4) | `wake: task 6 hung: silent 15m, process alive, no ask pending. wsh jarvis dag status` | same as above |
| Merge conflict | `wake: merge conflict landing lane ending at task 5. git status` | fix, commit, `dag merge 5 --continue` |
| Verify failed at a merge point | `wake: Verify failed after merging task 5 (exit 1). wsh jarvis dag status` | fix, commit, `dag merge 5 --continue` |
| Run finished | `wake: run finished. wsh jarvis dag status` | report, `wsh jarvis complete`, or ask the human |

Two new wsh subcommands, `dag retry <task>` and `dag skip <task>`, wrap the existing `DagActionCommand` actions. Today only `escalate` has a wsh command (`wshcmd-jarvisdag.go:391`).

`dag forward <task> "<note>"` hands the task's open judgment to the human with the lead's note. That judgment is either the task's pending ask or its failed or hung state. The lead's turn continues.

### Where the lead works (G1)

- The lead works in the project checkout. Workers receive the spec and plan by absolute path.
- The spec and plan stay uncommitted until the first lane merge. The engine stages exactly those two paths into that lane's squash commit. This matches the rule that spec and plan docs fold into the feature commit.
- The automatic merge path refuses a dirty index (`errIndexNotClean`, `pkg/orchestrate/mergetask.go:49`). Staging the two docs happens inside the merge, after that check.

### Dead lead (G8)

- **Before `dag submit`:** a lead process that exits fails the run visibly, with the reason "lead exited before submitting a plan".
- **After `dag submit`:** the engine keeps running the mechanics.
  - Every judgment event goes to the human as a cockpit card.
  - Lead-owned questions move to the human.
- A lead counts as dead when its process has exited, or when a wake is not confirmed (§6).

## 3. Plan format and parser

The format text lives in Go as `PlanFormat`, next to the parser, in `pkg/jarvis`. It is inserted into the lead launch prompt. `pkg/orchestrate` already imports `pkg/jarvis`, so the engine can use the parser without an import cycle. This repo's `CLAUDE.md` gains a short rule pointing user-written plans at the same format. pi loads `CLAUDE.md`, so it sees the rule too.

```markdown
**Verify:** `task test`
**Setup:** `task worktree:prepare`

### Task 1: <title>
**Depends on:** none
...task text...

### Task 2: <title>
...task text... (no Depends line: depends on Task 1)

### Task 3: <title>
**Depends on:** Task 1
```

**Parsing rules:**
- `**Verify:**` and `**Setup:**` are plan-level. They are read only before the first task heading. Each holds one shell command in backticks. Both are optional.
- A task heading is `### Task N` or `## Task N`, optionally followed by `: title`. Existing plans use both levels. N must run 1, 2, 3... in order.
- A task's text runs from its heading to the next task heading or end of file.
- `**Depends on:**` must be the first non-empty line after the heading.
  - Missing: the task depends on the previous task, so the plan runs serial.
  - `none`: the task has no dependencies.
  - A list (`Task 2, Task 5`): each named task must come earlier in the plan. A forward or unknown reference is a parse error.
- A plan with no task headings is a parse error.
- There is no task cap (G3). `MaxDagTasks` (`run.go:45`), its check (`pkg/orchestrate/dag.go:67`, `:185-189`) and its prompt text are deleted. Real plans have 3-26 tasks, and parallelism bounds concurrent load.

The parser returns tasks (id, title, text, dependencies), Verify, and Setup. `dag submit --plan` and the + Run preview both call it. The derived lanes are part of the result, so the preview and the engine can't disagree.

## 4. Engine

### Lanes

A lane is a maximal chain in which each task after the first has exactly one dependency, and is that dependency's only dependent.

- **Fork:** a task whose dependency has several dependents starts a new lane. That lane branches from the project branch after the dependency's lane merged.
- **Join:** a task with several dependencies starts a new lane after all of them merged.
- **Independent:** a task with `none` starts its own lane from the project branch at dispatch.

Each lane gets:
- one worktree and one branch, keyed by the lane's first task instead of per task (`TaskWorktreeKey`, `EnsureRunWorktree` at `engine.go:351`)
- one squash merge at its tip

Inside a lane, the tasks' own commits stack on the lane branch. Each task gets a fresh worker whose base is the previous task's commit.

Lanes run concurrently up to `--parallelism` on `dag submit`, which keeps its current default. There is no speed gain on a serial chain. The point of lanes is one merge, one Verify and one worktree per chain instead of per task.

### Worktrees and Setup

- After `git worktree add` for a lane, the engine runs the plan's `**Setup:**` command in that worktree. An unprepared worktree fails vitest today (`docs/orchestrator-howto.md:45-49`).
- A Setup failure fails the lane's first task with failure kind `setup`, which is a judgment event.

### Workers

- Every task gets a fresh worker session: fresh even within a lane (see Measurements).
- The engine launches it with `--session-id <uuid>`, generated at spawn and stored on the child run. Both CLIs accept the flag.
- Evidence and liveness find the transcript by that id, replacing the marker scan (`dagSessionMarker`, `engine.go:236`) and, for task workers, `TranscriptPathForTab` (`pkg/jarvis/evidence.go:450`). Leads and quick runs, which the engine does not launch, keep that lookup until they launch with a session id:
  - Claude: `~/.claude/projects/<cwd slug>/<uuid>.jsonl`
  - pi: located and read by `pkg/pisession`

`taskPrompt` (`engine.go:585-605`) becomes three parts: the worker contract, then the task's text from the plan, then `predecessorHandoff` (`engine.go:525-566`, unchanged) for in-lane successors. The worker contract replaces `HeadlessContract` (`engine.go:506`):

```
You are the worker for task <N> of the plan at <plan path> (spec: <spec path>).
The plan is approved: don't re-plan or pause for design approval. If a
consequential decision isn't pinned, or the plan and the code disagree, ask once
with <tool> and concrete options, then wait; the lead or the human answers.
Run <Verify command, or the tests the task names> and get them passing before
you complete; if you can't, ask. Commit, then
`wsh jarvis complete --commit $(git rev-parse HEAD)`.
If your context was compacted, re-read your task from the plan.
```

### Tests

- **Per task (D5a):** the worker owns them, as the contract above says.
- **At merge points (D5c):**
  - After each lane's squash merge, the engine runs `**Verify:**` in the project checkout. The last lane's Verify doubles as the run-end check.
  - Merges and their Verify runs are serialized per project: the next lane merge waits for the running Verify.
  - The dag mutation lock is not held during Verify.
  - A non-zero exit, or exceeding `VerifyTimeout`, puts the task in `verify-failed` and wakes the lead.
- **Recovery (G2):** the lead fixes the failure in the project tree and commits. `dag merge <task> --continue` on a `verify-failed` task re-runs Verify at HEAD instead of finishing a squash. A pass clears the state and releases the merge queue.
- **No Verify line:** there is no merge-point check, and the run is reported "unverified".

### Merges

- `AutoMergeReady` (`mergetask.go:176`) already lands merges without the lead. It now runs at lane tips.
- A conflict leaves the task in `blocked-merge`, as today, and wakes the lead.
- `dag merge <task> --continue` finishes it (`MergeContinue`, `pkg/orchestrate/merge.go:47`), then Verify runs.
- A dependent in another lane waits for its dependency's lane to merge. A dependent in the same lane doesn't.

### Hung workers (F25)

A task is hung when all three hold:
- it is stalled: the existing `StallThreshold` of 15m transcript silence (`pkg/orchestrate/liveness.go:28`), or the 5m `FirstTokenDeadline` (`:36`)
- its process is still alive
- no ask is pending for its block

The first-token deadline is armed for pi only. A Claude child that writes no transcript is never stalled, so it is never reported hung.

Hung is a judgment event. A worker waiting on an answer is never hung. Any silence threshold must stay above the 155s maximum compaction time, because a compacting worker writes nothing. A worker whose process exited without `complete` fails through the existing exit path.

### Failures

- The engine keeps its existing automatic retry for retryable failure kinds, minus tier escalation (§9).
- It wakes the lead when a task fails with its retry spent, or with a non-retryable kind.
- The manual "retry on another model" (`dag escalate <task> --model`) stays.

### End of run and report

- When the last lane has merged and verified, or every remaining task is skipped or forwarded and resolved, the engine wakes the lead with `run finished`.
- `dag status` carries the numbers: elapsed time, worker-minutes, per-task minutes (`buildDurations`, `pkg/orchestrate/digest.go:634`), landed commits, the unverified flag, and the answered and forwarded counts.
- The lead writes the report in its terminal from those numbers, then runs `wsh jarvis complete`. The run card shows the same numbers.
- No duration estimate is shown anywhere.

## 5. Question queue

The queue lives on the agentask registry (`pkg/agentask/agentask.go`). `PendingAsk` gains two fields, set only for asks raised by DAG children:
- `Owner`: `lead` or `user`
- `Deadline`: UnixMilli

**Raise.**
- A DAG child's ask enters the queue owned by the lead, with `Deadline = raise + LeadAskDeadline`.
- If the lead is dead (G8), the ask is owned by the user from the start.
- In a plan-input run with no lead session yet, the ask is a judgment event: the engine launches the lead (§1), and the deadline starts at raise as usual.
- `forwardChildAsk` passes every question, not `questions[0]`.

**Wake.** The engine wakes the lead when it has lead-owned entries and is idle, and no wake is outstanding. That covers the empty-to-non-empty transition, and entries that arrived while the lead was busy answering others.

**`wsh jarvis dag asks`** lists every lead-owned entry, oldest first. Each entry shows:
- task id, age, and time to deadline
- every question: header, text, each option's label and description, and the multi-select flag

`DagAskItem` (`pkg/wshrpc/wshrpctypes_dag.go:69-76`) carries `Questions []baseds.AgentAskQuestion` in place of `Question` and `Options`.

**`wsh jarvis dag answer <task> <answers-json>`** answers all of the entry's questions (`CommandDagAnswerData.Answers`, unchanged). Multi-answer stays gated server-side in `pkg/agentask/encode.go`.

**`wsh jarvis dag forward <task> "<note>"`** sets `Owner = user` and attaches the note. The child keeps waiting and the lead's turn continues.

**Deadline.** An entry past its deadline moves to the user. Its note records that it was not answered in time.

**User-owned entries** render on the run's cockpit surface with all questions, options and the lead's note. The human answers through `DagAnswerCommand`. The child's own ask card sits on an invisible session (`wshserver_ask.go:62-64`), so this surface is where the human sees it.

**Gatekeeper.** It is never an owner for DAG children: `handleAsk` in `pkg/jarvis/watcher.go` skips asks whose block resolves to a DAG task.

**Delivery (F22/F23).**
- An answer counts as delivered only when the registry entry clears: through PostToolUse `ask --clear` for Claude, or the waiter returning for pi.
- If it hasn't cleared within `AnswerClearTimeout`, the entry returns to its owner with the failure noted.
- A second failed delivery moves it to the user.

## 6. Waking the lead

One adapter serves both harnesses, replacing `NotifyLead`'s pi control files (`control.go:117`).

- **Precondition:** the lead's block is alive, and its agent state is idle (`baseds.AgentState`, derived in `pkg/agentobserve/derive.go`).
- **Send:** type the wake text and Enter into the lead's block, through `blockcontroller.SendInput`, the mechanism `steerRunLead` already uses (`pkg/wshrpc/wshserver/wshserver_runs.go:506`).
- **Confirm:** the wake counts as delivered when the agent state turns `working` within `WakeConfirmTimeout`.
- **Retry:** an unconfirmed wake is retried once. If that also fails, the lead is treated as dead for judgment events (G8), and the pending events go to the human.
- **Busy lead:** wakes are held and joined into one message, sent when the lead next goes idle.

The same adapter types the handoff `/compact` (§7) and the plan-input launch wake.

## 7. Context management

1. **The lead's context is never the only copy of anything.**
   - Decisions live in the spec, tasks in the plan, run state in the engine.
   - Wake messages are self-contained.
2. **Deliberate compaction at handoff.** After `dag submit` succeeds and the lead is idle, the engine types:
   ```
   /compact Keep: what the human said that the spec does not record, and the reason behind each decision. Drop: code you read, drafts, tool output.
   ```
   - This compacts at the natural boundary, instead of an auto-compaction landing mid-wake at ~205k.
   - pi's `session_before_compact` event carries `customInstructions` for a manual `/compact`. Before building on it, the plan verifies that pi's `/compact` takes the argument. The fallback is the extension calling `ctx.compact` (`types.d.ts:246`).
   - Auto-compactions keep the harness's default summary. Re-orientation (rule 3) covers them.
3. **Re-orientation after any compaction.**
   - A new hidden `wsh jarvis dag rules` resolves the calling block's run. It prints the orchestration rules when the block is an orchestrator lead holding a dag, and nothing otherwise.
   - **Claude:** a new hook entry `{"SessionStart", "compact", "jarvis dag rules", 15}` in `cmd/wsh/cmd/wshcmd-installhooks.go`. It sits next to the existing `startup|clear|compact` memory-inject entry at line 40 and uses that entry's output shape.
   - **pi:** the extension's `session_compact` handler runs `wsh jarvis dag rules` and keeps the output. Its `context` handler then appends it as a message on each later provider request (`ContextEventResult.messages`, `types.d.ts:814`).
   - The handoff compaction fires this too, so the rules arrive exactly when orchestration starts.
4. **Workers** get the plan path and task heading in their contract, so they re-read their task after a compaction. No hook is needed.
5. **Silence thresholds** stay above the 155s maximum compaction time (§4).

## 8. Harness scope

Run workers (leads and task workers) support Claude Code and pi only.

- `pkg/harness/catalog.go:41-50`: `RunWorkerCapable: false` for codex and opencode. `ConsultCapable` is unchanged.
- Delete the codex and opencode arms in `RunWorkerSpecFor` (`pkg/jarvis/runexec.go:44-47`).
- Delete the codex entry in `livenessRuntimes` (`pkg/orchestrate/liveness.go:64`) and its test.
- Delete the codex and opencode route rows (`pkg/runroute/runroute.go:50-51`) and `codexSafe` (`:25`).
- Update the assertions in `pkg/harness/catalog_test.go:29` and `pkg/wshrpc/wshserver/wshserver_harness_test.go:46`.
- The frontend already filters on `runworkercapable` (`harnesspicker.tsx:36`, `harnessstore.ts:30-33`) and route capabilities (`route.ts:104`). No frontend change is needed for scope.
- Add a `docs/deferred.md` entry for codex/opencode run workers, with the `git show <commit>:<path>` recovery commands for the deleted arms.
- `docs/orchestrator-howto.md` states the pi ask tool package, `@juicesharp/rpiv-ask-user-question`, and the superpowers package. pi leads need the latter for `brainstorming` and `writing-plans`, because pi's `skills` setting (`~/.claude/skills`) doesn't hold plugin skills.
- **G6:** the owner adds the superpowers package back to `~/.pi/agent/settings.json`. Nothing in this design builds a fallback.

## 9. Tier deletion

A route is a runtime plus an exact model. There are two route settings, Lead route and Workers route.

**Deleted:**
- **runroute:** the `Tier` column of the capability table (`runroute.go:46-51` become model rows), `resolveLegacyTier` (`:72`), `NormalizeLegacy` (`:120`).
- **Tier fields:** `Run.Tier` (`pkg/waveobj/wtype.go:266`), `RunSpec.Tier` (`:350`), `CommandCreateRunData.Tier` (`pkg/wshrpc/wshrpctypes_runs.go:28`), `CommandDagActionData.Tier` (`wshrpctypes_dag.go:54`), `RouteCapabilityInfo.Tier` (`wshrpctypes_jarvis.go:216`), and the `harness:preferredtier` setting (`pkg/wconfig/settingsconfig.go:181`, `metaconsts.go:130`) with its validation at `wshserver.go:251`.
- **Automatic escalation:** context-window escalation (`autoEscalationTarget`, `outcome.go:132`; `escalateDecision`, `retry.go:62`; `nextTier`), and the tier paths in `escalationTarget` and `applyEscalation` (`mutation.go:88`, `:124`). `dag escalate` requires `--model`.
- **Frontend:** the route-tier fallbacks in `frontend/app/view/agents/route.ts` and its consumers. The plan enumerates them from `route.ts`'s exports. The tiers in `view/jarvis/autonomyladder*` and `briefautonomy.ts` are autonomy levels, a different concept, and they stay.

**Kept:**
- consult tiers (`pkg/consult`, G9)
- the channel `Tier` in `wshrpctypes_channels.go:70` (concierge, gatekeeper, delegator), a different concept

**Pin migration.** Saved route pins live in:
- `JarvisProfile.WorkerRoute` (`wtype.go:511`)
- `ProfileOverride.Route` and `.WorkerRoute` (`:519`, `:524`)
- run settings (`pkg/jarvis/runsettings.go:39`)
- the `harness:preferredtier` setting, which moves into the preferred model setting and is then removed

A one-time pass at server start rewrites every pin that has a tier and no model to the model that tier resolves to in today's table:

| Pin | Rewritten to |
|---|---|
| claude + cheap | `consult.CheapModel` |
| claude + mid | `consult.MidModel` |
| any runtime + capable | empty model (the runtime default) |

`RoutePin` keeps its `tier` JSON field only for this pass to read. The pass clears it on write. Historical runs lose their tier label; their resolved `Model` is already recorded.

## 10. Deletions

| What | Where | Why |
|---|---|---|
| `dag wait` | `wshcmd-jarvisdag.go:192` | the lead no longer polls |
| `dag submit [dag-json]` / `--file` | `wshcmd-jarvisdag.go:61-90` | replaced by `--plan`; it was the Claude lead's planning mechanism |
| `dag import-tasks`, `dag init` | `wshcmd-jarvisdag.go:93`, `:495` | pi lead planning mechanisms |
| pi control plumbing | `control.go`, `control_test.go`, `wshrpctypes_picontrol.go`, `wshserver_picontrol.go`, `PiControlAckCommand` (`wshrpctypes_dag.go:22`), hidden `dag ack` (`wshcmd-jarvisdag.go:478`), the watcher and `agent_settled` control handling in `pi/extensions/waveterm-tools.ts` and the installed `pi-tools-extension.ts` | never worked; replaced by the wake adapter |
| plan gate | `DagStatus_AwaitingPlan`, `approve-plan`/`sendback-plan` actions, `RunEventKindDagPlanGated` (`pkg/waveobj/runevent.go:62`) and its append (`wshserver_dag.go:127`), "Approve & proceed" (`runcards.tsx:58`), `plangate.ts` | no plan gate |
| engine lead prompt | `buildEngineOrchestratePrompt` (`run.go:440-471`) and its triage, cap, gate, pi import-tasks, submit-and-wait and merge-ready text | replaced by the launch prompt and orchestration rules |
| `MaxDagTasks` | `run.go:45`, `dag.go:67`, `:185-189` | G3 |
| pipeline, adaptive | see §1 | two shapes |
| tiers | see §9 | one way to name a model |

The frontend orchestration-toggle and pipeline-shape code lives in `newruncontrol.tsx`, `newrun.ts`, `briefsheet.tsx`, `briefrunsheet.tsx`, `runlauncher.tsx`, `runconfig.ts`, `runconfigstore.ts`, `runsettings.ts`, `daggraph-header.tsx`, `channelcomposers.tsx`, `runactions.ts`, `agents.tsx`, `orchestratorpicker.ts`, `cockpitsurface.tsx` and `cockpitsurfacemodel.ts`. The plan checks each file for what is toggle code and what is shared.

## 11. Fixes

**Land first.** Both are independent of the rest.

- **False stall** (`engine.go:259-262`). A tracked task with no writes keeps its spawn-time `LastActivity` seed. The seed reaches the 15m stall rule, while the 5m first-token rule (which needs `LastActivity == 0`) never fires. After the untracked guard, add:
  ```go
  if activity == 0 {
      t.LastActivity = 0
  }
  ```
  A write-less pi child is then flagged at 5m. A write-less Claude child is not flagged at all: the first-token deadline is armed for pi only (`firstTokenRuntimes`, `liveness.go:72`), because Claude children routinely finish without writing a transcript. The untracked guard keeps its `continue`. An unreadable child has written nothing as far as the probe can tell, so the first-token rule would flag a healthy pi child.
- **Silent schedule failure.** `cleanupScheduleFailure` (`engine.go:81-130`) records a failure kind on the task and appends a `task-failed` run event, as `failDispatch` (`:138`) does.

**With the queue (§5):** F22/F23 answer delivery.

**With the engine (§4):** `--session-id` launch, Setup, the F25 hung signal.

## 12. Testing

**Go unit tests.** Behavior, table-driven where the repo does that.

- **Plan parser:**
  - missing Depends means serial; `none`; lists
  - forward and unknown references rejected; out-of-order N rejected
  - Verify and Setup read only before the first task; both heading levels
  - task text bounds; no tasks rejected
- **Lane derivation:** chain, fork, join, independent; the longest-chain count shown in the preview.
- **Queue:**
  - lead ownership at raise; user ownership when the lead is dead
  - deadline moves the entry to the user (injected clock)
  - `forward`; wake condition (idle, entries, no outstanding wake)
  - entries arriving mid-turn trigger a wake when the lead goes idle
  - `dag asks` shows every question and the multi flag
  - the Gatekeeper skips DAG children
- **Delivery:** answered-but-not-cleared returns to the owner; a second failure goes to the user.
- **Wake adapter:** with a fake state source and input sink:
  - idle send, confirm, a single retry, dead after the retry
  - busy lead joins events into one message
- **Merge-point Verify:**
  - pass; failure puts the task in `verify-failed`; timeout
  - `--continue` re-runs Verify
  - the merge queue waits on Verify
  - the lock is not held during Verify (a tick proceeds while Verify runs)
- **Stall fix:**
  - a tracked, write-less pi child is flagged at 5m, not 15m
  - a tracked, write-less Claude child is never flagged, and reads freshness unknown
  - an untracked child is never flagged, pi included
- **`cleanupScheduleFailure`:** records kind, attempts and event.
- **Hung:** stalled + alive + no ask gives hung; with an ask pending it doesn't.
- **G1 fold:** the first lane's squash commit contains the spec and plan; later lanes don't.
- **Pin migration:** each row of the table, pins that already have a model are untouched, and it is idempotent.
- **Harness catalog:** only claude and pi are run-worker capable.

**Frontend.**
- vitest for `runconfig.ts` (two shapes, plan path, preview model).
- The CDP `surface-smoke` and + Run scenarios updated. `harness-picker` fails already when a preferred runtime is set; discount it.

**Live acceptance.** The dev app, on this repo.

1. Orchestrator, goal, Claude lead: an architectural goal whose plan has at least two lanes and a Verify line. Measure wall clock against the 1h bar, lead turns (one per wake plus the report), and worker-minutes.
2. The same with a pi lead.
3. Orchestrator from a plan path: no lead session until the first judgment event.
4. A forced child ask. A plan task leaves a decision deliberately unpinned: the lead answers one, forwards one, and one reaches its deadline. Child asks have never happened in real runs, so this path must be driven on purpose.
5. A forced Verify failure and a forced merge conflict, each recovered with `dag merge --continue`.

## 13. Delivery slices

This is too large for one plan. Slice 1 is two small, reversible fixes, made directly without a plan. Slices 2, 3 and 5 get one plan each; slice 4 is split into four sub-slices, and only its two risky ones get plans. Each slice leaves the app working. Old paths are deleted only after their replacements are live, so there is no half-landed state. Tracked as the Wave initiative `effort:aeabb4ad-a19c-4f5d-bba2-44586b73af16`, with slice 4's sub-slices as chunks under its `S4 plan-driven engine` stage.

1. **Land-first fixes:** false stall, `cleanupScheduleFailure`.
2. **Harness scope and tier deletion:** §8, §9, pin migration.
3. **Queue and wake:** §5, §6; `dag retry`, `dag skip`, `dag forward`. Delete the pi control plumbing and `dag wait` once the adapter wakes both harnesses.
4. **Plan-driven engine:** §3, §4, in four sub-slices.
   - **4a. Plan parser:** `PlanFormat`, the parser with its lane derivation, and `dag submit --plan` beside JSON submit. No plan.
   - **4b. Worker identity and hung:** `--session-id` launch, transcript lookup by session id, the hung signal. No plan.
   - **4c. Setup and merge-point Verify:** Setup after `worktree add`, Verify after each squash merge at today's per-task merge points, `verify-failed` and `dag merge --continue`, the per-project merge queue, report numbers. Plan.
   - **4d. Lanes:** lane worktrees and branches, stacked in-lane commits, merges at lane tips, cross-lane waits, the G1 spec and plan fold. Plan.
5. **Lead flow:** launch prompt, orchestration rules, worker contract, compaction handoff and re-orientation hooks, + Run shapes and plan-path preview. Delete pipeline, adaptive, the plan gate and the old lead prompt, then JSON submit, `import-tasks`, `init` and `MaxDagTasks`. Those four move here from slice 4: until this slice replaces the old lead prompt (`buildEngineOrchestratePrompt`), it tells leads to submit through JSON, `import-tasks` and `init`, and states the `MaxDagTasks` cap, which `dagDigestChildRunLimit` and the frontend's `MAX_DAG_TASKS` also follow.

Slice 5 depends on 3 and 4. Slices 1 and 2 are independent of everything. Within slice 4, 4b is independent; 4c needs 4a, because Setup and Verify come from the plan; 4d needs 4a and 4c.

## 14. Open items

- **Constants chosen in this spec, not measured:**
  - `LeadAskDeadline = 10m`: above the 155s maximum compaction plus a Read/Grep answer, and below the 15m stall threshold.
  - `WakeConfirmTimeout = 30s`
  - `AnswerClearTimeout = 30s`: hook delivery is sub-second; this absorbs a slow turn start.
  - `VerifyTimeout = 20m`
- **pi `/compact <instructions>`:** verify before slice 5 (§7).
