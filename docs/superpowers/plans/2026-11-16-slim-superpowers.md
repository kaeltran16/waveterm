# Slim the orchestrator's superpowers dependency

**Spec:** `docs/superpowers/specs/2026-11-16-slim-superpowers-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/jarvis ./pkg/orchestrate ./pkg/wshrpc/... ./pkg/wconfig ./pkg/waveobj ./pkg/agentsync ./cmd/wsh/cmd ./skills`
**Check:** `go vet ./pkg/jarvis ./pkg/orchestrate ./pkg/wshrpc/... ./pkg/wconfig ./pkg/waveobj ./cmd/wsh/cmd ./skills && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs settings-plan-skill`

## Decisions beyond the spec

1. **This run stops short of the flip.** It builds the engine override, Arc's design skill, arc:plan, the
   writing-plans copy, the plan-skill setting and every re-pointed name. Turning superpowers off (the user
   disables `superpowers@claude-plugins-official` in `~/.claude/settings.json` and removes pi's superpowers
   package) is the user's action, and the spec ties deleting the override to that same change: deleting it
   here would put superpowers back into every engine session until the user flips. Task 9 files it as an
   actionable open issue naming everything that change deletes. The override still lands as its own task
   and commit (Task 1, no dependencies).
2. **The override is one launch option.** `jarvis.RunWorkerOptions.NoSuperpowers bool` makes a claude launch
   add `--settings` with the inline JSON `{"enabledPlugins":{"superpowers@claude-plugins-official":false}}`
   (one argv element). It is part of `RunWorkerSpec.BaseArgs`, so a resume keeps it. Set on workers, task
   reviewers and every `LaunchJudgingSession` (plan review, final verify, and also the brainstorm builder
   check and judge, which share that launch path and invoke no skill). Never on a lead, a design session or
   pi.
3. **The setting** is the wconfig key `run:planskill` (`RunPlanSkill` on `SettingsType`), values `plan` and
   `writing-plans`, shipped default `plan` in `pkg/wconfig/defaultconfig/settings.json`. Empty or unknown
   resolves to `plan`; an unknown value is logged. It sits on Settings > Run defaults beside the run route.
4. **The run's record.** `waveobj.Run.PlanSkill` (`json:"planskill,omitempty"`) is stamped at CreateRun on
   engine (orchestrator) runs from the setting, and copied onto `waveobj.TaskGroup.PlanSkill` at dag submit,
   the way `Autonomous` is. A stored empty value (every run and dag from before this change) reads as
   `writing-plans`, today's contract, so in-flight runs keep the contract their plan was written for.
5. **Skill names.** The skills live in `skills/plan` and `skills/writing-plans`, so Claude Code lists them as
   `arc:plan` and `arc:writing-plans`. Prompts name `arc:<skill>` on every runtime, as the canvas prompt
   already names `arc:design` for pi. The brainstorm skill keeps its name, `arc:brainstorm`.
6. **The plan review switches with the contract.** Its checklist item "each task states its acceptance
   criteria and names the tests that prove them" holds only for writing-plans; under arc:plan it asks for
   acceptance criteria a test can check at a seam the task implies. Without this every arc:plan plan fails
   review.
7. **The brainstorm hook becomes a redirect.** While superpowers is still on, a session that invokes
   `superpowers:brainstorming` (or `brainstorming`) is told to use `arc:brainstorm` instead; invoking
   `arc:brainstorm` adds nothing, since the skill is the instructions. The redirect goes with the override
   in the flip change (Decision 1).
8. **Notices.** Each skill folder holding copied upstream text carries a `LICENSE` file with that upstream's
   MIT notice (superpowers for `writing-plans`, Matt Pocock's for `plan`, both for `brainstorm`).
9. **Upstream sources.** superpowers 7.0.2 is installed at
   `~/.claude/plugins/cache/claude-plugins-official/superpowers/7.0.2/` (`skills/brainstorming/SKILL.md`,
   `skills/writing-plans/SKILL.md`, `LICENSE`); grilling at `~/.agents/skills/grilling/SKILL.md`;
   to-tickets and its `LICENSE` come from the latest `github.com/mattpocock/skills`.
10. **`PlanFormat` stays** the writing-plans text, so `wsh jarvis dag submit --help` is unchanged; leads get
    `jarvis.PlanFormatFor(skill)`.
11. **View-mod fixtures** keep their legacy (writing-plans) inputs and are regenerated where text moves. The
    arc:plan worker and reviewer briefs get fixtures of their own, since the mod parses the worker's Check
    clause.

## Contract by plan skill

The two contracts every task below implements. `writing-plans` is today's text with the skill renamed to
`arc:writing-plans`.

| | `writing-plans` | `plan` (default) |
|---|---|---|
| Lead plan step | "write the plan with arc:writing-plans ... except its complete-code rule ... acceptance criteria with the focused tests that prove them ..." (today's) | "write the plan with arc:plan": each task a vertical slice with what to build, what blocks it, acceptance criteria, its files, the interfaces others rely on and the scenario step for UI; no step lists and no listed tests. Keeps the width paragraph and `planCallersStep`. |
| Plan format | `PlanFormat` | `PlanFormat` without the "A task step names only the focused tests..." sentence, and the example task body reads as what to build plus acceptance criteria |
| Worker brief | today's ("Run the tests your task names...", "When your task says to watch a test fail first...") | picks its own test cases red-green at the public seam the acceptance criteria imply (behaviour through the public interface, mocks only at system boundaries, no expected value computed by the code under test); asks the lead with the ask tool only when the seam is unclear, such as needing a new public interface; runs the tests it wrote plus Check. The Check clause keeps the form `` ..., and `<check>`, `` |
| Task review | today's | also judges the worker's tests against the acceptance criteria and that seam; a criterion no test checks is a fail |
| Plan review item | "names the tests that prove them" | acceptance criteria a test can check (Decision 6) |

### Task 1: Engine sessions launch without superpowers
**Depends on:** none
**Files:** `pkg/jarvis/runexec.go`, `pkg/jarvis/runexec_test.go`, `pkg/orchestrate/engine.go`, `pkg/orchestrate/engine_test.go`, `pkg/orchestrate/review.go`, `pkg/orchestrate/review_test.go`, `pkg/orchestrate/stagesession.go`, `pkg/orchestrate/stagesession_test.go`

Spec Decision 1, shaped by Decision 2 above. Add `NoSuperpowers bool` to `jarvis.RunWorkerOptions` (its
comment says it is deleted when superpowers is turned off); `RunWorkerSpecFor` adds the `--settings` pair
for claude only, before `--session-id`, so it lands in `BaseArgs`. Set it at the worker spawn
(`dispatchTasks`), the task reviewer spawn (`review.go`) and `LaunchJudgingSession`.

Acceptance:
- A claude spec with `NoSuperpowers` has `--settings` followed by JSON that unmarshals to
  `enabledPlugins["superpowers@claude-plugins-official"] == false`, in both `Args` and `BaseArgs`, and
  `ResumeWorkerArgs` over those `BaseArgs` carries it; pi and an unset option add nothing. New test
  `TestRunWorkerSpecForNoSuperpowers` in `pkg/jarvis`.
- Workers, task reviewers and judging sessions launch with it, and the lead does not: extend the launch-option
  assertions in `TestScheduleOnceLabelsAWorkerWithItsTask`, `TestReviewerRunsOnTheLeadsRouteInTheLaneTree`, the
  judging-session tests in `stagesession_test.go`, and the lead check in `runexec_test.go`.
- Live probe, recorded in the report: `claude -p --settings '<the JSON>' --output-format stream-json
  --verbose "reply ok"` lists no superpowers plugin and no `superpowers:` skill in its init event, and the
  same command without `--settings` lists them.

Run: `go test ./pkg/jarvis -run 'TestRunWorkerSpecFor|TestEnsureWorkers'` and
`go test ./pkg/orchestrate -run 'TestScheduleOnceLabelsAWorkerWithItsTask|TestReviewerRunsOnTheLeadsRouteInTheLaneTree|TestSpawnStageSession|TestLaunchJudgingSession'`.

### Task 2: The plan-skill setting and the run's record of it
**Depends on:** none
**Files:** `pkg/wconfig/settingsconfig.go`, `pkg/wconfig/metaconsts.go`, `pkg/wconfig/defaultconfig/settings.json`, `schema/settings.json`, `frontend/types/gotypes.d.ts`, `pkg/waveobj/wtype.go`, `pkg/jarvis/planskill.go`, `pkg/jarvis/planskill_test.go`, `pkg/wshrpc/wshserver/wshserver_runs.go`, `pkg/wshrpc/wshserver/wshserver_dag.go`, `pkg/wshrpc/wshserver/wshserver_planskill_test.go`

Spec Decision 6, shaped by Decisions 3 and 4. Interfaces later tasks rely on, in `pkg/jarvis/planskill.go`:
- `const PlanSkill_Plan = "plan"`, `const PlanSkill_WritingPlans = "writing-plans"`
- `func NewRunPlanSkill(setting string) string`: the setting for a new run; empty or unknown is
  `PlanSkill_Plan` (unknown is logged).
- `func EffectivePlanSkill(stored string) string`: the contract a run or dag works by; empty is
  `PlanSkill_WritingPlans`, a known value is itself.
- `waveobj.Run.PlanSkill` and `waveobj.TaskGroup.PlanSkill`, both `string` with `json:"planskill,omitempty"`.

Add `RunPlanSkill string json:"run:planskill,omitempty"` to `SettingsType`, then `task generate`. CreateRun
stamps `run.PlanSkill` on engine launches only; DagSubmit copies it onto the proposed group beside
`Autonomous`. While in `wtype.go`, the `Skill` field's example comment becomes `"arc:plan"` (spec
Constraints).

Acceptance:
- `TestNewRunPlanSkill` and `TestEffectivePlanSkill` (table tests) in `pkg/jarvis`.
- In `wshserver_planskill_test.go`: an orchestrator run created with the setting unset records `plan`, with
  `writing-plans` records `writing-plans`, and a quick run records none; a submitted dag carries its run's
  value. Read the setting through a seam if CreateRun has none for config.
- `TestSettingsKeysInSync` passes (the generated files agree).

Run: `go test ./pkg/jarvis -run 'PlanSkill'`, `go test ./pkg/wshrpc/wshserver -run 'PlanSkill'`,
`go test ./pkg/wconfig -run 'TestSettingsKeysInSync|TestDefaultSettings'`.

### Task 3: The lead's plan step and plan format by plan skill
**Depends on:** Task 2 (uses `Run.PlanSkill`, `EffectivePlanSkill` and the `PlanSkill_*` constants)
**Files:** `pkg/jarvis/leadprompt.go`, `pkg/jarvis/leadprompt_test.go`, `pkg/jarvis/run.go`, `pkg/jarvis/plan.go`, `pkg/jarvis/plan_test.go`, `claude/arc-view-mod/testdata/lead-goal.txt`, `claude/arc-view-mod/testdata/lead-goal-autonomous.txt`, `claude/arc-view-mod/testdata/lead-design.txt`, `claude/arc-view-mod/testdata/lead-design-prototype.txt`

Spec Decisions 5 and 6, the "Lead plan step" and "Plan format" rows of the contract table. The plan step
and the format follow `EffectivePlanSkill(run.PlanSkill)` in both the goal prompt and the design prompt
(`writeLaunchPrompt` takes the skill, so its caller `BuildOrchestratePrompt` in `run.go` passes `run.PlanSkill`; `writePlanAndSubmit` takes it too). Add
`func PlanFormatFor(planSkill string) string`; `PlanFormatFor(PlanSkill_WritingPlans) == PlanFormat`. Keep
the arc:plan format's dropped sentence and its replacement in named constants so tests assert through
them, never through copied wording (AGENTS.md: no phrase tests).

Acceptance:
- `TestPlanFormatParses` covers both variants: each example parses with `ParsePlan`.
- A test asserts the focused-tests sentence constant is in `PlanFormatFor(PlanSkill_WritingPlans)` and
  absent from `PlanFormatFor(PlanSkill_Plan)`.
- Lead prompt tests: a run with `PlanSkill` `plan` names `arc:plan` and carries the arc:plan format; one with
  `writing-plans` or empty names `arc:writing-plans` and carries `PlanFormat`; neither names
  `superpowers:`. Both goal and design prompts.
- Regenerate the four lead fixtures with `ARC_UPDATE_VIEWMOD_FIXTURES=1 go test ./pkg/orchestrate -run
  TestViewModFixtures`, and the view mod's suite still passes on them.

Run: `go test ./pkg/jarvis -run 'TestPlanFormat|Prompt|TestPlanAuthor'`, `go test ./pkg/orchestrate -run TestViewModFixtures`,
`npx vitest run claude/arc-view-mod/hooks/prompt-core.test.ts`.

### Task 4: Worker brief, task review and plan review by plan skill
**Depends on:** Task 1, Task 2 (uses `TaskGroup.PlanSkill`, `EffectivePlanSkill` and the `PlanSkill_*` constants)
**Files:** `pkg/orchestrate/engine.go`, `pkg/orchestrate/engine_test.go`, `pkg/orchestrate/review.go`, `pkg/orchestrate/review_test.go`, `pkg/orchestrate/planreview.go`, `pkg/orchestrate/planreviewlens_test.go`, `pkg/orchestrate/planreviewround2_test.go`, `pkg/orchestrate/viewmod_fixtures_test.go`, `claude/arc-view-mod/testdata/worker-plan.txt`, `claude/arc-view-mod/testdata/reviewer-plan.txt`, `claude/arc-view-mod/hooks/prompt-core.ts`, `claude/arc-view-mod/hooks/prompt-core.test.ts`, `cmd/wsh/cmd/claude-view-mod/hooks/prompt-core.ts`

Spec Decision 5 and 6, the "Worker brief", "Task review" and "Plan review item" rows of the contract table,
all keyed on `EffectivePlanSkill(g.PlanSkill)` in `workerContract`, `reviewPrompt` and `writeChecklist`.
Under writing-plans every brief stays byte-identical to today. Keep each skill-dependent sentence a named
constant, as `planReviewChecklist` items already are. In `workerContract` three sentences switch: the
opening "Run the tests your task names" (under arc:plan: the tests you write), the "When your task says to
watch a test fail first..." sentence (under arc:plan: the seam-and-red-green rule and the ask-when-unclear
rule), and the Verify clause "Run the tests your task names alone ... even when your task says to" (under
arc:plan: run the tests you wrote alone). The arc:plan opening keeps the Check clause's shape
(``..., and `<check>`,``).

Acceptance:
- Worker brief tests: a `plan` group's brief carries the seam-and-red-green constant and the ask-when-unclear
  rule, and not the "tests your task names" text; a `writing-plans` or empty group's brief is unchanged
  (existing `engine_test.go` assertions keep passing). The Check clause still matches the mod's
  `WORKER_CHECK` for both.
- Review brief: a `plan` group's reviewer brief carries the tests-against-criteria constant; writing-plans
  does not.
- Plan review: a `plan` group's checklist carries the arc:plan item and not the "names the tests" one, and
  writing-plans the reverse, in all three briefs (full, second pass, follow-up).
- New view-mod fixtures `worker-plan` and `reviewer-plan` from a `plan` group. `WORKER_CHECK` in
  `prompt-core.ts` matches only "Run the tests your task names, and ...", so widen it to match both openings;
  it must read the Check command from both worker fixtures (a `prompt-core.test.ts` case), then
  `task sync:claudemod` and commit the copy.

Run: `go test ./pkg/orchestrate -run 'WorkerContract|TaskPrompt|ReviewPrompt|PlanReview|TestViewModFixtures'`,
`npx vitest run claude/arc-view-mod/hooks/prompt-core.test.ts`.

### Task 5: Arc's plan skills: arc:plan and the writing-plans copy
**Depends on:** none
**Files:** `skills/plan/SKILL.md`, `skills/plan/LICENSE`, `skills/writing-plans/SKILL.md`, `skills/writing-plans/LICENSE`, `skills/skills.go`, `cmd/wsh/cmd/claude-mod/skills/plan/SKILL.md`, `cmd/wsh/cmd/claude-mod/skills/plan/LICENSE`, `cmd/wsh/cmd/claude-mod/skills/writing-plans/SKILL.md`, `cmd/wsh/cmd/claude-mod/skills/writing-plans/LICENSE`, `docs/agents/claude-mods.md`

Spec Decisions 5, 6 and 7 (arc:plan serves the user's own planning too), Decisions 5, 8 and 9 above.
- `skills/plan`: adapted from to-tickets, writing the engine's plan format (`jarvis.PlanFormat` /
  `docs/orchestrator-guide.md` "The plan format") with the arc:plan task shape from the contract table. In a
  run the lead prompt gives the format and the submit; outside a run it writes the plan to
  `docs/superpowers/plans/YYYY-MM-DD-<topic>.md` for `wsh runs start --plan`. Its description makes it the
  skill for turning a spec or design into a plan.
- `skills/writing-plans`: 7.0.2's text, changed only where the plan format or this repo requires: drop the
  references to skills Arc does not ship (subagent-driven-development, executing-plans, using-git-worktrees)
  and the execution-handoff menu, since a run executes the plan. Its description says it is the alternative
  plan skill, used when a run or the user names it, so it does not compete with arc:plan.
- Add both to the `//go:embed` line in `skills/skills.go`; run `task sync:claudemod` and commit the copies;
  add both to the skill list in `docs/agents/claude-mods.md`.

Acceptance: `go test ./pkg/agentsync` passes with both seeded (the frontmatter parses);
`claude plugin validate cmd/wsh/cmd/claude-mod` passes; each `LICENSE` holds its upstream's notice. No phrase
tests on skill text.

Run: `go build ./skills && go test ./pkg/agentsync -run 'Skill'`.

### Task 6: Arc's design skill
**Depends on:** none
**Files:** `skills/brainstorm/SKILL.md`, `skills/brainstorm/LICENSE`, `cmd/wsh/cmd/claude-mod/skills/brainstorm/SKILL.md`, `cmd/wsh/cmd/claude-mod/skills/brainstorm/LICENSE`

Spec Decisions 2, 3 and 4. `skills/brainstorm/SKILL.md` stops being an overlay: no "Follow
superpowers:brainstorming", no "as superpowers does", nothing that relies on that skill being loaded. Port
from superpowers 7.0.2's brainstorming what the overlay assumed and does not restate (the flow from first
message to an approved spec), keeping Arc's protocol (the file, the lines Arc sends, the judge, the builder
check) as the body. Add the one short interview section and the size step from the spec, with the
directions-question exception; the spec rule of Decision 3 and the test rule of Decision 4. The description
triggers on any brainstorm or design inside Arc (`wsh` on PATH), still not in an agent an Arc run started.
After the design is approved, the next step it names is a run (or arc:plan), never superpowers:writing-plans.
Run `task sync:claudemod` and commit the copies.

Acceptance: `grep -n superpowers: skills/brainstorm/SKILL.md` finds nothing; `.superpowers/` and
`docs/superpowers/` paths stay. `go test ./pkg/agentsync -run Skill` passes. No phrase tests.

Run: `go test ./pkg/agentsync -run 'Skill'`.

### Task 7: Brainstorm entry points name Arc's design skill
**Depends on:** Task 4
**Files:** `pkg/jarvis/designprompt.go`, `pkg/jarvis/designprompt_test.go`, `claude/arc-view-mod/testdata/design-brainstorm.txt`, `claude/arc-view-mod/hooks/prompt-core.ts`, `claude/arc-view-mod/hooks/prompt-core.test.ts`, `cmd/wsh/cmd/claude-view-mod/hooks/prompt-core.ts`, `cmd/wsh/cmd/wshcmd-agenthook.go`, `cmd/wsh/cmd/wshcmd-agenthook_test.go`, `scripts/cdp-e2e-runs-piece4.mjs`

Spec Constraints (re-pointing), Decision 7 above. Depends on Task 4 only because both edit `prompt-core.ts`.
- `DesignSessionPrompt`'s brainstorm kind names `arc:brainstorm`; its signature stays.
- The view mod's `designSession` matcher reads the new prompt (regenerate `design-brainstorm.txt` with
  `ARC_UPDATE_VIEWMOD_FIXTURES=1`), then `task sync:claudemod` and commit the copy.
- `brainstormContextFor` keeps matching `superpowers:brainstorming` and `brainstorming`, and
  `brainstormContextText` redirects to `arc:brainstorm`; `arc:brainstorm` adds no context.
- `scripts/cdp-e2e-runs-piece4.mjs` step 1 asserts the prompt includes `superpowers:brainstorming`: make it
  assert `arc:brainstorm` instead, so no script names the upstream skill.

Acceptance:
- `TestDesignSessionPrompt` asserts the brainstorm prompt names `arc:brainstorm` and no `superpowers:`.
- The agenthook tests: the upstream names get the redirect context, `arc:brainstorm` and other skills get
  none, and a run agent gets none.
- `prompt-core.test.ts` draws the design-session card from the regenerated fixture.

Run: `go test ./pkg/jarvis -run TestDesignSessionPrompt`, `go test ./cmd/wsh/cmd -run 'TestBrainstormContextFor|TestSessionStartContext'`,
`go test ./pkg/orchestrate -run TestViewModFixtures`, `npx vitest run claude/arc-view-mod/hooks/prompt-core.test.ts`.

### Task 8: The plan-skill row on Settings
**Depends on:** Task 2 (uses the `run:planskill` key it adds to the generated settings type)
**Files:** `frontend/app/view/agents/settingsmodel.ts`, `frontend/app/view/agents/settingsmodel.test.ts`, `frontend/app/view/agents/settingssurface.tsx`, `scripts/cdp/scenarios-settings.mjs`, `scripts/cdp/scenarios.mjs`

Spec Decision 6, Decision 3 above. A row `run.planskill` in the `run` section ("Run defaults"), `key:
"run:planskill"`, `scope: "synced"`, `config: true`, rendered in `RunRouteSection` as a two-option
`Segmented` (arc:plan, writing-plans) that writes the key with `writeConfig`; the desc says it applies to new
runs. Theme tokens only (DESIGN.md).

Acceptance:
- `settingsmodel.test.ts`: the run section lists `run.planskill` on the config path.
- New CDP scenario `settings-plan-skill` in `scenarios-settings.mjs`, registered in `scenarios.mjs`, with
  steps: 1. Settings > Run defaults shows the row with both options and arc:plan selected by default;
  2. choosing writing-plans selects it and `getfullconfig` reads `run:planskill` = `writing-plans`;
  3. choosing arc:plan selects it back; a screenshot. Teardown restores the key's prior value. Run it with
  `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs settings-plan-skill` before completing.

Run: `npx vitest run frontend/app/view/agents/settingsmodel.test.ts`.

### Task 9: Docs and the flip's open issue
**Depends on:** none
**Files:** `docs/orchestrator-guide.md`, `docs/agents/brainstorm.md`, `docs/open-issues.md`

Spec Decisions 6, 7, 8, 10 and Decision 1 above. Runs beside the code: the names it documents are fixed in
this plan (setting `run:planskill`, skills `arc:plan`, `arc:writing-plans`, `arc:brainstorm`).
- `docs/orchestrator-guide.md`: every `superpowers:writing-plans` / `superpowers:brainstorming` becomes the
  setting-chosen plan skill (`arc:plan` by default, `arc:writing-plans`) or `arc:brainstorm`; the two
  contracts in a few lines where the guide describes the complete-code override; the Settings row and that a
  run keeps the skill it started with; the pi requirement drops the superpowers package.
- `docs/agents/brainstorm.md`: the agent runs `arc:brainstorm`; the hook's redirect for the upstream names.
- `docs/open-issues.md`, under Actionable: "Turn superpowers off": the user disables
  `superpowers@claude-plugins-official` and removes pi's superpowers package, and the same change deletes
  `RunWorkerOptions.NoSuperpowers` with its call sites and tests and the brainstorm hook redirect. Under Held
  until 2026-11-30: "Plan-skill bench" (spec Decisions 8 and 9: the real-run comparison and the replay bench,
  its own plan).

Acceptance: `grep -rn "superpowers:" docs/orchestrator-guide.md docs/agents/brainstorm.md` finds only text
about the upstream names the hook redirects.
