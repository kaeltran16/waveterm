# Live-run states, phase 2: fixes for P1-P22

Source: `C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\live-run\report-phase2.md` (gitignored; its `p2-*`
shots and `steps-p2/` drivers sit beside it, and phase 1's `report.md` gives context). The report's Tooling notes
are out of scope.

Every cause below was checked against the code at `d0be5ee41`. The three the report left untraced (P19, P20, P21)
were traced here, and each is a real defect. None of the 22 is dropped as "not a defect": P18 is the one the report
called acceptable, and it gets a wording fix only (D18).

## Shared rules

- Logic is extracted into a pure `foo.ts` with `foo.test.ts` beside it; the `.tsx` stays thin. Go fixes get Go unit
  tests.
- Colors, spacing and shadows come from the `@theme` tokens in `frontend/tailwindsetup.css` only. No new tokens.
- Every UI fix gets a step in an existing CDP scenario for its surface. The step runs at the width where the
  finding was seen (1600x950 unless a decision says 1000x700). It is built the way phase 1 built its steps: a run
  held with `deferstart` in an unborn git repo, so no model starts (`arrangeHeldRun`, `heldStandIn`, `seedHeldRun`
  and `seedDag` in `scripts/cdp/scenarios-shared.mjs`); stage sessions as `fstWriteRun` stand-ins; and page-only
  injections as in `scripts/cdp/live-run-fixture.mjs`. `docs/reference/cdp-run-fixtures.md` is the recipe.
- Stay off the parallel run's files: `frontend/app/view/agents/projectoverview*` and
  `scripts/cdp/scenarios-project-overview.mjs`.

## Decisions

### D1. P1: a transcript stream waits for its folder

**Cause (confirmed):** `streamTranscript` (`pkg/wshrpc/wshserver/transcript.go`) returns
`watching transcript dir: …` when `watcher.Add(filepath.Dir(path))` fails on a folder that does not exist yet. A run
member reports its transcript path before Claude creates `~/.claude/projects/<cwd-slug>/`. `livetranscript.ts`
swallows the error in a bare `catch {}`, and `useCardStreams` keeps the id in `streamedRef`, so nothing restarts it.

**Decision:** fix it at the source, in Go. When the transcript's folder is missing, the stream watches the nearest
existing ancestor. On each `Create` event for the next folder down the path, it moves the watch one level down,
until it is watching the transcript's own folder. Then it reads the file from offset 0, the same backlog read as
today, so lines written before the watch arrived are not lost. If no ancestor exists at all, which means a broken
path, the stream fails as today. The stream sends one empty backlog at once, as it does for a missing file, so the
caller sees it as open. ctx cancellation still ends it at any level.

**Frontend:** `livetranscript.ts` logs a stream that ends in an error, with the agent id, the path and the error
(`console.error`, which reaches `fe-log`), instead of swallowing it. It does **not** restart a failed stream.
**Why:** with D1 the only errors left are real ones (permissions, no ancestor at all), and an automatic restart of
those would loop. The ws-reconnect restart (`restartActiveStreams`) stays as it is.

### D2. P2: Take over answers the lead's relay of the same question

**Cause (confirmed):** a lead relays a worker's product question with its own `AskUserQuestion`; the lead prompt
tells it to (`pkg/jarvis/leadprompt.go`, the "questions:" rule). `TakeOverAsk` (`pkg/orchestrate/queue.go`)
deliberately does not wake the lead. But the lead is blocked on its own question, so that question stays open. The
real relay in this run had the header `Suffix` and a question that opens with "Task t-3 (truncate) needs…".

**Decision:** make the relay identifiable by contract and close it on take-over.
1. The lead prompt's questions rule tells the lead to give a relayed question the header `<task id>` (for example
   `t-3`), exactly and nothing else. Claude's header limit is 12 characters, and task ids fit.
2. `TakeOverAsk`, after the move succeeds, checks the lead's own pending ask (the lead block's oref in
   `agentask.GlobalRegistry`). If every one of its questions has a header equal to the task id (a relay is
   normally one question), the engine answers each of them. A mixed ask is left alone, because answering it would
   also answer a question that is not the relay. The engine answers it
   with a new constant, `jarvis.TakenOverRelayAnswer`: "The human took this question over in the cockpit and
   answers the worker there; relay nothing and carry on." It goes through the same validated background delivery
   that `answerLeadQuestion` (`pkg/orchestrate/autonomous.go`) uses. Generalize that function to take the answer
   text instead of copying it. A delivery failure is recorded as a `lead-wake-failed` event, as there. The take-over
   itself still succeeds, because the worker's question did move.
3. A lead ask whose header is not the task id is never touched. A Plan review or land question can never be
   answered by mistake.

**Why not text matching:** the relay rewords the question (it adds the lead's checks and recommendation), so
matching question text would be fuzzy and could hit the wrong ask. A header contract is exact.

**Label:** a take-over is counted in the dag tally's `forwarded`. The run rail's fact row "Forwarded" and the
digest chip `forwarded N` become "Handed to you" and `to you N`, the words the timeline already uses for
`task-forwarded` (`runtimeline.ts`). This covers both a forward and a take-over, and no wire change is needed.

### D3. P3: the lead card shows the plan review stage

**Cause (confirmed):** `buildLeadCard` builds its rows from `dag.tasks` plus the Final row only.

**Decision:** a "Plan review" row built from `dag.planreview`, before the task rows, in the shape of the Final row:
- **Label:** "Plan review"; the tag adds `round N` when N > 1.
- **While reviewing:** live, tone run, sub naming the lenses still at work (the tree's `planReviewLensTitle`).
- **Failed, waiting on the lead:** live, tone wait, sub "failed · lead deciding".
- **Passed:** a done row, tone ok.
- **Accepted by the human after failing:** a done row in the muted tone, sub "accepted by you" (D14).

Its open target is the current round's newest plan reviewer: live, or ended through `endedReviewerId`. The
activity line "Standing by" is not shown while a plan review is in progress: the line reads
"plan review · round N" instead.

### D4. P4: the doc review dialog keeps section lines

**Cause (confirmed):** `parseDocReview` (`docreview.ts`) keeps only `- ` lines after the first item, so a "Findings I
would not accept:" line between items is dropped.

**Decision:** `items` becomes an ordered list of entries, `{ kind: "item" | "heading", text }`. A non-item line
after the first item is a heading. The dialog renders a heading as a subhead inside the findings list, so a
rejected finding sits under its own heading. Item numbering, quoting and notes still address items only.

### D5. P5: a done task waiting on its lane is not "landed"

**Cause (confirmed):** `taskRow` treats every `done` task that is not `mergestate === "ready"` as landed.

**Decision:** `mergestate === "waiting"` gives a wait row (kind `wait`, muted tone) with sub
`t-2 · lane B · done · lands with <lane tip id>`. The lane tip is the last task of the task's lane in
`digest.lanes`; a task that is its own lane tip (or has no lane) reads `done · waiting to land` instead. Only
`task.merged` (or a missing digest on a finished run) reads "landed".

### D6. P6: the Events rail shows run milestones and the lead's questions

**Cause (confirmed):** `RUN_KIND` (`cockpitevents.ts`) has no mapping for `plan-reviewed`, a non-final
`task-review-failed`, `final-step` or `landed`. `useRailTracking` (`cockpiteventsrail.tsx`) skips every run member,
the lead included.

**Decision:**
- **`plan-reviewed`:** a pass reads as kind `finished` ("plan review passed"), a fail as kind `failed`
  ("plan review failed").
- **`task-review-failed` (not final):** a new rail kind, `sentback`: verb "review sent back", the `text-warning`
  tone, the `CornerDownRight` icon. The final one stays `failed`, so a review still counts as failed once.
- **`final-step`:** only a step that ends the stage maps: `passed` gives `finished` ("final verification passed"),
  and `failed` or `unverified` gives `failed`. Intermediate steps stay off the rail, as task steps are.
- **`landed`:** kind `landed`; `land-held` gives kind `failed` ("land held · <reason>").
- **The lead's own question:** a run lead whose state turns to `asking` makes an `asked` event, with `who` the run's
  title, a focus on the lead's card, and the question as its text. Only the lead's asking transition is tracked:
  workers and reviewers stay covered by their run's events.

### D7. P7: elapsed time never goes negative and ticks each second

**Cause (confirmed):** the card computes `runElapsed` from `structuralNow`, which ticks every 15 s, and
`runElapsed` does not clamp.

**Decision:** `runElapsed` clamps at 0, and 0 reads as an empty string, as today. The card's meta line subscribes
to the model's 1 s `nowAtom` itself and computes the elapsed time there. The rest of `buildLeadCard` stays on
`structuralNow`, which keeps its re-render cost as it is.

### D8. P8: one count of need-you, and run members carry their run's project

**Cause (confirmed):** the engine spawns workers, reviewers and stage sessions with `projectName ""`
(`pkg/orchestrate/engine.go`, `review.go` and `stagesession.go`, through `spawnWorker`), so `session:project` is
empty on their tabs. `projectOf` then falls back to the transcript folder name. The header counts every agent
(`cockpitCounts`), while the tabs count cards (`chipCounts`).

**Decision:**
- **Go:** the engine passes the owner run's project name when it spawns any run member, the same name its lead
  gets: the owning channel's name, as `interrupted.go` and `wshserver_design.go` already pass `ch.Name`. Existing
  member tabs fix themselves at their next spawn; no migration is needed.
- **Frontend:** the header's "need you" count is the number of shown cards that need you: the count the tabs
  already show (`chipCounts` in `cardgridlayout.ts`, over the `cardNeedsYou` closure in `cockpitsurface.tsx`). The
  header reads it instead of deriving its own. `cockpitCounts` keeps its signature for `projectswitcher.tsx`. The project count stays per agent, and
  it is right once members carry their project.

### D9. P9: the footer names the run's worker route while it plans

**Decision:** `RunInfo` carries the lead run's `workerroute`. The footer uses `dag.workerroute`, else the run's
route, else "workers as lead", which is the meaning of a nil route (inherit the lead). "default" is gone.

### D10. P10: sub-second steps read "<1s"

**Decision:** `fmtDuration` (`runcompletion.ts`) returns `<1s` for 0 < ms < 1000. Today it rounds, so 500-999 ms
read "1s"; the new rule applies before the rounding. A 0 or missing duration is handled
by the callers as today.

### D11. P11: the Final pane's Verifier step opens its transcript

**Cause (confirmed):** `stepHasOutput` and `KEPT_STEPS` (`finalstage.ts`) leave out the verifier.

**Decision:** the Verifier step is clickable when the stage has a verifier session, live or ended. It focuses that
session: the live verifier agent, or its ended transcript through the id `finalRowFocusId` already resolves. Its
output panel is not involved, because the transcript is the verifier's output.

### D12. P12: one name per run

**Cause (confirmed):** `RunInfo.title` is `runTitle(run, dag)`, the plan's title once a plan exists, and the events,
rail and Sessions use it. The lead card header, the tree's lead row and the agent header show the lead's tab name,
which comes from the goal.

**Decision:** where a lead stands for its run (the lead card's header line, the agent tree's lead row, the agent
header's name), it is named by its run's title. This goes through one pure helper, `leadDisplayName(agent, run)`:
`run.title` when the run has a dag, else `agent.name`. The tab name itself is not renamed. **Why:** a rename would
overwrite a human's own rename and needs an engine write for a label.

### D13. P13: the real landing branch

**Decision:** `landingBranch` (`runrail.ts`) returns `wave/<full run id>`, the branch `pkg/orchestrate` creates. It
becomes the one source: the lead card footer ("lands on …"), the ended worker banner (`endedLine`) and
`brainstormrunmodel.ts` all call it instead of slicing the id. Long names truncate visually (`truncate`, plus a
`title` with the full name).

### D14. P14: an accepted plan review reads accepted, not failed

**Decision:** when `dag.planreview.state === "accepted"`, every plan-review stage row of that review reads
"accepted by you" in the muted tone, in the tree's done fold and in Sessions. In Sessions, `stageStatus` lets the
stage's `accepted` win over a reviewer's own `failed` verdict. A reviewer's own verdict still shows while the stage
is not accepted. The tree's run line counts these as "N plan reviews", not "N reviews", wherever it counts plan
review sessions.

### D15. P15: an ask takes the lead pane's room

**Cause (confirmed):** the lead pane (`leadcard.tsx`, `max-h-[45%]`) renders even when it holds nothing, and beside
an open ask.

**Decision:** a pure `leadPaneShown({ hasAsk, hasLines, userOpened })`.
- The pane is collapsed to its one-line header while the card shows an ask (a child ask, a doc review, or the lead's
  own question), unless the human opened it during this ask.
- A pane with no transcript lines is not rendered at all.

This is width- and height-independent: no px threshold. The step runs at 1000x700, where the ask clipped.

### D16. P16: "asking you", not "standing by"

**Decision:** `leadStandingBy` is false for a lead whose state is `asking`. `leadActivity` checks `asking` first and
reads "asking you". This covers the mark and the flow bar too, since both use `leadStandingBy`.

### D17. P17: the lead's rail after landing

**Cause (confirmed):** after a land, the run's worktree is removed, so the lead's rail (`agentdetailsrail.tsx`) reads
"Branch —" and "Files touched: Not a git repository".

**Decision:** when the agent is a run lead and its run's `land.state === "landed"`:
- **Branch:** reads "landed on <base> · <short commit>".
- **Files touched:** reads "worktree removed after landing", then the landed commits from the digest's report
  (`report.commits`, one line each: short sha and subject).
- **Other leads and agents:** keep today's text.

### D18. P18: closing a finished run's last tab says it closes the run

**Decision:** in `confirmCloseSession`, a lead that is its run's only open tab, on a finished run, gets the title
"Close run", the confirm label "Close run", and the message:
`"<run title>" has finished and its lead is its last open session. Close it? This can't be undone.`
The action is the same tab close. The decision is a pure helper with a test. The tree's run-row menu is unchanged.
**Why:** the report calls it acceptable; this is the honest-wording fix, with no new flow.

### D19. P19: Sessions does not say "working" for an idle lead

**Cause (traced):** `leadStatus` (`sessionsruns.ts`) says "waiting on engine" only while the dag is open. A live
lead at its prompt on a done dag falls through to "working". `headStatus` says "working" for any live group.

**Decision:**
- **The lead's status:** a live lead at its prompt reads "waiting on engine" while the run is open, else "idle".
- **The head:** on a run that is not open, with a live group, it reads "lead idle" (key `idle`). "working" or
  "planning" stays for an open run.

### D20. P20: Sessions counts each message's tokens once

**Cause (traced):** Claude Code writes one JSONL record per content block of an assistant message, and each record
repeats the message's `usage`. `extractSession` (`pkg/agentsessions/agentsessions.go`) sums the usage of every
record. `usagestats.TranscriptUsage`, which feeds the card and the rail, dedupes by message id first. For this
run's transcripts the per-record sum is 8,103,417 and the deduped sum 3,768,150: the 8.1M and 3.7M seen.

**Decision:** `extractSession` keeps one usage per `message.id`, the record with the largest output (the same rule
as `usagestats.dedupe`). Records without an id still count each. Both numbers then come from the same rule, with no
label change. Pi and Codex sessions are unchanged: their entries do not repeat.

### D21. P21: no unhandled rejection for input to a block without a controller

**Cause (traced):** both log lines are a `ControllerInputCommand` rejected with `no controller found for block`.
- The 16:40:29.128 one came 37 ms before the block's controller registered (`run() lock` at .091, `running` at
  .130).
- The 16:50:26.8 one came 1.3 s after the block's shell exited (16:50:25.57) and before its tab was deleted.
- Most likely both were the terminal's resize (`termwrap.ts` `handleResize`), which calls the RPC with no catch.
  `SendInput` already persists a resize that no process took, and still returns the error.

**Decision:**
- **Go:** `blockcontroller.SendInput` returns nil for a resize-only input (`TermSize` set, no `InputData`, no
  `SigName`) when the block has no controller and the size was persisted. The size is kept for the next start,
  which is the documented outcome, not a failure. Input data to a missing controller is still an error. This
  reverses what `TestSendInputKeepsAResizeNoProcessTook` asserts today ("should still report an error"). No caller
  acts on that error: the frontend's resize is fire-and-forget. So that test flips.
- **Frontend:** the resize call in `termwrap.ts` and `sendDataToController` in `term-model.ts` handle a rejection by
  logging it with the block id (`console.error`), never leaving it unhandled.

### D22. P22: Space on a done row peeks its transcript

**Cause (confirmed):** a row's `peekId` is its live worker only.

**Decision:** a task row's `peekId` is its live worker, else its ended transcript (the row's `openId`, the
`endedWorkerId`) when it has one. A waiting row with neither stays inert. If the peek cannot render an ended id,
Space on such a row opens it as Enter does. The help bar is static and keeps "space peek".

## Not changed

- **Tooling notes:** out of scope.
- **P18's tree menu:** "Close run" on a lead run's row is not added (D18).
- **Restarting a failed transcript stream:** not added (D1).
