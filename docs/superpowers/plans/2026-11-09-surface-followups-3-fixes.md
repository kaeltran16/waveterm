# Surface review follow-ups, round 3: code fixes

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix F1-F8 of the round-3 surface review follow-ups: the Diff poll's session start, earlier plan-review
rounds in the Agent tree, the brainstorm review's narrow rows, wstore lint, the final stage's outcome event, the
Brief composer's lead name, and two scenario steps that do not prove what they claim.

**Architecture:** Nine tasks, one per finding area (F2 split into its Go half and its frontend half), each owning
its files and its scenario file so all but two run side by side. Pure logic goes in a `.ts` beside its test; each
UI change is proven by a step in an existing scenario, run at the width where it was broken. The two Go changes
are a new optional field on the plan-review stage (F2) and a new run event kind recorded from the one place the
final stage's outcome is decided (F5).

**Tech Stack:** Go (orchestrate, waveobj, wstore), React 19 + jotai, vitest, CDP scenarios (`scripts/cdp`).

**Effort:** effort:fdea6d43-219b-4cf2-b4ce-51758338103b
**Spec:** `docs/superpowers/specs/2026-11-09-surface-followups-3-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/orchestrate ./pkg/waveobj ./pkg/wstore`
**Check:** `go vet ./pkg/orchestrate ./pkg/waveobj ./pkg/wstore && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs diff-scope agent-tree-rail brainstorm-check-review cockpit-rail-help brief-composer-steer-only sessions-list-states`

## Global Constraints

- **Never attach to CDP :9222 and never run `task verify:ui` against the default port**: another session may be
  driving that app. See your scenario only in an isolated app:
  `ARC_FINAL_OUT=<a new temp dir> node scripts/cdp/final-verify.mjs <scenario...>` (its own ports, store and
  WebView2 profile; it waits for a lock if another worker holds it).
- Logic is extracted, not rendered: pure `foo.ts` + `foo.test.ts`, thin `.tsx`.
- Colors and spacing from the `@theme` tokens in `frontend/tailwindsetup.css` only; no new tokens.
- Never lower an existing step's bar; add lettered sub-steps (e.g. `19b`) rather than renumbering steps other
  scenarios or docs cite.
- Lint/format only the files you touched; keep prettier off `scripts/*.mjs`.
- Never stop `wave-tauri.exe` / `wavesrv.x64.exe` by image name; never touch the user's packaged Arc.
- After changing a waveobj type, run `task generate` and commit the generated files with it.
- `tsconfig.json` is `strict: false`: narrow ok-unions with `"reason" in result`.

## Review Focus

- F1: a session whose start never resolves must poll exactly as today (`ref: ""`, no error, no selection change);
  Task 4's test pins it.
- F2: a run with one plan-review round must render its reviewer rows exactly as today (no round label), so every
  existing agent-tree-rail and lead-card step stays valid; Task 3's test pins it. A dag stored before
  `pastrounds` existed (field absent) must read as one round.
- F2: the lead card's "newest reviewer ended" check (`leadcardmodel.ts`) keeps reading only the current round;
  Task 3 must not change `endedPlanReviewers`' meaning.
- F5: a final stage ended by the human (`EndFinalStage`) records the event too, and a rerun's new round records
  its own; Task 7's tests pin both. `final-step`'s rail mapping stays as it is.
- F6: a run with no dag keeps naming its lead by the tab name, and a send that throws gives the draft back; Task 8 pins both.

---

### Task 1: Plan review keeps earlier rounds' reviewers on the dag
**Depends on:** none
**Files:** `pkg/waveobj/wtype.go`, `pkg/orchestrate/planreview.go`, `pkg/orchestrate/planreviewround2_test.go`, `frontend/types/gotypes.d.ts`

Spec D2 (Go half).

- [ ] Write the failing test in `planreviewround2_test.go`, `TestResubmitKeepsPastRoundReviewers`: a dag in round 1
  whose review failed with two reviewers (lens, state, runid, text set) is resubmitted with
  `ReplacePlanReviewProposal`; the new stage is round 2 with no `Reviewers`, and `PastRounds` is
  `[{Round: 1, Reviewers: <round 1's two, unchanged>}]`. If the round cap allows a third round in any mode, add a
  case that a second resubmit appends round 2 after round 1; otherwise assert nothing more.
- [ ] Run `go test ./pkg/orchestrate -run '^TestResubmitKeepsPastRoundReviewers$'`: fails to compile (no field).
- [ ] Add to `waveobj.PlanReviewStage`: `PastRounds []PlanReviewRound \`json:"pastrounds,omitempty"\`` (comment:
  earlier rounds' reviewers, oldest first), and the type `PlanReviewRound { Round int \`json:"round"\`; Reviewers
  []PlanReviewer \`json:"reviewers,omitempty"\` }`.
- [ ] In `ReplacePlanReviewProposal`, the new stage carries `append(pr.PastRounds, PlanReviewRound{pr.Round,
  pr.Reviewers})` (copy the slice, do not alias the old stage's). Leave the engine's loops over `Reviewers` as
  they are: past rounds' reviewers have all ended.
- [ ] Run the test again: passes. Run `task generate`; `frontend/types/gotypes.d.ts` gains `pastrounds` and
  `PlanReviewRound`.

### Task 2: agent-tree-rail step 9b waits for the tree to settle
**Depends on:** none
**Chunk:** agent-tree-rail step 9b: after it injects t-1's worker tab, the shot agent-tree-rail-p12-worker-header.png shows t-1's 'noop · 2 queued' row overlapping the 'wave asker' row (likely mid layout animation); no step asserts tree layout there. From run c91b87e8.
**Files:** `scripts/cdp/scenarios-agent.mjs`, `frontend/app/view/agents/agenttree.tsx`

Spec D7.

- [ ] In the isolated app, run `agent-tree-rail` with a temporary probe after step 9b's inject: sample every tree
  row's `getBoundingClientRect()` (rows of the tree container the scenario already scopes to) every 100 ms for 2 s.
  Record whether t-1's worker row and the "wave asker" row overlap, and whether the samples stop changing.
- [ ] If it settles: before the shot, wait (bounded, ~3 s, the step fails on timeout) until two consecutive
  samples 150 ms apart are equal. If it does not settle: fix the layout in `agenttree.tsx` (the row's layout /
  exit animation that leaves rows stacked) so it does, then keep the same wait.
- [ ] Add step `9c. after t-1's worker tab is added, the tree settles and no two tree rows overlap`, asserting no
  pair of row rects intersects by more than 1px vertically, with the sampled rects as detail.
- [ ] Remove the temporary probe. Run `agent-tree-rail` in the isolated app: 9b and 9c pass, and the shot shows
  no overlap. In the completion note say which case it was, with the measured samples.

### Task 3: The Agent tree lists every plan-review round's reviewers
**Depends on:** Task 1 (uses `PlanReviewStage.pastrounds` from the generated `gotypes.d.ts`), Task 2
**Chunk:** Agent tree lists finished plan reviewers only for the current plan-review round (built from dag.planreview.reviewers); earlier rounds' reviewers drop out after a resubmit because the dag keeps only the current round. From run 0432111d.
**Files:** `frontend/app/view/agents/runlineage.ts`, `frontend/app/view/agents/runlineage.test.ts`, `frontend/app/view/agents/agenttreemodel.ts`, `frontend/app/view/agents/agenttreemodel.test.ts`, `frontend/app/view/agents/agenttree.tsx`, `scripts/cdp/scenarios-agent.mjs`

Spec D2 (frontend half).

- [ ] Write failing tests. `runlineage.test.ts`: `planReviewerOf` finds a past round's reviewer and returns its
  `round` and verdict; `endedRoles` and `endedReviewerOf` cover a past round's ended reviewer; `endedPlanReviewers`
  still returns only the current round. `agenttreemodel.test.ts`: a dag with `pastrounds: [{round: 1, reviewers:
  [full failed, second failed]}]` and round 2 passed with `[followup passed]` lists, in the open done fold, round 1's
  two stage rows then round 2's, each row with `round` set (1, 1, 2), and the done row's `planReviews` is 3; a
  one-round dag's stage rows have no `round`; a dag without `pastrounds` reads as one round.
- [ ] Run `npx vitest run frontend/app/view/agents/runlineage.test.ts frontend/app/view/agents/agenttreemodel.test.ts`: the new cases fail.
- [ ] `runlineage.ts`: add `allEndedPlanReviewers(run): { reviewer: PlanReviewer; round: number }[]`, every round's
  reviewers with a verdict and a run id, oldest round first. `endedRoles` and `endedReviewerOf` use it.
  `planReviewerOf(review, runId)` also searches `review.pastrounds` and returns `{ lens, verdict, round }`.
- [ ] `agenttreemodel.ts`: ended reviewers come from `allEndedPlanReviewers`; the stage row type gains
  `round?: number`, set only when the run's plan review had more than one round; finished plan-reviewer rows sort
  by round (oldest first), replacing `stageRank`'s "earlier round has no lens" rule, whose comment you update.
  `stageOutcome` looks the reviewer up before its blanket `accepted`: a past round's reviewer reads its own
  verdict (passed or failed), also in an accepted run; only the current round's reviewers read `accepted`. Add an
  `agenttreemodel.test.ts` case for that: an accepted round-2 review with a failed round-1 reviewer lists it as
  failed, round 1, before the round-2 rows.
- [ ] `agenttree.tsx`: a stage row with `round` labels `Plan reviewer · <lens title> · round N`.
- [ ] Run the tests again: pass.
- [ ] `agent-tree-rail` (`scenarios-agent.mjs`): add a step (lettered after the scenario's existing plan-reviewer
  steps, at the scenario's wide width) that seeds the fixture dag's `planreview` with a round-1 `pastrounds` entry
  of two ended reviewers and a current round 2 reviewer, opens the run's done fold, and asserts both rounds' rows
  are listed in round order with their `round 1` / `round 2` labels; restore the fixture after. Run it in the
  isolated app: passes.

### Task 4: The Diff poll re-resolves an unresolved session start
**Depends on:** none
**Chunk:** Diff: the 10 s poll never re-resolves an agent's session start, so a scope opened before the first transcript write stays measured from HEAD until the agent's diff is reopened (spec F10 known limit)
**Files:** `frontend/app/view/agents/diffscope.ts`, `frontend/app/view/agents/diffscope.test.ts`, `frontend/app/view/agents/filesstore.ts`, `frontend/app/view/agents/filesstore.test.ts`, `scripts/cdp/scenarios-files-scope.mjs`

Spec D1.

- [ ] Write failing tests. `diffscope.test.ts`, for `pollAnchor(range: DiffRange, resolvedRef: string, end: string,
  sessionStartTs: number | null): { ref: string; end: string } | { sessionStartTs: number }`: a session range with
  `resolvedRef ""` and a start `1700000000` returns `{ sessionStartTs: 1700000000 }`; with a start `null` returns
  `{ ref: "", end: "" }`; a session range with a resolved ref returns `{ ref, end }` whatever the start; run,
  working and compare ranges return `{ ref, end }`. `filesstore.test.ts`: after a session-range load whose start
  did not resolve, a `reloadChanges` once the transcript head carries a timestamp calls `GitChangesCommand` with
  `sessionstartts` and leaves `filesSelectedPathAtom` unchanged; while the head still has no timestamp, it sends
  no `sessionstartts` and `ref` stays `""`.
- [ ] Run `npx vitest run frontend/app/view/agents/diffscope.test.ts frontend/app/view/agents/filesstore.test.ts`: the new cases fail.
- [ ] Add `pollAnchor` to `diffscope.ts`. In `filesstore.ts`, keep the last load's `DiffScope` range and
  `ScopeAgent` beside `current`; `reloadChanges` asks `ensureSessionStart` only when the range is a session and
  the state's `ref` is `""`, and passes `pollAnchor`'s answer to `loadChangesForCwd` as a refresh
  (`isInitial: false`).
- [ ] Run the tests again: pass.
- [ ] `diff-scope` (`scenarios-files-scope.mjs`): add step `19b` after step 19 (the agent with no session start):
  append a JSON line with an ISO `timestamp` to that agent's fixture transcript, wait up to
  `FILES_POLL_MS + 5000` without reopening the scope, and assert the summary no longer contains "(no session start
  yet)" and reads "worktree against " followed by a short sha. Steps 20-21 must still pass after it (restore the
  transcript if they depend on it). Run `diff-scope` in the isolated app at its default 1600 width: passes.

### Task 5: Brainstorm review changed rows keep a readable gist at 1000px
**Depends on:** none
**Chunk:** Brainstorm review changed rows cramp at 1000px wide: the Constraints row's gist wraps one word per line beside Keep the change / Put mine back (brainstormreview.tsx; seen in brainstorm-check-review-narrow.png)
**Files:** `frontend/app/view/agents/brainstormreview.tsx`, `scripts/cdp/scenarios-brainstorm-review.mjs`

Spec D3.

- [ ] `brainstorm-check-review`: add step `1e` that, at `CR_NARROW` (1000x700) and again at the wide override,
  reads the Constraints row's `[data-brainstorm-gist]` width and line count and the Keep the change button's rect.
  Assert at 1000: the gist is at least 240px wide (or the readable minimum you measure at 1600, if smaller) and its
  text has fewer lines than words; at 1600: the buttons sit beside the gist (button top within the gist's first
  line box). Shoot `brainstorm-check-review-narrow-row.png` at 1000.
- [ ] Run it in the isolated app: 1e fails at 1000.
- [ ] In `brainstormreview.tsx`, when the review is narrow, the keep-restore and confirm actions move onto a second
  grid line under the gist (spanning the gist's column), decided by the review's own width (Tailwind container
  query on the review's container), not the window's. At wide widths the row is unchanged.
- [ ] Run the scenario again: 1c, 1d and 1e pass, and the shot shows the buttons under a readable gist.

### Task 6: pkg/wstore lint leftovers
**Depends on:** none
**Chunk:** pkg/wstore lint leftovers: unused viewRe (wstore_dbops.go), fmtappendf (wstore_contract_test.go), infertypeargs (wstore_dag.go)
**Files:** `pkg/wstore/wstore_dbops.go`, `pkg/wstore/wstore_contract_test.go`, `pkg/wstore/wstore_dag.go`

Spec D4.

- [ ] Delete the unused `viewRe` (and the `regexp` import if nothing else uses it) in `wstore_dbops.go`.
- [ ] `wstore_contract_test.go:32`: `fmt.Appendf(nil, ...)` in place of `[]byte(fmt.Sprintf(...))`.
- [ ] `wstore_dag.go:56`: drop the inferable type argument of `DBUpdateFnErr`.
- [ ] `gopls check pkg/wstore/wstore_dbops.go pkg/wstore/wstore_dag.go pkg/wstore/wstore_contract_test.go` prints
  none of the three; `go vet ./pkg/wstore` is clean; `go test ./pkg/wstore` passes.

### Task 7: A stage-end run event carries the final stage's outcome
**Depends on:** none
**Chunk:** Events rail cannot show the final stage's outcome: no run event records the verifier's verdict (final-step carries only round/step/ms/ok), so the rail says 'Final command passed', never 'final verification passed' or unverified (spec D6). Needs a stage-end event in pkg/orchestrate/final.go and its timeline/record readers. From run c91b87e8.
**Files:** `pkg/waveobj/runevent.go`, `pkg/orchestrate/final.go`, `pkg/orchestrate/final_test.go`, `frontend/app/view/agents/cockpitevents.ts`, `frontend/app/view/agents/cockpitevents.test.ts`, `frontend/app/view/agents/runtimeline.ts`, `frontend/app/view/agents/runtimeline.test.ts`, `frontend/app/view/orchestrate/timelinegroups.ts`, `frontend/app/view/orchestrate/timelinegroups.test.ts`, `frontend/app/view/orchestrate/peeklifecycle.ts`, `frontend/app/view/orchestrate/peeklifecycle.test.ts`, `frontend/app/view/orchestrate/dagdigest.ts`, `frontend/app/view/orchestrate/dagdigest.test.ts`, `scripts/cdp/scenarios-cockpit-rail.mjs`

Spec D5.

- [ ] Write failing Go tests in `final_test.go`: `TestFinalEndedEventRecordsOutcome` drives a stage to passed, to
  unverified (a flaky item or no Verify) and to failed (a Detail), and asserts exactly one `final-ended` run event
  per stage with `{"round": <round>, "outcome": "passed" | "unverified" | "failed"}`;
  `TestEndFinalStageRecordsFinalEnded`: `EndFinalStage(..., "unverified", "reason")` records one with outcome
  `unverified`.
- [ ] Run `go test ./pkg/orchestrate -run '^(TestFinalEndedEventRecordsOutcome|TestEndFinalStageRecordsFinalEnded)$'`: fail.
- [ ] Add `RunEventKindFinalEnded = "final-ended"` to `runevent.go` with its detail documented beside
  `final-step`. In `finishFinal`, after the outcome is decided, queue on `afterCommit` an `appendRunEvent` of that
  kind with `round` and `outcome`, for every outcome (before the early return for non-failed).
- [ ] Run the Go tests again: pass.
- [ ] Write failing TS tests: `cockpitevents.test.ts`: `final-ended` passed -> `["finished", "final verification
  passed"]`, unverified -> `["finished", "final stage unverified"]`, failed -> `["failed", "final verification
  failed"]`; the existing `final-step` cases unchanged. For each reader that lists or describes run event kinds
  (`runtimeline.ts`, `timelinegroups.ts`, `peeklifecycle.ts`' final-stage kinds, `dagdigest.ts`' kind list), a case
  that `final-ended` is read and described with the same words.
- [ ] Implement the mapping in `runRailKind` and the readers; update `runRailKind`'s doc comment (the verdict now
  records an event). Run `npx vitest run` on the five test files: pass.
- [ ] `cockpit-rail-help` (`scenarios-cockpit-rail.mjs`): add `final-ended` fixture events (passed, and unverified on
  a second fixture or a later step) beside the existing `fx-rail-help-fs`, and a step asserting the rail shows
  "final verification passed" and "final stage unverified". Run it in the isolated app: passes.

### Task 8: The Brief composer names a run's lead by its plan title
**Depends on:** none
**Chunk:** Brief composer names a run's lead by its tab name: briefcomposertarget.ts workerName/sessionName use lead.name, seen in the 'is no longer live' error; elsewhere a dag'd lead goes by run.title through leadDisplayName (D12). From run c91b87e8.
**Files:** `frontend/app/view/jarvis/briefcomposertarget.ts`, `frontend/app/view/jarvis/briefcomposertarget.test.ts`, `frontend/app/view/jarvis/briefcomposer.tsx`, `frontend/app/cockpit/actions/run.ts`, `frontend/app/cockpit/actions/run.test.ts`, `scripts/cdp/scenarios-brief.mjs`

Spec D6.

- [ ] Write failing tests. `briefcomposertarget.test.ts`: with `info: { title: "Plan title", dag: <a dag> }` the
  target's `workerName` is `"Plan title"`; with no dag it is the lead's tab name; `sessionName` still prefers the
  project name, else the same display name. `run.test.ts`: the "Message the lead" action's error for a send that
  does not land names the plan title for a dag'd run.
- [ ] Run `npx vitest run frontend/app/view/jarvis/briefcomposertarget.test.ts frontend/app/cockpit/actions/run.test.ts`: fail.
- [ ] `BriefTargetInput` gains `info?: Pick<RunInfo, "title" | "dag">`; `resolveBriefComposerTarget` names the lead
  with `leadDisplayName(lead, input.info)`. `briefcomposer.tsx` reads `runInfoAtom(run.id)`, whose value is
  `RunInfoRead { run, loaded }`, and passes its `.run`. `cockpit/actions/run.ts` builds its error with
  `leadDisplayName(t.steerLead, t.info)`.
- [ ] `briefcomposer.tsx`'s send: a `steerWorker` that throws (a lead whose terminal is gone makes `sendAgentText`
  throw; `fireAndForget` drops it today, eating the draft) is treated as not sent: `console.error` the error with
  the lead's name, restore the draft, and show the same "<workerName> is no longer live — nothing was sent."
  status. Keep the existing `!sent` branch.
- [ ] Run the tests again: pass.
- [ ] `brief-composer-steer-only` (`scenarios-brief.mjs`) has no fixture run today: seed one with the shared
  run-fixture helpers in `scenarios-shared.mjs` (`docs/reference/cdp-run-fixtures.md`): a dag'd run with a plan
  title, and a devMock lead whose tab name differs from that title, whose run id is the run's, and whose blockId is
  a bogus id. Add a step that opens the run's sheet, types a message, sends, and asserts the status reads
  "<plan title> is no longer live — nothing was sent.", does not contain the tab name, and the draft is back in
  the composer. Tear the fixture down after. Run it in the isolated app: passes.

### Task 9: sessions-list-states waits on the archive's loaded state
**Depends on:** none
**Chunk:** sessions-list-states idle-archive step passes while the real archive is still loading after its 60 s wait (2218 sessions seen), so it does not prove the archive finished. From run c91b87e8 (t-10).
**Files:** `scripts/cdp/scenarios-sessions-list-states.mjs`

Spec D8.

- [ ] In the isolated app, measure how long the real archive takes to reach `complete` from the scenario's start
  (log `archive.waitedMs` and the session count); run twice.
- [ ] Set `ARCHIVE_WAIT_MS` to the larger measurement with at least 50% margin. Before the idle step, record a step
  "the real archive finished loading within <N> s" that fails when `archive.complete` is false, with
  `{ waitedMs, sessions }` as detail; assert the idle-archive budget only when it loaded (otherwise record the idle
  step failed with "archive not loaded").
- [ ] Run `sessions-list-states` in the isolated app: both steps pass. Report the measured times; if the archive
  needed more than ~3 minutes, report it as an open issue instead of raising the timeout further.
