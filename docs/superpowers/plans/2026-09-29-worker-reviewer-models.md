# Per-task worker models and a reviewer route for engine runs

**Verify:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" node scripts/verify.mjs ./pkg/jarvis/... ./pkg/orchestrate/... ./pkg/wshrpc/... ./pkg/waveobj/... ./cmd/wsh/...`
**Check:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go vet ./pkg/jarvis/... ./pkg/orchestrate/... ./pkg/wshrpc/... ./pkg/waveobj/... ./cmd/wsh/... && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke new-run-window model-picks`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\worker-reviewer-models\project

**Spec:** `docs/superpowers/specs/2026-09-29-worker-reviewer-models-design.md`. Read it before your task. Its
section numbers are cited below as "spec §N".

**Goal:** Engine runs can put each task on its own model (a plan Model line or the plan reviewer's pick, when the
run's workers setting is Reviewer picks), the human can change a pick until the task starts, and task reviewers
and stage sessions run on a human-chosen reviewer route.

**Architecture:** Go is the source of truth. Task 1 adds every wire field and regenerates the bindings once;
afterward no task changes a wire type. The engine resolves a task's route with one precedence function
(`effectiveTaskRoute`), which the frontend mirrors in one pure module (`taskroute.ts`). The plan reviewer's picks
arrive on its pass verdict and are applied in the same write that passes the review.

**Design canvas:** the Prototype directory. Build `Main.dc.html`, `ProjectPicker.dc.html` (variant 1 only),
`Dag.dc.html`, `PicksInline.dc.html` and `Profile.dc.html`. `CommandBar`, `Grouped` and `PicksGate` are rejected:
do not build them. Serve them with
`python -m http.server 8766 --bind 127.0.0.1 --directory C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design`.

## Global Constraints

- Only Task 1 changes `pkg/waveobj`, `pkg/wshrpc/wshrpctypes_*.go` or any generated file
  (`frontend/app/store/wshclientapi.ts`, `frontend/app/store/services.ts`, `frontend/types/gotypes.d.ts`,
  `frontend/types/waveevent.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`, `pkg/{waveobj,wconfig}/metaconsts.go`).
  Never hand-edit a generated file. If a later task truly needs a wire change, stop and say so in the report.
- A task edits only the files its **Files** list names. New tests go in the new test files named there, never
  appended to an existing shared test file. Parallel tasks must not collide.
- Run only the focused tests that prove your change: `go test ./pkg/x -run '<names>'` and
  `npx vitest run <file>`. Never a whole Go package or the full suite; Verify runs those. Go tests that touch
  sqlite need `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu"`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Do not use `task check:ts`
  or `task dev`: in a worktree they run a real `npm install` that replaces the `node_modules` junction. Give it a
  timeout over 2 minutes.
- `strict` is off in tsconfig: a `{ok:true}|{ok:false;reason}` union does not narrow on `.ok`. Use `"reason" in x`.
- `gofmt -l` and `npx prettier --check` only the files you touched; never `--write` the tree; never run prettier on
  `scripts/*.mjs`.
- Colors come from `@theme` tokens in `frontend/tailwindsetup.css`. No raw hex or rgba in components, and no new
  tokens. Read `DESIGN.md` before UI work.
- Frontend logic lives in a pure `.ts` with a `.test.ts` beside it, consumed by a thin `.tsx`. No jsdom render tests.
- Comments say why, never what, and only when necessary. Match the surrounding code's idiom.
- Behavior is unchanged for a run that never opts into Reviewer picks or a reviewer route (spec "Behavior unchanged").
- Tests assert behavior and must fail if the behavior they name is removed.
- Commit messages: `type(scope): description`. No attribution trailers of any kind.

## Shared names (the contract between tasks)

Go, added by Task 1 (`pkg/waveobj/wtype.go`):

```go
// TaskNode.ModelSource values
const (
	TaskModelSource_Plan       = "plan"
	TaskModelSource_Reviewer   = "reviewer"
	TaskModelSource_Owner      = "owner"
	TaskModelSource_Escalation = "escalation"
)
```

- `waveobj.JarvisProfile`: `ReviewerPicks bool` (`reviewerpicks,omitempty`), `ReviewerRoute *RoutePin`
  (`reviewerroute,omitempty`).
- `waveobj.ProfileOverride`: `ReviewerPicks *bool`, `ReviewerRoute *RoutePin` (same json names).
- `waveobj.Run`, `waveobj.TaskGroup`: `ReviewerPicks bool`, `ReviewerRoute *RoutePin`.
- `waveobj.TaskNode`: `ModelSource string` (`modelsource,omitempty`), `PickReason string` (`pickreason,omitempty`).
- `wshrpc.CommandCreateRunData`: `ReviewerPicks *bool`, `ReviewerRoute *waveobj.RoutePin`.
- `wshrpc.CommandSetRunSettingsData`: `ReviewerPicks bool`, `ReviewerRoute *waveobj.RoutePin`.
- `wshrpc.CommandDagActionData`: `Picks []DagModelPick` (`picks,omitempty`).
- `wshrpc.DagModelPick{TaskId string "taskid"; Model string "model"; Reason string "reason"}`.
- `wshrpc.CommandDagPlanPreviewRtnData`: `Tasks []DagPlanPreviewTask` (`tasks,omitempty`).
- `wshrpc.DagPlanPreviewTask{Id string "id"; Title string "title"; Lane int "lane"; Deps []string "deps,omitempty"; Model string "model,omitempty"}`.

Go, added by later tasks:

- `pkg/orchestrate/modelroute.go` (Task 4): `LightPickRoute = waveobj.RoutePin{Runtime: "claude", Model: "sonnet"}`;
  `effectiveTaskRoute(task *waveobj.TaskNode, owner *waveobj.Run, group *waveobj.TaskGroup) waveobj.RoutePin`
  (moved here from `engine.go`); `taskWaiting(t *waveobj.TaskNode) bool`; dag actions `"setmodel"` and `"leadmodels"`.
- `pkg/orchestrate/stagesession.go` (Task 5): `reviewerRoute(owner *waveobj.Run, g *waveobj.TaskGroup) waveobj.RoutePin`.
- `pkg/orchestrate/planreview.go` (Task 6): `PickModel_Sonnet = "sonnet"`, `PickModel_Lead = "lead"`,
  `MaxPickReasonLen = 200`,
  `RecordPlanReviewVerdict(ctx, dagID, reviewerRunID, verdict, text string, picks []wshrpc.DagModelPick) error`.

TypeScript:

- `frontend/app/view/agents/modelname.ts` (Task 7): `shortModel(model: string | undefined | null): string`.
  `claude-opus-5-5` becomes `opus-5-5`; an alias (`sonnet`) stays as is; empty becomes `default`.
- `frontend/app/view/agents/runconfigstore.ts` (Task 7): `reviewerPicksAtom: PrimitiveAtom<boolean>`,
  `reviewerRouteAtom: PrimitiveAtom<RoutePin | null>`, `setReviewerPicks(next: boolean)`,
  `setReviewerRoute(next: RoutePin | null)`.
- `frontend/app/view/agents/routepicker.tsx` (Task 7): optional prop
  `extraOption?: { label: string; selected: boolean; onSelect: () => void }`.
- `frontend/app/view/orchestrate/taskroute.ts` (Task 10):
  `LIGHT_PICK: RoutePin`,
  `type RouteSource = "plan" | "reviewer" | "owner" | "escalation" | "pinned" | "workers" | "inherited"`,
  `taskRoute(task: TaskNode, owner: Run, group: TaskGroup): { route: RoutePin; source: RouteSource }`,
  `workersRoute(group: TaskGroup, owner: Run): RoutePin`,
  `reviewerRouteOf(group: TaskGroup, owner: Run): { route: RoutePin; custom: boolean }`,
  `isWaiting(task: TaskNode): boolean`.

## Review Focus

- A plan reviewer writes a pick as `--pick "Task 2=sonnet: ..."` or `--pick "t-2 sonnet"`. It must be refused before
  the RPC with the expected shape, not stored under a task id that matches nothing (Task 6).
- A plan with a Model line naming a model this machine cannot run, on a run that is on Same as lead. Submit still
  refuses it, naming the task, because the plan is broken whatever the setting (Task 4).
- The owner toggles a pick in the same moment the task dispatches. `setmodel` on a task that has started is refused
  with its state, and the panel shows that error on the row (Tasks 4 and 11).
- An existing stored run, profile or dag with none of the new fields. Every task, reviewer and stage session
  resolves to exactly today's route (Tasks 4 and 5, zero-value table rows).
- A lead resubmits after a failed plan review, after the human changed the run's reviewer route or workers setting
  in the run sheet. The group keeps the human's settings, and the next round's reviewer is asked for picks again
  (Task 6).
- The human changes a run's width from the lead card after choosing Reviewer picks or a reviewer route. The
  width changes and nothing else resets (Task 12).
- A project outside the home directory, or on another drive. The picker shows its full parent path instead of an
  empty or `..\..` label (Task 8).

---

### Task 1: Wire types and generated bindings
**Depends on:** none

**Files:**
- Modify: `pkg/waveobj/wtype.go` (JarvisProfile, ProfileOverride, Run, TaskGroup, TaskNode, the TaskModelSource consts)
- Modify: `pkg/wshrpc/wshrpctypes_runs.go` (CommandCreateRunData, CommandSetRunSettingsData)
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` (CommandDagActionData, DagModelPick, CommandDagPlanPreviewRtnData, DagPlanPreviewTask)
- Regenerate: everything `task generate` writes
- Test: `pkg/waveobj/wtype_models_test.go` (new)

**Interfaces:** Produces every Go and TS name in "Shared names" under Task 1.

Add exactly the fields and types in "Shared names", with a comment on each field in the file's style. Say what nil or
false means (ReviewerRoute nil = the lead's route; ReviewerPicks false = the WorkerRoute rule stands). Update the
`Action` comment on `CommandDagActionData` to list `setmodel | leadmodels`. Update the `CommandDagSubmitData`
comment: a plan can now pin a task's model (`**Model:**`); only a per-task runtime still needs the typed form.

- [ ] **Step 1: Write the failing test.** In `wtype_models_test.go`, a JSON round-trip of a `TaskGroup` with
  `ReviewerPicks: true`, `ReviewerRoute: &RoutePin{Runtime: "claude", Model: "sonnet"}` and one task with
  `ModelSource: TaskModelSource_Reviewer` and `PickReason: "mechanical"`. Also assert that a zero `TaskGroup`
  marshals with none of the keys `reviewerpicks`, `reviewerroute`, `modelsource` or `pickreason`, so stored
  objects are unchanged.
- [ ] **Step 2:** `go test ./pkg/waveobj -run TestModelFields`. Expected: it fails to compile.
- [ ] **Step 3:** Add the fields, types and constants.
- [ ] **Step 4:** `task generate`, then `git status`. Only the Go files above and the generated files may change.
  Confirm `frontend/types/gotypes.d.ts` has `reviewerpicks`, `reviewerroute`, `modelsource`, `pickreason`,
  `DagModelPick`, `DagPlanPreviewTask`.
- [ ] **Step 5:** Run the test again and expect PASS. Run the typecheck from Global Constraints and expect exit 0.
- [ ] **Step 6:** Commit `feat(models): wire fields for reviewer picks, reviewer route and task model source`.

### Task 2: Workers and reviewer settings: profile, run settings, CreateRun, `wsh runs start`
**Depends on:** Task 1

**Files:**
- Modify: `pkg/jarvis/profile.go` (`ResolveProfileWithDiagnostics`, `ProfileOverrideIsEmpty`)
- Modify: `pkg/jarvis/runsettings.go` (`PendingEngineSettings`, `ApplyPendingEngineSettings`, `ApplyLiveEngineSettings`, `RunEngineSettings`)
- Modify: `pkg/jarvis/routemigrate.go` (migrate `ReviewerRoute` in profile, channel overrides, runs, dags)
- Modify: `pkg/wshrpc/wshserver/wshserver_runsettings.go` (`validateWorkerRoute` becomes `validateRoute`; `validateEngineDefaults`; `SetRunSettingsCommand`)
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (CreateRun inheritance and storage)
- Modify: whichever of `pkg/wshrpc/wshserver/wshserver_jarvis.go` or `wshserver_channels.go` saves the global
  profile. It must validate the new global fields as `validateEngineDefaults` validates an override's.
- Modify: `cmd/wsh/cmd/wshcmd-runs.go` (flags, validation, list line)
- Test: `pkg/jarvis/profile_reviewer_test.go` (new), `pkg/wshrpc/wshserver/wshserver_reviewer_settings_test.go`
  (new), `cmd/wsh/cmd/wshcmd-runs_reviewer_test.go` (new)

**Interfaces:** Consumes Task 1's fields. Produces `validateRoute(field string, route *waveobj.RoutePin, requireInstalled bool) error`
and `validateWorkersSetting(route *waveobj.RoutePin, picks bool) error`, which refuses both set, in
`wshserver_runsettings.go`.

Behavior (spec §1, §7):

- `ResolveProfile`: when the override's `WorkerRoute != nil || ReviewerPicks != nil`, take both from the override
  (nil `ReviewerPicks` reads as false). `ReviewerRoute` mirrors `WorkerRoute`: a non-nil override replaces it.
  `ProfileOverrideIsEmpty` counts both new fields.
- `PendingEngineSettings` gains `ReviewerPicks bool` and `ReviewerRoute *waveobj.RoutePin`, always applied like
  `WorkerRoute`. Update the type's comment.
- CreateRun, engine launch only: when `data.ReviewerPicks == nil`, take `WorkerRoute` (if nil) and `ReviewerPicks`
  from the resolved profile, as today. When it is non-nil, keep `data.WorkerRoute` exactly as sent. `ReviewerRoute`
  nil takes the profile's. Validate both routes (`requireInstalled` true) and the workers pair, then store all
  three on the run.
- SetRunSettings validates the pair and the reviewer route, and carries both into `PendingEngineSettings`.
- Refusal text names both fields, e.g. `reviewerPicks and workerRoute are both set; the workers setting is one of them`.
- `wsh runs start`: `--reviewer-picks` (bool), `--reviewer-runtime`, `--reviewer-model`. `--reviewer-model` needs
  `--reviewer-runtime`. `--reviewer-picks` is refused with `--worker-runtime`/`--worker-model`. All three need an
  orchestrator run, joining the existing error that lists the engine-only flags. `--reviewer-picks` sends
  `ReviewerPicks: &true`; no flag sends nil. `wsh runs` prints `workers=reviewer-picks` when set and
  `reviewers=<runtime> <model>` when a reviewer route is set.
- `routemigrate.go`: run `migratePin` over `ReviewerRoute` at each of the four sites, beside `WorkerRoute`.

- [ ] **Step 1: Write the failing tests.**
  - `profile_reviewer_test.go`, table test `TestResolveProfileWorkersPair`:
    - A global route with an override `{ReviewerPicks: &true}` resolves to picks true and route nil.
    - A global with picks and an override `{ReviewerPicks: &false}` resolves to Same as lead.
    - A global with picks and an override `{WorkerRoute: &x}` resolves to route x and picks false.
    - A nil override keeps the global.
  - `TestResolveProfileReviewerRoute`: an override route replaces the global; a nil one inherits it.
  - `TestProfileOverrideIsEmptyReviewerFields`.
  - `TestApplyEngineSettingsReviewerFields`: both Apply functions and `RunEngineSettings` carry both fields, and a
    zero value clears a stored route.
  - `TestMigrateReviewerRoutePins`: a stored `ReviewerRoute{Tier: "..."}` on a run and a dag is rewritten. Follow
    the existing routemigrate tests' store setup.
  - `wshserver_reviewer_settings_test.go`:
    - `TestCreateRunReviewerPicksInheritance`. Profile has picks; nil data gives a run with picks. Data
      `ReviewerPicks: &false` with no route gives a run on Same as lead, though the profile names a route.
    - `TestCreateRunRefusesPicksWithRoute`.
    - `TestSetRunSettingsReviewerFields`, both pending on the run and live on the group.
    - `TestProfileSaveRefusesPicksWithRoute`, for the global profile and for an override.
    - Follow the fixtures in the existing `wshserver_runsettings` and `wshserver_profile` tests.
  - `wshcmd-runs_reviewer_test.go`: the flag rules above, through the same function the existing `runs start`
    tests call.
- [ ] **Step 2:** Run each new test by name and expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the new tests plus the existing ones they sit beside:
  - `go test ./pkg/jarvis -run 'Profile|EngineSettings|Migrate'`
  - `go test ./pkg/wshrpc/wshserver -run 'RunSettings|CreateRun|Profile'`
  - `go test ./cmd/wsh/cmd -run 'Runs'`
  Expect PASS.
- [ ] **Step 5:** Commit `feat(runs): workers setting with reviewer picks, and a reviewer route, on profile and run`.

### Task 3: Plan format: a per-task `**Model:**` line
**Depends on:** Task 1

**Files:**
- Modify: `pkg/jarvis/plan.go` (`PlanFormat`, a `planModelRe`, `ParsePlan` head-block handling)
- Test: `pkg/jarvis/plan_model_test.go` (new)

**Interfaces:** Produces parsed tasks with `RunSpec.Model` set and `ModelSource == waveobj.TaskModelSource_Plan`.

Behavior (spec §2):

- In a task's head block (the `inTaskHead` state), `**Model:** <value>` is accepted after Depends, and before,
  after or among Chunk lines. It ends `dependsAllowed`, as a Chunk line does.
- The value is trimmed. Refuse an empty value, one containing a backtick or whitespace, and a second Model line in
  the same task. Errors read like the Chunk errors: `task 3: **Model:** ...`.
- A Model line after the head block is task text.
- `PlanFormat`:
  - Add one sentence after the Chunk sentence: `A task may also carry one **Model:** <model id> line in that same
    place (not in backticks): the model its worker runs on, used when the run's workers setting is Reviewer picks
    and ignored otherwise.`
  - Put `**Model:** <model id>` in the example under Task 1's Depends line, so `TestPlanFormatParses` still parses it.

- [ ] **Step 1: Write the failing tests.** `TestParsePlanModelLine`, table-driven:
  - A Model line after Depends.
  - A Model line first under the heading, with no Depends (the task still depends on its predecessor).
  - A Model line between two Chunk lines.
  - A Model line after body text, which stays in `Description`.
  - Refused: empty, backticked, a value with a space, two Model lines.
  - Assert `RunSpec.Model`, `ModelSource`, `Deps` and `Description` for each case.
- [ ] **Step 2:** `go test ./pkg/jarvis -run 'TestParsePlanModelLine|TestPlanFormatParses'` and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same tests and expect PASS.
- [ ] **Step 5:** Commit `feat(plan): a per-task Model line`.

### Task 4: Engine: model precedence, owner model changes, submit and preview
**Depends on:** Task 1, Task 3

**Files:**
- Create: `pkg/orchestrate/modelroute.go` (`LightPickRoute`, `effectiveTaskRoute` moved from `engine.go`, `taskWaiting`, the setmodel/leadmodels helpers)
- Modify: `pkg/orchestrate/engine.go` (remove the moved function only)
- Modify: `pkg/orchestrate/mutation.go` (`applyEscalation` sets `ModelSource`; `applyActionLocked` cases `setmodel`, `leadmodels`)
- Modify: `pkg/orchestrate/dag.go` (`NewTaskGroup` refuses a non-empty `PickReason` or a `ModelSource` other than
  `""`/`plan`; `SameDagProposal` compares `ModelSource`)
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go`:
  - `DagSubmitCommand` copies `run.ReviewerPicks` and `run.ReviewerRoute` onto the proposed group.
  - `DagPlanPreviewCommand` returns `Tasks`.
  - `DagActionCommand` routes `setmodel`/`leadmodels` to `orchestrate.ApplyAction` if its switch needs a case for
    them.
- Test: `pkg/orchestrate/modelroute_test.go` (new), `pkg/wshrpc/wshserver/wshserver_dag_models_test.go` (new)

**Interfaces:** Consumes Task 1's fields and Task 3's parsed Model lines. Produces `LightPickRoute`,
`effectiveTaskRoute` (same signature), `taskWaiting`, and the `setmodel`/`leadmodels` actions through the existing
`ApplyAction(ctx, dagID, taskID, action string, target waveobj.RoutePin) error`.

Behavior (spec §3, §5, §8):

- `effectiveTaskRoute`, in order. The pin is `{RunSpec.Runtime or the owner's runtime, RunSpec.Model}` and exists
  when either field is set; runtimes go through `runroute.DefaultRuntime` as today.
  1. `ModelSource` is `owner` or `escalation`, or is `""` with a pin: the pin.
  2. `ModelSource` is `plan` or `reviewer`, `group.ReviewerPicks`, and a pin: the pin.
  3. `group.WorkerRoute` naming a runtime or model.
  4. The lead's route.
- `applyEscalation` sets `ModelSource = TaskModelSource_Escalation`.
- `taskWaiting(t)`: state `pending` or `ready`, `RunID == ""`, and `Attempts`, `Escalations` and `FirstActivity`
  all zero.
- `setmodel`:
  - The task must be waiting; otherwise refuse with `task %q has started (%s); a started task keeps its model`.
  - An empty target (no runtime, no model) means the lead's route: clear `RunSpec.Runtime` and `RunSpec.Model`.
  - Otherwise resolve it like `escalationTarget` does (default runtime, `runroute.Resolve`), then also call
    `validateWorkerHarness(runtime)`, which escalate does not, so a model this machine cannot run is refused here
    rather than at dispatch. Then set the pin.
  - Set `ModelSource = owner`; leave `PickReason`, `Attempts` and `Escalations` alone.
- `leadmodels`: for every waiting task with a non-empty `PickReason`, clear the pin and set `ModelSource = owner`.
  `taskID` is ignored.
- `applyActionLocked` already zeroes `g.Failures` after any action. Keep that out of these two actions: return
  before it, or skip it for them, since changing a waiting task's model answers no circuit-break.
- Submit validates every task's pin (the existing loop) whatever the workers setting, so a bad Model line is refused
  naming the task. Add no new code for that; the test pins it.
- Preview `Tasks`: in plan order, each with `Id`, `Title` (the label), `Lane` (1-based index into
  `jarvis.Lanes(plan.Tasks)`), `Deps` and `Model` (`RunSpec.Model` when `ModelSource == plan`).

- [ ] **Step 1: Write the failing tests.**
  - `modelroute_test.go`:
    - `TestEffectiveTaskRoutePrecedence`, a table over source {"", plan, reviewer, owner, escalation} × pin
      {none, set} × group {zero, WorkerRoute set, ReviewerPicks}. It includes the zero-value rows: no new fields
      gives today's result.
    - `TestApplyEscalationMarksSource`.
    - `TestTaskWaiting`.
    - `TestSetModelOnWaitingTask`: an explicit route and the empty target.
    - `TestSetModelRefusedOnceStarted`, for running, and for pending after a failure (`Attempts` 1).
    - `TestSetModelRefusesUninstalledHarness`: stub the harness check through the seam `validateWorkerHarness`
      tests already use.
    - `TestLeadModelsResetsOnlyWaitingPicks`: a running pick, a waiting pick, a plan-line task and a task with no
      pick.
    - `TestSetModelKeepsFailureStreak`.
    - `TestNewTaskGroupRefusesReviewerSource`.
    - `TestSameDagProposalComparesModelSource`.
    - Use the store fixtures the existing `mutation_test.go` uses.
  - `wshserver_dag_models_test.go`:
    - `TestDagSubmitCarriesReviewerSettings`.
    - `TestDagSubmitRefusesUnrunnableModelLine`: the run is on Same as lead, and the plan names
      `**Model:** no-such-model`.
    - `TestDagPlanPreviewTasks`: a 3-task plan with one Model line and a fork gives lanes, deps and model.
- [ ] **Step 2:** Run them by name and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the new tests and the existing ones they sit beside, and expect PASS:
  - `go test ./pkg/orchestrate -run 'EffectiveTaskRoute|Escalat|SetModel|LeadModels|TaskWaiting|NewTaskGroup|SameDagProposal'`
  - `go test ./pkg/wshrpc/wshserver -run 'DagSubmit|DagPlanPreview'`
- [ ] **Step 5:** Commit `feat(orchestrate): per-task model precedence and owner model changes`.

### Task 5: The reviewer route drives task reviewers and stage sessions
**Depends on:** Task 1

**Files:**
- Modify: `pkg/orchestrate/stagesession.go` (add `reviewerRoute`; `spawnStageSession` uses it)
- Modify: `pkg/orchestrate/review.go` (`spawnReviewer` uses it)
- Test: `pkg/orchestrate/reviewerroute_test.go` (new)

**Interfaces:** Consumes `TaskGroup.ReviewerRoute`. Produces `reviewerRoute(owner *waveobj.Run, g *waveobj.TaskGroup) waveobj.RoutePin`.

Behavior (spec §6): `reviewerRoute` returns `{runroute.DefaultRuntime(g.ReviewerRoute.Runtime), g.ReviewerRoute.Model}`
when the group's route names a runtime or model, else `{runroute.DefaultRuntime(owner.Runtime), owner.Model}`.
`spawnReviewer` and `spawnStageSession` use it for the harness check, the spawn and the child run's
`Runtime`/`Model`. Nothing else changes.

- [ ] **Step 1: Write the failing tests.**
  - `TestReviewerRoute`: nil, empty and set routes, including a route with a model and no runtime.
  - `TestSpawnReviewerUsesReviewerRoute` and `TestStageSessionUsesReviewerRoute`: through the spawn seam the
    existing `review_test.go` and stage-session tests stub. Assert the child run's `Runtime`/`Model` for a group
    with a reviewer route, and the owner's for a zero group.
- [ ] **Step 2:** `go test ./pkg/orchestrate -run 'ReviewerRoute'` and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `go test ./pkg/orchestrate -run 'ReviewerRoute|Review|StageSession|PlanReview|Verifier'` and
  expect PASS.
- [ ] **Step 5:** Commit `feat(orchestrate): reviewers and stage sessions run on the reviewer route`.

### Task 6: The plan reviewer picks models
**Depends on:** Task 4

**Files:**
- Modify: `pkg/orchestrate/planreview.go` (prompt, `RecordPlanReviewVerdict` picks, `ReplacePlanReviewProposal`)
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (the `planreview-*` case passes `data.Picks`)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` (`--pick` on `planreview`, `parsePick`)
- Modify (callers of the changed signature, which pass `nil`): `pkg/orchestrate/basecheck_test.go`,
  `pkg/orchestrate/planreview_test.go`, `pkg/wshrpc/wshserver/wshserver_dagplanreview_test.go`
- Test: `pkg/orchestrate/planreviewpicks_test.go` (new), `cmd/wsh/cmd/wshcmd-jarvisdag_pick_test.go` (new)

**Interfaces:** Consumes `LightPickRoute` and the precedence from Task 4. Produces `PickModel_Sonnet`,
`PickModel_Lead`, `MaxPickReasonLen`, the new `RecordPlanReviewVerdict` signature (update every caller) and
`parsePick(s string) (wshrpc.DagModelPick, error)`.

Behavior (spec §4):

- **Prompt**: `planReviewPrompt(g, tree)` gains a section only when `g.ReviewerPicks`.
  - It lists each task whose `ModelSource != plan` as `t-N: <label>`, and states the rule: `sonnet` only for a
    mechanical, tightly specified task (a copy of an existing pattern, a field threaded through, prose against
    written code); `lead` for anything with a design choice.
  - The pass line shows `--pick "t-N=<sonnet|lead>: <one-line reason>"`, one per listed task.
  - A group not on Reviewer picks gets byte-for-byte today's prompt.
- **Validation**, when the verdict is pass and `g.ReviewerPicks`. Each refusal names the task and the problem, so
  the reviewer can resend:
  - one pick per task without a Model line, and none for tasks with one;
  - no unknown or repeated task ids;
  - `Model` is `sonnet` or `lead`;
  - `Reason` is non-empty, has no newline, and is at most `MaxPickReasonLen` runes;
  - a `sonnet` pick is refused when `validateWorkerHarness("claude")` fails, with the error saying to pick `lead`.
  - Any picks on a fail verdict, or on a group not on Reviewer picks, are refused.
- **Apply**, in the same `mutatePlanReview` call that sets `Passed`:
  - `sonnet` sets `RunSpec.Runtime`/`Model` from `LightPickRoute`; `lead` clears both.
  - Both set `ModelSource = reviewer` and `PickReason`.
  - The `plan-reviewed` pass event detail gains `"picks": [{"taskid","model","reason"}]` (omitted when none).
- **ReplacePlanReviewProposal**: does not copy `ReviewerPicks` or `ReviewerRoute` from the proposal. The group keeps
  its own.
- **CLI**:
  - `planreview` gains a repeatable `--pick` string flag. `parsePick` splits at the first `=` and then at the first
    `:`, and trims all three parts.
  - The task must match `^t-\d+$`, and the model must be `sonnet` or `lead`.
  - A bad value is refused before the RPC with `--pick wants "t-N=<sonnet|lead>: <reason>", got %q`.
  - `dagPlanReviewData` puts the parsed picks on `CommandDagActionData.Picks`.

- [ ] **Step 1: Write the failing tests.**
  - `planreviewpicks_test.go`:
    - `TestPlanReviewPromptAsksForPicks`: it lists only the tasks with no Model line.
    - `TestPlanReviewPromptUnchangedWithoutPicks`: compare against the prompt for a zero group.
    - `TestPlanReviewPassAppliesPicks`: the store shows picks and `Passed` together.
    - `TestPlanReviewPassRefusesBadPicks`, a table: missing, extra for a Model-line task, unknown, repeated, bad
      model, empty/multiline/overlong reason, picks on a non-picks group, picks on fail.
    - `TestPlanReviewPassRecordsPicksEvent`: stub `appendRunEventAt` as the existing plan review tests do.
    - `TestReplaceProposalKeepsReviewerSettings`.
    - Follow the fixtures in the existing plan review tests.
  - `wshcmd-jarvisdag_pick_test.go`: `TestParsePick`, with good values, surrounding spaces, `Task 2=sonnet: x`,
    `t-2 sonnet`, `t-2=opus: x` and `t-2=sonnet:` (empty reason).
- [ ] **Step 2:** Run them by name and expect FAIL.
- [ ] **Step 3:** Implement. Update every `RecordPlanReviewVerdict` caller, including existing tests, which pass `nil`.
- [ ] **Step 4:** Run these and expect PASS:
  - `go test ./pkg/orchestrate -run 'PlanReview|ReplaceProposal'`
  - `go test ./cmd/wsh/cmd -run 'Pick|PlanReview'`
  - `go test ./pkg/wshrpc/wshserver -run 'PlanReview|DagAction'`
- [ ] **Step 5:** Commit `feat(orchestrate): the plan reviewer picks each task's model on Reviewer picks runs`.

### Task 7: Launcher config: Reviewer picks and the Reviewers route
**Depends on:** Task 1

**Files:**
- Create: `frontend/app/view/agents/modelname.ts`, `frontend/app/view/agents/modelname.test.ts`
- Modify: `frontend/app/view/agents/runconfig.ts` (`ProfileRunDefaults`, `profileRunDefaults`)
- Modify: `frontend/app/view/agents/runconfigstore.ts` (atoms, setters, hydration, `endRunConfigDraft`)
- Modify: `frontend/app/view/jarvis/newrun.ts` (`RunConfig`, `LaunchOpts`, `launchOptsFromConfig`)
- Modify: `frontend/app/view/agents/runactions.ts`. `createRun` builds the CreateRun payload field by field (its
  opts type and the `RpcApi.CreateRunCommand` call), so add `reviewerPicks`/`reviewerRoute` to its opts and send
  them as `reviewerpicks`/`reviewerroute`. `newruncontrol.tsx` and `briefsheet.tsx` only spread the opts and need no
  change. Extract the payload into an exported pure `createRunPayload(...)` in `runactions.ts` if it is not already
  one, so it can be tested.
- Modify: `frontend/app/view/agents/routepicker.tsx` (`extraOption` prop)
- Modify: `frontend/app/view/agents/runlauncher.tsx` (`RoutingSection`: the Workers picker offers Reviewer picks, and a Reviewers picker)
- Test: `frontend/app/view/agents/runconfig-reviewer.test.ts` (new), `frontend/app/view/jarvis/newrun-reviewer.test.ts` (new)

**Interfaces:** Produces `shortModel`, `reviewerPicksAtom`, `reviewerRouteAtom`, `setReviewerPicks`,
`setReviewerRoute`, the `extraOption` prop, and `RunConfig.reviewerPicks: boolean` / `RunConfig.reviewerRoute: RoutePin | null`.

Behavior:

- `setReviewerPicks(true)` also sets `workerRouteAtom` to null, and `setWorkerRoute(route)` sets
  `reviewerPicksAtom` false. Both mark the config touched.
- Hydration reads `reviewerpicks`/`reviewerroute` from the profile.
- `launchOptsFromConfig` returns `reviewerPicks` (always, for orchestrator) and `reviewerRoute` (when set); a quick
  launch has neither.
- `RoutePicker`'s `extraOption` renders as one more row under the inherited row, styled like it. When
  `extraOption.selected`, the face shows its label.
- `RoutingSection`: Lead, then Workers (`inheritedLabel="Same as lead"`, `extraOption` Reviewer picks), then
  Reviewers (`title="Reviewers model"`, `inheritedLabel="Same as lead"`). Workers and Reviewers show only for
  orchestrator.

- [ ] **Step 1: Write the failing tests.**
  - `modelname.test.ts`: `claude-opus-5-5`, `sonnet`, `""`, `undefined`, and a pi `provider/model`, which stays whole.
  - `runconfig-reviewer.test.ts`: `profileRunDefaults` reads both fields, and a profile without them gives false/null.
  - `newrun-reviewer.test.ts`: `launchOptsFromConfig` for orchestrator with picks, with a reviewer route, with
    neither (`reviewerPicks: false` is still sent), and for quick.
  - `runactions-reviewer.test.ts` (new): the CreateRun payload carries `reviewerpicks` and `reviewerroute` when the
    opts do, and omits them for a quick launch.
  - Add the setter exclusivity and hydration tests to `runconfig-reviewer.test.ts`, driving `globalStore` as the
    existing `runconfigstore.test.ts` does.
- [ ] **Step 2:** `npx vitest run frontend/app/view/agents/modelname.test.ts frontend/app/view/agents/runconfig-reviewer.test.ts frontend/app/view/jarvis/newrun-reviewer.test.ts frontend/app/view/agents/runactions-reviewer.test.ts`
  and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same vitest command and the existing `runconfig`/`runconfigstore`/`newrun` tests, then the
  typecheck. Expect PASS and exit 0.
- [ ] **Step 5:** Commit `feat(launcher): Reviewer picks and a reviewers route in the run launcher`.

### Task 8: Project picker (ProjectPicker.dc.html variant 1)
**Depends on:** none

**Files:**
- Create: `frontend/app/view/jarvis/projectpicker.ts`, `frontend/app/view/jarvis/projectpicker.test.ts`,
  `frontend/app/view/jarvis/projectpicker.tsx`

**Interfaces:** Produces:

```ts
export function projectWhere(path: string, home: string): string;
export function recentProjects(projects: { name: string; path: string }[], channels: Channel[], limit?: number): string[]; // default 3
export function pickerSections(
    names: string[],
    recent: string[],
    query: string,
    whereOf: (name: string) => string
): { recent: string[]; rest: string[]; restLabel: "All projects" | "Matches" };
export function ProjectPicker(props: {
    projects: { name: string; path: string }[];
    channels: Channel[] | null;
    picked: string | null;
    onPick: (name: string) => void;
    onRegister: () => void;
}): JSX.Element;
```

Behavior (spec §9 "Project picker"):

- `projectWhere`: the parent folder of `path`, relative to `home` when inside it (`IdeaProjects` for
  `~\IdeaProjects\waveterm`), else the full parent path. It handles `\` and `/`, a trailing separator, drive-letter
  case, and a project that is home itself (empty string).
- `recentProjects`: projects ordered by their channel's newest run `createdts`, newest first. A channel matches a
  project by path, using the same matcher `resolveChannelTarget` uses (`resolveTargetChannel` in
  `channelderive.ts`). Projects without runs are dropped, and at most `limit` are returned.
- `pickerSections`:
  - With an empty query: `recent`, then `rest` = the others sorted case-insensitively by name, labeled
    `All projects`.
  - With a query: `recent` is empty, and `rest` is `rankProjects` over names plus a where-match (name first), labeled
    `Matches`.
- The component: a field button with name, where and chevron, and `aria-haspopup="listbox"`. It opens a listbox
  with a search input (`Search N projects`), the Recent and All/Matches groups, `No project matches.`, and a footer
  with the key hints and a `Register a project` link that calls `onRegister`.
  - ↑↓ move the highlight over the visible rows with `stepPick`. ⏎ picks and closes. Esc closes the list and stops
    propagation, so the dialog stays open. A click outside closes it.
  - Match the `newruncontrol.tsx` idiom for tokens. The home directory comes from the same source the codebase
    already uses for `~` (grep `homedir` in `frontend/`).

- [ ] **Step 1: Write the failing tests** in `projectpicker.test.ts`:
  - `projectWhere`: Windows paths inside home; on another drive; forward slashes; a trailing separator; home itself.
  - `recentProjects`: ordering, dropping projects without runs, the limit.
  - `pickerSections`: empty query, a query that drops Recent, a where-only match, no match.
- [ ] **Step 2:** `npx vitest run frontend/app/view/jarvis/projectpicker.test.ts` and expect FAIL.
- [ ] **Step 3:** Implement the model, then the component.
- [ ] **Step 4:** Run the vitest command and the typecheck. Expect PASS and exit 0.
- [ ] **Step 5:** Commit `feat(newrun): searchable project picker with recent projects`.

### Task 9: The New run window (Main.dc.html)
**Depends on:** Task 7, Task 8

**Files:**
- Create: `frontend/app/view/jarvis/newrunplan.ts`, `frontend/app/view/jarvis/newrunplan.test.ts`
- Modify: `frontend/app/view/jarvis/newruncontrol.tsx` (two-pane layout; `ProjectPicker` replaces `ProjectChips`)
- Modify: `frontend/app/view/agents/runlauncher.tsx` only to export the pieces the new layout reuses (`ShapeCards`,
  `WorkerStepper`, the plan-path preview effect). Do not change their behavior. Task 7 owns the rest of this file and
  has landed.

**Interfaces:** Consumes Task 7's atoms, setters, `extraOption`, `shortModel`; Task 8's `ProjectPicker`; the
preview's `tasks` (Task 1 types; Task 4 fills them at runtime). Produces:

```ts
export type PlanModelTone = "plan-live" | "plan-ignored" | "at-review" | "workers";
export interface PlanModelRow { id: string; title: string; lane: string; needs: string; model: string; tone: PlanModelTone }
export function planModelRows(tasks: DagPlanPreviewTask[], workers: { picks: boolean; model: string }): PlanModelRow[];
export function planMixLine(tasks: DagPlanPreviewTask[], workers: { picks: boolean; model: string }): { text: string; accent: boolean };
export function workersModelName(workerRoute: RoutePin | null, leadRoute: RoutePin | null): string; // shortModel of the route, else of the lead, else "lead"
```

Behavior (spec §9 "New run window"; match `Main.dc.html` for structure, spacing and copy):

- `planModelRows`:
  - `needs` is the deps joined with `, `, or `–`.
  - A Model line on picks gives `<shortModel> · plan` with tone `plan-live`; on other settings the same text with
    tone `plan-ignored`, which renders struck through and faint.
  - No line on picks gives `at review`; otherwise the workers model name.
- `planMixLine`:
  - On picks: `N set by the plan · M picked at review`, accent.
  - Otherwise `all on <model>`, plus ` · plan lines ignored` when any task has a Model line.
- Layout:
  - The dialog is `w-[min(960px,94vw)]` and `h-[min(720px,88vh)]`, with a header (`New run`, `ctrl+⏎ to start`).
  - Two panes: a left column 300px wide, and a right pane `minmax(0,1fr)`.
  - A footer with the summary, Cancel and Start run. Start run is disabled with the `launchBlocker` reason, as today.
- Left column:
  - Project: `ProjectPicker`, with `onRegister` wired to the registration flow the modal already offers when no
    projects exist.
  - Shape: the two cards, then Workers at once under them for orchestrator.
  - Models: rows labeled Lead, Workers and Reviewers (the latter two for orchestrator), each a full-width
    `RoutePicker`.
- Right pane:
  - For orchestrator, the Goal | Plan file segmented toggle with `startNote`. Goal is a textarea filling the pane;
    quick shows only the goal textarea.
  - Plan file: the path input, then the title (from the preview), the shape line (`N tasks · L lanes · longest chain C`),
    the mix line right-aligned, and a bordered table with a sticky header (task, title, lane, needs, model).
  - Rows use `planModelRows` in a scrolling body. A preview error shows in place of the table.
- Keep every existing behavior of the modal: channel resolution, remembered project, the goal draft, `ctrl+⏎`,
  errors in the footer.

- [ ] **Step 1: Write the failing tests** in `newrunplan.test.ts`: `planModelRows` for each tone (picks on and off,
  with and without Model lines), `needs` formatting, `planMixLine` in its three shapes, and `workersModelName` with
  a route, with only a lead, and with neither.
- [ ] **Step 2:** `npx vitest run frontend/app/view/jarvis/newrunplan.test.ts` and expect FAIL.
- [ ] **Step 3:** Implement the model, then the layout.
- [ ] **Step 4:** Run the vitest command, the existing `newrun.test.ts` and the typecheck. Expect PASS and exit 0.
- [ ] **Step 5:** Commit `feat(newrun): two-pane New run window with the plan's model table`.

### Task 10: Run graph: model source on cards, the detail rail and the header (Dag.dc.html)
**Depends on:** Task 7

**Files:**
- Create: `frontend/app/view/orchestrate/taskroute.ts`, `frontend/app/view/orchestrate/taskroute.test.ts`
- Modify: `frontend/app/view/orchestrate/dagstore.ts`:
  - `buildViewData` uses `taskRoute`.
  - `DagNodeRoute.source` becomes `RouteSource`.
  - `DagViewNode` gains `tag: string | null` and `reviewLine: string`.
  - `routeSourceLabel` moves to `taskroute.ts`; re-export it here if other files import it from `dagstore`.
- Modify: `frontend/app/view/orchestrate/dagstore.test.ts`. It pins the old `pinned`/`workers`/`inherited` sources,
  so update those expectations only.
- Modify: `frontend/app/view/orchestrate/dagnodes.tsx` (the card tag)
- Modify: `frontend/app/view/orchestrate/dagdetailrail.tsx` (worker and review lines)
- Modify: `frontend/app/view/orchestrate/daggraph-header.tsx` (the workers and reviewers chips)
- Modify: `frontend/app/view/orchestrate/daggraph.tsx` (the stage line's model per stage)

**Interfaces:** Consumes `shortModel` (Task 7). Produces everything under Task 10 in "Shared names", plus:

```ts
export function routeSourceLabel(source: RouteSource): string;
export function cardModelTag(task: TaskNode, owner: Run, group: TaskGroup): string | null;
export function reviewStateText(task: TaskNode): string;
export function workersChip(group: TaskGroup, owner: Run): string;  // "workers · same as lead" | "workers · reviewer picks" | "workers · <short>"
export function reviewersChip(group: TaskGroup, owner: Run): string; // "reviewers · same as lead" | "reviewers · <short>"
```

Behavior (spec §3 precedence mirrored exactly, spec §9 "Run graph"):

- `taskRoute` mirrors Go's `effectiveTaskRoute` (Task 4's four rungs). The source is:
  - the task's `modelsource` when it is not empty and its rung applied;
  - `pinned` for an empty source with a pin;
  - `workers` for rung 3;
  - `inherited` for rung 4.
- `routeSourceLabel`: `plan's pick`, `reviewer's pick`, `your pick`, `escalated`, `pinned`, `workers route`,
  `same as lead`.
- `cardModelTag` is null when the task's route model equals `workersRoute`'s. Otherwise it is
  `<shortModel> · <plan|review|you|escalated|pinned>`, where `pinned` is a typed-JSON pin (spec §9). For rung 3 or 4
  it is always null.
- `reviewStateText`:
  - `reviewing` when `reviewrunid` is set and there is no verdict;
  - `passed first time` for pass with `reviewround` 0;
  - `passed after N failed` for pass with `reviewround` N;
  - `failed` for fail;
  - else `not started`.
- Rail:
  - `worker · <label> · <runtime> / <model or default> · <resolved>` (the resolved model comes from harnesses as
    today).
  - `review · <same as lead | reviewer route> · <resolved reviewer model> · <reviewStateText>`.
  - Keep the `data-dag-node-route` attribute, now carrying the new source values.
- Header chips per `Dag.dc.html`. The stage line appends `· <shortModel of reviewerRouteOf>` to the plan review and
  final verify entries.
- `isWaiting` mirrors Go's `taskWaiting`: state `pending`/`ready`, no `runid`, and `attempts`, `escalations` and
  `firstactivity` all zero.

- [ ] **Step 1: Write the failing tests** in `taskroute.test.ts`:
  - The same precedence table as Go's `TestEffectiveTaskRoutePrecedence`, including the zero-value rows.
  - Every label.
  - `cardModelTag`: equal model gives null; a reviewer sonnet pick on an opus lead gives `sonnet · review`.
  - Each `reviewStateText` branch, both chips, `reviewerRouteOf` and `isWaiting`.
- [ ] **Step 2:** `npx vitest run frontend/app/view/orchestrate/taskroute.test.ts` and expect FAIL.
- [ ] **Step 3:** Implement, then wire the views.
- [ ] **Step 4:** Run the vitest command, `dagstore.test.ts`, `dagcanvas.test.ts` and the typecheck. Expect PASS and
  exit 0.
- [ ] **Step 5:** Commit `feat(dag): show where each task's worker and reviewer model came from`.

### Task 11: Model picks: banner, panel and timeline (PicksInline.dc.html)
**Depends on:** Task 10

**Files:**
- Create: `frontend/app/view/orchestrate/modelpicks.ts`, `frontend/app/view/orchestrate/modelpicks.test.ts`,
  `frontend/app/view/orchestrate/modelpicks.tsx`
- Modify: `frontend/app/view/orchestrate/dagmodal.tsx`. It mounts the banner under the modal header, and the panel
  at the top of the right column, above `TimelineRail`, in the live modal only.
- Modify: `frontend/app/view/agents/runtimeline.ts` (+ its view if the row renders in a `.tsx`). A `plan-reviewed`
  row with `detail.picks` lists them under the summary as `t-N · <model> · <reason>`.
- Test: `frontend/app/view/agents/runtimeline-picks.test.ts` (new)

**Interfaces:** Consumes `taskRoute`, `isWaiting`, `LIGHT_PICK` and `shortModel`. Produces:

```ts
export interface PickRow { id: string; title: string; reason: string; model: "sonnet" | "lead"; waiting: boolean; changed: boolean; runningModel: string }
export function pickRows(group: TaskGroup, owner: Run): PickRow[];
export function picksBanner(group: TaskGroup, owner: Run): { onLight: number; total: number } | null;
export function setModelPayload(group: TaskGroup, taskId: string, model: "sonnet" | "lead"): CommandDagActionData;
export function leadModelsPayload(group: TaskGroup): CommandDagActionData;
export function planReviewPicks(detail: unknown): { taskid: string; model: string; reason: string }[];
```

Behavior (spec §9 "Model picks"):

- `pickRows` is empty unless `group.reviewerpicks`. It lists tasks with a `pickreason` whose route is the light pick,
  or whose `modelsource` is `owner`.
  - `model` is `sonnet` when the task's route is `LIGHT_PICK`, else `lead`.
  - `changed` is `modelsource === "owner"`.
  - `runningModel` is `shortModel` of the route, for a started task.
- The panel and banner render only when some row is waiting.
- `picksBanner` counts the rows on the light pick against `group.tasks.length`.
- `setModelPayload`: `{action: "setmodel", taskid, runtime: "claude", model: "sonnet"}` for sonnet, and an empty
  runtime and model for lead. `leadModelsPayload`: `{action: "leadmodels"}`. Both carry the group's channel and run.
- Panel:
  - Title `Model picks`, with `from the plan reviewer` beside it.
  - The button `Put waiting tasks back on <shortModel of lead>`.
  - Rows: id, title, and a `sonnet | <lead short>` segmented toggle while waiting, or `running on <model>` with the
    live dot once started. Under them, the reason and `waiting` / `you changed it`.
  - Footer copy per the mockup, naming the lead's model.
  - A refused action shows `dagActionError` text on its row.
- Banner copy per the mockup, with `N of M tasks on sonnet`.

- [ ] **Step 1: Write the failing tests.**
  - `modelpicks.test.ts`: `pickRows` on a non-picks group is empty. On a picks group it covers a waiting sonnet
    pick, a started one, a lead pick (not listed), and an owner-changed one (listed, `changed`). Also
    `picksBanner` counting and null when nothing waits, and both payloads.
  - `runtimeline-picks.test.ts`: `planReviewPicks` with picks, without them, and with malformed detail (empty).
- [ ] **Step 2:** `npx vitest run frontend/app/view/orchestrate/modelpicks.test.ts frontend/app/view/agents/runtimeline-picks.test.ts`
  and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the vitest command, `runtimeline.test.ts` and the typecheck. Expect PASS and exit 0.
- [ ] **Step 5:** Commit `feat(dag): review and change the plan reviewer's model picks`.

### Task 12: Profile Reviewer route row and run sheet pickers (Profile.dc.html)
**Depends on:** Task 7

**Files:**
- Modify: `frontend/app/view/jarvis/profilemodel.ts` (a Reviewer route row, and the Worker route row's Reviewer picks value)
- Modify: `frontend/app/view/jarvis/briefprofileview.tsx` (render the row, and the Workers picker's `extraOption`)
- Modify: `frontend/app/view/jarvis/runsettings.ts`, `frontend/app/view/jarvis/runsheetmodel.ts`, and the sheet view
  that renders the worker picker (`runsheet.tsx` or `briefrunsheet.tsx`)
- Modify: `frontend/app/view/agents/leadcard.tsx`. Its parallelism control calls `SetRunSettingsCommand` with only
  the width; route it through the payload helper below (and `leadcardmodel.ts` if the effective settings are read
  there).
- Test: `frontend/app/view/jarvis/profilemodel-reviewer.test.ts` (new), `frontend/app/view/jarvis/runsettings-reviewer.test.ts` (new)

**Interfaces:** Consumes the `extraOption` prop and the Task 1 profile/settings fields.

Behavior (spec §1 override rule, spec §9 "Profile and run sheet"):

- Profile rows follow `Profile.dc.html`: Reviewer route, with the hint `Task reviews, plan review and final verify`,
  directly below Worker route, with the same Global/Project source dot and Reset.
- The Worker route row:
  - Reviewer picks writes `reviewerpicks: true` and no route.
  - A route writes the route and clears `reviewerpicks`.
  - In project scope, Same as lead writes `reviewerpicks: false` and no route.
  - Reset removes both from the override.
- The Reviewer route row writes `reviewerroute`; Reset removes it.
- Run sheet: the worker picker offers Reviewer picks, and a Reviewers picker follows it. The payload it sends to
  `SetRunSettingsCommand` always carries `reviewerpicks` and `reviewerroute` as shown.
- `SetRunSettings` always applies the workers setting and the reviewer route, so a caller that omits them resets
  them. Add an exported pure helper in `runsettings.ts` that builds a payload from the run's effective settings
  (the group's once a dag exists, else the run's) plus the changed field. The lead card's parallelism control
  uses it, so changing the width keeps the worker route, Reviewer picks and the reviewer route. Today it drops
  the worker route.

- [ ] **Step 1: Write the failing tests.**
  - `profilemodel-reviewer.test.ts`: the rows' values and sources for global and project scope, and the override
    each choice writes, including project Same as lead and Reset.
  - `runsettings-reviewer.test.ts`: the settings payload for each workers choice, and with a reviewer route. Also
    the width-only helper: on a run with a worker route, Reviewer picks or a reviewer route (from the group when a
    dag exists, else the run), it keeps all three.
- [ ] **Step 2:** Run both by path and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them, the existing `profilemodel`/`runsettings`/`runsheetmodel` tests and the typecheck. Expect
  PASS and exit 0.
- [ ] **Step 5:** Commit `feat(profile): reviewer route row and reviewer picks in run defaults and the run sheet`.

### Task 13: Orchestrator guide
**Depends on:** Task 2, Task 5, Task 6, Task 11

**Files:**
- Modify: `docs/orchestrator-guide.md`

Document, against the code as merged (read it; do not copy the spec blindly):

- the `**Model:**` line;
- the workers setting (Same as lead, a route, Reviewer picks) and the four-rung precedence;
- what the plan reviewer is asked for and the `--pick` shape;
- where picks are recorded (the Plan reviewed timeline entry, cards, the Model picks panel), and that the owner can
  change them until a task starts;
- the reviewer route and what it drives;
- the `wsh runs start` flags `--reviewer-picks`, `--reviewer-runtime` and `--reviewer-model`.

Place each in the section that already covers its neighbor (worker route, plan review, `wsh runs start`). Leave
`docs/keyboard-shortcuts.md` alone: no bindings change.

- [ ] **Step 1:** Write the sections.
- [ ] **Step 2:** Check that every flag, action and field name in them exists:
  `grep -rn "reviewer-picks\|reviewer-runtime\|reviewer-model\|\"setmodel\"\|\"leadmodels\"\|--pick" cmd pkg`.
- [ ] **Step 3:** Commit `docs(orchestrator): per-task models, reviewer picks and the reviewer route`.

### Task 14: CDP scenarios `new-run-window` and `model-picks`
**Depends on:** Task 2, Task 6, Task 9, Task 11

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` (two scenarios appended to the list; do not touch the others)
- Create: `scripts/cdp/fixtures/models-plan.md` (a 3-task plan, one task with `**Model:** sonnet`, and noop tasks:
  "do nothing, make no file changes, stop immediately")

Follow the scenario shape and helpers of `dag-lifecycle` and `run-sheet-polish`: arrange, goto, shot, assert,
teardown. Scope DOM queries to a `data-*` container, never a document-wide button search. Pin the viewport to
1600x950 before by-name clicks. Add `data-*` hooks in components only if a query cannot be scoped otherwise. If you
do, list them in the report; Tasks 9 and 11 own those files and have landed.

- `new-run-window`:
  - Open + Run (the `R` binding or the New run button).
  - Open the project picker, assert its Recent and All projects groups, type a query, and assert that Recent is gone
    and Matches shows.
  - Pick the scenario's project.
  - Switch to Plan file and type the fixture's absolute path. Assert 3 rows, and a model cell `sonnet · plan`
    struck through on Same as lead.
  - Set Workers to Reviewer picks. Assert `sonnet · plan` is no longer struck, the other rows read `at review`, and
    the mix line reads `1 set by the plan · 2 picked at review`.
  - Cancel. Teardown deletes the channel and project it created.
- `model-picks`:
  - createrun with `reviewerpicks: true`, `deferstart: true`, `parallelism: 1`, `runtime: "claude"`.
  - Submit the fixture plan.
  - Wait for `dag.planreview.runid`, then record `planreview-pass` through `dagaction`, with
    `runid = planreview.runid` and picks for the two tasks without a Model line (one `sonnet`, one `lead`).
  - Open the run's graph.
  - Assert:
    - the banner reads `1 of 3 tasks on sonnet`;
    - the panel lists the sonnet pick;
    - toggling it to the lead's model writes `modelsource: "owner"` on that task (read back with `getobject`);
    - the card tag and rail line show the source.
  - Teardown cancels the run and deletes the channel.

- [ ] **Step 1:** Write both scenarios and the fixture.
- [ ] **Step 2:** In your own worktree dev app (`scripts/cdp/final-verify.mjs` sets it up; see AGENTS.md
  "Worktrees"), run `CDP_PORT=<port> task verify:ui -- new-run-window model-picks` and expect both to PASS. If the
  environment cannot run the dev app, say so in the report rather than claim a pass.
- [ ] **Step 3:** Commit `test(cdp): new run window and model picks scenarios`.
