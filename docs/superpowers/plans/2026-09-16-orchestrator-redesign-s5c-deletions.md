# Orchestrator Redesign Slice 5c: Deletions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** delete the paths slices 3, 4 and 5a/5b replaced. After this slice there is one way to start an orchestrator (a plan, submitted by the engine or by a lead that wrote one), one machine (the engine), no plan gate, no task cap, and no pipeline shape. Runs already in the store still render.

**Architecture:** every deletion here removes a *writer* — a command that starts something, a control that arms it, a prompt that teaches it. Every *reader* that a stored run needs to render stays. That line decides each file: `PhaseRail` stays because pipeline runs exist; `DefaultPlaybook` goes because nothing can start one. Where a field is persisted (`Run.Orchestration`, `RunPhase.Triage`, `TaskGroup.PlanGate`), the field stays in `waveobj` and the code that sets it goes — dropping a JSON field would not migrate old blobs, it would silently reinterpret them.

**Tech Stack:** Go (`pkg/jarvis`, `pkg/orchestrate`, `pkg/waveobj`, `pkg/wshrpc`, `pkg/wshrpc/wshserver`, `cmd/wsh`), React 19 + TypeScript + jotai, vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md`. This plan implements §10 Deletions in full, plus the removals §1 lists (pipeline mode, adaptive orchestration, triage) and the `MaxDagTasks` removal G3 asks for. §9's tier deletion already landed in slice 2; §10's `dag wait` and pi control plumbing already landed in slice 3; `buildEngineOrchestratePrompt` already landed in slice 5a.

**Gate:** spec §13 — "5c needs 5a, 5b and live acceptance 1 to 3". All three acceptances ran (effort `aeabb4ad` chunk 12, 2026-09-16). This slice is unblocked.

## Decisions that differ from the spec's wording

1. **Persisted fields stay; their writers go.** `TaskGroup.PlanGate`/`PlanApprovedTs`, `Run.PlanGatePending`, `Run.Orchestration`, `RunPhase.Triage` and `RunPhase.Gate`/`Held` keep their `waveobj` declarations. They are stored inside JSON blobs, so removing the Go field does not rewrite history — it makes old blobs decode with the field silently dropped, which changes how a finished run reads. `JarvisProfile.DefaultPlanGate`, `ProfileOverride.DefaultPlanGate` and `.Machine` are *settings*, not history, and are deleted outright.
2. **The profile playbook editor goes with pipeline.** Once `RunMode_Pipeline` cannot be started, `JarvisProfile.Playbook` has no consumer: `resolveRunPlan`'s pipeline branch is its only reader, and `ResolvePlaybook` (`profile.go:282`) already has zero callers. Leaving `playbookeditor.tsx` mounted would keep a control that edits a field nothing reads. **Owner: say so at approval if you would rather keep the playbook as a settable thing** — it is the one deletion here that is inferred rather than named by the spec.
3. **`childRunPlan`'s default becomes quick.** `wshserver_runs.go:315` currently falls back to `RunMode_Pipeline` when neither the request nor the profile names a mode. That fallback is load-bearing today and would become a mode that cannot run, so it moves to `RunMode_Quick`. A saved `defaultmode: "pipeline"` likewise resolves to quick.
4. **`dagDigestChildRunLimit` gets its own number.** It is `jarvis.MaxDagTasks` today (`wshserver_dag.go:235`) and exists for a different reason — bounding how many child runs one status snapshot loads. With the cap gone it becomes a standalone `const dagDigestChildRunLimit = 64`, and its drift test (`wshserver_dag_test.go:967`) is deleted with the alias.
5. **The dag's *task* gate stays.** `orchestrate.ApproveGate`/`SendBackGate` (`scheduler.go:130`, `:148`), `dag approve|sendback <task-id>` and the `gate-*` run-event kinds are a gate task *inside* an approved plan — a different feature from the plan gate, as `runevent.go:82` already notes. Only the `jarvis.ApproveGate`/`SendBackGate`/`HoldPhase` run-phase helpers and the `dag-plan-*` kinds go.
6. **No wire-compat shims.** `wsh` and `wavesrv` ship together, so a deleted RPC field needs no deprecation window. A `wshrpc` field that only the deleted path set is deleted.

## Global Constraints

- **Scope:** deletions only. No new behavior, no refactors of code that survives, no drive-by renames. If a surviving function reads better after its dead branch is gone, that is the edit — nothing further.
- **The tree compiles between tasks.** Each task is an independently buildable state: `go build ./...` and the TS typecheck pass at every task boundary, so a half-executed plan is recoverable.
- **Tests are deleted with their subject, not disabled.** A test whose only assertion is about a deleted path goes; a test that asserts something still true is kept and updated. Never `t.Skip`.
- No emojis. Comments are lower case and say why, never what.
- **Generated files:** never hand-edit `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts` or `pkg/wshrpc/wshclient/wshclient.go`. After changing a `wshrpc` or `waveobj` type, run `task generate`.
- Go tests for `jarvis`, `orchestrate` and `wshserver` need CGO flags. From PowerShell at the repo root:
  ```powershell
  $env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
  ```
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (`npx tsc` overflows).
- **Formatters:** HEAD is not formatter-clean. Never run `gofmt -w` or `prettier --write` over a file you did not already own; check only your hunks, with `gofmt -d <file>` and `npx prettier --check <file>`.
- **Staging:** other sessions edit this tree. Run `git status --short` before staging and stage only files this plan names.
- **Commit:** one commit for the whole slice, with the spec edits and this plan folded in. Commits for effort `aeabb4ad` need no approval; pushing does. No co-author trailer.
- **Backend restart:** the live check in Task 6 needs a rebuilt `wavesrv` and a restarted dev app. Ask the owner before killing or restarting either (`wavesrv.x64` is also the packaged app's binary; check its `.Path`). Start `task dev` with `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` so workers persist transcripts.

## Task order

1. The `wsh` surface: JSON submit, `import-tasks`, `init`, `jarvis triage`, `jarvis hold`.
2. `MaxDagTasks`.
3. The plan gate.
4. Adaptive orchestration and triage.
5. Pipeline mode.
6. Docs, `task generate`, full verification, live check, commit.

Tasks 1 and 2 are independent. Task 3 comes before 5 (the gate threads through `resolveRunPlan`). Task 4 comes before 5 (both edit `resolveRunPlan` and `BuildOrchestratePrompt`).

---

### Task 1: The `wsh` surface

The lead's only planning mechanism is `dag submit --plan`. Everything that was a second way in goes.

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go`
- Modify: `cmd/wsh/cmd/wshcmd-jarvis.go`
- Delete: `pkg/orchestrate/import.go`, `pkg/orchestrate/import_test.go`
- Modify: `pkg/wshrpc/wshrpctypes_dag.go`, `pkg/wshrpc/wshserver/wshserver_dag.go`

**Steps:**

- [x] **1.1 `dag submit` becomes plan-only.** In `wshcmd-jarvisdag.go`, delete `dagSubmitSource` (`:47-64`) and rewrite `dagSubmitCmd` (`:87-127`) so `--plan` is required and the inline/`--file` branch is gone:
  ```go
  var dagSubmitCmd = &cobra.Command{
  	Use:     "submit --plan <plan.md>",
  	Short:   "validate and submit a plan file as this run's DAG",
  	Long:    "Validate and submit a plan file as this run's DAG.\n\n" + jarvis.PlanFormat + dagOneDagPerRunNote,
  	Args:    cobra.NoArgs,
  	PreRunE: preRunSetupRpcClient,
  	RunE: func(cmd *cobra.Command, args []string) error {
  		plan, _ := cmd.Flags().GetString("plan")
  		if plan == "" {
  			return fmt.Errorf("--plan <plan.md> is required")
  		}
  		planPath, err := filepath.Abs(plan)
  		if err != nil {
  			return err
  		}
  		spec, _ := cmd.Flags().GetString("spec")
  		specPath, err := dagSpecPath(planPath, spec)
  		if err != nil {
  			return err
  		}
  		channelId, runId, err := dagIds(cmd)
  		if err != nil {
  			return err
  		}
  		data := wshrpc.CommandDagSubmitData{
  			ChannelId: channelId, RunId: runId, PlanPath: planPath, SpecPath: specPath,
  		}
  		g, err := wshclient.DagSubmitCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 20_000})
  		if err != nil {
  			return err
  		}
  		fmt.Printf("dag %s submitted (%d tasks, %d lanes, longest chain %d, parallelism %d)\n", g.ID, len(g.Tasks), len(jarvis.Lanes(g.Tasks)), jarvis.LongestChain(g.Tasks), g.Parallelism)
  		return nil
  	},
  }
  ```
  Delete `dagPlanPath` (`:65-76`) — its whole body was the "not with dag JSON" check. Keep `dagSpecPath`.
- [x] **1.2 Delete `dagImportCmd`** (`:132-173`) and `dagInitCmd` (`:549-584`).
- [x] **1.3 Fix `init()`** (`:643`): drop `dagImportCmd` from the first `AddCommand`, delete the `jarvisDagCmd.AddCommand(dagInitCmd)` line, and delete the `--file` flag registration plus all four `dagImportCmd`/`dagInitCmd` flag lines.
- [x] **1.4 Trim imports** in `wshcmd-jarvisdag.go`: `encoding/json`, `io`, `os` and `github.com/wavetermdev/waveterm/pkg/pitasks` lose their last use here. `time` too if `dagInitCmd` was its only user — check with `gofmt` + `go build`.
- [x] **1.5 Delete `pkg/orchestrate/import.go` and `import_test.go`.** `ImportPitasks` had exactly one caller (`dagImportCmd`). Then check whether `pkg/pitasks` still has any consumer: `grep -rn "pkg/pitasks" --include=*.go pkg cmd`. If nothing outside `pkg/pitasks` itself imports it, note it in Task 6's report — **do not delete the package in this slice**; it is not in §10 and `.pi/tasks` is a pi-side format we do not own.
- [x] **1.6 `dag submit` RPC.** In `wshrpctypes_dag.go`, `CommandDagSubmitData` keeps `Title`, `Parallelism` and `Tasks` only if the server still reads them on a non-plan submit. Read `DagSubmitCommand` in `wshserver_dag.go`: if `PlanPath == ""` is now unreachable from any caller (`wsh` sends a plan; `CreateRunCommand` sends a plan path), delete the non-plan branch and the fields it alone consumed. Keep whatever the plan path itself sets.
- [x] **1.7 Delete `wsh jarvis triage`** (`wshcmd-jarvis.go:78-88`) and its `jarvisCmd.AddCommand(jarvisTriageCmd)` line (`:121`). Delete `wsh jarvis hold` (the `Action: "hold"` command at `:58`) and its registration — `HoldPhase` only ever served an adaptive lead pausing itself for plan review, and there is no adaptive lead after Task 4.
- [x] **1.8 Verify:** `go build ./...`, `go vet ./cmd/... ./pkg/orchestrate/...`, `go test ./cmd/wsh/... ./pkg/orchestrate/...`. Run `wsh jarvis dag submit --help` and confirm it names only `--plan` and `--spec`.

---

### Task 2: `MaxDagTasks`

G3: a plan's size is the human's call, not a constant's.

**Files:**
- Modify: `pkg/jarvis/run.go`, `pkg/orchestrate/dag.go`, `pkg/orchestrate/dag_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go`, `wshserver_dag_test.go`, `wshserver_planstart_test.go`
- Modify: `frontend/app/view/agents/runconfig.ts`, `runconfig.test.ts`, `runlauncher.tsx`
- Modify: `frontend/app/view/orchestrate/plangate.ts` (deleted entirely in Task 3 — if Task 3 runs first, skip this file)

**Steps:**

- [x] **2.1 Delete `jarvis.MaxDagTasks`** (`run.go:41-45`, comment included) and `orchestrate.MaxTasks` (`dag.go:71-75`). `MaxParallelism` stays.
- [x] **2.2 Delete the cap check** in `NewTaskGroup` (`dag.go:185-190`) — the `len(tasks) > MaxTasks` block and its long error string. The empty-tasks check above it stays.
- [x] **2.3 Fix `dagOneDagPerRunNote`** (`wshcmd-jarvisdag.go:~38-42`): it is a `fmt.Sprintf` whose only argument is `orchestrate.MaxTasks`. Rewrite as a plain const string ending "...so a plan that does not fit in one dag must be split across two runs."
- [x] **2.4 `dagDigestChildRunLimit`** (`wshserver_dag.go:232-235`): replace the alias with its own number and say why it exists.
  ```go
  // dagDigestChildRunLimit bounds the child runs a status snapshot loads; the digest never pages the
  // list, so this is a cost bound on one snapshot, not a limit on how large a plan may be.
  const dagDigestChildRunLimit = 64
  ```
- [x] **2.5 Delete the drift tests:** `dag_test.go:255-258` (`MaxTasks` aliases `jarvis.MaxDagTasks`) and `wshserver_dag_test.go:966-969` (`dagDigestChildRunLimit` follows it). In `wshserver_planstart_test.go:118`, the loop builds `jarvis.MaxDagTasks+1` tasks to prove submit refuses an over-cap plan — that test's subject is gone, so **delete the test**, not just the constant.
- [x] **2.6 Frontend:** delete `MAX_DAG_TASKS` (`runconfig.ts:14`) and the `16 tasks max` prose in `runlauncher.tsx:223` — the parallelism line reads `{parallelism} concurrent children` with no ceiling clause. Delete the `MAX_DAG_TASKS` half of the source-drift test in `runconfig.test.ts` (the `MAX_PARALLELISM` half stays and still reads `pkg/orchestrate/dag.go`).
- [x] **2.7 Verify:** `go build ./...`, `go test ./pkg/jarvis/... ./pkg/orchestrate/... ./pkg/wshrpc/wshserver/...`, `npx vitest run frontend/app/view/agents/runconfig.test.ts`, typecheck.

---

### Task 3: The plan gate

There is no plan gate. A plan-path run was reviewed at + Run; a goal run's plan was written with the human in the lead's terminal.

**Files:**
- Modify: `pkg/orchestrate/dag.go`, `mutation.go`, `scheduler.go`, `digest.go`
- Delete: `pkg/orchestrate/plangate_test.go`, `pkg/wshrpc/wshserver/wshserver_plangate_test.go`
- Modify: `pkg/waveobj/runevent.go`, `pkg/waveobj/wtype.go`
- Modify: `pkg/wshrpc/wshrpctypes_dag.go`, `wshrpctypes_runs.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go`, `wshserver_runs.go`, `wshserver_runsettings.go`
- Modify: `pkg/jarvis/attention.go`, `profile.go`, `runsettings.go` (+ their tests)
- Delete: `frontend/app/view/orchestrate/plangate.ts`, `plangate.test.ts`, `plangatecard.tsx`
- Modify: `frontend/app/view/agents/runbody.tsx`, `runcards.tsx`, `runactions.ts`
- Modify: `frontend/app/view/jarvis/runsettings.ts`, `briefrunsheet.tsx`, `briefprofileview.tsx`, `profilemodel.ts` (+ their tests)

**Steps:**

- [x] **3.1 Engine.** Delete `DagStatus_AwaitingPlan` (`dag.go:45`), `PlanGatePending` (`:52-57`) and `GatePlan` (`:59-67`). Delete the `PlanGatePending(g)` branch in `RecomputeDagStatus` (`dag.go:317-321`) so the derivation starts at `cancelled`. Delete the `PlanGatePending` guards in `scheduler.go:78`, `digest.go:195` and `digest.go:267`, and the surrounding comments that explain the gate. Delete `ApprovePlan` (`mutation.go:303-340`) and the `PlanGatePending` check at `mutation.go:350`.
- [x] **3.2 Events.** Delete `RunEventKindDagPlanGated`, `RunEventKindDagPlanApproved` and `RunEventKindDagPlanSentBack` (`runevent.go:81-86`) with their comment block, and every append site (`grep -rn "DagPlanGated\|DagPlanApproved\|DagPlanSentBack" --include=*.go pkg cmd`). The `gate-*` kinds are a task gate and stay.
- [x] **3.3 Actions.** In `wshserver_dag.go`, delete the `approve-plan` (`:324-329`) and `sendback-plan` (`:330-345`) cases from `DagActionCommand`, delete `planSendBackLine` (`:361-370`), and delete the top-level gate application near `:118-135` (the `run.Mode != RunMode_Orchestrator` / `GatePlan` path — read it and remove only the gate half). Update the `Action` comment on `CommandDagActionData` (`wshrpctypes_dag.go:66`) to drop `approve-plan | sendback-plan`; keep `Notes`, which `forward` still uses, and rewrite its comment (`:69`) to name only `forward`.
- [x] **3.4 Settings.** Delete `PlanGate` from `jarvis.PendingEngineSettings` (`runsettings.go:40`) and every read of it (`:89-91`, `:104-105`, `:116-117`, `:120-124`). Delete `JarvisProfile.DefaultPlanGate` and `ProfileOverride.DefaultPlanGate` (`wtype.go`), their merge in `profile.go:230-231`, their term in the all-nil check at `profile.go:265`, and the `plangate` validation in `wshserver_runsettings.go`. Delete `CommandCreateRunData.PlanGate` (`wshrpctypes_runs.go`) and the `reqPlanGate` parameter of `resolveRunPlan` (`wshserver_runs.go:287`) — the quick branch already ignores it and the orchestrator branch passes a literal `false`.
- [x] **3.5 Attention.** Delete `AttentionPlanGate` (`attention.go:34`) and its row (`:297-310`). The `gates` group it fed also carries dag gate tasks — confirm with `grep -n "gates" pkg/jarvis/attention.go` that the group survives with the task-gate rows, and delete only the plan-gate append.
- [x] **3.6 Persisted fields stay.** Leave `TaskGroup.PlanGate`, `TaskGroup.PlanApprovedTs` and `Run.PlanGatePending` declared in `wtype.go` with a one-line comment: `// historical: slice 5c removed the plan gate; kept so a stored run still decodes as it was written.`
- [x] **3.7 Tests.** Delete `pkg/orchestrate/plangate_test.go` and `pkg/wshrpc/wshserver/wshserver_plangate_test.go`. In `wshserver_dag_test.go`, delete `mustApprovePlan` (`:26-38`) and every call — the dags those tests build are no longer gated, so the helper's callers just drop the line and use the group they already have. Update `pkg/jarvis/attention_dag_test.go`, `attention_test.go:322-335`, `resolve_test.go:134-146`, `runsettings_test.go` and `wshserver_runsettings_test.go`, `wshserver_profiledefaults_test.go`, `wshserver_run_test.go` by the same rule: delete a test whose subject was the gate, update one that merely set the field.
- [x] **3.8 Frontend.** Delete `frontend/app/view/orchestrate/plangate.ts`, `plangate.test.ts` and `plangatecard.tsx`. In `runbody.tsx` delete the two imports (`:28-29`), the `planGated(group)` branch (`:365`) and the `<PlanGateCard .../>` render (`:430`). Delete `planGate` from `runactions.ts` (`:70`, `:92`). In `frontend/app/view/jarvis/runsettings.ts` delete the `planGate` field (`:27`, `:119`, `:126`, `:191`, `:201`), its term in the dirty check (`:131`), its token in the settings key (`:142`), its payload write (`:177`) and the `defaultplangate` write (`:223`); the `planapprovedts` guards at `:95` and `:106` go with it — re-read that function and make sure what remains still refuses an edit to a terminal dag. Delete the gate checkbox in `briefrunsheet.tsx` (`:253-259`), the `defaultplangate` row in `briefprofileview.tsx` (`:194-205`) and its name in the `Defaults` pick (`:54`), and the `defaultplangate` term in `profilemodel.ts:146`.
- [x] **3.9 Verify:** `task generate` (waveobj + wshrpc changed), `go build ./...`, `go test ./pkg/...`, typecheck, `npx vitest run`.

---

### Task 4: Adaptive orchestration and triage

One machine. A lead hands the engine a plan; it does not fan out subagents of its own.

**Files:**
- Modify: `pkg/jarvis/run.go`, `runexec.go`, `runsettings.go`, `profile.go` (+ tests)
- Modify: `pkg/waveobj/wtype.go`, `pkg/waveobj/runevent.go`
- Modify: `pkg/wshrpc/wshrpctypes_runs.go`, `pkg/wshrpc/wshserver/wshserver_runs.go`, `wshserver_runsettings.go`
- Delete: `frontend/app/view/agents/orchestratorpicker.ts`, `orchestratorpicker.test.ts`
- Modify: `frontend/app/view/agents/runconfig.ts`, `runconfigstore.ts`, `channelcomposers.tsx` (+ tests)
- Modify: `frontend/app/view/jarvis/briefprofileview.tsx`, `briefrunsheet.tsx`

**Steps:**

- [x] **4.1 Prompts.** Delete `buildAdaptiveOrchestratePrompt` (`run.go:423-434`) and `ResolveOrchestration` (`run.go:394-405`). `BuildOrchestratePrompt` loses its fork:
  ```go
  // BuildOrchestratePrompt is the lead's initial prompt for an orchestrator run: it brainstorms the goal
  // with the human and hands pkg/orchestrate a plan file. Runtime names the ask tool.
  func BuildOrchestratePrompt(goal string, principles waveobj.PrincipleList, runtime string) string {
  	var b strings.Builder
  	if rendered := RenderPrinciples(principles); rendered != "" {
  		fmt.Fprintf(&b, "Work by these principles, and propagate them into every subagent you dispatch:\n%s\n\n", rendered)
  	}
  	writeLaunchPrompt(&b, goal, runtime)
  	return strings.TrimRight(b.String(), "\n")
  }
  ```
  Update its one caller (`runexec.go:190`) to drop the `run.Orchestration` argument.
- [x] **4.2 Constants.** Delete `Orchestration_Adaptive` (`run.go:50`) and keep `Orchestration_Engine` — it is still the value written to `Run.Orchestration` and read by the brief sheet. Delete `TriageVerdict_Quick`/`TriageVerdict_Plan` (`run.go:70-75`) and `RunAction_Triage` (`:68`).
- [x] **4.3 Triage writer.** Delete `RecordTriage` (`run.go:274-284`) and its `AdvanceRunCommand` case (`wshserver_runs.go:593-594`, and the second switch at `:660`). Delete `RunEventKindTriage` (`runevent.go:17`) and its append site, and the `triage:` line from the detail-key comment (`runevent.go:~90`). **Keep** `RunPhase.Triage`/`waveobj.PhaseTriage` and the `runcards.tsx:235` renderer: a finished adaptive run still shows the call it announced.
- [x] **4.4 `ResolveOrchestration` callers.** `runsettings.go:55` and `wshserver_runs.go:381-382` both asked "is this the engine?". Every orchestrator run is now, so both collapse to the mode test alone. In `CreateRunCommand`, delete the `data.Orchestration == jarvis.Orchestration_Adaptive` refusal (`wshserver_runs.go:329`), the `orchestration = resolved.Machine` fallback (`:378-380`), and set `data.Orchestration = jarvis.Orchestration_Engine` unconditionally for an orchestrator run. Read the whole `resolveRunPlan` → `engineLaunch` stretch (`:287-390`) before editing; the parallelism/worker-route hydration it guards must still run for every orchestrator launch.
- [x] **4.5 Settings.** Delete `JarvisProfile.Machine` and `ProfileOverride.Machine` (`wtype.go:527-530`, `:546`), their merge (`profile.go:233-234`), their term in the all-nil check (`:265`), and the `machine must be…` validation (`wshserver_runsettings.go:64-65`). Delete `CommandCreateRunData.Orchestration` only if nothing sends it after 4.4 — check `grep -rn "orchestration" frontend/app/view/jarvis/newrun.ts` first; if + Run still sets it to `"engine"`, simplify + Run instead and keep the field.
- [x] **4.6 Frontend.** Delete `orchestratorpicker.ts` and `orchestratorpicker.test.ts`. In `runconfigstore.ts` delete `orchestrationAtom`, `setOrchestration`, `LAUNCH_ORCHESTRATION` and the three writes in `hydrateRunConfigFromProfile`/`resetRunConfig`. In `runconfig.ts` delete the `Orchestration` import and `ProfileRunDefaults.orchestration` (`:56`, `:63`, `:68`). In `channelcomposers.tsx` delete the `orchestratorBehaviorFace` import and call (`:24`, `:54`, `:132-137`) and replace the footer line with the engine wording it already produced: `` `→ engine DAG · lead ${leadFace} · workers ${workerFace ?? "same as lead"}` ``. Delete the machine row in `briefprofileview.tsx` (`:149-160`) and its name in the `Defaults` pick (`:54`). In `briefrunsheet.tsx:174` the fact becomes `run.orchestration || "engine"` — the `runtime === "pi"` fallback was `ResolveOrchestration`'s mirror.
- [x] **4.7 Tests.** Update `pkg/jarvis/profile_test.go:285-290`, `run_test.go`, `runsettings_test.go`; `frontend/app/view/agents/runconfig.test.ts`, `runconfigstore.test.ts`, `composercommand.test.ts`. Delete assertions whose subject was adaptive; keep and update ones that merely named it.
- [x] **4.8 Verify:** `task generate`, `go build ./...`, `go test ./pkg/...`, typecheck, `npx vitest run`.

---

### Task 5: Pipeline mode

Two shapes: Quick and Orchestrator.

**Files:**
- Modify: `pkg/jarvis/run.go`, `runexec.go`, `profile.go` (+ tests)
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (+ tests)
- Modify: `cmd/wsh/cmd/wshcmd-jarvis.go`
- Delete: `frontend/app/view/jarvis/playbookeditor.tsx`
- Modify: `frontend/app/view/agents/composercommand.ts`, `frontend/app/view/jarvis/briefprofileview.tsx`, `frontend/app/cockpit/palette-launch.ts`, `command-palette.tsx` (+ tests)

**Steps:**

- [x] **5.1 Creation path.** In `wshserver_runs.go`, `resolveRunPlan` loses its playbook tail:
  ```go
  // top-level launches opt into the orchestrator explicitly; an unset mode is a quick run.
  func resolveRunPlan(resolved waveobj.JarvisProfile, reqMode string) (string, []waveobj.RunPhase) {
  	if reqMode == jarvis.RunMode_Orchestrator {
  		return reqMode, jarvis.DefaultOrchestratorPlaybook()
  	}
  	return jarvis.RunMode_Quick, jarvis.QuickPlaybook()
  }
  ```
  `childRunPlan` (`:308-320`) follows: a child with no requested mode and a profile that names none (or names `pipeline`) is a quick run, and `StripPhaseGates` has nothing left to strip once neither surviving playbook sets `Gate`, so delete it too.
  ```go
  // a child never halts for human review, and neither surviving playbook gates a phase.
  func childRunPlan(resolved waveobj.JarvisProfile, reqMode string) (string, []waveobj.RunPhase) {
  	if reqMode == "" {
  		reqMode = resolved.DefaultMode
  	}
  	mode, pb := resolveRunPlan(resolved, reqMode)
  	return mode, pb
  }
  ```
- [x] **5.2 Playbooks.** Delete `DefaultPlaybook` (`run.go:77-85`) and `StripPhaseGates` (`:104-113`). `DefaultOrchestratorPlaybook` loses its `gate` parameter (its one caller already passes `false`); its phase becomes `{Kind: PhaseKind_Orchestrate, Skill: "superpowers:subagent-driven-development", State: PhaseState_Pending}` — check whether that skill is still the right one now that the lead hands the engine a plan, and if not leave `Skill` empty rather than inventing a name. Delete `BuildPhasePrompt` (`run.go:362-375`) and the `runexec.go:192` branch that called it; read `runexec.go:186-195` and make sure the remaining quick/orchestrator fork covers every reachable mode.
- [x] **5.3 Phase gate helpers.** Delete `HoldPhase` (`run.go:255-269`), `heldPhaseIndex` (`:286-293`), `gateIndex` (`:296-307`), `ApproveGate` (`:310-328`) and `SendBackGate` (`:331-344`) from `pkg/jarvis`, with `RunAction_Approve`, `RunAction_SendBack` and `RunAction_Hold` (`run.go:65-67`) and their `AdvanceRunCommand` cases (`wshserver_runs.go:587-592`, `:612`, `:654-659`). Before deleting, confirm nothing can still reach `RunStatus_AwaitingReview` for a *run*: `grep -rn "RunStatus_AwaitingReview" --include=*.go pkg cmd`. If `recomputeStatus` still derives it, that derivation goes too — with no gated phase there is no run-level review. The `orchestrate.ApproveGate`/`SendBackGate` task-gate pair is untouched.
- [x] **5.4 Profile playbook** (decision 2). Delete `JarvisProfile.Playbook`, `ProfileOverride.Playbook` (`wtype.go:523`, `:541`), `ResolvePlaybook` (`profile.go:282-287`, already callerless), the `Playbook:` in `DefaultProfile` (`profile.go:36`), the normalization loop at `profile.go:66` and the merge at `:224-225`. Delete `frontend/app/view/jarvis/playbookeditor.tsx` and the two playbook sections in `briefprofileview.tsx` (`:460-473` global, `:495-548` project).
- [x] **5.5 Mode constant.** **Keep** `RunMode_Pipeline` (`run.go:37`) with `// historical: 5c stopped anything from starting one; stored runs still carry it.` Its remaining readers are display-side. Delete the `pipeline` option in `briefprofileview.tsx:144` and make `defaultmode`'s fallback `"quick"` (`:138`). Delete `"pipeline"` from `RunShape` (`composercommand.ts:22`) if nothing assigns it; if a stored value can still arrive there, keep the union member and delete only the launcher path.
- [x] **5.6 Surviving readers.** `PhaseRail`, `runbody.tsx`'s pipeline body, `runmodel.ts:92`'s completed-gate case, `runcards.tsx` and the palette's strategy suffix all render stored runs and **stay**. Delete only what a *new* run can no longer produce.
- [x] **5.7 Comment sweep.** `runconfig.ts:37` says "Pipeline is not offered: slice 5c of the orchestrator redesign deletes it, and + Run stops starting it first" and `runconfigstore.ts`/`newrun.ts` carry similar forward references. Rewrite each to describe what is, not what is coming. `grep -rn "slice 5c\|until 5c\|5c deletes" --include=*.go --include=*.ts --include=*.tsx pkg cmd frontend` and clear every hit.
- [x] **5.8 Verify:** `task generate`, `go build ./...`, `go test ./pkg/... ./cmd/...`, typecheck, `npx vitest run`, `npx eslint .`.

---

### Task 6: Docs, verification, live check, commit

**Steps:**

- [x] **6.1 Spec edits.** In `docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md`, mark §10's table rows landed, and update §13's slice-5c line the way 5a and 5b were updated. Fix any §-reference that now points at deleted code.
- [x] **6.2 `CLAUDE.md`.** The plan-format paragraph at the end of "Design docs" says plans are run via `wsh jarvis dag submit --plan` or + Run → Orchestrator → A plan file — still true. Check that nothing else in `CLAUDE.md` or `AGENTS.md` names pipeline, adaptive, `import-tasks` or `dag init`.
- [x] **6.3 `docs/open-issues.md` / `docs/deferred.md`.** If either references a deleted path, update it. If `pkg/pitasks` came out of Task 1.5 callerless, record that in `docs/deferred.md` with the `git show COMMIT:path` recovery line rather than deleting the package here.
- [x] **6.4 Full verification**, all from the repo root:
  - `task generate` then `git status --short` — no diff in generated files.
  - `go build ./...`; `go vet ./pkg/... ./cmd/...`
  - `go test ./pkg/... ./cmd/...` with `CGO_CFLAGS` set as in Global Constraints.
  - `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — exit 0.
  - `npx vitest run` — no new failures against the pre-slice count.
  - `npx eslint .`
  - `gofmt -d` and `npx prettier --check` on your files only.
  - `grep -rn "MaxDagTasks\|import-tasks\|Orchestration_Adaptive\|AwaitingPlan\|approve-plan\|sendback-plan\|MAX_DAG_TASKS" --include=*.go --include=*.ts --include=*.tsx pkg cmd frontend` — no hits outside a historical-field comment.
- [x] **6.5 Live check.** Ask the owner before restarting anything. Rebuild the backend (`task build:backend`), restart the dev app with `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`, then:
  1. + Run shows Orchestrator and Quick, and no machine or gate control.
  2. An Orchestrator from a plan path runs straight through with no gate card and no "Approve & proceed".
  3. A goal run's lead submits with `dag submit --plan` and the dag dispatches immediately.
  4. `wsh jarvis dag submit --help`, `wsh jarvis dag --help`, `wsh jarvis --help` — no `import-tasks`, `init`, `triage`, `hold`, `--file`.
  5. An existing pipeline run and an existing adaptive run still open and render in the brief sheet.
- [x] **6.6 Commit.** `git status --short`, stage only this slice's files plus the spec edits and this plan, one commit. No co-author trailer. Report the live-check results and anything found-but-not-fixed on effort `aeabb4ad` chunk "S5c deletions" before ticking it done.

---

## Execution record

Landed as `c9eb83ee` (the deletions), `df947f66` (the gaps those deletions left) and the commit this
section belongs to (the live check). Two steps were executed differently from what is written above;
both are deliberate, and the reasoning is here rather than only in a commit message.

### 1.6 — the non-plan `dag submit` branch was kept

The step asks to delete `CommandDagSubmitData.Tasks` and the branch behind it once no shipped caller
sends it. Nothing does. It stayed anyway: `Tasks` is the only submission form that carries a per-task
`RunSpec`, the plan format has no syntax for pinning a task to a runtime or model, and the engine
validates and dispatches on that pin (`wshserver_dag_test.go` covers exactly that). Deleting the branch
would delete a tested capability and its "pass tasks or planpath, not both" refusal — one gap traded for
two. The reasoning is recorded on the type so it is not mistaken for dead code later.

### 4.6 — the brief sheet's machine fact keeps its runtime fallback

The step says `briefrunsheet.tsx` should read `run.orchestration || "engine"`, calling the
`runtime === "pi"` half "ResolveOrchestration's mirror". That is right for a run launched today and
wrong for every run launched before the control existed: those store no orchestration, and only a pi
lead drove the engine then. Under the step as written, a stored adaptive run's receipt reads
`machine: engine` directly above a settings panel refusing the same run *for being adaptive* — the run
contradicting itself on one screen. The rule now lives once, as `runMachine` in `runsettings.ts`, read by
both the receipt and `sheetFace`, and mirrors `jarvis.IsEngineRun` server-side. This is the slice's own
rule applied: the deletion removed a writer, and the reader a stored run needs stayed.

### Live check (6.5) — results

Backend rebuilt, dev app restarted with `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`, driven over CDP.

1. **Pass.** + Run offers shape Orchestrator | Quick, start Goal | Plan file, a parallelism stepper and
   routing. No machine control, no gate control, no adaptive or pipeline shape.
2. **Pass.** An Orchestrator from a plan path went straight to `executing`; the dag was created from the
   plan and both tasks spawned within a second of each other. No gate card, no "Approve & proceed",
   phase `orchestrate` neither gated nor held.
3. **Pass.** A goal run's lead wrote its own plan file, submitted it with the plan form (the stored dag
   carries the `planpath`), and all four tasks spawned inside 30ms of one another.
4. **Pass.** `wsh jarvis`, `wsh jarvis dag` and `wsh jarvis dag submit` name no `import-tasks`, `init`,
   `triage`, `hold` or `--file`.
5. **Pass.** A stored pipeline run opens with its full playbook and replays its historical
   `Held for review` / `Gate approved` rows, over "these settings are fixed: a pipeline run has no
   scheduler to reconfigure". A stored adaptive run opens read-only over "an adaptive lead runs its own
   subagents". A stored `awaiting-review` run renders the rewritten gate card — "this run stopped at a
   plan gate that no longer exists" — with cancel as its only action.

Found and not fixed: every goal-led orchestrator run records **two** `phase-started@0` events, because
`CreateRunCommand` writes one when it starts the lead and `DagSubmitCommand` writes another when the
lead's dag is created. It predates this slice by a month (the oldest affected stored run is from
2026-08-22) and the plan-file path, which creates its run deferred, emits exactly one. Out of scope here.
