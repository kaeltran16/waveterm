# Per-task worker models and a reviewer route for engine runs

Design canvas (the spec for every screen here; gitignored, read by absolute path):
`C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\worker-reviewer-models\project\`

- `Main.dc.html`: the New run window, two panes (design E). Built.
- `ProjectPicker.dc.html` variant 1: the project field with a searchable list. Built; variant 2 is rejected.
- `Dag.dc.html`: model source on cards, the detail rail and the header. Built.
- `PicksInline.dc.html`: the banner and Model picks panel. Built.
- `Profile.dc.html`: run defaults with a Reviewer route row. Built.
- `CommandBar`, `Grouped`, `PicksGate`: rejected, not built.

## Goal

An engine run can put cheap, mechanical tasks on Sonnet and keep design work on the lead's model, and the
human can choose where task reviews, the plan review and the final verify run. A run that never opts in
behaves exactly as today.

## Terms

- **Workers setting**: one of *Same as lead*, *a specific route*, or *Reviewer picks*.
- **Reviewer route**: where task reviewers and stage sessions (plan reviewer, final verifier) run. `nil` means
  the lead's route.
- **Waiting task**: a task that has never started: state `pending` or `ready`, no `RunID`, and `Attempts`,
  `Escalations` and `FirstActivity` all zero.
- **Lead's route**: `{runroute.DefaultRuntime(owner.Runtime), owner.Model}`, as today.
- **Light pick**: the claude runtime with the `sonnet` alias (`{Runtime: "claude", Model: "sonnet"}`), resolved
  by `runroute.Resolve` at dispatch like any pin. It is a named constant in `pkg/orchestrate`, never an inline string.

## 1. Stored settings

### Workers setting: `ReviewerPicks`

A new flag beside `WorkerRoute`, not a fake `RoutePin`:

| Where | Field |
|---|---|
| `waveobj.JarvisProfile` | `ReviewerPicks bool` `json:"reviewerpicks,omitempty"` |
| `waveobj.ProfileOverride` | `ReviewerPicks *bool` `json:"reviewerpicks,omitempty"` |
| `waveobj.Run` | `ReviewerPicks bool` `json:"reviewerpicks,omitempty"` |
| `waveobj.TaskGroup` | `ReviewerPicks bool` `json:"reviewerpicks,omitempty"` |
| `wshrpc.CommandCreateRunData` | `ReviewerPicks *bool` `json:"reviewerpicks,omitempty"` |
| `wshrpc.CommandSetRunSettingsData` | `ReviewerPicks bool` `json:"reviewerpicks,omitempty"` |
| `jarvis.PendingEngineSettings` | `ReviewerPicks bool` |

Rules:

- `ReviewerPicks` true with a non-nil `WorkerRoute` is refused wherever both can be written (profile save,
  override save, CreateRun, SetRunSettings, `wsh runs start`) with an error naming both.
- **Override resolution**: the workers setting is one section made of the pair. When an override's
  `WorkerRoute` or `ReviewerPicks` is non-nil, `ResolveProfile` takes both from the override
  (`ReviewerPicks` nil there reads as false). So a project can now override a global model back to Same as lead
  (`reviewerpicks: false`, no route).
- **CreateRun**: when `ReviewerPicks` is nil (e.g. `wsh runs start` with no worker flags), the workers setting comes
  from the resolved profile, as `WorkerRoute` does today. When it is non-nil, the caller owns the workers
  setting as sent: `WorkerRoute` is taken as-is and nil means Same as lead. The launcher always sends it for an
  orchestrator run.
- **SetRunSettings / PendingEngineSettings**: always applied, like `WorkerRoute` (the sheet always sends what it
  shows). `ApplyPendingEngineSettings`, `ApplyLiveEngineSettings` and `RunEngineSettings` carry it.
- **DagSubmit** takes it from the run (`run.ReviewerPicks` onto the group). It is not in
  `CommandDagSubmitData`: the lead cannot choose it.
- `ReplacePlanReviewProposal` leaves the group's `ReviewerPicks` and `ReviewerRoute` alone (a live-sheet edit made
  before the resubmit must survive it).

### `ReviewerRoute`

Mirrors `WorkerRoute` everywhere it lives: `JarvisProfile`, `ProfileOverride` (nil = inherit global),
`Run`, `TaskGroup`, `CommandCreateRunData` (nil = the profile's), `CommandSetRunSettingsData` and
`PendingEngineSettings` (always applied), `validateEngineDefaults`, `ProfileOverrideIsEmpty`, and the pin
migration in `pkg/jarvis/routemigrate.go` (profile, channel overrides, runs, dags). The migration pass only runs
once per data dir and reviewer pins never held tiers, so the new lines are for symmetry, not a data fix.

`validateWorkerRoute` becomes `validateRoute(field string, route *RoutePin, requireInstalled bool)`, called
for both fields, so the error names the field. Reviewer routes use the same harness operation as workers
(`harness.OperationRunWorker`), since reviewers and stage sessions are spawned through `spawnWorker`.

Only the human sets `ReviewerRoute` (the launcher, the profile, the run sheet, `wsh runs start`). It is not in
`CommandDagSubmitData`, and no `wsh jarvis` command writes it. No wsh command calls `SetRunSettingsCommand`,
so a lead has no path to it.

## 2. Plan format: `**Model:**`

A task may carry one `**Model:** <model>` line in its head block: after `**Depends on:**` when present, and
before, after or among its `**Chunk:**` lines. `<model>` is a model id or alias as
`wsh jarvis dag escalate --model` takes it (`sonnet`, `claude-opus-5-5`, a pi `provider/model`), not in
backticks. It is resolved against the run's own runtime (`RunSpec.Runtime` stays empty, as dispatch already
reads).

- `ParsePlan` puts it in `TaskNode.RunSpec.Model` and sets `TaskNode.ModelSource = "plan"`.
- Refused: an empty value, a value with a backtick or a space, and a second Model line in one task.
- A Model line anywhere else in the task is task text (the same rule as Chunk).
- Submit validates it through the existing per-task pin loop in `DagSubmitCommand` (resolve, harness
  installed) whatever the workers setting is, so a plan naming a model the machine cannot run is refused at
  submit, naming the task.
- `jarvis.PlanFormat` gains the rule and its example gets a Model line; `TestPlanFormatParses` keeps prose and
  parser together.
- The `CommandDagSubmitData` comment that says the plan format cannot pin a model is corrected: a plan can pin a
  model; only a per-task runtime still needs the typed form.

## 3. Where a task's model comes from

### New task fields

On `waveobj.TaskNode`:

- `ModelSource string` `json:"modelsource,omitempty"`: `plan` | `reviewer` | `owner` | `escalation`. Empty is a
  typed-JSON `RunSpec` pin, or no pin at all.
- `PickReason string` `json:"pickreason,omitempty"`: the plan reviewer's one-line reason. Kept after an owner
  change, so the panel can still show why the reviewer chose it.

`NewTaskGroup` refuses a submitted task with a non-empty `PickReason` or with `ModelSource` other than `""` or
`plan`. `SameDagProposal` compares `ModelSource`.

### Precedence (`effectiveTaskRoute`)

A task's `RunSpec` pin is `{RunSpec.Runtime or the owner's runtime, RunSpec.Model}` and exists when either field is set.

1. `ModelSource` is `owner` or `escalation`, or is empty with a pin: the pin. A human's per-task choice, an
   escalation and a typed pin always win, which is today's behavior for the last two.
2. `ModelSource` is `plan` or `reviewer`, the group is on Reviewer picks, and there is a pin: the pin.
3. The group's `WorkerRoute`, when it names a runtime or model.
4. The lead's route.

So on Same as lead or a specific route, plan Model lines and reviewer picks are ignored (rung 2 is skipped). On
Reviewer picks, the order is: the plan's Model line, else the reviewer's pick, else the lead's route. A pick of
the lead's route is stored as an empty pin, so it falls to rung 4.

`escalationTarget`, dispatch (`childRunFromSpec`) and the frontend graph all read this one rule. The frontend
mirrors it in a pure TypeScript function with its own tests (section 7), because the graph renders sources
the engine does not send.

`applyEscalation` sets `ModelSource = "escalation"`. Retry and escalate are otherwise unchanged.

## 4. The plan reviewer picks models

Only when `g.ReviewerPicks`:

- **Prompt**: `planReviewPrompt` adds the rule and the tasks to pick for (every task whose `ModelSource` is not
  `plan`, by id and title): pick `sonnet` only for a mechanical, tightly specified task (a copy of an existing
  pattern, a field threaded through, prose against written code); pick `lead` for anything with a design
  choice; give one line on why. Its pass command becomes
  `wsh jarvis dag planreview pass "<summary>" --pick "t-2=sonnet: <reason>" --pick "t-3=lead: <reason>" ...`.
- **Wire**: `CommandDagActionData.Picks []DagModelPick` with `DagModelPick{TaskId, Model, Reason}` in
  `wshrpctypes_dag.go`. `Model` is `sonnet` or `lead`.
- **CLI**: `--pick` is a repeatable string flag on `planreview`, parsed as `<task>=<sonnet|lead>: <reason>`;
  a malformed value is refused before the RPC, with the expected shape.
- **Validation**: `RecordPlanReviewVerdict` on pass refuses, naming the problem, so the reviewer can resend:
  a missing pick for a task without a Model line; a pick for a task with one; an unknown or repeated task; a
  model other than `sonnet` or `lead`; an empty reason, a reason with a newline, or one over
  `MaxPickReasonLen` (200 runes); and a `sonnet` pick when the claude harness cannot run a worker (the error
  says to pick `lead`). A run not on Reviewer picks refuses any picks, as does a fail verdict.
- **Applied atomically**: in the same `mutatePlanReview` that sets `Passed`: `sonnet` sets `RunSpec` to the light
  pick, `lead` clears `RunSpec.Runtime` and `RunSpec.Model`; both set `ModelSource = "reviewer"` and `PickReason`.
  Dispatch waits on `planReviewHolds`, so no worker ever starts on a passed review without its picks. There is
  no extra stage and no hold.
- **Timeline**: the `plan-reviewed` pass event's detail gains `picks: [{taskid, model, reason}]`, and the
  timeline row renders them under the summary.
- **Not reviewed**: on `accept` after a failed review, or for a fix round's tasks (no plan review), tasks
  without a Model line run on the lead's route.

## 5. The owner changes a pick

New dag actions in `applyActionLocked`, sent from the cockpit through `DagActionCommand` (no wsh command):

- `setmodel`: `TaskId` plus `Runtime`/`Model` (as escalate). The task must be waiting; otherwise it is
  refused with the task's state. The model is resolved with `runroute.Resolve` (as escalate does) and also checked
  with `validateWorkerHarness`, so a model this machine cannot run is refused on the panel row. It sets `RunSpec` and
  `ModelSource = "owner"`, and keeps `PickReason`.
- `leadmodels`: every waiting task with a `PickReason` gets an empty `RunSpec` and `ModelSource = "owner"`. So
  "put waiting tasks back on the lead's model" is one write. A no-op when none qualify.

Neither action changes `Escalations`, `Attempts` or the dag's failure streak rule. A running task keeps its
model; retry and escalate are unchanged.

## 6. Reviewer route drives reviewers and stage sessions

One helper, `reviewerRoute(owner, g) RoutePin`: the group's `ReviewerRoute` when it names a runtime or model
(runtime defaulted as `effectiveTaskRoute` does), else the lead's route. `spawnReviewer` (`review.go`) and
`spawnStageSession` (`stagesession.go`; the plan reviewer and the final verifier) use it in place of the owner
pin they build today. The spawned child run records that route, so usage attribution is unchanged.

## 7. `wsh runs start`

- `--reviewer-picks`: the workers setting is Reviewer picks. Refused with `--worker-runtime`/`--worker-model`.
- `--reviewer-runtime` and `--reviewer-model`, like the worker pair (`--reviewer-model` needs
  `--reviewer-runtime`).
- All three need an orchestrator run, like the existing engine flags.
- `wsh runs` prints `workers=reviewer-picks` and `reviewers=<runtime> <model>` beside today's `workers=`.

## 8. Plan preview

`CommandDagPlanPreviewRtnData` gains `Tasks []DagPlanPreviewTask`:
`{ID, Title, Lane int (1-based, jarvis.Lanes order), Deps []string, Model string}`. `Model` is the Model line, or
empty. It is computed from the parsed plan, so it needs no run.

## 9. Frontend

Pure `.ts` models with `.test.ts` beside them, rendered by thin `.tsx`. `@theme` tokens only, per DESIGN.md.

### New run window (`Main.dc.html`)

`newruncontrol.tsx` becomes a 960x720 (capped to the viewport) two-pane dialog:

- **Left column (300px)**: the Project field (below), Shape cards with Workers at once under them
  (orchestrator only), and Models rows: Lead, Workers, Reviewers (Workers and Reviewers orchestrator only).
  The Workers picker offers Same as lead, Reviewer picks, and routes. The Reviewers picker offers Same as lead
  and routes.
- **Right pane**: a Goal | Plan file toggle with the start note (orchestrator; quick shows the goal only). Goal
  is a textarea filling the pane. Plan file is the path input, then the plan's title, the shape line
  (`14 tasks · 5 lanes · longest chain 4`), the model mix line, and a scrolling table: task, title, lane,
  needs (`–` when none), model.
- **Model cell** (from a pure `planModelRows`):
  - A Model line on Reviewer picks: `<model> · plan`, accent.
  - A Model line otherwise: `<model> · plan`, struck through and faint.
  - No line on Reviewer picks: `at review`, muted.
  - No line otherwise: the workers model's short name.
- **Mix line**: on Reviewer picks, `N set by the plan · M picked at review`, accent. Otherwise `all on <model>`,
  plus ` · plan lines ignored` when the plan has any.
- **Footer**: the summary (`orchestrator × 3 in waveterm`), Cancel, Start run. `ctrl+⏎` starts, as today.

The launcher atoms (`runconfigstore.ts`) gain `reviewerPicksAtom` and `reviewerRouteAtom`, hydrated from the
profile (`profileRunDefaults`) like `workerRouteAtom`. `launchOptsFromConfig` sends `reviewerpicks` for every
orchestrator launch and `reviewerroute` when set. The Brief sheet's `RunLauncher` shares `RoutingSection`, so it
gains the same Workers option and Reviewers picker.

### Project picker (`ProjectPicker.dc.html` variant 1)

It replaces `ProjectChips` in the New run window only; the profile view and the effort form keep chips.

- A field shows the picked project's name and its **where**: the parent folder, relative to the home directory
  (`IdeaProjects` for `~\IdeaProjects\waveterm`), or the full parent path outside home.
- It opens a listbox with a search input (`Search N projects`). With no query it shows **Recent**, then
  **All projects** (sorted by name, without the recent ones). A query shows one **Matches** list
  (`rankProjects`, matching name or where) and `No project matches.` when empty.
- Recent is up to 3 registered projects whose channels have the newest runs (`createdts`), newest first,
  derived from the channel list the window already reads.
- Keys: ↑↓ move (wrapping, `stepPick`), ⏎ picks and closes, esc closes the list (not the dialog). A footer shows
  the key hints and a Register a project link to the existing registration flow.
- These keys are local to the open list, not `keybindings.ts` bindings.

### Run graph (`Dag.dc.html`)

- **Route source labels** replace today's `pinned`/`run worker route`/`inherits run route`: `plan's pick`,
  `reviewer's pick`, `your pick`, `escalated`, `pinned` (typed JSON), `workers route`, `same as lead`.
- **Card tag**: shown only when the task's effective model differs from the run's workers model (the group's
  `WorkerRoute`, else the lead's). It reads `<short model> · <plan|review|you|escalated|pinned>`.
- **Detail rail**: two lines. `worker · <source> · <runtime> / <model> · <resolved>`, and
  `review · <same as lead | reviewer route> · <resolved> · <state>`. State is `not started`, `reviewing`,
  `passed first time`, `passed after N failed`, or `failed`, from `ReviewVerdict`/`ReviewRound`.
- **Header**: chips `workers · <same as lead | reviewer picks | model>` and `reviewers · <same as lead | model>`.
  The stage line shows each stage session's model (`plan review · passed · opus-5-5`,
  `final verify · waiting · opus-5-5`).

### Model picks (`PicksInline.dc.html`)

Shown in the live dag modal only when the group is on Reviewer picks and at least one reviewer-picked task
(a `PickReason` whose pick was not the lead's route, or one the owner changed) is still waiting.

- **Banner** under the modal header: `Plan review passed and put N of M tasks on sonnet. They run as picked
  unless you change them.`, plus `no need to act`.
- **Panel** in the right column, above the timeline rail: title `Model picks · from the plan reviewer`, a
  `Put waiting tasks back on <lead short name>` button (`leadmodels`), and one row per listed task: id, title,
  a `sonnet | <lead>` toggle (`setmodel`) while waiting or `running on <model>` once started, the reason, and
  `waiting` or `you changed it`. Footer: `A task that already started keeps its model. If it fails, retry it on
  <lead> from its card.`
- Both disappear once every listed task has started; the cards and rail keep the source.
- A refused action shows its error on the row, as the rail does for dag actions.

### Profile (`Profile.dc.html`) and run sheet

- Run defaults gain a **Reviewer route** row (`Task reviews, plan review and final verify`) below Worker route,
  with the same Global/Project source dot and Reset. The Worker route row offers Reviewer picks.
- The run sheet's worker picker offers Reviewer picks, and it gains a Reviewers picker. Both are written through
  `SetRunSettings`.
- Every `SetRunSettings` caller sends the effective workers setting and reviewer route along with what it changes,
  since the settings are always applied. The lead card's parallelism control sends only the width today, which
  already resets the worker route; it is fixed to send all of them.

## 10. Docs

- `jarvis.PlanFormat` (section 2).
- `docs/orchestrator-guide.md`: the Model line; the workers setting and its precedence; how reviewer picks are
  made, recorded and changed; the reviewer route and what it drives; the new `wsh runs start` flags.
- `docs/keyboard-shortcuts.md`: unchanged. No `keybindings.ts` binding changes (the picker's keys are local).

## 11. Testing

- **Go**, focused tests beside the code:
  - `ParsePlan` Model-line cases.
  - `effectiveTaskRoute` over the precedence table.
  - `ResolveProfile` pair resolution.
  - Validation refusals (picks with a route; bad reviewer route).
  - `RecordPlanReviewVerdict` pick validation and atomic apply.
  - `setmodel`/`leadmodels` on waiting and started tasks.
  - `reviewerRoute` in `spawnReviewer`/`spawnStageSession`.
  - Route migration of `ReviewerRoute`.
  - CreateRun inheritance.
  - `wsh runs start` flag rules; the `--pick` parser.
  - Plan preview tasks.
- **Frontend**: vitest for `planModelRows` and the mix line, the project picker model, the route mirror and labels,
  the card-tag rule, the rail lines, the picks panel model, `launchOptsFromConfig`, profile rows, and run
  settings.
- **CDP** (`scripts/cdp/scenarios.mjs`):
  - `new-run-window`: open + Run; the project picker's Recent/All/Matches; Plan file with a fixture plan (one
    Model line); the model column and mix line flip between Same as lead and Reviewer picks.
  - `model-picks`: a run on Reviewer picks submitted with DeferStart and a plan file (dag-lifecycle's pattern);
    the scenario records the pass verdict with picks itself, as the reviewer run; the banner and panel render;
    a toggle writes `setmodel`; teardown cancels the run.

## Behavior unchanged

A run on Same as lead or a specific worker route with no reviewer route spawns every worker, reviewer and
stage session on exactly the route it uses today. Existing stored profiles, runs and dags decode with the new
fields zero, which reads as that. The one deliberate difference is that a plan's Model line is now parsed; on
such runs it is ignored, and before this change it was task text.
