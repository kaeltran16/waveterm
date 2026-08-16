# Orchestrator Redesign Implementation Plan

> **For agentic workers:** executed inline by the lead (this run) — the DAG/child machinery under
> repair is exactly what would be used to delegate, so children are not used to fix it. TDD per task.

**Goal:** close the 10 observed orchestrator flaws (`docs/orchestrator-redesign-flaws.md`, F1–F10) with
the 8 derived requirements (R1–R8): children stop asking questions nobody can answer, stalls get
caught and reported, the lead can see and answer child asks, plan context reaches children, run
context reaches the lead, and status stops lying.

**Architecture:** all fixes live in the existing engine loop (`pkg/orchestrate` ScheduleOnce +
control files + `wshserver_dag.go`), the ask registry (`pkg/agentask`), the spawn path
(`pkg/jarvis/runexec.go`), and the CLI (`cmd/wsh/cmd/wshcmd-jarvisdag.go`). No new subsystems, no
message bus, no timeout policies — only the observed failure modes.

**Tech Stack:** Go (engine, CLI, RPC), React 19 (FE DAG graph + ask card), pi extension
(`pi/extensions/waveterm-tools.ts` control dispatch).

**Spec:** `docs/orchestrator-redesign-flaws.md` (evidence + requirements). Travels with this plan.

## Global Constraints

- KISS/YAGNI: no new subsystems; only the failure modes in the tracker.
- The lead is the child's human: children stay headless; every question routes to lead or cockpit.
- Never hand-edit generated files; run `task generate` after any wshrpc/waveobj change.
- TDD: failing test first per task; `go test ./pkg/orchestrate/ ./pkg/wshrpc/wshserver/` and
  `npx vitest run` for FE pieces.
- Go tests: `CGO_CFLAGS=-I<repo>/pkg/jarvisembed/csrc` (PowerShell) if sqlite-vec CGO header fails.
- tsc via `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.

---

### Task 1: Description passthrough + headless-child contract (R5, R6)

**Files:**
- Modify: `pkg/waveobj/wtype.go` (TaskNode + Description field)
- Modify: `pkg/orchestrate/import.go` (map pitasks.Description)
- Modify: `pkg/orchestrate/engine.go` (taskPrompt: goal + description + HEADLESS_CONTRACT)
- Test: `pkg/orchestrate/import_test.go`, `pkg/orchestrate/engine_test.go`

**Interfaces:**
- Produces: `waveobj.TaskNode.Description string`; `orchestrate.HeadlessContract` const; taskPrompt
  output shape `goal\n\n<description>\n\n<headless contract>`.

- [ ] **Step 1:** failing tests — import_test: a pitasks task with Description maps to
      TaskNode.Description; engine_test: taskPrompt(desc task) contains the description text and the
      contract text; taskPrompt(label-only) contains the contract but no description.
- [ ] **Step 2:** run tests, confirm fail.
- [ ] **Step 3:** implement the three edits. Contract text (const): "You are a headless worker. Never
      ask the user questions — resolve unpinned decisions to the plan's recommended option or the
      minimal documented assumption and proceed. Do not pause for design approval; the plan was
      already approved."
- [ ] **Step 4:** tests pass; `task generate` (TaskNode is a waveobj type consumed by FE bindings).

### Task 2: Lead run-context resolution (R7)

**Files:**
- Create: `pkg/wshrpc/wshserver/wshserver_ctx.go`
- Modify: `pkg/wshrpc/wshrpctypes_ask.go` or a new types file (CommandJarvisCtxData/RtnData),
  `cmd/wsh/cmd/wshcmd-jarvis.go` (ctx command), `cmd/wsh/cmd/wshcmd-jarvisdag.go`
  (status/action/submit/import-tasks fall back to ctx when --channel/--runid absent)
- Test: `pkg/wshrpc/wshserver/wshserver_ctx_test.go`, `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`

**Interfaces:**
- Produces: RPC `jarvisctx` returning `{channelid, runid, dagoid, goal}`; `wsh jarvis ctx` prints it;
  dag commands auto-fill from ctx.

- [ ] **Step 1:** failing test — ctx resolution: block → tab → run (scan `wstore.GetRun`-readable
      runs for a phase WorkerORefs containing the tab) → channel; unknown block → empty result, no
      error.
- [ ] **Step 2:** confirm fail.
- [ ] **Step 3:** implement resolution (runs scan via wstore: query db_run rows, match
      phases[].workerorefs; bounded by channel — the caller block's workspace → channel list). Wire
      `wsh jarvis ctx` + dag-command fallback.
- [ ] **Step 4:** tests pass; `task generate` (new RPC).

### Task 3: Child-ask forwarding + answer CLI (R1)

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_ask.go` (AskCommand: dag-child → publish child-ask event +
  NotifyLead), `pkg/orchestrate/control.go` (DagEventChildAsk + child_ask mapping),
  `pkg/wshrpc/wshserver/wshserver_dag.go` (asks list + answer actions via agentask registry),
  `cmd/wsh/cmd/wshcmd-jarvisdag.go` (`asks`, `answer <task-id> <answers-json>`),
  `pi/extensions/waveterm-tools.ts` (dispatch child_ask)
- Test: `pkg/wshrpc/wshserver/wshserver_ask_test.go` (dag-child ask publishes scoped event),
  `pkg/orchestrate/control_test.go` (child_ask message), CLI tests

**Interfaces:**
- Produces: dag event `dag:child-ask` (scoped dag+parent run, payload
  `{"taskid":..., "question":...}`); control cmd `child_ask`; `wsh jarvis dag asks` lists pending
  asks (task → child run → worker block → agentask registry); `wsh jarvis dag answer` wraps
  `AnswerAgentCommand`.

- [ ] **Step 1:** failing tests: child-block ask → event published to dag+parent-run scopes; control
      message maps child_ask; asks list finds the pending ask registered under the child block.
- [ ] **Step 2:** confirm fail.
- [ ] **Step 3:** implement: block→tab→run→DagORef resolution (shared helper with Task 2); registry
      scan; CLI subcommands.
- [ ] **Step 4:** tests pass; `task generate`.

### Task 4: Watchdog (R2, R3)

**Files:**
- Modify: `pkg/waveobj/wtype.go` (TaskNode.LastActivity + TaskState_Stalled const in
  `pkg/orchestrate/dag.go`), `pkg/orchestrate/engine.go` (set/refresh LastActivity; stall detection;
  stalled → publish + NotifyLead; activity resumes), `pkg/orchestrate/control.go` (child_stalled),
  `pkg/orchestrate/watchdog.go` (new: package ticker, started once from wshserver init, lists active
  dags and calls ScheduleOnce every 30s), `pkg/wstore` (dag list-by-status if missing)
- Test: `pkg/orchestrate/engine_test.go` (stall detection with frozen child; resume on activity),
  watchdog ticker test (stubbed ScheduleOnce count)

**Interfaces:**
- Produces: `TaskNode.LastActivity`; liveness source = child block's pi session file mtime via
  `pkg/agentsessions` scan (fallback: child run CreatedTs); stall threshold const 15 min; state
  `stalled`; control cmd `child_stalled`; `orchestrate.StartWatchdog(ctx, 30s)`.

- [ ] **Step 1:** failing tests for detection + control mapping.
- [ ] **Step 2:** confirm fail.
- [ ] **Step 3:** implement liveness read, detection in ScheduleOnce, stalled state (RetryTask/SkipTask
      already generic over states), watchdog ticker + wstore listing + init wiring.
- [ ] **Step 4:** tests pass; `task generate` (new state/field flow to FE types).

### Task 5: FE — stalled state + parent-run child-ask card (R1, R4)

**Files:**
- Modify: `frontend/app/view/orchestrate/daggraph.tsx` (stalled color, ask badge),
  `frontend/app/view/agents/runbody.tsx` or a small `childaskcard.tsx` (pending child asks for the
  run's dag rendered in the run header when dagoref present; option buttons call
  `RpcApi.AnswerAgentCommand`)
- Test: `frontend/app/view/orchestrate/daglayout.test.ts` (stalled state passthrough), pure helpers
  for the ask card if any logic (parse answers → selectedindexes)

- [ ] **Step 1:** failing tests (layout/state mapping).
- [ ] **Step 2:** confirm fail.
- [ ] **Step 3:** implement state color + card.
- [ ] **Step 4:** vitest + tsc green.

### Task 6: Scaffold + docs (R8)

**Files:**
- Create: `cmd/wsh/cmd/wshcmd-jarvisdag.go` `dag init` subcommand (writes `.pi/tasks/tasks.json`
  template with nextId/sample task/timestamps), `docs/orchestrator/tasks.example.json`
- Test: CLI test (init writes parseable store)

- [ ] **Step 1:** failing CLI test (init output parses via pitasks.Parse, has ≥1 sample task).
- [ ] **Step 2:** confirm fail.
- [ ] **Step 3:** implement init.
- [ ] **Step 4:** tests pass; update `docs/orchestrator-redesign-flaws.md` status column after the
      verification gate (Task 7).

### Task 7: Verification gate + live validation

- [ ] `task generate` clean; `node --stack-size=4000 ... tsc --noEmit` 0 errors; `npx vitest run`
      green; `task build:backend` green (go tests incl. new suites); `npx prettier --check` on
      changed files.
- [ ] Live validation: cancel current DAG is done; re-import the evidence goal's 6 tasks
      (`.pi/tasks/tasks.json` still present), observe: children spawn with description+contract in
      their goal, `wsh jarvis ctx` resolves, child asks (if any) appear in `wsh jarvis dag asks` and
      the parent-run card, watchdog reports stalls, tasks complete and the DAG finishes.
- [ ] Commit everything (one commit: `feat(orchestrate): ...`), then `wsh jarvis complete --commit`.
