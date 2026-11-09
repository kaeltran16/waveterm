# Live-run states phase 3 fixes (Q1-Q19) Implementation Plan

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 19 findings of the live-run phase 3 review: forwarded failures become the human's on the card, the
merge gate reads the same everywhere and offers nothing while held, the human's own actions leave run events, Rerun
answers the lead's open question, and twelve label fixes.

**Architecture:** One small interface task lands the wire fields, the run event kinds and the shared frontend helpers
(`mergeGateLine`, `verifyFailLine`); two Go tasks (digest/merge gate; actions/final/wake/detail) and the card and tree
tasks build on it side by side, while the events, initiative and doc review tasks start at once. The Hub/DAG-peek/
stage-pane task runs last: it shares `scripts/cdp/scenarios-runs.mjs` with the card task and reads the events task's
titles.

**Tech Stack:** Go (pkg/orchestrate, pkg/jarvis, wshrpc), React 19 + jotai + Tailwind 4, vitest, CDP scenarios.

**Spec:** `docs/superpowers/specs/2026-11-09-live-run-phase3-fixes-design.md` (decisions D1-D19, one per finding).
**Verify:** `node scripts/verify.mjs ./pkg/orchestrate ./pkg/wshrpc/wshserver ./pkg/jarvis ./pkg/waveobj ./cmd/wsh/cmd`
**Check:** `go vet ./pkg/orchestrate ./pkg/wshrpc/... ./pkg/jarvis ./pkg/waveobj ./cmd/wsh/cmd && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs lead-card-merge-gate agent-tree-rail cockpit-rail-help run-sheet-polish dag-peek brief-live-initiative doc-review`

## Global Constraints

- **CDP port:** never attach to CDP :9222 and never run `task verify:ui` against the default port. See your
  scenarios only in an isolated app: `ARC_FINAL_OUT=<a new temp dir> node scripts/cdp/final-verify.mjs <scenario...>`.
- **Existing steps:** never lower an existing step's bar. Extend a step or add a lettered sub-step or the next number;
  never renumber.
- **Fixtures:** held runs and page-only injections as `scripts/cdp/live-run-fixture.mjs` does (digest fields and run
  events no RPC writes); `docs/reference/cdp-run-fixtures.md` is the recipe. `arrangeLiveRuns` and run A's default
  digest stay as they are: `agent-tree-rail` and `cockpit-roster-counts` arrange them too. Any new injection is
  opt-in, called only by the step that needs it, and teardown removes only what a step added.
- **Width:** each UI step runs at the width its decision names (1600x950 unless it says 1000x700).
- **Tokens:** colors come from the `@theme` tokens in `frontend/tailwindsetup.css` only. No new tokens.
- **Parallel run 5195e068** edits `final.go` (`finishFinal`), `runevent.go`, `cockpitevents.ts` (`runRailKind`),
  `runtimeline.ts`, `peeklifecycle.ts`, `timelinegroups.ts` and `scenarios-cockpit-rail.mjs` (P6b) for its
  `final-ended` event. Do not add a final-stage outcome event or map `final-ended`; keep your hunks away from
  `finishFinal`.
- **Generated files:** after a wshrpc type change run `task generate`; never hand-edit `frontend/types/gotypes.d.ts`.

## Review Focus

- A task forwarded, then retried by the human and failed again: the new failure is the lead's again (no
  `forwardedts`) until the lead forwards it once more. Task 2 tests it.
- A forward of a worker's question (a `task-forwarded` row with an `askid`) never marks a failure as forwarded.
  Task 2 tests it.
- A held tip whose holder's Verify passes reads `ready` again on the next digest, with `merge` back in its actions.
  Task 2 tests it.
- Rerun while the lead has no pending question still wakes the lead exactly once, as today; a delivery that fails
  later also wakes it once. Task 3 tests both.
- A card refusal for one task stays while that task is unchanged, even when another task's row changes. Task 4
  tests it.

---

### Task 1: Wire fields, run event kinds and the shared digest lines
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_dag.go`, `pkg/waveobj/runevent.go`, `cmd/wsh/cmd/wshcmd-jarvisdag.go`, `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`, `frontend/types/gotypes.d.ts`, `frontend/app/view/agents/runlineage.ts`, `frontend/app/view/agents/runlineage.test.ts`

Spec "Wire changes", D3 (actor), D5 (frontend helper), D6 (frontend helper). No engine behavior changes here.

**Produces:**
- `DagTaskDigest.ForwardedTs int64 json:"forwardedts,omitempty"`; `DagTaskDigest.MergeHeldBy string
  json:"mergeheldby,omitempty"`; `DagTaskDigest.VerifyFailLine string json:"verifyfailline,omitempty"`; the
  `MergeState` comment lists `held`.
- `CommandDagActionData.By string json:"by,omitempty"` and `const DagActionBy_Lead = "lead"` in `pkg/wshrpc`.
- `waveobj.RunEventKindTaskSkipped = "task-skipped"`, `RunEventKindTaskEscalated = "task-escalated"`,
  `RunEventKindFinalRerun = "final-rerun"`, each with a one-line comment naming its detail keys
  (`taskid, by`; `taskid, model, runtime, by`; `round`).
- In `runlineage.ts`: `export function mergeGateLine(run: Pick<RunInfo, "dag" | "digest">, taskId: string): string |
  undefined` and `export function verifyFailLine(task: TaskNode, td: DagTaskDigest | undefined): string | undefined`.

- [ ] Add the fields and constants; run `task generate`.
- [ ] Every `CommandDagActionData` the `wsh jarvis dag` subcommands send carries `By: wshrpc.DagActionBy_Lead`. If
  they build it in several places, route them through one helper first. A test named `TestDagActionPayloadsByLead`
  in `wshcmd-jarvisdag_test.go` asserts the retry, skip and escalate payloads carry `by: "lead"`.
- [ ] `mergeGateLine` per D6: `"merge ready"` for `mergestate: "ready"`; for `"held"`, `"merge ready · waits on
  <holder>'s Verify"` (holder verifying), `"… on <holder>'s failed Verify"` (verify-failed), `"… on <holder>'s
  merge conflict"` (blocked-merge), the holder's state read from `run.dag`; undefined for any other state or a
  missing digest task. Tests cover all five outcomes.
- [ ] `verifyFailLine` per D5: `td.verifyfailline` when set; else the text of `task.verifyerror`'s first line before
  its first `": "` ("exit 1" from "exit 1: ✔ adds two positive numbers"); undefined with no verifyerror. Tests cover
  the three cases.
- [ ] **Done when:** `go test ./cmd/wsh/cmd -run '^TestDag'` and `npx vitest run frontend/app/view/agents/runlineage.test.ts`
  pass, and Check is clean.

### Task 2: Digest: forwarded failures, the held merge gate, the Verify failure line
**Depends on:** Task 1
**Files:** `pkg/orchestrate/digest.go`, `pkg/orchestrate/digest_test.go`, `pkg/orchestrate/mergetask.go`, `pkg/orchestrate/mergetask_test.go`, `pkg/orchestrate/verify.go`, `pkg/orchestrate/land_test.go`, `cmd/wsh/cmd/wshcmd-jarvisdag.go`, `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`

Spec D1 (engine half), D5 (digest line), D6 (engine half), D7.

**Consumes:** Task 1's `ForwardedTs`, `MergeHeldBy`, `VerifyFailLine`, `held`.
**Produces:** `func mergeQueueHolder(g *waveobj.TaskGroup) (taskID, state string)` and `type mergeHeldError` in
`mergetask.go`.

- [ ] **Forwarded (D1):** `buildTaskDigest` sets `ForwardedTs` from the retained rows by D1's rule. Tests in
  `digest_test.go` (`TestDigestForwardedFailure...`) build `DagDigestSnapshot`s with seeded `Retained` rows (never
  through `ApplyAction`, whose signature Task 3 changes): set for a failed task forwarded after its `task-failed`; set
  for verify-failed and review-failed; unset when a `task-retried` or `task-spawned` and then a new `task-failed` are
  newer than the forward; unset for a forward row carrying an `askid`; unset for a task now `running`.
- [ ] **Failure line (D5):** for a `verify-failed` task, `VerifyFailLine` is the first line of
  `firstFailureExcerpt(t.VerifyOutput)` within `MaxVerifyLineLen`, "" when none matches. Tests for both.
- [ ] **Holder (D6):** `mergeQueueHolder` returns the first verify-failed task, else the conflict awaiting
  `--continue`, else the first verifying task, else `"", ""`. `AutoMergeReady` reads it in place of its own checks.
- [ ] **Held gate (D6):** a ready tip with a holder reads `MergeState: "held"`, `MergeHeldBy`, no `HumanActions`;
  `Counts.MergeReady` and `buildNext`'s merge-ready steps (2 and 4b) skip it. Tests: held while another task
  verifies, while one is verify-failed, while a conflict awaits continue; `ready` with `merge` again once the holder
  is done; `Next.Kind` is not `merge-ready` while held.
- [ ] **Refusal (D7):** `MergeTask` refuses a held tip of the same dag before claiming with a
  `mergeHeldError{tip, holder, what}` reading `"task <tip> waits on task <holder>'s Verify"` (or `failed Verify`,
  `merge conflict`), whose `Is(target error) bool` is `target == errProjectBusy`. `claimProject` keeps its signature
  and `%w` wrap; its message drops the dag uuid per D7. Tests in `mergetask_test.go`: `errors.Is(err,
  errProjectBusy)` holds and the text lacks "project checkout is busy" and any uuid; `land_test.go`'s busy hold keeps
  passing (edit it only if its assertion names the old text).
- [ ] **CLI:** `wsh jarvis dag status` prints a held tip as `merge held: waits on <holder>'s Verify` where it prints
  `ready` today (the `td.MergeState == "ready"` case); a `TestDag...` test covers it.
- [ ] **Done when:** `go test ./pkg/orchestrate -run 'Digest|MergeTask|MergeQueue|AutoMerge|BusyCheckout'` and
  `go test ./cmd/wsh/cmd -run '^TestDag'` pass.

### Task 3: Engine: action events, Rerun answers the lead, wake text, Verify detail cut
**Depends on:** Task 1 (uses the By field, DagActionBy_Lead and the three run event kinds)
**Files:** `pkg/orchestrate/mutation.go`, `pkg/orchestrate/mutation_test.go`, `pkg/orchestrate/final.go`, `pkg/orchestrate/finalend_test.go`, `pkg/orchestrate/final_test.go`, `pkg/orchestrate/queue.go`, `pkg/orchestrate/queue_test.go`, `pkg/orchestrate/autonomous.go`, `pkg/orchestrate/plancmd.go`, `pkg/orchestrate/plancmd_test.go`, `pkg/orchestrate/verify_test.go`, `pkg/orchestrate/setup_test.go`, `pkg/orchestrate/verifylast_test.go`, `pkg/orchestrate/actionlock_test.go`, `pkg/orchestrate/circuitbreakdispatch_test.go`, `pkg/orchestrate/earlymerge_test.go`, `pkg/orchestrate/laneschedule_test.go`, `pkg/orchestrate/leadsteer_test.go`, `pkg/orchestrate/leftbehind_test.go`, `pkg/orchestrate/modelroute_test.go`, `pkg/orchestrate/outcome_test.go`, `pkg/orchestrate/rewind_test.go`, `pkg/wshrpc/wshserver/wshserver_dag.go`

Spec D2, D3 (engine half), D5 (detail cut), D11 (wake half).

**Consumes:** Task 1's `By`, `DagActionBy_Lead`, the three run event kinds.
**Produces:** `func ApplyAction(ctx context.Context, dagID, taskID, action, by string, target waveobj.RoutePin) error`
(`by` is `"lead"` or `"human"`; `applyActionLocked` takes it too); `answerLeadQuestionWith(ctx, channelId, runId,
blockId, text string, match func(baseds.AgentAskQuestion) bool, onFail func()) (bool, error)`.

- [ ] **Events (D3):** `DagActionCommand` passes `"lead"` when `data.By == DagActionBy_Lead`, else `"human"`.
  `applyActionLocked` appends after the persist: `task-retried {taskid, auto: false, by}`, `task-skipped {taskid,
  by}`, `task-escalated {taskid, model, runtime, by}`. Update every `ApplyAction`/`applyActionLocked` caller in the
  listed tests (actionlock, circuitbreakdispatch, earlymerge, laneschedule, leadsteer, leftbehind, modelroute,
  outcome, rewind). Tests in `mutation_test.go` assert each row and its `by` for both actors.
- [ ] **Rerun (D2, D3):** `RerunFinalStage` appends `final-rerun {round}` and, after the commit, answers the lead's
  pending question with `finalRerunAnswer(round)` (D2's text) through `answerLeadQuestionWith` matching every
  question, with an `onFail` that posts `finalRerunWake`; it posts the wake at once only when nothing was answered.
  `TakeOverAsk` and `answerLeadQuestion` pass `nil`. Tests in `finalend_test.go`: a pending lead question is
  answered with the rerun text and no wake is posted; with no question one wake is posted; a failing delivery (stub
  `deliverLeadAnswerFn`) posts one wake; the `final-rerun` row is written once.
- [ ] **Wake (D11):** both non-autonomous `finalFailedWake` texts carry D11's Rerun sentence with the run id; the
  autonomous texts do not change. Update the text assertions in `final_test.go`/`finalend_test.go`.
- [ ] **Detail cut (D5):** a long no-match tail in `failureDetail` starts at the first line start inside it; the
  `"<reason>: "` prefix, the matched-excerpt path and the short `pe.Error()` path do not change. Tests in
  `plancmd_test.go`: a long output of passing `node --test` lines yields a detail starting `exit 1: ` whose tail
  begins at a line start. Keep `assertDetailKeepsCause` (`verify_test.go`), `setup_test.go`'s Setup wake and
  `verifylast_test.go` passing; edit them only if they pin a cut mid-line.
- [ ] **Done when:** `go test ./pkg/orchestrate -run 'Action|Rerun|FinalFailed|FailureDetail|TakeOver|Autonomous|EarlyMerge|LaneSchedule|LeadSteer|CircuitBreak|VerifyLast|LeftBehind|ModelRoute|Outcome|Rewind|Setup|DetailKeepsCause'` passes and `go vet ./pkg/orchestrate` is clean.

### Task 4: Lead card: forwarded rows, merge gate, Verify line, refusals, progress, landed footer
**Depends on:** Task 1 (reads `forwardedts`, `held`, `mergeGateLine` and `verifyFailLine`)
**Files:** `frontend/app/view/agents/leadcardmodel.ts`, `frontend/app/view/agents/leadcardmodel.test.ts`, `frontend/app/view/agents/leadcard.tsx`, `frontend/app/view/agents/leadcardactions.ts`, `frontend/app/view/agents/leadcardactions.test.ts`, `frontend/app/view/agents/runlineage.ts`, `frontend/app/view/agents/runlineage.test.ts`, `scripts/cdp/scenarios-runs.mjs`, `scripts/cdp/live-run-fixture.mjs`

Spec D1 (card half), D5 (card), D6 (card), D9, D12, D14, D17.

**Consumes:** `mergeGateLine`, `verifyFailLine` (Task 1); `leadLandFacts` (`leadland.ts`, unchanged).
**Produces:** `ACTION_LABEL` moved to `leadcardmodel.ts` (exported); `progressText(p: { done: number; skipped:
number; total: number }): string`; `cardErrorShown(...)`; `runProgress` returning `{ done, skipped, total }`;
`injectLiveGateDigest(h, ctx)` in `live-run-fixture.mjs` (opt-in).

- [ ] **Forwarded (D1):** `taskRow` treats a task whose digest row has `forwardedts` as having no judge: tag `needs
  you`, `needsYou: true`, failed/stalled `["retry", "skip"]`, verify-failed/blocked-merge `["resolve"]`,
  review-failed `inline: "review"`. Tests: each of the four states with a live lead and `forwardedts`; `askCount`
  counts them; the same rows without it keep "lead judging"/"lead fixing".
- [ ] **Verify line (D5):** the verify-failed/blocked-merge row's `detail` is `verifyFailLine(task, td)`. Tests:
  "exit 1" for a no-match error, the digest's line when set.
- [ ] **Merge gate (D6, D14):** the merge-gate branch takes `ready` and `held`; its sub is `join(task.id, laneText,
  mergeGateLine(run, task.id))`, its `openLabel` "Open transcript". Tests for both states.
- [ ] **Refusals (D9):** the error label is `ACTION_LABEL[action] <task>`; a task error records the task id and the
  stamp `<state>|<askid>`, and `cardErrorShown` hides it once the task's stamp differs. Tests in
  `leadcardmodel.test.ts`/`leadcardactions.test.ts`, including the Review Focus line.
- [ ] **Progress (D12):** `runProgress` adds `skipped` (update the `toEqual({ done, total })` assertions in
  `runlineage.test.ts`'s "counts done and skipped tasks as finished"); `progressText` gives `"4/5 · 1 skipped"` and
  `"3/4"`; `leadcard.tsx` renders it.
- [ ] **Landed (D17):** with `leadLandFacts(run)` non-null the settings line and title use its `branch`.
- [ ] **Steps, `lead-card-merge-gate`, 1600 unless noted:** `injectLiveGateDigest` page-injects into run A's digest
  `forwardedts` on t-5 and t-7, a `verifyfailline`-less verifyerror on t-7, and a held tip; only these steps call it,
  and they undo it after.
  - `L26` t-5 (failed) and t-7 (verify-failed) with `forwardedts` read `needs you` with Retry/Skip and Continue,
    and the header chip and Cockpit tab count include them; the same at 1000x700 (`L26b`).
  - `L26c` t-7's red detail reads "exit 1", not a test line.
  - `L27` a ready tip held by t-8's Verify reads "merge ready · waits on t-8's Verify" and its button "Open
    transcript", at 1600 and 1000x700.
  - `L28` a refused Take over shows "Take over t-…: …" without "Error:", and the line goes once that task's state
    changes in the page.
  - `L29` a run with a skipped task reads `<n>/<m> · 1 skipped`.
  - `L30` a landed run's footer reads "landed on <base> · <sha>", not "lands on wave/…".
- [ ] **Done when:** `npx vitest run frontend/app/view/agents/leadcardmodel.test.ts frontend/app/view/agents/leadcardactions.test.ts frontend/app/view/agents/runlineage.test.ts`
  passes, Check is clean, and `lead-card-merge-gate` passes in an isolated app.

### Task 5: Tree and rail lanes: failed tones, merge gate rows
**Depends on:** Task 1 (reads `mergeGateLine` and `held`)
**Files:** `frontend/app/view/agents/agenttreemodel.ts`, `frontend/app/view/agents/agenttreemodel.test.ts`, `frontend/app/view/agents/agenttree.tsx`, `frontend/app/view/agents/runrail.ts`, `frontend/app/view/agents/runrail.test.ts`, `scripts/cdp/scenarios-agent.mjs`

Spec D6 (tree and rail), D18.

**Consumes:** `mergeGateLine` (Task 1); `openRunDag(model, run, taskId)` from `runrailsections.tsx` (unchanged).
**Produces:** `workerRowTone(task: TaskNode): "error" | "warning" | undefined` in `agenttreemodel.ts`.

- [ ] **Tree gate (D6):** a done task whose digest `mergestate` is `ready` or `held` stays among the live rows, not
  the done fold; its sub is `mergeGateLine`, its dot the wait dot. Tests in `agenttreemodel.test.ts`.
- [ ] **Rail lane (D6):** `laneRow` gives such a tip state `pending` and text `mergeGateLine`. Tests in
  `runrail.test.ts`.
- [ ] **Failed rows (D18):** `workerRowTone` per D18; `WorkerRow` draws `bg-error`/`bg-warning` and colors its sub
  `text-error`/`text-warning`; a row with no focus key opens the DAG at its task. Tests for `workerRowTone`.
- [ ] **Steps, `agent-tree-rail`** (live-run run A; the held-tip injection is page-only and written in this
  scenario file, never in `live-run-fixture.mjs`):
  - `9d` at 1600 and `9e` at 1000x700: t-5 (failed) and t-7 (verify-failed) rows draw the error dot (computed
    background equals `--color-error`), and a click on a failed row with no session opens the DAG modal at it.
  - `9f` at 1600: a held tip stays out of the done fold, reads "merge ready · waits on t-8's Verify", and the rail's
    lane for it says the same.
- [ ] **Done when:** `npx vitest run frontend/app/view/agents/agenttreemodel.test.ts frontend/app/view/agents/runrail.test.ts`
  passes, Check is clean, and `agent-tree-rail` passes in an isolated app.

### Task 6: Events: the human's actions, forwarded failures and a failed stage on the rail
**Depends on:** none
**Files:** `frontend/app/view/agents/cockpitevents.ts`, `frontend/app/view/agents/cockpitevents.test.ts`, `frontend/app/view/agents/cockpiteventsrail.tsx`, `frontend/app/view/agents/runtimeline.ts`, `frontend/app/view/agents/runtimeline.test.ts`, `frontend/app/view/orchestrate/timelinegroups.ts`, `frontend/app/view/orchestrate/timelinegroups.test.ts`, `frontend/app/view/orchestrate/peeklifecycle.ts`, `frontend/app/view/orchestrate/peeklifecycle.test.ts`, `scripts/cdp/scenarios-cockpit-rail.mjs`

Spec D3 (frontend), D10. The kinds are the spec's string literals (`task-skipped`, `task-escalated`, `final-rerun`,
detail keys as in "Wire changes"); no generated type is needed.

**Produces:** `RailKind` gains `"acted"`; `eventText` covers `task-retried` (human), `task-skipped`,
`task-escalated`, `final-rerun` in D3's words.

- [ ] **Titles and text (D3):** in `runtimeline.ts` per D3; `timelinegroups.ts` labels; `peeklifecycle.ts` adds
  `final-rerun` to the final stage's kinds. Tests for each kind, both actors, and an auto retry keeping today's
  text.
- [ ] **Rail (D3, D10):** `runRailKind` maps a human's retry/skip/escalate/take-over and `final-rerun` to `acted`,
  `task-forwarded` (not by the human) to `asked`, `dag-blocked {kind: final-failed}` to `failed` "final stage
  failed"; other `dag-blocked` kinds stay off. `cockpiteventsrail.tsx` gives `acted` its icon, verb and
  `text-accent-soft` tone. Tests in `cockpitevents.test.ts`.
- [ ] **Steps, `cockpit-rail-help`:** a new step after the existing last one (keep clear of 5195e068's P6b) publishes
  page events on its held run and asserts, at 1000x700: a `task-forwarded` row reads "… handed to you", a
  `dag-blocked final-failed` row reads "final stage failed" in the failed tone, and a human `task-skipped` row reads
  "you skipped …"; at 1600 the same three rows render.
- [ ] **Done when:** `npx vitest run frontend/app/view/agents/cockpitevents.test.ts frontend/app/view/agents/runtimeline.test.ts frontend/app/view/orchestrate/timelinegroups.test.ts frontend/app/view/orchestrate/peeklifecycle.test.ts`
  passes, Check is clean, and `cockpit-rail-help` passes in an isolated app.

### Task 7: Initiative panel: "just now", short work ids, a Notes count that agrees
**Depends on:** none
**Files:** `frontend/app/view/jarvis/effortdetailview.tsx`, `frontend/app/view/jarvis/effortfeed.ts`, `frontend/app/view/jarvis/effortfeed.test.ts`, `pkg/jarvis/effortops.go`, `pkg/jarvis/effortops_test.go`, `scripts/cdp/scenarios-brief.mjs`

Spec D15, D16.

- [ ] **Go (D16):** attach/detach notes read `<kind> <8-char id> attached|detached`. Tests in `effortops_test.go`
  for both, with a chunk and without.
- [ ] **Count (D16):** `export function noteCount(feed: FeedEntry[]): number` in `effortfeed.ts`, counting the
  entries the feed renders as note rows, marks included; the header uses it. Tests: a feed holding only a "marked
  active" mark counts 1.
- [ ] **Ago (D15):** the "updated" fact uses `formatAgo`.
- [ ] **Steps, `brief-live-initiative`, 1600:** the panel's updated fact reads "just now" without "ago"; after a
  status change the Notes header counts at least 1; after attaching a run, its note reads "run <8 chars> attached"
  with no `run:` prefix.
- [ ] **Done when:** `go test ./pkg/jarvis -run 'Effort'` and `npx vitest run frontend/app/view/jarvis/effortfeed.test.ts`
  pass, Check is clean, and `brief-live-initiative` passes in an isolated app.

### Task 8: Doc review dialog title follows the lead's proposal
**Depends on:** none
**Files:** `frontend/app/view/agents/docreview.ts`, `frontend/app/view/agents/docreview.test.ts`, `scripts/cdp/scenarios-cockpit.mjs`

Spec D19. The button already renders the lead's own approve label (`docreviewdialog.tsx`, `cleanLabel`); it does
not change.

- [ ] `DOC_REVIEW_COPY.review.title` becomes "The plan review failed twice. Proceed as the lead proposes?". A test
  in `docreview.test.ts` pins it.
- [ ] **Step, `doc-review`, 1600:** a Plan review ask whose approve option is "Keep the plan" shows the new title and
  a primary button reading "Keep the plan" (the button half passes on HEAD already; the step pins it).
- [ ] **Done when:** `npx vitest run frontend/app/view/agents/docreview.test.ts` passes, Check is clean, and
  `doc-review` passes in an isolated app.

### Task 9: Hub run sheet, DAG peek and the stage pane
**Depends on:** Task 4, Task 6 (its Lifecycle step reads Task 6's event titles)
**Files:** `frontend/app/view/jarvis/runsheetmodel.ts`, `frontend/app/view/jarvis/runsheetmodel.test.ts`, `frontend/app/view/jarvis/runsheet.tsx`, `frontend/app/view/orchestrate/dagpeek.ts`, `frontend/app/view/orchestrate/dagpeek.test.ts`, `frontend/app/view/orchestrate/dagtaskpeek.tsx`, `frontend/app/view/agents/finalstage.ts`, `frontend/app/view/agents/finalstage.test.ts`, `frontend/app/view/agents/finalstagepane.tsx`, `scripts/cdp/scenarios-runs.mjs`

Spec D4, D5 (Hub and peek), D6 (Hub row), D7 (DAG), D8, D11 (pane), D13.

**Consumes:** `mergeGateLine`, `verifyFailLine` (Task 1); `actionWords` (`dagdigest.ts`, unchanged).
**Produces:** `taskFailureDetail(events: RunEvent[], taskId: string): string | undefined` in `dagpeek.ts`;
`finalFailedNote(lead: { asking: boolean } | undefined): string` in `finalstage.ts`.

- [ ] **Hub (D4, D5, D6, D8):** the skipped meta reads `skipped`; a verify-failed row's red line is
  `verifyFailLine`; a done task with `mergestate` `held` gets `mergeGateLine` as its meta and no attention row;
  attention chips render `actionWords`. Tests in `runsheetmodel.test.ts`.
- [ ] **Peek (D5, D7, D13):** `taskFailureDetail` per D13 feeds the `last failure` row; a failed task with no run
  reads "Never dispatched · failed at <kind>"; a verify-failed peek's headline uses `verifyFailLine`; a held tip's
  peek shows `mergeGateLine` and no Merge action. Tests in `dagpeek.test.ts`.
- [ ] **Pane (D11):** `finalFailedNote` per D11 drives the footer of `finalstagepane.tsx`, its lead read from the
  roster. Tests for the three cases.
- [ ] **Steps, 1600** (every injection page-only and written in `scenarios-runs.mjs`; `live-run-fixture.mjs` is not
  edited):
  - `run-sheet-polish`: a skipped task's meta reads "skipped"; an attention chip reads words ("retry / skip /
    escalate"), not ids; a held tip has no attention row and its meta reads "merge ready · waits on <holder>'s
    Verify".
  - `dag-peek`: a task failed at Setup with a `task-failed` detail shows it in the peek and "Never dispatched"; a
    held tip offers no Merge and names its holder; after a page-published human `task-skipped`, the Lifecycle shows
    "you skipped …".
  - `lead-card-merge-gate` `L31`: run C's stage pane footer reads "The lead is asking you about this failure…" with
    lead C set to asking in the page roster from this step, and today's line otherwise.
- [ ] **Done when:** `npx vitest run frontend/app/view/jarvis/runsheetmodel.test.ts frontend/app/view/orchestrate/dagpeek.test.ts frontend/app/view/agents/finalstage.test.ts`
  passes, Check is clean, and `run-sheet-polish`, `dag-peek` and `lead-card-merge-gate` pass in an isolated app.
