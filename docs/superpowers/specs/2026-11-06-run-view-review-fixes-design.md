# Orchestrator run view: live pass fixes (F1-F26)

Source: `C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\run-view\report.md` (gitignored; its screenshots
sit beside it, named by the shot numbers each finding cites). The report's line numbers are older than this tree;
the causes below were re-traced against it.

## Shared rules

- **"The dag has ended"** is `runFinished({ dag: group, status: group.status })` (`agents/runlineage.ts`): status
  `done` or `cancelled`. Every finding below that changes behaviour for an ended dag uses it, never a new
  predicate. Why: one definition already exists and the lead card and runs rail use it.
- **The dag is the owner's single source of truth.** A TaskGroup carries `runid` and `channelid`; the DAG modal
  takes both from the loaded group, never from its opener (F3).
- Logic lands in pure `.ts` beside a test; a `.tsx` only calls it. Existing `@theme` tokens only. Copy is
  sentence case.

## F1: full run history in the modal

- **Decision:** a run's event history loads whole. `wstore.QueryRunEvents` treats `limit <= 0` as "every event"
  and honours any positive limit as given (no 500 cap). `runeventstore.ts` sends no limit and its live append
  stops slicing to 200.
- **Why:** measured on the packaged store (2026-11-06): the largest run holds 333 events / 159 KB, 3072 runs
  average 7. Paging adds a load-more row and a total that the header and Attention must both respect; loading
  everything is one query of at most a few hundred rows, and it fixes the header count, the strip's start, the
  peek's Lifecycle and the Attention count at once. The other callers of `QueryRunEvents` are tests; three of them
  pass 0 (`wstore_runevent_test.go`, `wstore_channelrows_test.go`, `wshserver_resume_test.go`) and read fewer than
  200 events, so they pass unchanged. `TestRunEventPrune`'s comment that names the 200 default is updated.
- No wire type change (the field and its JSON name stay), so no `task generate`; the doc comments on
  `CommandJarvisRunEventsData` and the handler are updated.

## F2: graph keys yield to any modal above the graph

- **Decision:** the DAG modal registers itself on the modal stack (`registerModal(DAG_MODAL_ID)` in
  `dagmodal.tsx` while open; `DAG_MODAL_ID` exported from `dagmodalstate.ts`). The graph's window keydown handler
  (`daggraph.tsx`) returns at once when `!isTopModal(DAG_MODAL_ID)`, before Enter and before `graphKey`.
- **Why:** the Final shots viewer and every `ModalShell` (including the confirm F15 adds) register on that
  stack, so "the DAG modal is the top modal" covers every overlay above the graph instead of naming the viewer's
  atom. A plain `anyModalOpen()` would not do: the run sheet behind the DAG modal is a `ModalShell` and stays
  registered while the modal is open, so it would silence every graph key. Registering also takes Escape from the
  sheet's shell while the DAG modal is on top, which is the layering the modal already intends. Remounting the
  viewer from the modal's state is not needed: with keys stopped, nothing else changes the selection while the
  viewer's backdrop covers the graph.

## F3: a DAG opened from a worker run's sheet

- **Decision:** `DagModalState` is `{ kind: "live"; dagOref: string; error: string }`; `openDagLive(dagOref)`
  and `openDagTask(dagOref, taskId)`. The modal loads the TaskGroup and takes the owner run id (`group.runid`)
  and channel (`group.channelid`) from it for the subtitle, the graph's owner run and the timeline rail. While the
  dag loads it shows the graph skeleton; a dag that no longer exists shows "This DAG no longer exists".
- On a worker run's sheet (`run.taskid` set), the dock button reads **"Open in the run's DAG"** and opens the dag
  with that task selected; the sheet's timeline links do the same.
- **Why:** the caller-supplied run id is what let the worker run masquerade as the owner; deriving it from the
  dag removes the parameter that could disagree. The worker sheet's own mislabels (quick run, totals) are out of
  scope, as the report says.

## F4: an ended dag offers no task actions

- **Decision:** `buildViewData` gives every node `actions: []` once the dag has ended. On an ended dag a failed
  or stalled task's card fact is `"run cancelled"` (cancelled dag) or `"run ended"` (done dag), and
  `chipGroups` labels its attention group `"failed"` instead of `"need you"`.
- **Why:** the engine refuses every task action on a cancelled dag (`pkg/orchestrate/mutation.go`); a button the
  engine refuses is worse than none.

## F5: the timeline of a finished run

- **Decision:** `TimelineRail` takes `ended: boolean`. When ended: the axis ends at the last event, the strip's
  right label reads `ended HH:MM`, the now marker is not drawn, and the "live" status pill is hidden (loading and
  error still show). Times carry a date (`Oct 16 13:59`) when the events span more than one local day or the last
  event is not from today. Durations (the strip's span and gap rows) read `45s`, `12m`, `1h17m`, or `29d`
  (`spanText(ms)`: under an hour minutes, under 48 hours h+m, else whole days).
- **Why:** an ended run has no "now" on its axis; a bare HH:MM across days misorders rows to the eye.

## F6: raw ANSI in Verify output

- **Finding re-traced:** the engine strips colour escapes when it captures command output since `f66af917e`
  (2026-10-16, `tailBuffer.String`). On the packaged store, every dag holding escapes was created on or before
  2026-10-15. The bug left is the stored legacy text.
- **Decision:** strip on read, at the two readers: the Go `lastOutputLine` (feeds the digest's `VerifyLastLine`
  and the Final stage's failure reasons, `final.go`) applies `utilfn.StripANSI` to the whole output before it
  picks the last non-blank line, so a line made only of escapes is skipped rather than returned as `""`; and the
  peek's `verifySection` strips CSI/SGR sequences from the tail with a local
  regex. No store migration.
- **Why:** a migration rewrites every dag blob for a display problem two readers fix in a line each; legacy final
  stage text holds escapes on one dag only and is left as is.

## F7: the review note fills the peek

- **Decision:** the review row carries the whole review note (its verdict prefix kept; no longer `firstLine`),
  clamped to 3 lines with a "Show the whole note" toggle (`PeekRow.clamp`).
- **Why:** it keeps the reviewer's verdict first while the Worker, Verify and Lifecycle blocks stay above the fold.

## F8: a finished task's time and branch facts

- **Decision:** the activity row of a task that is not running, stalled, verifying or reviewing reads
  `worked <span>` (last minus first activity) instead of "first … ago · last … ago"; with neither stamp, no row.
  The peek's meta (`wave/<runid>`) is empty once the task merged, was skipped or cancelled, or the dag ended.
- **Why:** "498h ago" is a fact about the reader's clock; the work's length is a fact about the task. A merged
  task's branch no longer exists.

## F9: model tag hides the card's state word

- **Decision:** the card's meta row keeps `id · state word` in a `flex-none` span; only the fact truncates; the
  tag stays `flex-none` on the right.
- **Why:** DESIGN.md: status is never colour alone.

## F10: "N/M done" counts skipped

- **Decision:** the header reads `<done>/<total> done`, counting `done` only, plus ` · <n> skipped` when any task
  was skipped. `runProgress` stays as it is for progress bars.

## F11: Final node of a cancelled run

- **Decision:** when the dag is cancelled and the stage never started (no `group.final`), the Final node and its
  peek read `did not run · run cancelled`.

## F12: "skipped by you"

- **Decision:** a skipped task's fact is `run cancelled` on a cancelled dag, and empty otherwise (the card then
  shows `t-1 · skipped` with no trailing separator).
- **Why:** the engine records no skipper on the task; the lead skips as often as the human, so "by you" is a
  guess.

## F13: palette "Open the DAG" for finished runs

- **Decision:** the `run:dag` action applies when `t.run.dagoref` is set and opens through the `dag` target (F14).
- **Why:** the run object always carries its dag; the live lineage holds only rostered runs.

## F14: an address for a DAG

- **Decision:** `dag:<oid>` and `dag:<oid>#<taskId>` parse to `{ kind: "dag", dagId, taskId? }`. The router loads
  the dag, opens its owner run's sheet (`group.runid` in `group.channelid`) and the modal on it, with the task
  selected when named. A Ctrl+click peeks the owner run. A dag that does not exist reports "That DAG no longer
  exists". `openRunDag` and the palette route through it. `wsh ui`'s help and the cockpit skill list the kind.

## F15: the header's Cancel

- **Decision:** it calls `confirmCancelRun(group.channelid, group.runid, liveSessions(group), onError)` and shows
  a refusal beside the button. `liveSessions(group)` counts tasks running, verifying or reviewing, plus one for a
  plan review or a Final stage in flight.
- **Why:** the same confirm and the same rule (confirm when sessions are live) as the run sheet and palette.

## F16: the peek over the zoom controls

- **Decision:** the peek's `shift` middleware also shifts on the cross axis (`crossAxis: true`), so the right
  padding (the controls strip) holds when neither side fits. No bottom placement.

## F17: the drawer at 1000x700 and refit on resize

- **Decision:** in the drawer layout the activity strip is not drawn (the rail keeps it). The graph refits to its
  opening view when its pane resizes, until the user pans or zooms it (a move with a user event).
- **Why:** the strip is the drawer's least useful 60 px; a resize that keeps a stale viewport hides the Final
  node.

## F18: the opening view clips large graphs

- **Decision:** `openView` fits the whole graph down to `ZOOM_MIN` when the dag has ended or no task needs you,
  is live or ready; it keeps the focused open at the floor only when such a focus set exists.
- **Why:** both clipped cases in the report (a finished run, a plan-review run whose tasks are all pending) have
  no focus set. An off-screen cue for live runs is not added (no case in the report needs it).

## F19: "next to start" during plan review

- **Decision:** while the dag's status is `plan-review` or `awaiting-plan`, a pending or ready task's fact is
  `waits on plan review`.

## F20: timeline rows that do nothing visible

- **Decision:** a child-run row and the Evidence sealed row first dismiss the DAG modal (`dismissDagModal`), then
  switch the run or scroll to `[data-evidence-block]`. A row whose detail would only repeat its title has no
  detail and no expand. A `lead-wake-failed` row's detail is its `reason`, with its `lines` as preformatted text.

## F21: event counts

- **Decision:** every count is of events: the rail header, each filter chip (the events in its filtered groups)
  and the peek's Lifecycle. For a task, the rail's Task filter count equals the peek's Lifecycle count.

## F22: empty or earlier Final rounds

- **Decision:** the viewer's empty state names where the round ended (`Round 2 ended at Verify, before the Final
  command ran.`). Each "Earlier rounds" line toggles that round's failure detail, and, when the round kept
  screenshots, a `screenshots` link opens the viewer at that round.

## F23: escalate picker label

- **Decision:** with `canInherit={false}` the route picker's empty label is `Pick a model`, decided by a pure
  `emptyRouteLabel(canInherit, inheritedLabel?)` in `agents/route.ts` (the repo has no render tests).

## F24: stage line wrapping

- **Decision:** each stage-line entry is `whitespace-nowrap`; the row wraps between entries (`flex-wrap`, a row
  gap).

## F25: subtitle run id

- **Decision:** `<project> · <runid first 8>`, the id in lowercase (`normal-case`), as the sheet and palette
  show it.

## F26: the avatar over the modal

- **Decision:** the pet's floating sprite is hidden (`invisible`, still mounted, as its WebGL canvas must not
  unmount) while the DAG modal or the Final shots viewer is open.

## Out of scope

The worker run sheet's own labels (F3's "on the same sheet" note), the report's "Cost and tooling" gaps, and a
store migration of legacy ANSI text (F6).
