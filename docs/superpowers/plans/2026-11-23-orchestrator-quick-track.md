# Orchestrator fast track for small runs

A plan-file run of 4 tasks or fewer gets one light plan review instead of two rounds, no per-task review, and one
review of the whole merged diff in the final stage. Final and the land don't change. JSON dags, Quick runs and plans
of 5 or more tasks keep today's path.

**Spec:** `docs/superpowers/specs/2026-11-23-orchestrator-quick-track-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/orchestrate ./pkg/jarvis ./pkg/waveobj ./pkg/wshrpc/... ./cmd/wsh/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/orchestrate ./pkg/jarvis ./pkg/waveobj ./pkg/wshrpc/... ./cmd/wsh/...`
**Final:** `node scripts/cdp/final-verify.mjs plan-review-light plan-review-rounds model-picks final-stage run-sheet-polish transcript-runs`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\orchestrator-quick-track\project\Main.dc.html

## Decisions beyond the design

- **The track is a stored flag.** `TaskGroup.FastTrack` (`json:"fasttrack,omitempty"`) is set at the first plan-file
  submit when the plan has `jarvis.FastTrackMaxTasks` (4) tasks or fewer. A JSON dag never sets it. Everything
  downstream (the plan review, task states, the final stage, the label) reads that flag, never the task count, so
  fix-round tasks don't change the track. Why: the spec decides the track once at submit. A stored flag can't
  drift when a fix round adds tasks.
- **Lens key `light`, title `Light review`**, as `PlanReviewLens_Light` in Go and in the frontend's lens title map.
  The end reviewer is a stage session with role `end-reviewer` (`jarvis.UsageRole_EndReviewer`), titled `End review`.
  Its step key in the final stage is `review` (`FinalStep_Review`), titled `End review`. Task 1 lands every key and
  title on both sides, so the backend and frontend agree from the start.
- **A lost light reviewer is replaced in the same round.** When the light reviewer is lost (today's one respawn
  spent), the engine adds a fresh light reviewer row to the round, up to `MaxLightReviewers` = 3 per round. The lost
  rows stay visible. After the third loss the round settles the way a round with a lost full reviewer settles today:
  the lead gets the lost wake and resubmits the same plan, which opens a fresh light round. Why: the spec says a
  plan never dispatches without a verdict. The cap stops a broken route from spawning a session on every tick.
- **After light-review findings, the lead's resubmit dispatches.** The failed wake tells the lead to revise the plan
  file and run `wsh jarvis dag submit` again. With 4 tasks or fewer, the resubmit replaces the tasks and dispatches
  with no review. The plan review's state becomes `accepted`, with the stored marker `PlanReviewStage.Amended`
  set, and its `plan-reviewed` event carries `amended: true`. `planreview accept` also still works, to proceed on
  the plan unchanged, and leaves `Amended` unset. Reusing `accepted` keeps dispatch and the round logic as they
  are. The marker is how each surface that today says the human accepted tells the lead's amendment apart: the
  tree row, the sessions row, the lead card, `dag status`'s plan review line and the verifier's brief. A resubmit with
  more than 4 tasks clears `FastTrack` and opens a full round 1 (Full review + Second pass, no follow-up prior). If
  that round fails, the follow-up comes next, as today. Light rounds don't count toward `MaxPlanReviewRounds`; the
  engine reads which rounds were light from their reviewers' lenses, with no new field.
- **The light reviewer's pack.** Code builds it from these parts, in this order:
  - the plan's commands (Setup, Verify, Check, Final, Prototype);
  - each task's id, title and full text;
  - the edges the engine parsed (`writeDependsEdges`);
  - the spec text inline, or the prototype's path when there is no spec;
  - the contents of every file the tasks' `**Files:**` lines name (`jarvis.TaskFiles`).

  A file that doesn't exist yet is listed as new. Each file is capped at 1,000 lines and the whole pack at 5,000
  lines. Past a cap, the pack lists the path with a line saying how much was left out and that the reviewer reads
  the rest from the tree. The pack leaves out the plan's path and its header prose, so the lead's reasoning stays
  out. The caps keep the brief bounded without a token count.
- **The light checklist reuses the full checklist's own constants** (`planReviewChecklist` items and the board, Depends-reason
  and spec-gap constants), never copies of their text, for:
  - scenario steps for every UI change and every board;
  - order and Depends: the same-file item and the Depends-reason item;
  - spec contradictions;
  - Files coverage: the callers-claim item, plus one new item saying every file and caller a task changes is on
    its Files line.
- **End review wiring.**
  - **Where it lives.** It is a stage session tracked on `FinalStage.EndReview` (persisted, so a restart keeps its
    verdict) and runs on the reviewer route.
  - **Verdict.** It gives its verdict with the existing `wsh jarvis dag final pass|fail`, which the server routes to
    the end review when the caller's run id is `EndReview.RunID`. No new RPC, so no new generated client.
  - **Start.** It starts as soon as the stage's tree exists: on the landing tree when there are no commands,
    otherwise once the Tree step ends. The verifier keeps today's timing.
  - **Command failures.** A Check, Verify or Final failure still stops a verifier working alongside, but not the end
    review. The stage waits for its verdict, so every failure reaches the lead in one fix round.
  - **Failed detail.** A failed end review's findings join the stage's Detail as a block opened by `[End review] `,
    after any command or verifier detail.
  - **Lost or unverified.** A pass's `--unverified` becomes the unverified reason `end review: <note>`. Lost twice
    adds `the end review did not finish: <why>`.
  - **Event.** When it settles it records a `final-step` event with step `review`.
- **The per-task line moves to the merge.** On a fast-track dag, each task the merge lands posts the quiet line and
  caveat lines a review pass posts today. The caveats are the worker's Differs from plan, Not verified and Found not
  fixed (`leadSectionLines`). A dag that merges nothing (outside git) posts them when the task is done. For later tasks needs no
  routing at merge, because a descendant can only dispatch after the task is done, and every dispatch reads every
  done ancestor's section (`predecessorHandoff`). So the merge types nothing to running workers. The section goes
  to the lead when no unfinished task follows, as today.
- **The label reads the dag.** The run sheet shows `fast track` last on its settings line, after the approvals word,
  as an accent-tinted chip (board A). `wsh runs show` appends `  fast track` to its route line, and the run card's
  route text appends `· fast track`, both from the dag's `fasttrack`.
- **Boards.** Main (A) is the approved board. B (Timeline) and C (SettingsOnly) are the alternatives shown beside it.
  C's settings-line word is the same element as A's, so A's run-sheet step renders it. B's extra timeline row at
  submit is not in the spec and is not built. Its two lines are A's, covered by the run-sheet and run-card steps.
- **Scenarios on the full path.** `plan-review-rounds` and `model-picks` submit `models-plan.md` (3 tasks), which
  would now take the fast track. Task 2 moves both onto a 5-task fixture plan so they keep testing the two-round
  review. The new `plan-review-light` scenario uses the 3-task plan.
- **Spec changes this revision made:** the per-task "wake" on merge is today's review-pass lines (a quiet line
  and caveat lines, no wake of their own), and board B's timeline row at submit is recorded as not built, under a
  new Deviations section.
- **Only Task 1 runs `task generate`**, apart from Task 4, which may extend `FinalEndReview`; no other task touches a
  wire type.

### Task 1: Fast-track keys, titles and wire shapes
**Depends on:** none
**Files:** `pkg/waveobj/wtype.go`, `pkg/jarvis/plan.go`, `pkg/jarvis/usage.go`, `pkg/orchestrate/planreview.go`, `pkg/orchestrate/final.go`, `pkg/orchestrate/mutation.go`, `pkg/orchestrate/engine.go`, `frontend/types/gotypes.d.ts`, `frontend/app/view/agents/runtimeline.ts`, `frontend/app/view/agents/runlineage.ts`

**What to build:** the shared names every other task builds on, with no behavior change yet:
- `TaskGroup.FastTrack bool` `json:"fasttrack,omitempty"`;
- `FinalStage.EndReview *FinalEndReview` `json:"endreview,omitempty"`;
- `PlanReviewStage.Amended bool` `json:"amended,omitempty"`: the light review failed and the lead's amended
  resubmit dispatched (state `accepted`);
- the `FinalEndReview` type below;
- `jarvis.FastTrackMaxTasks = 4`;
- `jarvis.UsageRole_EndReviewer = "end-reviewer"`;
- `PlanReviewLens_Light = "light"`, titled `Light review` by `PlanReviewLensTitle`;
- `FinalStep_Review = "review"`.

Add `EndReview.RunID` (nil-safe) to the two lists of a dag's judging sessions, `childRunIDs` in `mutation.go`
(cancel, interrupted runs) and `sessionRunIDs` in `engine.go` (`cleanupScheduleFailure`), so a cancel or a failed
tick stops the end reviewer once Task 4 starts one.

Then run `task generate`. On the frontend:
- `light: "Light review"` in `PLAN_REVIEW_LENS_TITLE`;
- `review: "End review"` in `FINAL_STEP_TITLE`;
- an `end-reviewer` entry, `End reviewer started`, in the stage-session started map in `runtimeline.ts`;
- `end-reviewer: "End review"` in `STAGE_LABELS` in `runlineage.ts`.

**Interfaces:**

```go
// a fast-track dag's review of the whole merged diff, beside the final stage's commands
type FinalEndReview struct {
	State      string `json:"state"`                // reviewing | passed | failed | lost
	RunID      string `json:"runid,omitempty"`
	StartedTs  int64  `json:"startedts,omitempty"`
	Respawns   int    `json:"respawns,omitempty"`
	Text       string `json:"text,omitempty"`       // the summary, the findings, or why it was lost
	Unverified string `json:"unverified,omitempty"` // a pass's --unverified note
	Waiting    bool   `json:"waiting,omitempty"`    // the rest of the stage ended and its outcome waits on this verdict
	Judged     bool   `json:"judged,omitempty"`     // with Waiting: the verifier gave the rest of the stage its verdict
}
```

**Acceptance:**
- `PlanReviewLensTitle("light")` is `Light review`, and the frontend's `planReviewLensTitle("light")` is the same.
- `frontend/types/gotypes.d.ts` carries `fasttrack?` on `TaskGroup`, `endreview?` on `FinalStage` and the
  `FinalEndReview` type.
- `childRunIDs` and `sessionRunIDs` include a stage's `EndReview.RunID` when set, and a stage without one lists
  what it lists today.
- The Go tests and the typecheck still pass with no fast-track behavior wired.

### Task 2: Track decision at submit and the light plan review
**Depends on:** Task 1
**Files:** `pkg/orchestrate/planreview.go`, `pkg/orchestrate/planreviewlight_test.go`, `pkg/orchestrate/queue.go`, `pkg/wshrpc/wshserver/wshserver_dag.go`, `pkg/wshrpc/wshserver/wshserver_dagplanreview_test.go`, `pkg/wshrpc/wshserver/wshserver_dag_models_test.go`, `pkg/wshrpc/wshserver/wshserver_dag_test.go`, `pkg/wshrpc/wshserver/wshserver_dagplan_test.go`, `pkg/wshrpc/wshserver/wshserver_landing_test.go`, `pkg/wshrpc/wshserver/wshserver_planstart_test.go`, `pkg/jarvis/leadprompt.go`, `pkg/jarvis/leadprompt_test.go`, `cmd/wsh/cmd/wshcmd-jarvisdag.go`, `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`, `scripts/cdp/scenarios-plan-review.mjs`, `scripts/cdp/scenarios.mjs`, `scripts/cdp/fixtures/models-plan-full.md`

**What to build:** a plan-file submit of 4 tasks or fewer sets `FastTrack`, and its plan review is one light
reviewer. The reviewer runs on the Light reviewers route, or on the reviewer route with model picks on a Reviewer
picks run, and works from a code-built pack. It checks the four things the spec names. The rest follows the
decisions above:
- the replacement when a light reviewer is lost;
- the lead's resubmit dispatching after findings (state `accepted`);
- a resubmit with more than 4 tasks moving to the full review;
- light rounds not counting toward the round limit.

The failed and lost wakes on the fast track say what the lead does next: revise and resubmit, which dispatches,
or `planreview accept`.
- The amended resubmit sets `PlanReviewStage.Amended`, and the `plan-reviewed` event carries `amended: true`.
- `wsh jarvis dag submit` reports a resubmit that dispatched as landed (`dagSubmitLanded`), and `planReviewLine`
  says the lead amended the plan after the light review, not that the human accepted it.
- The lead prompt asks for the short plan inside the existing format when the plan has `jarvis.FastTrackMaxTasks`
  tasks or fewer: each task keeps its goal, Files, Depends and acceptance, scenario steps included, and no other
  prose. It also says that on the fast track a task's line arrives at merge and fix-round tasks are not reviewed.
  The design-session launch flow doesn't change.
- The existing server tests that submit a small plan file and expect the two-reviewer round now either use a plan
  of 5 or more tasks or assert the light round.
- `plan-review-rounds` and `model-picks` move to a new 5-task fixture.
- New scenario `plan-review-light`. It submits the 3-task `models-plan.md`, records a failed light verdict over RPC,
  then resubmits.

**Acceptance:**
- The first submit of a 4-task plan file sets `FastTrack`, and its round has exactly one reviewer, lens `light`.
- A 5-task plan file and a JSON dag don't set it. A JSON dag has no plan review, as today.
- The light reviewer's route is the Light reviewers route, or the reviewer route on a Reviewer picks run. Only on
  Reviewer picks does a pass need a `--pick` per task without a Model line, and off it a pick is refused.
- The light brief holds each task's text, every parsed edge, the spec text, and the contents of an existing
  Files-line path. It doesn't hold the plan's path or preamble. A file over the cap is cut with the path named.
- A light pass dispatches. A light fail wakes the lead with the findings.
- A resubmit of 4 tasks or fewer after that fail dispatches with no new round, the review reads `accepted` with
  `Amended` set, and `dag submit` reports it landed. `planreview accept` after a light fail dispatches with
  `Amended` unset.
- `planReviewLine` for an amended review differs from the one for a plain accept (an inserted-state check).
- A resubmit of 5 tasks clears `FastTrack` and opens a round with the Full review and Second pass. That round can
  still be followed by a follow-up round.
- A lost light reviewer gets a fresh light reviewer in the same round, up to 3. After the third loss the lead gets
  the lost wake, and a resubmit of the same plan opens a new light round.
- The lead prompt's short-plan instruction embeds `jarvis.FastTrackMaxTasks`.
- Scenario `plan-review-light` steps:
  - the run's graph shows one plan reviewer chip titled `Light review`;
  - the timeline's Plan reviewed row lists one reviewer, `Light review · failed`;
  - the Agent tree's plan reviewer row reads `Plan review · Light review`;
  - after the resubmit the dag leaves plan-review and t-1 dispatches.
- `plan-review-rounds` and `model-picks` still pass on the 5-task fixture.

### Task 3: Fast-track tasks skip review and report at merge
**Depends on:** Task 1 (reads the `TaskGroup.FastTrack` field it adds)
**Files:** `pkg/orchestrate/dag.go`, `pkg/orchestrate/engine.go`, `pkg/orchestrate/mergetask.go`, `pkg/orchestrate/review.go`, `pkg/orchestrate/reportsections.go`, `pkg/orchestrate/fasttracktasks_test.go`

**What to build:** on a fast-track dag, a worker that finishes with a commit goes straight to done, never to
reviewing. That includes fix-round tasks. The task then merges and runs Verify exactly as today. When a merge
lands, each task it landed gets the lines a review pass gives the lead today:
- a quiet line naming the task as merged;
- one caveat line each for Differs from plan, Not verified and Found not fixed.

The task's For later tasks goes to the lead only when no unfinished task follows it. Nothing is typed to a running
worker at merge, since every descendant reads it at dispatch. A dag with no merges (outside git) posts the lines
when the task is done. A committed fast-track task must not also get today's "finished without reporting a
commit" line. A non-fast-track dag, JSON dags included, behaves exactly as today.

**Acceptance:**
- On a fast-track dag, a worker run done with a commit leaves its task `done`, not `reviewing`, and a fix-round
  task the same.
- Without `FastTrack` the same worker still enters review.
- The merge of a fast-track task posts one quiet line for it and one caveat line per non-empty section among
  Differs from plan, Not verified and Found not fixed.
- A lane merge that lands two tasks posts the lines for both.
- A task with For later tasks and no unfinished descendant hands the section to the lead. With an unfinished
  descendant it is not typed to anyone, and that descendant's dispatch prompt carries it (`predecessorHandoff`).
- A committed fast-track task gets no "finished without reporting a commit" line. A worker with no commit still
  gets it.
- A landed fast-track task's worker Not verified is among the final stage's caveats (`taskCaveats`), as a reviewed
  task's is.

### Task 4: The end review in the final stage
**Depends on:** Task 1 (uses `FinalEndReview`, `FinalStep_Review` and `jarvis.UsageRole_EndReviewer`)
**Files:** `pkg/orchestrate/final.go`, `pkg/orchestrate/verifier.go`, `pkg/orchestrate/endreview.go`, `pkg/orchestrate/endreview_test.go`, `pkg/orchestrate/final_test.go`, `pkg/orchestrate/finalalongside_test.go`, `pkg/wshrpc/wshserver/wshserver_resmon.go`, `pkg/waveobj/wtype.go`, `frontend/types/gotypes.d.ts`

**What to build:** on a fast-track dag, every final round runs one end reviewer next to Check, Verify and Final,
following the "End review wiring" decision above.

Its brief covers:
- the spec and plan paths;
- `git diff <base>..<head>` of the whole run;
- for each task: its id, title, goal and Files line, the paths its lane's merged commit changes that the lane's
  Files lines don't list (`unlistedFiles` over the union), and its Differs from plan and Not verified sections;
- every task's goalpost findings (`goalpostsForTask`), each to be judged by name;
- in a fix round, the fix tasks, as the verifier lists them.

It looks for:
- real bugs;
- weak or missing tests;
- acceptance criteria not met or not proved;
- edits outside a task's files;
- mismatches with the design.

It runs none of the plan's commands, apart from one named test to settle a doubt, and ends with
`wsh jarvis dag final pass|fail`.

The stage ends only once the commands, the verifier (when it runs) and the end review have all settled. Waiting on
the end review is kept on `EndReview.Waiting`/`Judged`, not in the stage's state names. A failure from any of them
fails the stage once, with every detail, through today's failed wake. `End final stage` stops the end review.
`Rerun final stage` and the next fix round start a fresh one. On a fast-track dag whose plan review is `accepted`
with `Amended` set, the verifier's brief says the lead amended the plan after the light review, not that the human
proceeded. A plain accept keeps today's text. The
resource monitor names the end reviewer's session. Without `FastTrack` the stage is exactly today's, and
`EndReview` stays nil.

**Interfaces:** `RecordFinalVerdict(ctx, dagID, callerRunID, verdict, text, unverified)` keeps its signature. A
caller whose run id is the round's `EndReview.RunID` records the end review's verdict; any other caller is judged
as the verifier, as today.

**Acceptance:**
- A fast-track round starts an end-reviewer session (StageRole `end-reviewer`, reviewer route) once its tree exists,
  while Check runs. With a Final line the verifier still starts only after Final.
- A Check failure stops the alongside verifier but not the end review. The stage stays non-terminal until the end
  review's verdict. On a failed end review the stage fails with Detail holding the command's failure, then a
  blank line, then `[End review] <findings>`.
- With every command passing:
  - an end review fail fails the stage, and the lead's failed wake carries the findings;
  - an end review pass with the verifier's pass ends the stage passed;
  - a pass with `--unverified` ends it unverified, with reason `end review: <note>`.
- An end review verdict given before the commands finish is persisted, and the stage settles on it after they
  finish. Restarting the server mid-stage keeps a recorded verdict.
- An end reviewer lost twice adds `the end review did not finish: <why>`, and the stage settles without it.
- The end review settling records a `final-step` run event with step `review`, its round, `ms` and `ok`.
- `EndFinalStage` stops the end reviewer. `RerunFinalStage` and a fix round's next stage run a new end review.
- The verifier's brief for an `Amended` review differs from the one for a plain accept (an inserted-state check).
- The brief lists a goalpost finding recorded on a task, and an unlisted path from a task's merged commit (an
  inserted-value check, no wording assertions).
- A non-fast-track dag's final stage never starts an end reviewer, and today's final tests pass unchanged.

### Task 5: The fast track label
**Depends on:** Task 1 (reads `fasttrack` from the generated `TaskGroup` type)
**Files:** `frontend/app/view/jarvis/briefrunsheet.tsx`, `frontend/app/view/agents/runscards.ts`, `frontend/app/view/agents/runscards.test.ts`, `cmd/wsh/cmd/wshcmd-runs.go`, `cmd/wsh/cmd/wshcmd-runs_test.go`, `scripts/cdp/scenarios-runs.mjs`, `scripts/cdp/scenarios-transcript-runs.mjs`

**What to build:** the words `fast track` wherever `autonomous` shows, for a run whose dag has `fasttrack`:
- **Run sheet.** Last on the settings line, after the approvals word and before `adjust`. It is a chip tinted as a
  mode (accent-soft text, accent-tinted border and background) as board A draws it, using existing `@theme` tokens
  only (read `DESIGN.md`). It carries a `data-jarvis-brief-sheet-fasttrack` attribute.
- **`wsh runs show`.** The route line ends with `  fast track`, read from the status reply's group.
- **Run card in a transcript.** The route text ends with `· fast track`, read from the source's group
  (`claude opus · fast track`).

The card's token bar also gets an `end-reviewer` entry in `ROLE_STYLE`, labelled `end reviewer`. A run without a
dag, or with `fasttrack` unset, shows none of these.

**Acceptance:**
- `runsShowLines` puts `fast track` in the route line for a digest whose group has `FastTrack`, and leaves it out
  otherwise.
- The run card model's route text is `claude opus · fast track` for an opus claude run with a fast-track group, and
  `claude opus · autonomous · fast track` when the run is also autonomous.
- Scenario `run-sheet-polish`: a new step seeds `fasttrack: true` on its dag and shows `fast track` as the last
  item before `adjust` on the run sheet's settings line, then a screenshot.
- Scenario `transcript-runs`: the runs-show fixture's group carries `fasttrack: true`, and a step shows the card's
  route line ending `fast track`, then a screenshot.

### Task 6: The end review in the final stage views, and the amended plan review's wording
**Depends on:** Task 1 (uses the `FinalEndReview` type, `PlanReviewStage.Amended` and the `End review` titles it adds), Task 2 (adds a step to its `plan-review-light` scenario)
**Files:** `frontend/app/view/agents/finalstage.ts`, `frontend/app/view/agents/finalstage.test.ts`, `frontend/app/view/agents/finalstageviews.tsx`, `frontend/app/view/agents/agenttreemodel.ts`, `frontend/app/view/agents/agenttreemodel.test.ts`, `frontend/app/view/agents/sessionsruns.ts`, `frontend/app/view/agents/leadcardmodel.ts`, `frontend/app/view/agents/leadcardmodel.test.ts`, `scripts/cdp/scenarios-final.mjs`, `scripts/cdp/scenarios-plan-review.mjs`

**What to build:** when the stage carries `endreview`, the final stage's step model (`finalStageView`, used by the
pane, the rail, the DAG peek and the tree row) gets an `End review` step before the verifier. Its state comes from
`endreview.state`: lost reads as failed, and reviewing reads as running.
- **Beside a command.** While it reviews next to a running command, the subline and activity say so, the way
  `verifier alongside` does.
- **Waiting.** While the stage waits only on it, the headline names the end review.
- **Failure attribution.** A Detail whose only failure is the end review's leaves the verifier's and the commands'
  steps unfailed, and marks the End review step failed.
- **Tree row.** An `end-reviewer` stage session gets its outcome from `endreview.state` when its run id matches, and
  counts as a stage session in the session lists (`STAGE_ROLES`).

A stage without `endreview` draws exactly as today.

An `accepted` plan review with `amended` set reads as the lead's amendment, never `accepted by you`, in the tree
row's verdict text (`STAGE_VERDICT_TEXT`/`stageOutcome`), the sessions row (`sessionsruns.ts`) and the lead card
(`leadcardmodel.ts`). A plain accept keeps `accepted by you`.

**Acceptance:**
- `finalStageView` for a checking stage with a running Verify and a reviewing end review lists `End review` as
  running, and its subline names the end review alongside.
- For a stage whose detail is only `[End review] …`, `End review` is failed and the verifier's step is not.
- For a stage with no `endreview`, the steps are today's.
- `stageOutcome` for an `end-reviewer` session whose run id matches a passed end review is `passed`.
- Scenario `final-stage`: a new step seeds `endreview: {state: "reviewing"}` on the stage while Verify runs. It
  shows the End review step running in the Final verification pane's step list, with the row's activity naming the
  end review alongside, then a screenshot. A second seeded step with `state: "failed"` and a `[End review]` detail
  shows that step failed and the verifier's step not failed, then a screenshot. The seeded dag keeps `fasttrack`
  unset, so the engine leaves the seeded end review alone.
- An amended review's tree, sessions and lead-card text is not `accepted by you`, and a plain accept's still is.
- Scenario `plan-review-light`: a new step after the resubmit shows the Agent tree's light reviewer row with the
  amendment's text, not `accepted by you`, then a screenshot.

### Task 7: Document the fast track
**Depends on:** Task 2 (documents the light review it builds), Task 3 (documents the review-free tasks and merge lines), Task 4 (documents the end review), Task 5 (documents the fast track label), Task 6 (documents the End review step and the amended wording)
**Files:** `docs/orchestrator-guide.md`

**What to build:** the guide describes the fast track as built, in the sections it changes:
- **The plan review:** which runs take the light review, its brief and checks, picks, a lost reviewer, and a
  resubmit after findings.
- **A task's review:** no per-task review on the fast track, and the lines that come at merge.
- **The final stage:** the end review beside the commands, its verdict, failure detail, unverified reasons, rerun
  and fix rounds.
- **Watching a run:** the Light review row, the End review step, and the `fast track` label.

Read the merged code for the exact values (the caps, `MaxLightReviewers`, the detail prefix), not this plan.

**Acceptance:**
- Each of the four sections states the fast-track behavior with the values in the code.
- No section still says every plan-file run gets two round-1 reviewers or that every task is reviewed.
