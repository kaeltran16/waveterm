# Orchestrator gaps: six engine and hook fixes

**Verify:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run && CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/... ./cmd/...`
**Setup:** `task worktree:prepare`

Six pending chunks of the "Orchestrator guide — gaps and rough edges" effort (`effort:5d11f853-41e2-44d4-8aa4-bf92cee88dca`),
chunks #8, #6, #12, #11, #10 and #19. The same plan runs twice from the same base commit, once through the Arc engine and
once through native Claude Code delegation, to compare the two. Neither branch lands on `main` until they are compared.

Rules for every task (each task repeats the ones it needs, because a worker sees only its own task):

- Do not edit anything under `docs/`. Docs are updated when the chosen result lands.
- Do not run `wsh effort` commands or touch any effort tracker.
- After changing a wshrpc, waveobj or wconfig type, run `task generate` and commit what it writes. Never hand-edit generated files.
- Check formatting only on the files you touched (`gofmt -l <files>`, `npx prettier --check <files>`), never the whole tree.
- Every new test must fail on the code before your change. Check that it does.

### Task 1: Kill a timed-out plan command's whole process tree on Windows
**Depends on:** none

Chunk #8. When Setup or Verify hits its timeout (`SetupTimeout`, `VerifyTimeout` in `pkg/orchestrate/plancmd.go`),
`exec.CommandContext` kills only the Git Bash launcher that `shellCommand` (`pkg/orchestrate/plancmd_windows.go`) started.
The bash children keep running. On the backlog run an orphaned `go test ./pkg/...` ran for 30+ minutes after its Verify
timed out, competing with the lead's re-run.

Change:

- On Windows, `execPlanCommand` must put the command's process into a job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
  right after it starts, terminate the whole job when the context ends (timeout or cancel), and close the job after `Wait`.
  Use `exec.Cmd.Cancel` for the context path. Keep the existing `WaitDelay` and output handling.
- The job-object code already exists, unexported, in `pkg/shellexec/jobobject_windows.go` (`attachJobObject`,
  `killJobTree`, `closeJobObject`). Do not copy it. Move it into a new leaf package `pkg/util/jobobject` with exported
  functions, and make `pkg/shellexec` and `pkg/orchestrate` both use it. Behavior in `shellexec` must not change.
- Non-Windows behavior stays as it is.

Tests:

- `TestExecPlanCommandTimeoutKillsTheProcessTree` in a Windows-only test file in `pkg/orchestrate`. Run a command that starts
  a long-lived grandchild process (for example a backgrounded `sleep 300` inside the bash command) with a timeout of about
  2 seconds. Assert that `execPlanCommand` returns a timeout error, and that the grandchild process no longer exists shortly
  after it returns. Find the grandchild's Windows PID from inside bash (Git Bash's `/proc/<pid>/winpid`) and print it. The
  test must fail on the current code.
- The existing `pkg/shellexec` and `pkg/orchestrate` tests keep passing.

Rules: do not edit `docs/`, and do not run `wsh effort` commands. Commit with a message that states the fix.

### Task 2: Workers run their task's tests and a plan Check; the engine owns Verify
**Depends on:** none

Chunk #6. `workerContract` (`pkg/orchestrate/engine.go`) tells every worker to run the plan's full Verify before it
completes. The engine then runs the same Verify again after the merge. On the backlog run that meant up to four full test
suites at once, a 20-minute Verify timeout, and frontend-only workers waiting 30 to 40 minutes on the Go suite. In 56
worker runs of the full suite, none failed.

Change:

- Add an optional plan-level `**Check:**` line to `ParsePlan` (`pkg/jarvis/plan.go`), parsed exactly like Verify and Setup:
  one command in backticks, before the first task, at most one. Add `Check string` to `jarvis.Plan`. Add
  `Check string \`json:"check,omitempty"\`` to `waveobj.TaskGroup` beside Verify and Setup. Copy it wherever the
  submit path copies Verify and Setup (`DagSubmitCommand` in `pkg/wshrpc/wshserver/wshserver_dag.go`). Add it to
  `DagPlanPreviewCommand`'s return data too.
- Check is a fast whole-project static check that workers run, for example typecheck plus `go vet`. It is not run by the
  engine.
- New `workerContract` test sentence, replacing the "Run `<Verify>`…" sentence:
  - With Verify set: "Run the tests your task names" plus ", and `<Check>`," when Check is set, then "and get them passing
    before you complete; if you can't, ask. Don't run the plan's full Verify (`<Verify>`): the engine runs it after your
    task merges."
  - With no Verify: the same, without the Verify sentence. With neither Check nor Verify it must still tell the worker to
    run the tests the task names.
  - Everything else in the contract (the plan path, the ask instruction, commit then `wsh jarvis complete --commit`, the
    compaction line) stays as it is.
- Update `PlanFormat` so it documents Check. Add a `**Check:**` line to its example, which `TestPlanFormatParses` parses.
- Run `task generate` (TaskGroup and the preview return type changed) and commit the generated files.

Tests:

- Update `TestWorkerContractNamesPlanSpecVerifyAndTool` and `TestWorkerContractWithoutPlanOrVerify` in
  `pkg/orchestrate/engine_test.go` to the new text.
- Add `TestWorkerContractNamesCheckAndLeavesVerifyToTheEngine` (Check and Verify both set) and
  `TestWorkerContractWithCheckButNoVerify`.
- Add `TestParsePlanCheck` in `pkg/jarvis/plan_test.go`: a Check line parses. Add rejection cases to `TestParsePlanRejects`
  for a Check without backticks and for two Check lines.
- Add a DagSubmit test (next to the existing ones in `pkg/wshrpc/wshserver`) asserting the stored dag carries the plan's Check.

Rules: do not edit `docs/`, and do not run `wsh effort` commands. Commit with a message that states the change.

### Task 3: Carry the plan's header to every worker
**Depends on:** Task 2

Chunk #12. A worker's prompt is `workerContract` plus its own task section (`taskPrompt`, `pkg/orchestrate/engine.go`).
Anything above Task 1 reaches no worker unless it opens the plan. The backlog plan's header said "Never edit docs/"; five
lanes did, and two conflicted.

Change:

- `ParsePlan` keeps the plan's header as `Plan.Preamble`. That is every line after the `# title` line and before the first
  task heading, verbatim and in order, including fenced blocks. It excludes the title and the `**Verify:**`,
  `**Setup:**` and `**Check:**` lines, with leading and trailing blank lines trimmed. Today, fenced lines before the first
  task are dropped; they now belong to the preamble.
- Add `Preamble string \`json:"preamble,omitempty"\`` to `waveobj.TaskGroup`, and copy it on submit like Check.
- `taskPrompt` puts the preamble between the contract and the task text, under the line "The plan's header applies to
  every task:" followed by the preamble verbatim. With no preamble, the prompt is unchanged.
- Run `task generate` and commit the generated files.

Tests:

- `TestParsePlanPreamble`: header prose, a fenced block and a blank-line run are kept verbatim, and the title and the
  Verify, Setup and Check lines are not.
- `TestParsePlanWithoutPreamble`: a plan whose header holds only the title and commands has an empty preamble.
- `TestTaskPromptCarriesThePlanHeader`: the header sits between the contract and the task text.
- `TestTaskPromptWithoutPlanHeader`: no preamble means no header line.
- The existing `TestTaskPrompt*` and `TestParsePlan*` tests keep passing.

Rules: do not edit `docs/`, and do not run `wsh effort` commands. Commit with a message that states the change.

### Task 4: Close a task's tracker chunks when it lands
**Depends on:** Task 3

Chunk #11. Nothing closes effort chunks when a plan's tasks land. The backlog tracker read 3/16 with 13/13 tasks landed.

Change:

- Plan syntax:
  - A plan-level `**Effort:**` line names the effort: the value is `effort:<oid>` or a bare oid, not in backticks. It
    goes in the header like Verify, and at most one is allowed.
  - A task may carry `**Chunk:** <exact chunk label>` lines, one per chunk. They go directly after its `**Depends on:**`
    line, or first under the heading when there is no Depends line, before any other task text.
  - A `**Chunk:**` line anywhere else is task text.
  - A plan with a Chunk line but no Effort line fails to parse, naming the task.
- Types:
  - Add `EffortOID string` to `jarvis.Plan`, and `EffortOID string \`json:"effortoid,omitempty"\`` to `waveobj.TaskGroup`.
  - Add `Chunks []string \`json:"chunks,omitempty"\`` to `waveobj.TaskNode`.
  - The Effort and Chunk lines are not task description text, and not preamble text either (Task 3).
- Submit (`DagSubmitCommand`) refuses a plan whose effort does not exist, or whose chunk labels do not resolve on that
  effort (use `jarvisstate.ResolveChunkIndex`). The error names the missing effort or label.
- When a task's merge passes Verify, where the engine appends `task-verify-passed` (`pkg/orchestrate/verify.go`), the engine
  marks each of that task's chunks done on the effort. When a lane lands several tasks in one merge, it does this for every
  task in the lane.
  - Do it through `wstore.UpdateEffort` with `jarvisstate.ApplyEffortOps` and a `setChunkStatus` op, the way
    `EffortMutateCommand` does. Use the note "landed <squash commit> (run <run id>, task <task id>)".
  - A failure to update the effort is logged with the effort, chunk and task. It must not fail the merge or the Verify.
- Update `PlanFormat` to document both lines, with an example that `TestPlanFormatParses` parses.
- Run `task generate` and commit the generated files.

Tests:

- Plan parsing: `TestParsePlanEffortAndChunks` (one Effort, two chunks on one task, none on another, and a Chunk line with no
  Depends line), `TestParsePlanChunkWithoutEffortRejected`, and `TestParsePlanChunkLineLaterIsTaskText`.
- Submit: a test that a missing effort and a missing chunk label are each refused with the name in the error.
- Engine: `TestVerifyPassClosesTheTasksChunks`. A dag whose task names a chunk on a stored effort, after Verify passes, leaves
  that chunk `done` with the landed-commit note. Also `TestVerifyFailLeavesChunksOpen`.
- Keep the existing `pkg/orchestrate` and `pkg/jarvis` tests passing.

Rules: do not edit `docs/`, and do not run `wsh effort` commands. Your tests use their own stored efforts. Commit with a
message that states the change.

### Task 5: Seal a lead's report from `wsh jarvis complete --report`
**Depends on:** none

Chunk #10. A run's sealed evidence summary is the last assistant text in the final worker's transcript (`SealEvidence` and
`finalAssistantText`, `pkg/jarvis/evidence.go`). `wsh jarvis complete` makes an orchestrator run terminal, and the engine
then closes the lead's tab mid-turn (`MaybeCloseOrchestratorLead`). So the lead's report is lost, and the sealed summary is
whatever the lead said before it.

Change:

- `wsh jarvis complete` (`cmd/wsh/cmd/wshcmd-jarvis.go`) gains `--report <file>`. The file is read in the wsh process,
  relative to its working directory. An unreadable or empty file is an error, and nothing is sent.
- Add `Report string \`json:"report,omitempty"\`` to `wshrpc.CommandReportRunPhaseData` and `wshrpc.CommandAdvanceRunData`.
  `ReportRunPhaseCommand` forwards it.
- A complete with a report stores it on the run: add `Report string \`json:"report,omitempty"\`` to `waveobj.Run`, set in
  the same update that records the completion.
- `SealEvidence` uses `run.Report` as the summary when it is set, and otherwise uses the transcript as today.
- The lead's run-finished rule (`pkg/jarvis/leadprompt.go`, the "run finished" bullet) tells the lead to write its report
  to a file and finish with `wsh jarvis complete --report <file>` once the human says so. The rest of that rule stays.
- Run `task generate` and commit the generated files.

Tests:

- `TestSealEvidenceUsesTheCompleteReport` and `TestSealEvidenceFallsBackToTheTranscriptWithoutAReport` in
  `pkg/jarvis/evidence_test.go`.
- A server test that a complete carrying a report stores it on the run (next to the existing AdvanceRun or ReportRunPhase
  tests).
- A wsh test for the report file: read it, and refuse it when it is empty or missing. Extract a small function if the cobra
  command is hard to test directly.
- Update any lead-prompt test that asserts the run-finished text.

Rules: do not edit `docs/`, and do not run `wsh effort` commands. Commit with a message that states the change.

### Task 6: An idle Claude session reads idle, not working
**Depends on:** none

Chunk #19. `planEmission` (`cmd/wsh/cmd/wshcmd-agenthook.go`) maps every Claude Code `Notification` hook to the `waiting`
state, and the roster folds `waiting` into working (`agentVMFromInput`, `frontend/app/view/agents/agentsviewmodel.ts`).
Claude Code sends a Notification of type `idle_prompt` when a session has sat at its prompt. So an orchestrator lead reads
as working for the whole run, though it is idle between wakes.

Change:

- Add `NotificationType string \`json:"notification_type"\`` to `ccHookEvent`.
- In `planEmission`, a Notification maps by type:
  - `idle_prompt` maps to `idle`.
  - `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog` and `agent_needs_input` map to `waiting`, as today.
  - An empty type (an older Claude Code that does not send the field) maps to `waiting`, as today.
  - Any other type (`auth_success`, `agent_completed`, `elicitation_complete`, `elicitation_response`, the
    `quota_auto_resume_*` types) emits nothing, leaving the state unchanged.
- The frontend does not change.

Tests:

- Extend the table in `cmd/wsh/cmd/wshcmd-agenthook_test.go` with one case per mapping above: idle, each waiting type, empty
  type, and at least two of the no-emission types.

Rules: do not edit `docs/`, and do not run `wsh effort` commands. Commit with a message that states the change.
