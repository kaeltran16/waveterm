# Live-run states, phase 3: fixes for Q1-Q19

Source: `C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\live-run\report-phase3.md` (gitignored; its `p3-*`
shots and `steps-p3/` drivers sit beside it). The report's Tooling notes are out of scope.

Every cause below was checked against the code at `87c41274b`. None of the 19 is already fixed on HEAD. Q18's cause,
which the report left untraced, was traced here (D18).

**Parallel run 5195e068** adds a `final-ended` run event carrying the final stage's outcome (`finishFinal` in
`pkg/orchestrate/final.go`, `runRailKind` in `cockpitevents.ts`, `runtimeline.ts`, `peeklifecycle.ts`,
`timelinegroups.ts`, `dagdigest.ts`, `pkg/waveobj/runevent.go`, scenario `cockpit-rail-help` step P6b). It had not
landed on main when this spec was written (its commit `076b5ae9b` sat on its task branch only). So Q10's verdict half
is that run's, and this spec maps only `dag-blocked {kind: final-failed}` and `task-forwarded` (D10). The two runs
touch the same files in separate hunks; whichever lands second merges them.

## Shared rules

- Logic is extracted into a pure `foo.ts` with `foo.test.ts` beside it; the `.tsx` stays thin. Go fixes get Go unit
  tests.
- Colors come from the `@theme` tokens in `frontend/tailwindsetup.css` only. No new tokens.
- Every UI fix gets a step in an existing CDP scenario for its surface, run at the width where the finding was seen
  (1600x950 unless a decision says 1000x700). Steps are built as phases 1 and 2 built theirs: runs held with
  `deferstart` (`arrangeHeldRun`, `heldStandIn`, `seedHeldRun`, `seedDag` in `scripts/cdp/scenarios-shared.mjs`),
  and page-only injections as in `scripts/cdp/live-run-fixture.mjs` (the digest fields and run events no RPC
  writes). `docs/reference/cdp-run-fixtures.md` is the recipe. Existing steps are never lowered or renumbered; new
  ones are lettered sub-steps or the next number.
- Never attach to the dev app on CDP :9222. Scenarios run only in an isolated app:
  `ARC_FINAL_OUT=<new temp dir> node scripts/cdp/final-verify.mjs <scenario...>`.

## Wire changes (one place, used by many decisions)

- `DagTaskDigest.ForwardedTs int64 json:"forwardedts,omitempty"`: when the lead handed this task's failure to the
  human (D1).
- `DagTaskDigest.VerifyFailLine string json:"verifyfailline,omitempty"`: a verify-failed task's failure line (D5).
- `DagTaskDigest.MergeState` gains the value `held`, and `DagTaskDigest.MergeHeldBy string
  json:"mergeheldby,omitempty"` names the task holding the merge queue (D6).
- `CommandDagActionData.By string json:"by,omitempty"`: `"lead"` from `wsh jarvis dag` (the lead's CLI); empty means
  the human (the cockpit and `wsh runs`). Constant `wshrpc.DagActionBy_Lead = "lead"` (D3).
- Run event kinds in `pkg/waveobj/runevent.go`: `RunEventKindTaskSkipped = "task-skipped"`,
  `RunEventKindTaskEscalated = "task-escalated"`, `RunEventKindFinalRerun = "final-rerun"` (D3). The frontend
  already labels `task-skipped` in `timelinegroups.ts`.

## Decisions

### D1. Q1: a forwarded failure is yours on the card

**Cause (confirmed):** `taskRow` in `leadcardmodel.ts` sets `judge = lead alive`; the failed/stalled branch and the
verify-failed/blocked-merge branch then give no actions and `needsYou: false` ("lead judging", "lead fixing"). Only
`childaskmodel.ts` reads `task-forwarded`. `ForwardTask` (`pkg/orchestrate/queue.go`) writes a `task-forwarded` row
with no `askid` for a failed, stalled, blocked-merge, verify-failed or review-failed task.

**Decision:** the engine says it, once, in the digest. `buildTaskDigest` sets `ForwardedTs` to the newest
`task-forwarded` row for the task that has no `askid`, when the task is in one of those five states and that row is
newer than every row that starts a new attempt or records a new failure for the task: `task-spawned`,
`task-retried`, `task-merge-started`, `task-failed`, `task-verify-failed`, `task-review-failed`. All of these kinds
are already in `dagDigestRetainedKinds`, so no query changes. **Why the digest and not the card's event list:** the
card's events are the UI's 200-row window, which a long run outgrows; the digest's retained read is unbounded by
kind, and every surface (card, Hub, DAG) can read one field.

**Card:** a row whose digest task has `forwardedts` is the human's whatever the lead's state: `needsYou: true`, tag
`needs you`, and the actions it gets with no lead: failed/stalled `retry`, `skip`; verify-failed/blocked-merge
`resolve` (Continue); review-failed `inline: "review"`. The header's need-you count and the Cockpit tab count follow,
since both read the card VM's `needsYou`.

### D2. Q2: Rerun answers the lead's open final-stage question

**Cause (confirmed):** `RerunFinalStage` (`final.go`) only `PostWake`s `finalRerunWake`; the wake is held while the
lead asks (`wake.go`, `leadAsking`), so it arrives after the lead has acted on the human's answer.

**Decision:** after the commit, the rerun answers the lead's own pending question with the rerun line, through
`answerLeadQuestionWith` (`autonomous.go`) with a matcher that accepts every question. **Why every question:** a
failed final stage comes after every task settled, so a question the lead holds then is about the stage; no header
contract identifies it the way D2 of phase 2 did for relays. The answer text is a new constant
`finalRerunAnswer(round)`: "The human reran the final stage of round N in the cockpit; its failure was outside the
code. Drop any fix plan for it; the stage's outcome wakes you." When no question is pending, or the answer does not
validate, the rerun posts the wake at once, as today. The delivery runs in a goroutine, so a delivery that fails later
posts the wake from that goroutine: `answerLeadQuestionWith` gains an `onFail func()` run after it records
`lead-wake-failed`, and returns `(answered bool, err error)`, `answered` meaning a delivery started. Its two other
callers pass `nil` and keep their behavior.

### D3. Q3: your Retry, Skip, Escalate and Rerun write run events

**Cause (confirmed):** `applyActionLocked` (`mutation.go`) appends an event only for approve
(`review-overruled`); `RerunFinalStage` appends none. The RPC carries no actor.

**Decision:** `applyActionLocked` takes the actor (`ApplyAction(ctx, dagID, taskID, action, by string, target)`;
`by` is `"lead"` or `"human"`, the server mapping an empty `By` to `"human"`) and, after the persist, appends:
`task-retried {taskid, auto: false, by}`, `task-skipped {taskid, by}`, `task-escalated {taskid, model, runtime,
by}`. `RerunFinalStage` appends `final-rerun {round}` (only a human reruns). `wsh jarvis dag` sends `By: "lead"`.

**Frontend:** `eventText`/titles in `runtimeline.ts`: "you retried t-2", "you skipped t-3", "you escalated t-3 to
<model label>", "lead retried/skipped/escalated …", "you reran the final stage". Titles `Skipped`, `Escalated`,
`Final stage rerun`; tones from the existing ones. The Events rail gets a new `RailKind` `acted` (icon `Hand` or
`RotateCcw` from lucide, verb "you acted", tone `text-accent-soft` as `told`), used for a human's retry, skip,
escalate, take-over (`task-forwarded` with `by: human`) and the rerun. `peeklifecycle.ts` lists `final-rerun` with
the final stage's kinds; `timelinegroups.ts` labels `task-escalated` "escalated" and `final-rerun` "final rerun".

### D4. Q4: "skipped", not "skipped by the lead"

**Cause (confirmed):** hardcoded at `runsheetmodel.ts` (the `skipped` case). **Decision:** the meta reads
`skipped`. The actor shows in the timeline and Lifecycle through D3. **Why not name the actor here:** the run sheet
model reads no events, and one word in a table row is not worth a new input.

### D5. Q5: a Verify failure's detail never opens on an arbitrary line

**Cause (confirmed):** `failureDetail` (`plancmd.go`) keeps the last bytes of the output when
`firstFailureExcerpt` matches nothing, cut at any byte; the card shows `firstLine(verifyerror)`, so it read
"exit 1: ✔ adds two positive numbers" and the Lifecycle "exit 1: elled 0".

**Decision:** two parts, both keeping the failure markers in Go only.
1. `failureDetail` keeps its shape (`"<reason>: <excerpt or tail>"`, and the short-output `pe.Error()` path as
   is), but a long no-match tail is cut forward to the first line start inside it, so no reader shows a word cut in
   half. **Why not change its shape:** it feeds Setup wakes, basecheck, land and final messages as `(%s)`; only the
   cut point is wrong.
2. The digest gains `DagTaskDigest.VerifyFailLine string json:"verifyfailline,omitempty"` for a `verify-failed`
   task: the first line of `firstFailureExcerpt(t.VerifyOutput)` within `MaxVerifyLineLen`, "" when no line names a
   failure. A pure `verifyFailLine(task, td)` in `runlineage.ts` returns it, else the reason alone (the text of
   `verifyerror`'s first line before its first `": "`, so "exit 1"). The card's verify-failed row, the Hub row and
   the DAG peek read it instead of `firstLine(verifyerror)`. A passing test line is never shown as the failure.

### D6. Q6: the merge gate shows everywhere, and a held gate asks nothing of you

**Cause (confirmed):** `taskMergeState` returns `ready` for a lane tip even while `AutoMergeReady`
(`mergetask.go`) holds every merge behind a verifying, verify-failed or conflicted task; `taskHumanActions` gives it
`merge`, so the Hub lists it as attention. The tree folds a done task into "done" and the rail's lane reads "done".

**Decision:** one helper `mergeQueueHolder(g) (taskID, state string)` in `mergetask.go` names the task holding the
queue, with the conditions `AutoMergeReady` uses: a `verify-failed` task, a conflict awaiting `--continue`
(`conflictAwaitingContinue`), or a `verifying` task. `AutoMergeReady` uses it too, so the two cannot disagree. A
ready tip while a holder exists reads `MergeState: "held"`, `MergeHeldBy: <holder>`, no `HumanActions`, is not
counted in `Counts.MergeReady`, and `buildNext` does not name it as `merge-ready`. `wsh jarvis dag status` prints
it as "merge held: waits on t-4's Verify".

**Frontend:** one pure helper `mergeGateLine(run, taskId)` in `runlineage.ts`: `"merge ready"` for a `ready` tip;
for `held`, `"merge ready · waits on t-4's Verify"`, `"… on t-4's failed Verify"` or `"… on t-4's merge conflict"`
by the holder's state; undefined otherwise. The card's merge-gate row (ready or held), the tree (a ready or held tip
stays a live row, not folded into done, with this line as its sub and a wait dot) and the rail's lane (this line as
its text, `pending` state) all read it. The Hub's attention queue already lists only `ready`, so a held tip drops out
of it; its task row's meta reads `mergeGateLine`.

### D7. Q7: Merge is not offered while it cannot run, and its refusal is plain

**Cause (confirmed):** the refusal is `claimProject`'s `"project checkout is busy: task t-4 of dag <uuid> is
landing"` (`verify.go`). The DAG's Merge button comes from `mergeReadyIds` (`mergestate === "ready"`).

**Decision:** with D6 a held tip is not `ready`, so `mergeReadyIds` drops it and the DAG offers no Merge. A manual
`MergeTask` on a held tip of the same dag is refused before any claim with `"task t-2 waits on task t-4's Verify"`
(or failed Verify / merge conflict). It is a typed `mergeHeldError{tip, holder, what string}` whose `Is(target)`
matches `errProjectBusy`, so `errors.Is` callers keep working while its text does not contain "project checkout is
busy". `claimProject` keeps its signature and its `%w` wrap; its message drops the dag uuid: "task t-4 is merging or
verifying" for the same dag, "another run is landing in this checkout" for a different one. **Why not name the
other run:** a `landing` knows its run id only once its Verify starts, and the land's claim never has one.

### D8. Q8: Hub attention chips in words

**Cause (confirmed):** `AttentionRow` in `runsheet.tsx` renders `entry.actions.join("/")`. **Decision:** render
`actionWords(entry.actions)` from `dagdigest.ts` ("resolve and continue", "retry / skip / escalate").

### D9. Q9: a card refusal says the action's words and goes when its cause does

**Cause (confirmed):** `dagAction` labels the error `${action} ${taskId}` (`leadcardactions.ts`);
`runCardErrorAtom` clears only when another action starts.

**Decision:** the action labels the card already uses (`ACTION_LABEL` in `leadcard.tsx`) move to
`leadcardmodel.ts` as the one map (`Take over`, `Retry`, `Skip`, `Continue`, `Approve`, `Send back`, `Tell`), and the
error reads `"<Label> t-4: <message>"`. A task action's error records the task id and a stamp of that task's state
and ask id when raised; the card shows it only while the task's current stamp matches (pure
`cardErrorShown(err, run)` in `leadcardmodel.ts`). Errors with no task (adjust, cancel) keep today's behavior.

### D10. Q10: the rail shows forwarded failures and a failed final stage

**Cause (confirmed):** `runRailKind` (`cockpitevents.ts`) maps neither `dag-blocked {kind: final-failed}` nor
`task-forwarded`. **Decision:** `dag-blocked` with `kind: final-failed` → `failed`, "final stage failed";
`task-forwarded` without `by: human` → `asked`, its `eventText` ("t-4 handed to you · <note>"); with `by: human` →
`acted` (D3). Other `dag-blocked` kinds stay off the rail. The verifier's verdict is 5195e068's `final-ended`.

### D11. Q11: Rerun is offered where the failure is put to you

**Cause (confirmed):** `finalFailedWake` (`queue.go`) never names the rerun in its non-autonomous texts; the stage
pane's footer (`finalstagepane.tsx`) always says "The lead has this failure and decides what happens next".

**Decision:** both non-autonomous `finalFailedWake` texts add: "If the failure is outside the code (a service down,
a tool missing), offer the human `Rerun final stage` (the stage pane's button, or `wsh runs rerun-final <run>`): a
rerun spends no round." The pane's footer comes from a pure `finalFailedNote(lead)` in `finalstage.ts`: lead asking
→ "The lead is asking you about this failure. Rerun it if the failure was outside the code."; lead present → today's
line; no lead → "This failure is yours. Rerun it if the failure was outside the code."

### D12. Q12: progress does not count a skipped task as done

**Cause (confirmed):** `runProgress` (`runlineage.ts`) counts done or skipped. **Decision:** `runProgress` also
returns `skipped` (additive; its other readers keep their numbers). The card's progress reads `<done − skipped>/
<total>` and appends ` · N skipped` when N > 0, through a pure `progressText` in `leadcardmodel.ts`: "4/5 · 1
skipped". **Why only the card:** six other readers use `runProgress` for bars and history; the finding is the card's.

### D13. Q13: a task that failed before its worker started says why

**Cause (confirmed):** `taskPeek` (`dagpeek.ts`) shows only `last failure: <kind>`; the reason is in the
`task-failed` event's `detail` (dispatch failures carry one). `WorkerSession` (`dagtaskpeek.tsx`) says "Not
dispatched yet" for a failed task with no run.

**Decision:** pure `taskFailureDetail(events, taskId)` in `dagpeek.ts`: the newest `task-failed` row's `detail` for
the task. The peek's `last failure` row appends it (clamped). A failed task with no run reads "Never dispatched ·
failed at <kind>" instead of "Not dispatched yet".

### D14. Q14: the merge-gate row's button says "Open transcript"

**Cause (confirmed):** the ready row sets no `openLabel`. **Decision:** it sets `openLabel: "Open transcript"`.

### D15. Q15: "updated just now", not "just now ago"

**Cause (confirmed):** `effortdetailview.tsx` appends " ago" to `formatAge`. **Decision:** use `formatAgo`
(`agentsviewmodel.ts`).

### D16. Q16: initiative notes name work by its short id, and the Notes count agrees with "last note"

**Cause (confirmed):** `applyEffortOps` (`pkg/jarvis/effortops.go`) writes `op.Kind+" attached: "+op.ORef` and
`"detached: "+op.ORef`. The Notes header counts `feed.filter(e => e.text !== "")`, which drops the status marks the
Brief row calls its last note.

**Decision:** the notes read `run 5f2d916b attached` / `run 5f2d916b detached` (kind, the oref's id cut to 8
characters, the verb). Stored notes stay as they are. The Notes count comes from a pure `noteCount(feed)` in
`effortfeed.ts` that counts every entry the feed renders as a note row, marks included.

### D17. Q17: after landing, the footer says where it landed

**Cause (confirmed):** `buildLeadCard` always adds `lands on <branch>`. **Decision:** once
`leadLandFacts(run)` (`leadland.ts`) is non-null, the settings line uses its `branch` ("landed on main · c2c0149")
and its title the same.

### D18. Q18: failed task rows in the tree read as failed, and a click goes somewhere

**Cause (traced):** `WorkerRow` (`agenttree.tsx`) draws `bg-muted` when the task has no agent and the agent's own
state dot otherwise, never by task state; its click does nothing when `rowFocusKey` is undefined, which it is for a
task that failed before any session existed (`failedWithTranscript` false).

**Decision:** a task in `failed`, `verify-failed`, `blocked-merge` or `review-failed` draws an error dot
(`bg-error`) and its sub in `text-error`; `stalled` draws a warning dot. A row with nothing to open opens the run's
DAG at the task (`openRunDag(model, run, taskId)` from `runrailsections.tsx`). The tone choice is a pure
`workerRowTone(task)` in `agenttreemodel.ts`.

### D19. Q19: the doc review dialog says what the lead proposed

**Cause (confirmed for the title only):** `DOC_REVIEW_COPY.review.title` fixes "…Proceed with these fixes?" whatever
the lead proposed. The button already renders the lead's own approve option label (`docreviewdialog.tsx`,
`cleanLabel`, "(Recommended)" stripped, copy fallback); the shot's "Accept all and proceed" was the lead's own
option, which the lead prompt names.

**Decision:** the review title becomes "The plan review failed twice. Proceed as the lead proposes?". The button is
unchanged; the CDP step asserts it reads the lead's label, which passes on HEAD.
