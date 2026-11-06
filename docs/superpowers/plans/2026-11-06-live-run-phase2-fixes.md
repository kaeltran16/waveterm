# Live-run states phase 2 fixes (P1-P22) Implementation Plan

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix P1-P22 of the live-run states review, phase 2. That means three things: the Go fixes (transcript
streams, take-over, project names, Sessions tokens, input to a block with no controller), the cockpit fixes (lead
card, Events rail, agent tree and rail, Final pane, doc review dialog, Sessions run head), and a CDP step for each
UI fix at the width where it was broken.

**Architecture:** Ten tasks start at once, one per surface or Go area, each owning its files and its scenario file.
The Final pane (Task 11) shares `scenarios-runs.mjs` with the lead card (Task 5), so it waits for Task 5. The run
name fix (Task 12) touches the card, the tree and both of those scenario files, so it goes last. Pure logic goes in
a `.ts` beside its test; the `.tsx` stays thin.

**Tech Stack:** Go (wshserver, orchestrate, jarvis, agentsessions, blockcontroller), React 19 + jotai + Tailwind 4,
vitest, CDP scenarios.

**Spec:** `docs/superpowers/specs/2026-11-06-live-run-phase2-fixes-design.md` (each finding's decision is the spec's
D<n> with the same number: P1 is D1).
**Verify:** `node scripts/verify.mjs ./pkg/wshrpc/wshserver ./pkg/orchestrate ./pkg/jarvis ./pkg/agentsessions ./pkg/blockcontroller`
**Check:** `go vet ./pkg/wshrpc/wshserver ./pkg/orchestrate ./pkg/jarvis ./pkg/agentsessions ./pkg/blockcontroller && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs agent-streams lead-card-merge-gate cockpit-roster-counts cockpit-rail-help doc-review agent-tree-rail sessions-list-states final-stage`

## Global Constraints

- **CDP port:** never attach to CDP :9222 and never run `task verify:ui` against the default port. See your
  scenario only in an isolated app: `ARC_FINAL_OUT=<a new temp dir> node scripts/cdp/final-verify.mjs <scenario...>`.
- **Fixtures:** build them the way phase 1 did (`docs/reference/cdp-run-fixtures.md`). Runs are held with
  `deferstart` in an unborn git repo (`arrangeHeldRun`, `heldStandIn`, `seedHeldRun`, `seedDag`); stage sessions
  are `fstWriteRun` stand-ins; page-only injections follow `scripts/cdp/live-run-fixture.mjs`. No model may start.
  Teardown removes only what the scenario made.
- **Shared fixture files:** `scripts/cdp/scenarios-shared.mjs` is read-only for every task.
  `scripts/cdp/live-run-fixture.mjs` belongs to Task 5. Other tasks import it and build anything extra inside
  their own scenario file.
- **Step width:** a UI fix's step runs at the width the task names: 1600x950 by default, 1000x700 where a task
  says so. Viewport and reload traps: `docs/reference/cdp-verification.md`.
- **Existing steps:** never lower an existing step's bar. Add lettered sub-steps (`L18`, `9b`) rather than
  renumbering.
- **Tokens:** colors, shadows and spacing come from the `@theme` tokens in `frontend/tailwindsetup.css` only. No
  new tokens.
- **Off-limits files:** stay off `frontend/app/view/agents/projectoverview*` and
  `scripts/cdp/scenarios-project-overview.mjs`, which belong to a parallel run.
- **Lint and format:** only the files you touched. Keep prettier off `scripts/*.mjs`.
- **Processes:** never stop `wave-tauri.exe` or `wavesrv.x64.exe` by image name.
- **Comments and copy:** comments only for why, in lower case. Quote copy exactly as the spec gives it.

## Review Focus

- **P2, a Plan review or land question open while a worker's ask is taken over:** the lead's question must not be
  answered. Only a question whose header equals the task id is. Task 2 pins it.
- **P1, a transcript whose folder and its parent are both missing** (two levels): the stream still delivers once
  both appear. A path with no existing ancestor fails rather than hanging. Task 1 pins both.
- **P20, a record with usage but no `message.id`:** it still counts, once per record. Task 3 pins it.
- **P21, input data, not a resize, to a block with no controller:** it is still an error, and only a resize-only
  input is quiet. Task 4 pins it.
- **P5, a done task on a single-task lane whose `mergestate` is "waiting":** it never reads "lands with" itself.
  It reads "done · waiting to land". Task 5 pins it.

---

### Task 1: Transcript streams wait for a missing folder (P1)
**Depends on:** none
**Files:** `pkg/wshrpc/wshserver/transcript.go`, `pkg/wshrpc/wshserver/transcript_test.go`, `frontend/app/view/agents/livetranscript.ts`, `scripts/cdp/scenarios-agent-streams.mjs`

Spec D1.

- [ ] **Failing tests first** in `transcript_test.go`:
  - `TestStreamTranscriptWaitsForMissingDir`: under `t.TempDir()`, start `streamTranscript` on
    `<tmp>/a/b/s.jsonl` with `a` missing. Assert it sends one empty backlog. Then create `a/b`, write two lines to
    `s.jsonl`, and assert both lines arrive (5 s timeout). Cancelling ctx returns nil.
  - `TestStreamTranscriptReadsLinesWrittenBeforeWatch`: create the folder and write a line in one step, right after
    the start. Assert the line arrives.
  - `TestStreamTranscriptNoAncestorFails`: a path on a drive or volume root that does not exist (build it so no
    ancestor exists) returns an error.
- [ ] **Implement in `streamTranscript`:** watch the nearest existing ancestor of `filepath.Dir(path)`. On a
  `Create` event for the next path component, `Remove` the old watch, `Add` the deeper one, and repeat until the
  transcript's own folder is watched. Then do the backlog read. Keep the existing
  watch-before-backlog ordering at the final level.
- [ ] **`livetranscript.ts`:** the `catch` logs
  `console.error("transcript stream ended", id, path, err)` instead of an empty block. It does not restart the
  stream.
- [ ] **CDP step in `agent-streams`, at 1600x950:** start an agent whose `transcriptPath` is in a temp folder that
  does not exist yet. After the agent's stream opened (its card shows), create the folder and append two transcript
  lines. Assert both lines render in the agent's transcript within 10 s.
- [ ] **Done when:** `go test ./pkg/wshrpc/wshserver -run 'TestStreamTranscript'` passes, and `agent-streams`
  passes in an isolated app.

### Task 2: Take over answers the lead's relay (P2)
**Depends on:** none
**Files:** `pkg/orchestrate/queue.go`, `pkg/orchestrate/queue_test.go`, `pkg/orchestrate/autonomous.go`, `pkg/orchestrate/autonomous_test.go`, `pkg/jarvis/leadprompt.go`, `pkg/jarvis/leadprompt_test.go`

Spec D2. The frontend label is Task 9's.

**Produces:** `jarvis.TakenOverRelayAnswer` (const string, the spec's exact copy);
`answerLeadQuestionWith(ctx, channelId, runId, blockId, text string, match func(baseds.AgentAskQuestion) bool) error`
in `autonomous.go`, with `answerLeadQuestion` as its autonomous caller (match all, text `AutonomousOnAnswer`).
`answerLeadQuestionWith` answers the pending ask only when `match` holds for every question, and gives each
question `text`. Otherwise it does nothing and returns nil.

- [ ] **Failing tests first** in `queue_test.go`. Seed the lead's ask with `seedLeadAsk` in `wake_test.go`, or with
  a header variant you add beside it in `queue_test.go`, and stub `deliverLeadAnswerFn`.
  - `TestTakeOverAskAnswersLeadRelay`: the lead's open question has the header `t-3`. After the take-over, one
    delivery reaches the lead block's oref with text `jarvis.TakenOverRelayAnswer`.
  - `TestTakeOverAskLeavesOtherLeadQuestion`: the header is `Plan review`, so no delivery.
  - `TestTakeOverAskLeavesMixedLeadAsk`: the lead's ask has two questions with the headers `t-3` and
    `Plan review`, so no delivery. Only an ask in which every question's header is the task id is answered, every
    question with `TakenOverRelayAnswer`.
  - `TestTakeOverAskWithoutLeadQuestion`: the take-over succeeds as before.
  - `TestTakeOverAskRelayDeliveryFailure`: a delivery error appends `lead-wake-failed` and the take-over still
    returns nil.
- [ ] **`leadprompt_test.go`:** the claude orchestration rules contain "header `<task id>`" in the questions rule.
- [ ] **Implement:**
  - Add the header rule to the questions line in `leadprompt.go`: a relayed question's header is the task id
    exactly.
  - After `moveAskToUser` succeeds in `TakeOverAsk`, call `answerLeadQuestionWith` for the run's lead block (use
    `readLeadState`), matching `q.Header == taskID`.
  - The existing `TestApplyAutonomousSwitch*` tests still pass.
- [ ] **Done when:** `go test ./pkg/orchestrate -run 'TestTakeOverAsk|TestApplyAutonomousSwitch'` and
  `go test ./pkg/jarvis -run 'TestOrchestrationRules|TestLeadPrompt'` pass. Use the existing leadprompt test names
  if they differ, and say which in your note.

### Task 3: Run members carry their project; Sessions counts each message once (P8 Go, P20)
**Depends on:** none
**Files:** `pkg/orchestrate/engine.go`, `pkg/orchestrate/review.go`, `pkg/orchestrate/stagesession.go`, `pkg/orchestrate/engine_test.go`, `pkg/orchestrate/review_test.go`, `pkg/orchestrate/stagesession_test.go`, `pkg/agentsessions/agentsessions.go`, `pkg/agentsessions/extractsession_test.go`

Spec D8 (Go half) and D20. The tests go in the existing test files listed above. The `queue_test.go` and
`wake_test.go` files belong to Task 2 and are not edited here.

- [ ] **Failing tests first:**
  - With `spawnWorker` stubbed to record `projectName`, a dispatched task worker (`engine_test.go`), a task
    reviewer (`review_test.go`) and a stage session (`stagesession_test.go`) each get the owning channel's name,
    not `""`.
  - `extractsession_test.go` `TestExtractSessionDedupesUsageByMessageId`: three records share `message.id` "m1"
    with usage `{in 10, out 5, cacheRead 100}`, and one has output 7. One record has no id, with total 3. Assert
    `TokensTotal == 10+7+100+3`.
- [ ] **Implement:**
  - Resolve the owner's channel once per spawn path (`wstore` channel by `owner.ChannelId`; a lookup error is logged
    and the spawn proceeds with `""`) and pass `ch.Name`.
  - In `extractSession`, keep per-`message.id` usage, the one with the largest output, and sum after the loop.
    Records without an id add directly.
- [ ] **Done when:**
  `go test ./pkg/orchestrate -run '<the three new test names>'` and
  `go test ./pkg/agentsessions -run 'TestExtractSession'` pass.

### Task 4: Input to a block with no controller (P21)
**Depends on:** none
**Files:** `pkg/blockcontroller/blockcontroller.go`, `pkg/blockcontroller/blockcontroller_test.go`, `frontend/app/view/term/termwrap.ts`, `frontend/app/view/term/term-model.ts`

Spec D21.

- [ ] **Failing tests first** in `blockcontroller_test.go`:
  - Flip the existing `TestSendInputKeepsAResizeNoProcessTook`, which already stubs `persistTermSize`: a
    `TermSize`-only input to a block with no controller now returns nil, and the size is still kept. Update its
    failure message to match.
  - Add a case where the stubbed persist fails: `SendInput` returns that error.
  - `TestSendInputDataWithoutController`: `InputData` set returns the "no controller found" error.
- [ ] **Implement:**
  - `SendInput` returns nil when the input is resize-only (`TermSize != nil`, `len(InputData) == 0`,
    `SigName == ""`), the controller is missing, and the persist succeeded. A failed persist returns that error.
  - In `termwrap.ts` `handleResize`, chain `.catch((e) => console.error("terminal resize", this.blockId, e))`.
  - In `term-model.ts` `sendDataToController`, do the same with `"terminal input"`.
- [ ] **Done when:** `go test ./pkg/blockcontroller -run 'TestSendInput'` passes. No CDP step: no rendered UI
  changes.

### Task 5: Lead card: plan review row, lane wait, clock, route, branch, pane, asking (P3, P5, P7, P9, P13, P15, P16)
**Depends on:** none
**Files:** `frontend/app/view/agents/leadcardmodel.ts`, `frontend/app/view/agents/leadcardmodel.test.ts`, `frontend/app/view/agents/runlineage.ts`, `frontend/app/view/agents/runlineage.test.ts`, `frontend/app/view/agents/leadcard.tsx`, `frontend/app/view/agents/leadpane.ts`, `frontend/app/view/agents/leadpane.test.ts`, `frontend/app/view/agents/runrail.ts`, `frontend/app/view/agents/runrail.test.ts`, `frontend/app/view/agents/brainstormrunmodel.ts`, `frontend/app/view/agents/brainstormrunmodel.test.ts`, `scripts/cdp/scenarios-runs.mjs`, `scripts/cdp/live-run-fixture.mjs`

Spec D3, D5, D7, D9, D13, D15, D16.

**Produces:**
- `landingBranch(run)` returns `wave/<full run id>`, and stays the single source for the branch name.
- `RunInfo.workerRoute?: RoutePin`.
- `leadPaneShown(input: { hasAsk: boolean; hasLines: boolean; userOpened: boolean }): "full" | "collapsed" | "none"`
  in `leadpane.ts`.

- [ ] **Failing tests first** (vitest, in the test files listed):
  - **P3:** with `dag.planreview` reviewing in round 2, `buildLeadCard` lists a first live row labelled
    "Plan review", tag `round 2`. A failed review is a wait-tone row with sub "failed · lead deciding". A passed one
    is done, tone ok. An accepted one is done, muted, sub "accepted by you". While reviewing, `activity` is
    "plan review · round 2".
  - **P5:** a done task with `mergestate: "waiting"` in a lane `["t-2","t-3"]` is a wait row with sub
    `t-2 · lane B · done · lands with t-3`. A single-task lane that is waiting reads `done · waiting to land`.
    `merged` reads "landed".
  - **P7:** `runElapsed` with `createdts` 10 s in the future is `""`, never negative.
  - **P9:** with no `dag` and `run.workerRoute.model` "claude-haiku-5-5", `settings` has "workers haiku". With
    neither route set, it has "workers as lead".
  - **P13:** `landingBranch` gives `wave/b85abade-fc46-491e-89bf-533150cb7a47`; the card's `settings` and
    `endedLine` and the brainstorm run line use it.
  - **P15:** `leadPaneShown` covers the matrix: no lines gives none; an ask without userOpened gives collapsed; an
    ask with userOpened gives full; no ask gives full.
  - **P16:** an asking lead is not `leadStandingBy`, and `leadActivity` is "asking you".
- [ ] **Implement:**
  - Make the tests pass.
  - `runInfoOf` fills `workerRoute` from the lead run.
  - The card's meta elapsed reads `model.nowAtom` in `leadcard.tsx`; `buildLeadCard` keeps `structuralNow`.
  - The footer branch text gets `truncate` with a full-name `title`.
  - The pane's toggle sets `userOpened` for the current ask key. It resets when the ask changes.
- [ ] **Fixture and steps:** extend `live-run-fixture.mjs` as needed, additively: Task 6 imports `arrangeLiveRuns`,
  `setLiveRoster`, `injectLiveAsks` and `teardownLiveRuns` at the same time, so keep their signatures and
  behavior. Then add steps to `lead-card-merge-gate`:
  - `L18 P3`, at 1600: a held run seeded with `planreview` reviewing shows the Plan review row, and no "Standing by".
  - `L19 P5`, at 1600: a lane-waiting done task reads "lands with t-3", not "landed".
  - `L20 P7`, at 1000: a dag with `createdts` in the future shows no "-" elapsed.
  - `L21 P9`, at 1600: a planning run created with a `workerroute` reads "workers haiku".
  - `L22 P13`, at 1600: the footer `title` holds the full `wave/<id>`.
  - `L23 P15`, at 1000x700: with a child ask open, the lead pane is collapsed, the ask's last option is fully
    visible, and at least one task row is visible.
  - `L24 P16`, at 1600: a lead in `asking` reads "asking you".
- [ ] **Done when:** `npx vitest run frontend/app/view/agents/leadcardmodel.test.ts frontend/app/view/agents/runlineage.test.ts frontend/app/view/agents/leadpane.test.ts frontend/app/view/agents/runrail.test.ts frontend/app/view/agents/brainstormrunmodel.test.ts`
  passes, and `lead-card-merge-gate` passes in an isolated app.

### Task 6: Cockpit header need-you count and Space on a done row (P8 frontend, P22)
**Depends on:** none
**Files:** `frontend/app/view/agents/cockpitsurface.tsx`, `frontend/app/view/agents/cockpitsurfacemodel.ts`, `frontend/app/view/agents/cockpitsurfacemodel.test.ts`, `frontend/app/view/agents/cardgridlayout.ts`, `frontend/app/view/agents/cardgridlayout.test.ts`, `frontend/app/view/agents/usecockpitkeyboard.ts`, `scripts/cdp/scenarios-cockpit-roster.mjs`

Spec D8 (frontend half) and D22. Where things live today:
- `cardNeedsYou` is a closure in `cockpitsurface.tsx`.
- `chipCounts`, the tab counts, is in `cardgridlayout.ts`.
- `cockpitCounts`, the header counts, is in `cockpitsurfacemodel.ts`, and `projectswitcher.tsx` also calls it.

Keep `cockpitCounts`' signature and its result for `projectswitcher.tsx` unchanged: the header takes its need-you
number from the same card count the tabs show (`chipCounts`' need-you count), not from `cockpitCounts`.
`live-run-fixture.mjs` is Task 5's, edited at the same time: import its existing exports only (`arrangeLiveRuns`,
`setLiveRoster`, `injectLiveAsks`, `teardownLiveRuns`). Task 5 keeps those signatures.

**Produces:** `rowPeekId(row: { worker?: { id: string }; openId?: string }): string | undefined` in
`cockpitsurfacemodel.ts`.

- [ ] **Failing tests first:**
  - The header's need-you count equals the number of shown cards that need you. A run card whose lead relays a
    worker's ask counts as 1, not 2. Test it through the pure function the header now reads (`chipCounts` or a
    helper beside it).
  - `rowPeekId` returns the live worker first, else `openId`, else undefined.
- [ ] **Implement:**
  - Use those in `cockpitsurface.tsx` (`peekId: rowPeekId(r)`).
  - If the peek cannot render an ended-transcript id, Space on that row opens it (`usecockpitkeyboard.ts`), as
    spec D22 allows. Say which you did in your note.
- [ ] **Steps in `cockpit-roster-counts`, at 1600,** built on `arrangeLiveRuns` imported from
  `live-run-fixture.mjs`:
  - `P8`: a run with a lead ask plus a relayed child ask shows the same need-you number in the header and the tab.
  - `P22`: a focused done row plus a Space keypress shows that task's ended transcript (peek or open).
- [ ] **Done when:** `npx vitest run frontend/app/view/agents/cockpitsurfacemodel.test.ts frontend/app/view/agents/cardgridlayout.test.ts` passes, and
  `cockpit-roster-counts` passes in an isolated app.

### Task 7: Events rail: run milestones and the lead's questions (P6)
**Depends on:** none
**Files:** `frontend/app/view/agents/cockpitevents.ts`, `frontend/app/view/agents/cockpitevents.test.ts`, `frontend/app/view/agents/cockpiteventsrail.tsx`, `scripts/cdp/scenarios-cockpit-rail.mjs`

Spec D6.

**Produces:** `RailKind` gains `"sentback"`, and a pure `leadAskEvents(leads, prevSnaps, now)` (or an equivalent
extension of `agentTransitions`) that yields only `asked` events for run leads.

- [ ] **Failing tests first** (`cockpitevents.test.ts`):
  - `plan-reviewed`: a pass gives finished, a fail gives failed.
  - `task-review-failed`: non-final gives sentback, final gives failed.
  - `final-step`: passed gives finished; failed and unverified give failed; any other step gives nothing.
  - `landed` gives landed, and `land-held` gives failed with the reason in its text.
  - A lead going from working to asking yields one `asked` event, with `who` the run title and `focusId` the lead
    card.
- [ ] **Implement** the mappings, the `sentback` row style in `cockpiteventsrail.tsx` (`CornerDownRight`,
  `text-warning`, verb "review sent back"), and the lead's tracking in `useRailTracking`.
- [ ] **Step in `cockpit-rail-help`, at 1600:** publish `plan-reviewed` (failed), `task-review-failed` (not final),
  `final-step` (passed) and `landed` events for a held run, and set its lead to asking. The rail lists each of them
  and the lead's question.
- [ ] **Done when:** `npx vitest run frontend/app/view/agents/cockpitevents.test.ts` passes, and
  `cockpit-rail-help` passes in an isolated app.

### Task 8: Doc review dialog keeps section headings (P4)
**Depends on:** none
**Files:** `frontend/app/view/agents/docreview.ts`, `frontend/app/view/agents/docreview.test.ts`, `frontend/app/view/agents/docreviewdialog.tsx`, `frontend/app/view/agents/answerbar.tsx`, `scripts/cdp/scenarios-cockpit.mjs`

Spec D4. `answerbar.tsx` (`DocReviewSummary`) reads `review.items.length`; it counts the item entries
(`entries.filter((e) => e.kind === "item").length`). The other `parseDocReview` callers (`agentheader.tsx`,
`agentrow.tsx`, `agenttree.tsx`, `leadcard.tsx`) only test for non-null. Do not edit them; if one reads `items`,
stop and say so.

**Produces:** `DocReview.entries: { kind: "item" | "heading"; text: string }[]` in place of `items`.

- [ ] **Failing test:** the real ask from the report gives entries in this order: items R1-2, R1-3, R1-5, then the
  heading "Findings I would not accept:", then items R1-1 and R1-4. The question text is in the spec's source run:
  path line, intro, three items, heading, two items.
- [ ] **Implement:** the dialog numbers and quotes items only, and renders a heading as a subhead (`text-muted`,
  small caps or semibold, existing tokens).
- [ ] **Step in `doc-review`, at both 1000x700 and 1600x950:** an ask with that shape shows the second heading
  between the two groups.
- [ ] **Done when:** `npx vitest run frontend/app/view/agents/docreview.test.ts` passes, and `doc-review` passes in
  an isolated app.

### Task 9: Agent tree and rail: accepted plan review, lead rail after landing, handed-to-you label, close wording (P14 tree, P17, P2 label, P18)
**Depends on:** none
**Files:** `frontend/app/view/agents/agenttreemodel.ts`, `frontend/app/view/agents/agenttreemodel.test.ts`, `frontend/app/view/agents/agenttree.tsx`, `frontend/app/view/agents/agentdetailsrail.tsx`, `frontend/app/view/agents/leadland.ts`, `frontend/app/view/agents/leadland.test.ts`, `frontend/app/view/agents/runrailsections.tsx`, `frontend/app/view/orchestrate/dagdigest.ts`, `frontend/app/view/orchestrate/dagdigest.test.ts`, `frontend/app/view/jarvis/runsheetmodel.test.ts`, `frontend/app/view/agents/agentactions.ts`, `frontend/app/view/agents/closesession.ts`, `frontend/app/view/agents/closesession.test.ts`, `scripts/cdp/scenarios-agent.mjs`

Spec D14 (tree), D17, D2 (label), D18.
- **`agenttree.tsx`:** edit only `StageRow` and `STAGE_OUTCOME_DOT`, so that a muted "accepted" outcome renders and
  typechecks. Its lead-row name is Task 12's, which runs after this task.
- **`agentheader.tsx`:** Task 12's; do not edit it.
- **`runsheetmodel.test.ts`:** its `muted('forwarded 1')` expectation becomes `muted('to you 1')`. `runrecord.ts`
  keeps its own text.

**Produces:**
- `leadLandFacts(run): { branch: string; files: string; commits: { sha: string; subject: string }[] } | null`.
- `closeSessionCopy(input: { isLead: boolean; runFinished: boolean; runTabCount: number; runTitle: string; name: string })`,
  returning the dialog's `{ title, message, confirmLabel }`.

- [ ] **Failing tests first:**
  - Tree: with `planreview.state "accepted"`, the stage rows' verdict text is "accepted by you" in a muted tone,
    and the run line says "plan reviews".
  - `leadLandFacts` on a landed run gives the branch "landed on main · d29f0d2", files
    "worktree removed after landing", and `report.commits`. On a run that has not landed it gives null.
  - `reportChips` gives `to you 1` in place of `forwarded 1`.
  - `closeSessionCopy` for a lead with 1 run tab on a finished run gives title "Close run" and the spec's message.
    Other inputs keep today's copy.
- [ ] **Implement:** wire them into `agenttreemodel.ts`, `agentdetailsrail.tsx` (Branch and Files touched),
  `runrailsections.tsx` (the FactRow label "Handed to you") and `confirmCloseSession`.
- [ ] **Steps in `agent-tree-rail`, at 1600:**
  - `P14`: an accepted plan review reads "accepted by you", not red "failed".
  - `P17`: a landed lead's rail reads "worktree removed after landing" and lists a commit.
  - `P2`: the run rail shows "Handed to you".
  - `P18`: the header Close on a finished run's last lead tab opens a "Close run" dialog. Cancel it.
- [ ] **Done when:** `npx vitest run frontend/app/view/agents/agenttreemodel.test.ts frontend/app/view/agents/leadland.test.ts frontend/app/view/orchestrate/dagdigest.test.ts frontend/app/view/jarvis/runsheetmodel.test.ts frontend/app/view/agents/closesession.test.ts`
  passes, and `agent-tree-rail` passes in an isolated app.

### Task 10: Sessions run head: idle lead, accepted plan review (P19, P14 Sessions)
**Depends on:** none
**Files:** `frontend/app/view/agents/sessionsruns.ts`, `frontend/app/view/agents/sessionsruns.test.ts`, `scripts/cdp/scenarios-sessions-list-states.mjs`, `scripts/cdp/sessions-page-fixtures.mjs`

Spec D19, D14 (Sessions).

- [ ] **Failing tests first** (`sessionsruns.test.ts`):
  - A live lead at its prompt on a done dag reads "idle", and the head reads "lead idle" (key `idle`).
  - On an open dag the lead reads "waiting on engine".
  - With a plan reviewer whose own verdict is failed and `planreview.state "accepted"`, the stage member reads
    "accepted by you" in the muted tone.
- [ ] **Implement:** `leadStatus`, `headStatus` and `stageStatus` as spec D19 and D14 say.
- [ ] **Steps in `sessions-list-states`, at 1600:** a finished run with a live lead at its prompt shows "lead idle"
  and no "working". An accepted plan review shows "accepted by you".
- [ ] **Done when:** `npx vitest run frontend/app/view/agents/sessionsruns.test.ts` passes, and
  `sessions-list-states` passes in an isolated app.

### Task 11: Final pane: sub-second steps and the Verifier step (P10, P11)
**Depends on:** Task 5
**Files:** `frontend/app/view/agents/runcompletion.ts`, `frontend/app/view/agents/runcompletion.test.ts`, `frontend/app/view/agents/finalstage.ts`, `frontend/app/view/agents/finalstage.test.ts`, `frontend/app/view/agents/finalstagepane.tsx`, `frontend/app/view/agents/finalstageviews.tsx`, `scripts/cdp/scenarios-runs.mjs`

Spec D10, D11.

- [ ] **Failing tests first:**
  - `fmtDuration(211)` and `fmtDuration(999)` are `<1s`; `fmtDuration(1500)` is unchanged from today. Today it
    rounds, so 500-999 ms read "1s": the `<1s` rule runs before the rounding.
  - The Verifier step is openable when the stage has a verifier run, and its target is the id `finalRowFocusId`
    resolves (live agent or ended transcript). With no verifier, it is not openable.
- [ ] **Implement:** a click on the Verifier step focuses that target. It does not use the output panel.
- [ ] **Steps in `final-stage`, at 1600:**
  - `P10`: a step with `ms: 211` reads "<1s".
  - `P11`: clicking the Verifier step of a passed stage, with a `fstWriteRun` verifier, opens its transcript.
- [ ] **Done when:** `npx vitest run frontend/app/view/agents/runcompletion.test.ts frontend/app/view/agents/finalstage.test.ts frontend/app/view/jarvis/recordrunrow.test.ts`
  passes, and `final-stage` passes in an isolated app.

### Task 12: One name per run (P12)
**Depends on:** Task 5, Task 9, Task 11
**Files:** `frontend/app/view/agents/runlineage.ts`, `frontend/app/view/agents/runlineage.test.ts`, `frontend/app/view/agents/leadcard.tsx`, `frontend/app/view/agents/statusline.tsx`, `frontend/app/view/agents/agenttree.tsx`, `frontend/app/view/agents/agentheader.tsx`, `scripts/cdp/scenarios-agent.mjs`, `scripts/cdp/scenarios-runs.mjs`

Spec D12.

**Produces:** `leadDisplayName(agent: Pick<AgentVM, "name">, run: Pick<RunInfo, "title" | "dag"> | undefined): string`
in `runlineage.ts`.

- [ ] **Failing test:** `leadDisplayName` gives `run.title` when `run.dag` is set, and `agent.name` with no dag or
  no run.
- [ ] **Implement:** the lead card header (a `name` override prop on `StatusLine`), the agent tree's lead row and
  the agent header's name use it for a run lead.
- [ ] **Steps, at 1600:** in `lead-card-merge-gate` (`L25 P12`), a held run whose lead tab is named from the goal
  shows the plan title on the card header. In `agent-tree-rail`, the tree's lead row and the agent header show the
  same title.
- [ ] **Done when:** `npx vitest run frontend/app/view/agents/runlineage.test.ts` passes, and
  `lead-card-merge-gate` and `agent-tree-rail` pass in an isolated app.
