# The lead plans from an approved design

**Spec:** `C:/Users/kael02/IdeaProjects/waveterm/docs/superpowers/specs/2026-10-27-lead-plans-from-approved-design-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/jarvis/... ./pkg/waveobj/... ./pkg/wshrpc/... ./pkg/orchestrate/... ./cmd/wsh/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/jarvis/... ./pkg/waveobj/... ./pkg/wshrpc/... ./pkg/orchestrate/... ./cmd/wsh/...`
**Final:** `node scripts/cdp/final-verify.mjs new-run-design run-sheet-designing`

Design work moves out of the run's lead: a run carries an approved design as fields (`Run.Spec`, `Run.Prototype`),
the lead's prompt branches on them in code, and a run can wait on a linked design session (`Run.Design`) whose
Approve / Build this… hands the design to the run and starts its lead.

## Decisions made beyond the spec (with why)

1. **One wire interface lands first (Task 1)**, with the two new RPC handlers stubbed. The server, prompt and
   frontend tasks all build on the same types and generated client; the stubs are replaced in Task 3.
2. **Approve / Build this… routing is one server RPC that looks up and attaches**:
   `RunDesignAttachCommand{blockid, spec, prototype}` scans for an orchestrator run in `planning` whose
   `Design.BlockId` is the block and attaches inside the same `UpdateRun`. Why: the frontend's run lists are partial
   (loaded per channel), so a frontend lookup could miss the run; the lookup stays code, never the agent's judgment.
   On attach `Design` is cleared and `Run.DesignSession` (the session's block id) is kept, so a repeat attach from the
   same block (double click, race, a second Build this…) matches that run and is **refused** (`run <id> already took
   this session's design`), never read as an unlinked session; the frontend shows the error and opens nothing. Only a
   block no run ever waited on gets the empty reply, which is the spec's "Not found: the normal session's launcher".
3. **The design session reuses the run-worker spawn** (`jarvis.SpawnRunWorker`) with a new
   `RunWorkerOptions.DesignSession bool`: no `ARC_RUN_AGENT` env, no `agent:runid`/`agent:taskid` stamps, and its tab
   is never put on a run phase, so it is a normal session (the brainstorm pane and its hook context apply, and
   closing its tab fails nothing). It runs on the run's lead route, in `run.ProjectPath` (the main checkout, where
   `.superpowers/` and `docs/superpowers/specs/` live), labelled `runLabel(goal)`, with the worker's launch flags
   (claude: `--dangerously-skip-permissions`), so it starts headlessly and never parks on a prompt the cockpit
   cannot show.
4. **A designing run** is `Status = planning`, phase 0 `running` with no worker orefs, no dag, `Design` set. Boot's
   `MarkInterruptedRuns` already skips a running phase with no worker. Attaching spawns the lead through
   `spawnRunWorkersWithPrompt(..., "")`, whose `phasePrompt` now yields the plan-from-design prompt because `Spec` or
   `Prototype` is set; the run then reads executing as any started lead run does.
5. **`wsh jarvis design --kind brainstorm|canvas`** (lead path) starts the session, sets `Design`, removes the lead's
   tab oref from the run's phases and sets the run to planning, and only then deletes the lead's tab. Why: since
   af66a198 closing a run's agent tab fails its running phase (`HandleWorkerTabClose`); with the oref gone first,
   the close finds nothing to fail.
6. **Run events:** `design-started` (`{kind, blockid}`) when a run starts waiting, `design-attached`
   (`{spec, prototype}`) on attach, beside `RunEventKindCreated` in `pkg/waveobj/runevent.go`.
7. **Launcher:** `StartFrom` gains `"design"`, labelled `Approved design`, offered only when the prefill brought a
   spec or a prototype; a remembered `"design"` start with no design reads as `goal`. The prototype now rides only the
   Approved design start (read-only, no remove button), so the goal start's prototype row goes. **Design first** is a
   three-way toggle on the Goal start (`Off` | `Brainstorm` | `Mock up`, wire `designfirst: "" | "brainstorm" |
   "canvas"`); with Approvals autonomous the launch is blocked with `Design first needs Ask me approvals`.
8. **Brainstorm prefill** sends the spec as a field (`spec`, absolute) and the goal becomes `Build <title>.`; the
   spec is no longer goal prose.
9. **Run sheet:** a run with `design` reads verb `Designing`, sub `brainstorming with you` / `mocking it up with
   you`, next `a lead plans from the design once you approve it`, with an `Open session` link to the session's tab
   (found by `blockid` among the roster's agents; `openTarget({kind: "agent", tabId})`). With no live tab the sub is
   `the design session's tab is closed` and there is no link.
10. **Design session prompt** (`jarvis.DesignSessionPrompt(goal, kind)`): brainstorm → "Brainstorm this goal with
    the human with superpowers:brainstorming: <goal>"; canvas → "Mock up this goal with arc:design: <goal>"; both add
    that a run waits on this session and takes the design when the human approves it (pane Approve / Build this…).

### Task 1: Wire types, RPC declarations, prompt signature
**Depends on:** none
**Files:** `pkg/waveobj/wtype.go`, `pkg/waveobj/runevent.go`, `pkg/wshrpc/wshrpctypes_runs.go`, `pkg/wshrpc/wshserver/wshserver_design.go`, `pkg/jarvis/run.go`, `pkg/jarvis/runexec.go`, `pkg/jarvis/leadprompt_test.go`, `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`

The interface every later task builds on. No behavior change.

- `pkg/waveobj/wtype.go`: `type RunDesign struct { Kind string json:"kind"; BlockId string json:"blockid" }`,
  `Run.DesignSession string json:"designsession,omitempty"` (the block of the session whose design the run took;
  set at attach, header decision 2),
  consts `RunDesignKind_Brainstorm = "brainstorm"`, `RunDesignKind_Canvas = "canvas"`; on `Run`, beside
  `Prototype`: `Spec string json:"spec,omitempty"` (absolute path of the approved spec; wins over the lead's
  `--spec` at DagSubmit) and `Design *RunDesign json:"design,omitempty"` (set while the run waits on a linked
  design session).
- `pkg/waveobj/runevent.go`: `RunEventKindDesignStarted = "design-started"`, `RunEventKindDesignAttached = "design-attached"`.
- `pkg/wshrpc/wshrpctypes_runs.go`: `CommandCreateRunData.Spec string json:"spec,omitempty"` and
  `DesignFirst string json:"designfirst,omitempty"`; on `RunCommands`:
  `RunDesignAttachCommand(ctx, CommandRunDesignAttachData) (*CommandRunDesignAttachRtnData, error)` with
  `CommandRunDesignAttachData{BlockId "blockid"; Spec "spec,omitempty"; Prototype "prototype,omitempty"}` and
  `CommandRunDesignAttachRtnData{ChannelId "channelid,omitempty"; RunId "runid,omitempty"}`, and
  `JarvisDesignCommand(ctx, CommandJarvisDesignData) error` with `CommandJarvisDesignData{ORef "oref"; Kind "kind"}`.
- `pkg/wshrpc/wshserver/wshserver_design.go`: both handlers on `*WshServer`, returning
  `fmt.Errorf("not implemented yet")`; Task 3 replaces them.
- `pkg/jarvis/run.go`: `BuildOrchestratePrompt(run *waveobj.Run) string`, reading `Goal`, `Principles`, `Runtime`,
  `Autonomous` from the run, same output as today. Update `phasePrompt` in `runexec.go` and every call in
  `leadprompt_test.go` (build a `&waveobj.Run{Goal: "ship auth", Runtime: runtime, ...}`).
- Run `task generate` (never hand-edit the generated files).

Acceptance: `go build ./...` passes; `go test ./pkg/jarvis -run 'Prompt|Orchestrat'` passes unchanged in substance;
`npx vitest run frontend/app/view/agents/runactions.test.ts` passes; Check passes.

### Task 2: The lead's prompt branches on the run's design
**Depends on:** Task 1
**Files:** `pkg/jarvis/leadprompt.go`, `pkg/jarvis/run.go`, `pkg/jarvis/leadprompt_test.go`

- `Spec` or `Prototype` set → the plan-from-design prompt (spec decision 2): states the design is approved and
  names the spec and/or prototype paths; no `superpowers:brainstorming`, no path classification (spike / bounded /
  architectural), no `Spec review`. It says: read the design and the code it touches, write the decisions made beyond
  it, with why, into the plan's header, then the plan step. The plan step names `--spec <spec path>` only when a
  spec is set; with only a prototype it says to put the prototype's path on the `**Prototype:**` line and submit
  without `--spec`. Split `writePlanAndSubmit` as needed so the submit command varies; keep the rest of its text.
  Autonomous → the same prompt plus `AutonomousRules`.
- Neither set, asking → the goal prompt: first line drops "with the superpowers:brainstorming skill" (keeps: the
  human is at this terminal, every question and approval through the ask tool). Spike and bounded unchanged. The
  architectural path asks once with header `Needs a design` and three options `Brainstorm it`, `Mock it up`,
  `Plan from the goal`: the first two run `wsh jarvis design --kind brainstorm` / `--kind canvas` and stop (the
  command closes this tab); `Plan from the goal` makes the design calls itself, records each with why in the plan's
  header, and submits without `--spec`. The mockup-settles-design `Spec review` text goes.
- Neither set, autonomous → unchanged.

Tests in `leadprompt_test.go` (claude and pi): `TestPlanFromDesignPrompt` for spec only, prototype only, both, each
asking and autonomous: no `brainstorming`, no `Spec review`, contains each set path, contains `--spec` iff a spec is
set, autonomous ones contain `AutonomousRules`; `TestGoalPromptNeedsADesign`: no `superpowers:brainstorming`,
contains `Needs a design`, the three option labels and `wsh jarvis design --kind brainstorm` / `--kind canvas`;
existing autonomous goal-prompt tests unchanged. Run `go test ./pkg/jarvis -run 'PlanFromDesign|NeedsADesign|Autonomous|Prompt'`.

### Task 3: Server: Spec, Design first, attach, wsh jarvis design
**Depends on:** Task 1
**Files:** `pkg/wshrpc/wshserver/wshserver_design.go`, `pkg/wshrpc/wshserver/wshserver_design_test.go`, `pkg/wshrpc/wshserver/wshserver_runs.go`, `pkg/wshrpc/wshserver/wshserver_dag.go`, `pkg/wshrpc/wshserver/wshserver_createrun_test.go`, `pkg/wshrpc/wshserver/wshserver_dag_test.go`, `pkg/jarvis/runexec.go`, `pkg/jarvis/designprompt.go`, `pkg/jarvis/designprompt_test.go`, `cmd/wsh/cmd/wshcmd-runs.go`, `cmd/wsh/cmd/wshcmd-runs_test.go`, `cmd/wsh/cmd/wshcmd-jarvis.go`, `cmd/wsh/cmd/wshcmd-jarvis_test.go`

- `pkg/jarvis/designprompt.go`: `DesignSessionPrompt(goal, kind string) string` (header decision 10).
  `RunWorkerOptions.DesignSession bool` in `runexec.go` (header decision 3): no `ARC_RUN_AGENT`, no run stamps.
- `wshserver_design.go`: `startDesignSession(ctx, channelId string, run *waveobj.Run, kind string) (blockId string, err error)`
  — the one server function both entry points use: validates kind, spawns the session (decision 3), sets
  `run.Design = {kind, blockid}` and `Status = planning`, appends `design-started`, sends the run/channel updates.
- CreateRun (`wshserver_runs.go`): `Spec` is stored on the run, must be absolute and exist, refused on a non-
  orchestrator run (`spec needs an orchestrator run`), as `Prototype` is. `DesignFirst` (`brainstorm` | `canvas`):
  refused on quick, refused with `--plan`, refused with `Spec`/`Prototype`, refused on an autonomous run
  (`design first needs a human: this run's approvals are autonomous`); otherwise the run is created in planning,
  no lead is spawned, and `startDesignSession` runs instead (a failed start cancels the run and returns the error).
- DagSubmit (`wshserver_dag.go`): `run.Spec` wins over `data.SpecPath`, as `run.Prototype` wins over the plan's line;
  a fix round still drops the spec.
- `RunDesignAttachCommand` (decision 2): requires `blockid` and at least one of `spec`/`prototype` (absolute,
  existing). Lookup over the channels' runs: a planning orchestrator run with `Design.BlockId == blockid` → attach;
  else a run with `DesignSession == blockid` → refused (`run <id> already took this session's design`); else empty
  reply, no error. Attach: in one `UpdateRun` refuse unless `Design != nil && Design.BlockId == blockid`, set
  `Spec`/`Prototype` and `DesignSession = blockid`, clear `Design`; append `design-attached`; spawn the lead with
  `spawnRunWorkersWithPrompt(ctx, channelId, runId, ch.Name, "")`; return the ids.
- `JarvisDesignCommand`: resolves the caller's run from `ORef` (`jarvis.ResolveRunWorkerFromMeta`); refuses a
  non-orchestrator run, an autonomous run, a run with a dag, and a bad kind; `startDesignSession`; removes the lead
  tab oref from the phases (reimplemented in `wshserver_design.go` the way `pkg/orchestrate`'s unexported
  `clearLeadTab` does it; do not export it or edit `wake.go`, which Task 4 owns); then deletes the lead's tab
  (decision 5).
- Cancel: a designing run (planning, phase 0 running with no worker) cancels through the existing
  `CancelRunCommand` like any planning run, and its design session's tab is left alone. Fix the cancel path if a
  worker-less running phase trips it.
- `wsh runs start --spec <path>` (made absolute like `--prototype`, orchestrator only, in the existing
  orchestrator-only flag error). `wsh jarvis design --kind brainstorm|canvas` calls `JarvisDesignCommand` with the
  caller's block oref, as `wsh jarvis ctx` does.

Tests (`wshserver_createrun_test.go`, `wshserver_design_test.go`, `wshserver_dag_test.go`, stub the spawn via
`jarvis.SpawnRunWorker`): `TestCreateRunStoresSpec`, `TestCreateRunRefusesSpecOnQuick`,
`TestCreateRunDesignFirstStartsNoLead` (run planning, `Design` set with the spawned block, no phase orefs, one spawn
with `DesignSession` and the design prompt), `TestCreateRunRefusesDesignFirstOnAutonomous`,
`TestDagSubmitRunSpecWins`, `TestRunDesignAttachStartsOneLead` (two sequential attaches from the same block → one
lead spawn whose prompt equals `jarvis.BuildOrchestratePrompt` of the attached run, which has `Spec` set (the
prompt's text is Task 2's to test); the second attach returns the `already took` error; `Design` cleared,
`DesignSession` set, `design-attached` event), `TestRunDesignAttachNoWaitingRun` (a block no run waited on → empty
reply, no error), `TestCancelDesigningRun` (cancelled; the session tab is not deleted),
`TestJarvisDesignSetsDesignAndClosesLead` (Design set, lead oref gone, tab deleted, phase not failed),
`TestJarvisDesignRefusesAutonomous`; `TestDesignSessionPrompt` in pkg/jarvis;
the wsh flag tests beside the existing `--prototype` ones. Run
`go test ./pkg/wshrpc/wshserver -run 'CreateRun|DesignFirst|RunDesignAttach|CancelDesigningRun|JarvisDesign|DagSubmitRunSpec'`,
`go test ./pkg/jarvis -run 'DesignSession'`, `go test ./cmd/wsh/cmd -run 'Runs|Jarvis'`.

### Task 4: Handoff compaction text for a lead that planned
**Depends on:** none
**Files:** `pkg/orchestrate/wake.go`, `pkg/orchestrate/wake_test.go`

`handoffInstructions` becomes (spec decision 5): keep the interfaces and files each task relies on, why the plan is
split as it is, and the human's answers to the lead's own asks; drop tool output, plan drafts and code bodies.
Mechanism unchanged. Test `TestHandoffInstructionsForAPlanningLead` asserts the keep and drop items and that the old
"what the human said that the spec does not record" is gone; run `go test ./pkg/orchestrate -run 'Handoff'`.

### Task 5: Launcher: Approved design start and Design first
**Depends on:** Task 1 (uses the generated `spec` / `designfirst` fields of `CommandCreateRunData`)
**Files:** `frontend/app/view/agents/runconfig.ts`, `frontend/app/view/agents/runconfig.test.ts`, `frontend/app/view/agents/runconfigstore.ts`, `frontend/app/view/agents/runlauncher.tsx`, `frontend/app/view/agents/runactions.ts`, `frontend/app/view/agents/runactions.test.ts`, `frontend/app/view/jarvis/newrun.ts`, `frontend/app/view/jarvis/newrun.test.ts`, `frontend/app/view/jarvis/newruncontrol.tsx`, `frontend/app/view/agents/brainstormmodel.ts`, `frontend/app/view/agents/brainstormmodel.test.ts`, `scripts/cdp/scenarios.mjs`

Header decisions 7 and 8.
- `runconfig.ts`: `StartFrom = "goal" | "plan" | "design"`; `startOptions(hasDesign: boolean): StartFrom[]`
  (`design` first when present); `effectiveStart(start, hasDesign)`; `startNote("design")` says a lead plans from the
  approved design, with no design conversation; `type DesignFirst = "" | "brainstorm" | "canvas"`;
  `launchBlocker` takes `designFirst` and `autonomous` and returns `Design first needs Ask me approvals` for
  Design first with autonomous.
- `NewRunPrefill` gains `spec?: string`; `prefillToLaunch` returns `spec` and opens on `start: "design"` when a spec
  or prototype came (shape corrected to orchestrator). `RunConfig` gains optional `spec?: string` and
  `designFirst?: DesignFirst` (absent = `""`, so `briefsheet.tsx`'s config builder needs no change). `launchOptsFromConfig`:
  design start → `spec`/`prototype`; goal start → `designFirst` when set, never a prototype; plan start unchanged.
  `CreateRunOpts`/`createRunPayload` send `spec` and `designfirst` on orchestrator runs only.
- `runlauncher.tsx` (the brief sheet's launcher, which never has a prefill): `START_LABEL` gains
  `design: "Approved design"` and its toggle lists `startOptions(false)`, so it shows no design start.
- `newruncontrol.tsx`: the start toggle lists `startOptions`; the design start shows the spec and prototype as
  read-only rows (`data-new-run-design`, each row `data-new-run-design-spec` / `-prototype`) above the editable goal;
  the goal start shows the `Design first` toggle (`role="group" aria-label="Design first"`). Footer and blockers as
  today.
- `runPrefill` (brainstorm) returns `spec` (absolute) and goal `Build <title>.`; the canvas's `openBuildRun` prefill needs no change (its
  prototype now opens the Approved design start).
- New CDP scenario `new-run-design` in `scripts/cdp/scenarios.mjs` (temp project like `new-run-window`; it replaces
  `RpcApi.CreateRunCommand` in the page with a recorder for the run, restoring it in teardown, so no lead starts):
  steps `1. a prefill with a spec and a prototype opens New run on the Approved design start` (pressed),
  `2. the spec and prototype show read-only and the goal is editable`, `3. Start run sends spec and prototype as
  fields and the goal without the spec path`, `4. the Goal start shows Design first; Brainstorm sends designfirst
  brainstorm`, `5. with Approvals autonomous, Design first blocks the launch with its reason`, `6. a prefill with no
  design offers only Goal and Plan file`.

Tests: `runconfig.test.ts` (`startOptions`, `effectiveStart`, the Design first blocker), `newrun.test.ts`
(`launchOptsFromConfig` for design/goal-with-design-first/plan, `prefillToLaunch` with spec/prototype),
`runactions.test.ts` (payload carries `spec`/`designfirst` only on orchestrator), `brainstormmodel.test.ts`
(`runPrefill` spec field and goal). Run `npx vitest run frontend/app/view/agents/runconfig.test.ts frontend/app/view/jarvis/newrun.test.ts frontend/app/view/agents/runactions.test.ts frontend/app/view/agents/brainstormmodel.test.ts`.

### Task 6: Linked design routing and the run sheet's Designing state
**Depends on:** Task 5
**Files:** `frontend/app/view/agents/designroute.ts`, `frontend/app/view/agents/designroute.test.ts`, `frontend/app/view/agents/brainstormsend.ts`, `frontend/app/view/agents/brainstormsend.test.ts`, `frontend/app/view/agents/canvaspane.tsx`, `frontend/app/view/jarvis/runsheetmodel.ts`, `frontend/app/view/jarvis/runsheetmodel.test.ts`, `frontend/app/view/jarvis/runsheet.tsx`, `scripts/cdp/scenarios.mjs`

Header decisions 2 and 9.
- `designroute.ts`: `routeDesign(io: DesignRouteIO, blockId: string, design: {spec?: string; prototype?: string}): Promise<"attached" | "launcher">`
  with `DesignRouteIO = { attach(data): Promise<{channelid?: string; runid?: string}>; onAttached(channelId, runId): void; openLauncher(): void }`;
  ids back → `onAttached`, empty → `openLauncher`; an attach error propagates (the caller shows it) and opens nothing.
- `approveAndOpenRun` (brainstormsend): after `brainstorm: approved`, `routeDesign` with the agent's block and the
  prefill's spec/prototype; attached → `notifyRun(agent, runId)` (`brainstorm: run <id>`); launcher → today's
  `openRunLauncher`. `openBuildRun` (canvas): attached → `openTarget({kind: "channel", channelId, runId})`;
  launcher → today's prefill. A refused attach (the `already took` error) shows the error and opens nothing.
- `runsheetmodel.ts`: `undaggedStatus` returns the Designing status when `run.design` is set (before the asking and
  planning branches); `designLink(run, agents): {tabId: string} | null` (the agent whose `blockId` is
  `run.design.blockid`). `runsheet.tsx` renders `Open session` (`data-run-sheet-design-link`) in the reading when the
  link exists, calling `openTarget(model, {kind: "agent", tabId})`.
- New CDP scenario `run-sheet-designing` (it runs in Final on the merged tree, where Task 3's server has landed):
  arrange creates a temp project holding a spec file, and two runs, one with `designfirst: "brainstorm"`, one with
  `designfirst: "canvas"`, goals `verify run-sheet-designing: ask nothing, make no changes, stop`. Steps:
  `1. the brainstorm run's sheet reads Designing with the brainstorm sub`;
  `2. Open session shows the session's tab on the Agent surface` (click it, assert the focused tab is the design
  session's);
  `3. the canvas run reads mocking it up with you; with its session tab deleted it reads the closed sub and has no
  Open session link`;
  `4. Approve in the brainstorm session's pane attaches: no New run window opens, the run leaves Designing, and the
  pane sends brainstorm: run <id>`. For step 4, seed the session's `brainstorm.json` (approvable, naming the spec)
  under its `.superpowers/brainstorm/<topic>/` as the `brainstorm-mode` scenario seeds one, open the pane and click
  Approve; the real attach runs and starts a lead. Record the pane's prompts by replacing `RpcApi.AgentPromptCommand`
  in the page, restored in teardown.
  Teardown cancels both runs and deletes the session and lead tabs and the project.

Tests: `designroute.test.ts` (attached, launcher, attach error opens nothing), `brainstormsend.test.ts` (approve on a
linked session sends `brainstorm: run <id>` and opens no launcher; unlinked opens it), `runsheetmodel.test.ts`
(Designing for brainstorm and canvas, the closed-tab sub, `designLink` found/missing, a run without design still reads
Planning). Run `npx vitest run frontend/app/view/agents/designroute.test.ts frontend/app/view/agents/brainstormsend.test.ts frontend/app/view/jarvis/runsheetmodel.test.ts`.

### Task 7: Docs and skills follow the new flow
**Depends on:** none
**Files:** `docs/orchestrator-guide.md`, `skills/brainstorm/SKILL.md`, `skills/design/SKILL.md`

Spec decision 6. `docs/orchestrator-guide.md`: rewrite the "A goal that still needs design decisions" row, the Lead
model row, "The lead brainstorms with you", the path classification and the handoff paragraph for: design happens in
a design session (pane, canvas, or both) before the run; the entry-points table; the Approved design start and Design
first; a designing run and `wsh jarvis design`; the lead plans from the approved design, or from the goal after the
`Needs a design` ask; `wsh runs start --spec`; the new handoff text. `skills/brainstorm/SKILL.md`: on a session a run
waits on, Approve attaches the design to that run and starts its lead (the agent then gets `brainstorm: run <id>`)
instead of opening the launcher. `skills/design/SKILL.md`: the same for Build this… on a linked canvas. Names must
match this plan's interfaces (`wsh jarvis design --kind brainstorm|canvas`, `Approved design`, `Design first`,
`Designing`). Acceptance: `grep -n "brainstorms with you" docs/orchestrator-guide.md` finds nothing.
