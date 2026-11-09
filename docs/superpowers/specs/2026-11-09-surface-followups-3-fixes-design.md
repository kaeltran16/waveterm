# Surface review follow-ups, round 3: code fixes (design)

Source: the round-3 follow-up report (F1-F8, initiative effort:fdea6d43, "Surface review on real data"). Each
finding was checked on HEAD 65cd90251 before this spec; all eight still happen. Decisions below are the lead's,
made autonomously (nobody at the cockpit); each says why.

## Global rules

- Every UI fix is proven by a step in an existing CDP scenario for its surface, run at the width where it was
  broken, and seen only in an isolated app (`ARC_FINAL_OUT=<new temp dir> node scripts/cdp/final-verify.mjs
  <scenario>`). Never attach to CDP :9222.
- Logic goes in a pure `.ts` with its `.test.ts`; Go fixes get unit tests.
- Colors and spacing only from the `@theme` tokens in `frontend/tailwindsetup.css`.
- New scenario steps are lettered sub-steps (`19b`), never a renumbering of steps other docs cite.

## D1. F1: the Diff poll re-resolves an unresolved session start

**Checked on HEAD:** `reloadChanges` (`filesstore.ts`) re-reads with `state.ref`, which is `""` while the session
start is unresolved, so the poll keeps measuring from HEAD until the scope is reopened. `ensureSessionStart` caches
only a resolved start, so asking again is cheap and correct.

**Decision:**
- `diffscope.ts` gains a pure decision, `pollAnchor(range, resolvedRef, end, sessionStartTs)` (name is the
  worker's), answering what a poll tick reads with: a session range with no resolved ref and a session start now
  known reads `{ sessionStartTs }`; every other case keeps today's `{ ref, end }`.
- `filesstore.ts` keeps the `ScopeAgent` of the scope's last load (module state beside `current`). A tick on a
  session range with `ref === ""` calls `ensureSessionStart(transcriptPath)` and, when it resolves, loads with the
  session start as a refresh (not an initial load: the user's selection stays). Why not reopen the scope: a reopen
  clears the selection and blanks the list, which is what the poll exists to avoid.
- A tick whose session start still does not resolve behaves exactly as today.
- The surface's existing effect already reloads when the agent's `transcriptPath` changes, so a transcript path
  that appears later is not this fix's case.

**Proof:** `diffscope.test.ts` (the decision), `filesstore.test.ts` (a poll after the start resolves sends
`sessionstartts` and keeps the selection; a poll while it does not resolve sends `ref: ""`). CDP: `diff-scope`
step 19b, after step 19's agent with no session start: the scenario appends a timestamped record to that agent's
transcript, waits past one poll (`FILES_POLL_MS` + margin), and asserts the summary leaves "(no session start
yet)" and reads "worktree against <sha>" with the scope never reopened.

## D2. F2: earlier plan-review rounds' reviewers stay on the dag and in the tree

**Checked on HEAD:** `ReplacePlanReviewProposal` (`pkg/orchestrate/planreview.go`) replaces `g.PlanReview` with a
fresh stage, so the previous round's `Reviewers` are gone; `endedPlanReviewers` (`runlineage.ts`) reads only the
current round.

**Decision (Go):** `waveobj.PlanReviewStage` gains `PastRounds []PlanReviewRound \`json:"pastrounds,omitempty"\``,
`PlanReviewRound{Round int; Reviewers []PlanReviewer}`, oldest first. `ReplacePlanReviewProposal` carries the old
stage's `PastRounds` plus `{pr.Round, pr.Reviewers}` into the new stage. Why on the stage and not a dag-level list
like `PastFinals`: only the reviewers are needed, not each round's plan and spec text, which would double the dag's
size per round. The engine never acts on a past round's reviewers (they all ended before the resubmit), so engine
loops over `Reviewers` stay as they are. `task generate` updates `gotypes.d.ts`.

**Decision (FE):**
- `runlineage.ts`: keep `endedPlanReviewers(run)` as the current round (its lead-card caller in `leadcardmodel.ts`
  depends on that), and add a reader of every round's ended reviewers with their round. `endedRoles` and
  `endedReviewerOf` use it, so a past round's reviewer is focusable and its transcript opens.
- `planReviewerOf` also finds a reviewer in a past round, returning its round; `stageOutcome` then reads a past
  round's reviewer's own verdict instead of the blanket "failed".
- `agenttreemodel.ts`: the done fold lists every round's finished reviewers, oldest round first. A stage row
  carries `round` when the run had more than one plan-review round, and `agenttree.tsx` shows it on the row's
  second line (`failed · round 1`, as the Final verification row's `failed at Final · round 1`); the title stays
  `Plan review · <lens>`. Why not in the title: at the scenario's 1600px the title truncates before the round
  (found while building it). A one-round run's rows read exactly as today (no round), so every existing scenario
  step stays valid.
- The done row's `planReviews` count includes past rounds.
- (Plan-review round 1 finding.) `stageOutcome` returns `accepted` for every plan reviewer of an accepted review
  before it looks the reviewer up. A past round's reviewer reads its own verdict (passed or failed) even in an
  accepted run; only the current round's reviewers read `accepted`. Why: the human accepted the last round, not
  the earlier one, whose verdict is a fact.
- `stageRank`'s rule "an accepted review's earlier round is the reviewers without a lens" no longer holds once
  past rounds carry lenses; finished plan reviewers sort by round instead (oldest first), and the comment says so.

**Proof:** Go: a test that a resubmit keeps round 1's reviewers in `PastRounds` (and a second resubmit, where
allowed, appends). TS: `agenttreemodel.test.ts` with a two-round dag lists both rounds' reviewers in round order,
labelled by round; a one-round dag carries no round. CDP: `agent-tree-rail` gains a step with a two-round fixture
(seed `planreview.pastrounds` on the fixture dag) asserting both rounds' reviewer rows and their round labels at
the scenario's wide width.

## D3. F3: Brainstorm review changed rows keep a readable gist at 1000px

**Checked on HEAD:** the keep-restore row puts both buttons in the row grid's right column beside the gist, so at
1000px the gist column collapses (seen in `brainstorm-check-review-narrow.png`).

**Decision:** below 820px of the review's own width (a container query, not the window's width) a changed row
stacks: the title on line 1, the gist with its cause across the row on line 2, the actions on line 3; the lines
under the row (diff, edit box, call, error) widen with it. Why: at a 1000px window the review is about 404px wide,
and with the 190px title column beside it the gist kept only 87px even with the actions moved under it (measured
while building it), so the title has to move too. At 1600 the row stays as today.

**Proof:** `brainstorm-check-review` step 1e at 1000x700 (the existing `CR_NARROW`): the Constraints row's gist is
at least a readable width (a minimum the worker sets from the measured 1600 layout, e.g. 240px) and its text is
not one word per line; the same step at 1600 asserts the buttons stay beside the gist. Step lettering follows the
existing 1c/1d.

## D4. F4: pkg/wstore lint leftovers

**Checked on HEAD:** `viewRe` (`wstore_dbops.go:36`) has no reference; `wstore_contract_test.go:32` uses
`[]byte(fmt.Sprintf(...))` (gopls: fmtappendf); `wstore_dag.go:56` spells a type argument Go infers.

**Decision:** delete `viewRe` (and its `regexp` import if it becomes unused), use `fmt.Appendf(nil, ...)`, drop
the inferable type argument. No behavior change; the package's tests prove it.

## D5. F5: a stage-end run event carries the final stage's outcome

**Checked on HEAD:** `finishFinal` (`pkg/orchestrate/final.go`) decides passed / unverified / failed but records
no run event; `runRailKind` (`cockpitevents.ts`) can only say "Final command passed".

**Decision:**
- New `waveobj.RunEventKindFinalEnded = "final-ended"`, detail `{"round", "outcome": passed | unverified |
  failed}`, documented beside `final-step` in `runevent.go`. Recorded once per round from `finishFinal`, the one
  place every outcome is decided (verifier verdict, a human's end, a failed command), queued on `afterCommit` so it
  is written only when the outcome persists. Why one choke point: recording at each caller is how a path gets
  missed.
- `runRailKind`: `final-ended` passed reads kind `finished` "final verification passed"; unverified reads kind
  `finished` "final stage unverified"; failed reads kind `failed` "final verification failed". `final-step` keeps
  its mapping unchanged ("Final command passed" and failed steps): cockpit-rail-help and `cockpitevents.test.ts`
  assert it, and it is a true statement about the command. Why the new kind: the rail could never say the stage
  passed, only the command (D6 of the phase 2 spec). A failed stage after a failed step shows both rows: the step
  says what failed, the stage-end says the stage is over.
- Run timeline and record readers (`runtimeline.ts`, `timelinegroups.ts`, `peeklifecycle.ts`' final-stage kinds,
  `dagdigest.ts`' kind list, and any other reader found by grepping `final-step`) know the new kind and describe
  it in the same words.

**Proof:** Go: `final_test.go` cases that a passed, an unverified and a failed stage each record one
`final-ended` with that outcome and round. TS: `cockpitevents.test.ts` maps the three outcomes, and the reader
tests cover the kind. CDP: `cockpit-rail-help` gains a step that seeds a `final-ended` event (passed and
unverified) on its fixture run and asserts the rail's text.

## D6. F6: the Brief composer names a run's lead by the plan title

**Checked on HEAD:** `briefcomposertarget.ts` sets `workerName` and `sessionName` from `lead.name`; the cockpit's
"Message the lead" action (`frontend/app/cockpit/actions/run.ts`) has the same `steerLead.name` in its
"is no longer live" error. Root cause is the same, so both callers go through `leadDisplayName` (`runlineage.ts`).

**Decision:** `resolveBriefComposerTarget` takes the run's `RunInfo` (or its title and whether it has a dag) and
names the lead with `leadDisplayName`; `briefcomposer.tsx` passes it from `runInfoAtom`. `sessionName` keeps its
project-name preference. The cockpit action's error uses `leadDisplayName(t.steerLead, t.info)`.

`briefcomposer.tsx` reads `runInfoAtom(run.id)`, whose value is `RunInfoRead {run, loaded}`: it passes `.run`.

**Plan-review round 1 finding, adopted:** a send that throws inside `fireAndForget` in `briefcomposer.tsx` would eat
the draft and show no status. So a thrown send is treated as not sent: the composer logs the error (never
swallowed), restores the draft, and shows the same "<workerName> is no longer live — nothing was sent." status.
Why: the composer's own comment says it must give the words back rather than eat them.

**Found while building it:** a send to a block that no longer exists does not throw. `AgentPromptCommand`
(`wshserver_agentmsg.go`) returns nil for any block id outside a snapshot store, and delivery fails later in a
goroutine that only logs. So the CDP step makes the send fail by stubbing `AgentPromptCommand` with `failRpc`, and
the server rejecting an unknown block is an open issue on the effort, not this spec's work.

**Proof:** `briefcomposertarget.test.ts`: a dag'd run's target names its plan title, a run with no dag its tab
name. A test for the cockpit action's error text if one exists beside it, else in its model's test. CDP:
`brief-composer-steer-only` step on a dag'd run whose lead's tab name differs from its plan title (the scenario has
no fixture run today, so the step seeds one with the shared run-fixture helpers): a send that cannot reach the
lead's terminal (`AgentPromptCommand` stubbed to fail) restores the draft and shows "<plan title> is no longer live
— nothing was sent." and never the tab name. (The composer's other visible name, line 133 of `briefcomposer.tsx`,
reads "lead" for an orchestrator run, so the error is where a dag'd run's name shows.)

## D7. F7: agent-tree-rail step 9b waits for the tree to settle and asserts no overlap

**Checked on HEAD:** step 9b shoots right after injecting t-1's worker tab and asserts only text.

**Decision:** first measure whether the overlap settles (sample the tree rows' rects over ~2 s after the inject).
If it settles: step 9b waits until two consecutive samples are equal (bounded wait that fails the step), shoots,
and a new step 9c asserts no two tree rows' rects overlap. If it does not settle: fix the tree layout in
`agenttree.tsx` (the AnimatePresence / layout animation that leaves rows stacked) and keep the same 9c assertion.
The worker reports which it was, with the measured samples.

## D8. F8: sessions-list-states waits on the archive's loaded state

**Checked on HEAD:** step 1 loops while `!archive.complete` for 60 s, then asserts the idle cost whatever the
archive's state.

**Decision:** the step first records a separate assertion "the real archive finished loading within <timeout>",
failing when it did not, and asserts the idle-archive budget only after it. The worker measures how long the
archive takes in the isolated app with the real transcript folder and sets the timeout with margin (report the
number). If the measured load is so slow it looks like a defect, the worker reports it as an open issue rather
than raising the timeout without bound.
