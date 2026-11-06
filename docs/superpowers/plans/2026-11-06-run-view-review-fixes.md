# Orchestrator run view live pass fixes Implementation Plan

**Spec:** `docs/superpowers/specs/2026-11-06-run-view-review-fixes-design.md` (each finding's re-traced cause and the decision taken; read your findings' sections before starting)
**Verify:** `node scripts/verify.mjs ./pkg/wstore ./pkg/orchestrate ./pkg/wshrpc/wshserver ./cmd/wsh/cmd`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs dag-lifecycle dag-observability dag-peek dag-motion plan-review-rounds final-shots palette-actions`

**Goal:** Fix findings F1-F26 of the orchestrator run view live pass (`C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\run-view\report.md`, gitignored; screenshots beside it named by shot number), each UI fix proven by a step in an existing CDP scenario at the width where it broke, each Go fix by a unit test.

**Architecture:** Six tasks start at once, split by file ownership: Go and the event store (F1, F6 Go half); the DAG modal's owner and its ways in (F3, F13, F14, F25); graph facts, actions, cards and header (F4, F8 meta, F9, F10, F12, F15, F19); the task peek (F6 view half, F7, F8 activity, F16, F23); the Final stage views (F11, F22). The graph viewport, keys and overlays (F2, F17 refit, F18, F24, F26) follow the graph task, whose `daggraph.tsx` and `dagcanvas.ts` they share, and the modal task, whose registration on the modal stack the key guard reads. The timeline rail (F5, F17 drawer, F20, F21) follows the modal task, whose `dagmodal.tsx` renders the rail. The scenario steps for `scripts/cdp/scenarios-runs.mjs` come last, one task, written against the `data-*` hooks the code tasks add (every scenario here lives in that one file, so the steps cannot be spread across the code tasks without serializing them). React 19 + Tailwind 4 + jotai; logic in pure `.ts` files with tests beside them.

## Global Constraints

- "The dag has ended" is `runFinished({ dag: group, status: group.status })` from `frontend/app/view/agents/runlineage.ts`; no new predicate for it (spec, Shared rules).
- Logic goes in a pure `.ts` with its test beside it, or a Go function with a `_test.go` beside it; a `.tsx` only calls it. A class-name-only change is proven by a scenario step.
- Existing `@theme` tokens only (`frontend/tailwindsetup.css`); no new token and no edit to `tailwindsetup.css`. Copy is sentence case (DESIGN.md).
- Each `data-*` hook named below is added if no hook on that element exists; when one exists, use it and say so in your commit body, since Task 8 selects on these names.
- Never attach to or kill a dev app on :9222; live checks run only through Final (`final-verify.mjs`'s isolated app). Workers do not run Final.
- Every line number below is pre-edit; anchor on the quoted code.
- Out of scope: the worker run sheet's own labels (F3's side note), the report's "Cost and tooling" section, a store migration of legacy ANSI text.

## Review Focus

1. F3: no caller can open the modal with an owner that disagrees with the dag; the subtitle, graph owner and timeline all read `group.runid` / `group.channelid` (Task 2 tests).
2. F1: `QueryRunEvents` with limit 0 returns every event; a positive limit is still honoured (Task 1 test). The live append no longer drops events.
3. F4/F12/F19: the card facts and actions for a running dag are unchanged (existing `dagcanvas.test.ts` / `dagstore.test.ts` cases stay green, unchanged).
4. F2: the graph keeps its keys when no modal is open (an existing keyboard step in `dag-peek` or `dag-lifecycle` still passes) and drops them while one is.
5. F14: `dag:<oid>#<taskId>` and a missing dag are both handled; `dag:` with an empty id is unsupported (Task 2 tests).

---

### Task 1: Whole run history; Verify last line without escapes (F1, F6 Go half)
**Depends on:** none
**Files:** `pkg/wstore/wstore_runevent.go`, `pkg/wstore/wstore_runevent_test.go`, `pkg/wshrpc/wshrpctypes_jarvis.go`, `pkg/wshrpc/wshserver/wshserver_jarvis.go`, `pkg/wshrpc/wshserver/wshserver_jarvis_test.go`, `pkg/orchestrate/plancmd.go`, `pkg/orchestrate/plancmd_test.go`, `frontend/app/view/agents/runeventstore.ts`

Decisions: spec F1 and F6.

- [ ] **F1 store:** `QueryRunEvents(ctx, channelId, runId, limit)` (`wstore_runevent.go`, "if limit <= 0 || limit > 500"): `limit <= 0` returns every event (no `LIMIT` clause, or `LIMIT -1`), a positive limit is used as given. Update its doc comment, `CommandJarvisRunEventsData`'s comment ("limit 0/absent -> 200, capped at 500"), the handler's ("Bounded read") and `TestRunEventPrune`'s comment where it names the 200 default. No wire type change: no `task generate`. The three tests that pass 0 (`wstore_runevent_test.go`, `wstore_channelrows_test.go`, `wshserver_resume_test.go`) read fewer than 200 events and stay green unchanged.
- [ ] **F1 frontend:** `runeventstore.ts` `load` sends no `limit`; the live append (`next.slice(0, 200)`) keeps every event.
- [ ] **F6 Go:** `lastOutputLine` (`plancmd.go`) applies `utilfn.StripANSI` to the whole output before it picks the last non-blank line, so a last line made only of escapes is skipped, not returned as `""`. It feeds the digest's `VerifyLastLine` and the Final stage's failure reasons (`final.go`, the two `lastOutputLine(...)` calls), which both read clean for a legacy record.
- [ ] **Tests:** `TestQueryRunEventsAllWhenNoLimit` in `wstore_runevent_test.go`: 250 events for one run → limit 0 returns 250 newest-first; limit 10 returns 10. `TestJarvisRunEventsCommand` gains a case: no `Limit` returns all events written. `TestLastOutputLineStripsANSI` in `plancmd_test.go`: `"ok\n\x1b[32m✓\x1b[39m done\n"` → `"✓ done"`; `"real line\n\x1b[39m\x1b[22m\n"` → `"real line"`.
- [ ] Run `go test ./pkg/wstore -run 'TestQueryRunEvents'`, `go test ./pkg/wshrpc/wshserver -run '^TestJarvisRunEventsCommand$'`, `go test ./pkg/orchestrate -run '^TestLastOutputLine'`: PASS. Run `task check:ts`: clean.
- [ ] Scenario steps: `dag-observability` F1 step (Task 8) counts the published history in the rail.

### Task 2: The DAG modal takes its owner from the dag; ways in (F3, F13, F14, F25)
**Depends on:** none
**Files:** `frontend/app/view/orchestrate/dagmodalstate.ts`, `frontend/app/view/orchestrate/dagmodalstate.test.ts`, `frontend/app/view/orchestrate/dagmodal.tsx`, `frontend/app/view/jarvis/runsheet.tsx`, `frontend/app/view/agents/runrailsections.tsx`, `frontend/app/view/agents/leadcard.tsx`, `frontend/app/cockpit/actions/run.ts`, `frontend/app/cockpit/actions/run.test.ts`, `frontend/app/cockpit/palette-items.ts`, `frontend/app/cockpit/palette-items.test.ts`, `frontend/app/view/jarvis/address.ts`, `frontend/app/view/jarvis/address.test.ts`, `frontend/app/view/jarvis/openref.ts`, `frontend/app/view/jarvis/openref.test.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `frontend/app/store/keybindings/dispatcher.test.ts`, `cmd/wsh/cmd/wshcmd-ui.go`, `skills/cockpit/SKILL.md`, `cmd/wsh/cmd/claude-mod/skills/cockpit/SKILL.md`, `scripts/cdp/scenarios-palette.mjs`

Decisions: spec F3, F13, F14, F25.

- [ ] **Interface (Tasks 6, 7 and 8 rely on it):** `DagModalState = { kind: "live"; dagOref: string; error: string }`; `openDagLive(dagOref: string): void`; `openDagTask(dagOref: string, taskId: string): void`; the `open-live` action carries `dagOref` only. `export const DAG_MODAL_ID = "dag-modal"` in `dagmodalstate.ts`. `dagmodal.tsx` loads the TaskGroup (`useWaveObjectValue<TaskGroup>(state.dagOref)`) and passes `group.channelid` / `group.runid` to `ModalSubtitle`, `ModelPicksBanner` (`runId`, ~104), `LiveDagModal` (which loads `run:<group.runid>`) and `TimelineRail` (`channelId={group.channelid} runId={group.runid}`); every `state.runId` / `state.channelId` read goes.
- [ ] **F2 half (spec F2):** while the modal is open, `dagmodal.tsx` registers `DAG_MODAL_ID` on the modal stack (`registerModal` from `@/app/modals/modalstack`, in an effect gated on the open state, unregistering on close). The run sheet's `ModalShell` underneath then no longer owns Escape while the modal is on top; check the modal's existing Escape layering (selection first, then close; the shots viewer above it) still holds by reading `escapeDagModal`'s binding path, and keep it so. While the dag loads: the graph skeleton and no rail; a dag that loaded as null: the text `This DAG no longer exists` in the graph's place. `window.__waveDagModalFixture.setState` takes the new shape.
- [ ] **F3 callers:** every `openDagLive` / `openDagTask` call drops its channel and run arguments (`runsheet.tsx` ~628, ~715, ~780, ~839, ~1107; `runrailsections.tsx` ~134-136). On a sheet whose run has `taskid` (a worker run), the dock button reads `Open in the run's DAG` and calls `openDagTask("dag:" + run.dagoref, run.taskid)`; the sheet's "open the full timeline" link does the same. Hook: `data-run-sheet-open-dag` on the dock button.
- [ ] **F25:** `ModalSubtitle` renders `<project> · <runId.slice(0, 8)>` with the id in a `normal-case` span. Hook: `data-dag-modal-subtitle` on the `<p>`, `data-dag-modal-runid` on the id span.
- [ ] **F14:** `address.ts` parses `dag:<oid>` → `{ kind: "dag", dagId }` and `dag:<oid>#<taskId>` → `{ kind: "dag", dagId, taskId }` (an empty oid → unsupported). `openref.ts` handles the `dag` target: load `dag:<dagId>`; if missing, `unavailable("That DAG no longer exists")`; else open the owner run's sheet as `openRunDag` does today (channel target with `runId: group.runid`, `group.channelid`), then `openDagTask` / `openDagLive`, and the `returnWhenClosed("dag", …)` cleanup. A Ctrl+click peek of a dag target peeks its owner run. `openRunDag(model, run, taskId?, event?)` becomes a call into this path with `run.dag.oid`. Add the kind to `wshcmd-ui.go`'s `Short` text and `skills/cockpit/SKILL.md`'s address list (`dag:<oid>[#<taskId>]`), then `task sync:claudemod` and commit the copy.
- [ ] **F13:** `run:dag` (`cockpit/actions/run.ts` ~117) applies when `t.run.dagoref` is set and opens the dag target for `t.run.dagoref`. `palette-items.ts`'s call (~314) routes the same way.
- [ ] **Tests:** `address.test.ts`: `dag:abc` → `{ kind: "dag", dagId: "abc" }`; `dag:abc#t-2` → with `taskId: "t-2"`; `dag:` → unsupported. `dagmodalstate.test.ts`: `openDagTask("dag:x", "t-1")` leaves state `{ kind: "live", dagOref: "dag:x" }` and selection `t-1`; update the existing `runId` expectations; `DAG_MODAL_ID` is a non-empty string. `run.test.ts`: `run:dag` applies to a run with `dagoref` and no lineage `info`; not to a run without `dagoref`. `openref.test.ts`: a `dag` target whose dag loads with `runid: "r1", channelid: "c1"` opens the channel `c1` sheet on run `r1` and the modal on `dag:<id>` with the task selected; a missing dag returns the reason. Update `palette-items.test.ts`, `bindings.test.ts`, `dispatcher.test.ts` to the new state shape.
- [ ] **Scenario step in `palette-actions` (`scripts/cdp/scenarios-palette.mjs`), at 1600x950,** numbered after its last step: F13: a run whose dag is done and that is not on the roster lists `Open the DAG` among its applicable actions (not under "Not now"), and running it shows the DAG modal with that dag (`[data-dag-modal-subtitle]` holds the run's 8-char id). Clear the viewport override in the scenario's teardown or a `finally`.
- [ ] Scenario steps for F3, F14 and F25 are added by Task 8 in `dag-lifecycle`; do not edit `scripts/cdp/scenarios-runs.mjs` here.
- [ ] Run `npx vitest run frontend/app/view/jarvis/address.test.ts frontend/app/view/jarvis/openref.test.ts frontend/app/view/orchestrate/dagmodalstate.test.ts frontend/app/cockpit/actions/run.test.ts frontend/app/cockpit/palette-items.test.ts frontend/app/store/keybindings/bindings.test.ts frontend/app/store/keybindings/dispatcher.test.ts`: PASS. Run `node --check scripts/cdp/scenarios-palette.mjs` and `task check:ts`: clean.

### Task 3: Graph facts, actions, cards and header for ended and plan-review dags (F4, F8 meta, F9, F10, F12, F15, F19)
**Depends on:** none
**Files:** `frontend/app/view/orchestrate/dagstore.ts`, `frontend/app/view/orchestrate/dagstore.test.ts`, `frontend/app/view/orchestrate/dagcanvas.ts`, `frontend/app/view/orchestrate/dagcanvas.test.ts`, `frontend/app/view/orchestrate/dagnodes.tsx`, `frontend/app/view/orchestrate/daggraph-header.tsx`, `frontend/app/view/orchestrate/daggraph.tsx`

Decisions: spec F4, F8 (meta), F9, F10, F12, F15, F19.

- [ ] **F4 actions / F8 meta:** `buildViewData` (`dagstore.ts`): every node's `actions` is `[]` once the dag has ended. `meta` is `wave/<runid>` only while the task is not merged, not skipped or cancelled, and the dag has not ended; else `""`.
- [ ] **Facts (F4, F12, F19):** `FactCtx` gains `dagStatus: string`; `daggraph.tsx`'s `factOf` call (~181) passes `group.status`. In `factOf`: `failed` / `stalled` on an ended dag → `run cancelled` (status cancelled) or `run ended` (status done); `skipped` → `run cancelled` on a cancelled dag, else `""`; `waitingFact` on status `plan-review` or `awaiting-plan` (and no ask) → `waits on plan review`. Every running-dag fact is unchanged.
- [ ] **F4 chips:** `chipGroups(tasks, ended: boolean)`: when ended, the attention group's label is `failed`. `daggraph-header.tsx` passes it.
- [ ] **F9:** the card's meta row (`dagnodes.tsx` ~141-150): `{task.id} · {word}` in a `flex-none` span (hook `data-dag-node-word` on the word span), then ` · {fact}` in a `min-w-0 truncate` span (hook `data-dag-node-fact`; not rendered when the fact is `""`), then the tag (`flex-none`, unchanged).
- [ ] **F10:** `progressText(tasks): string` in `dagcanvas.ts`: `"<done>/<total> done"` counting `done` only, plus `" · <n> skipped"` when n > 0. The header's line uses it (hook `data-dag-progress` on that line). `runProgress` is unchanged.
- [ ] **F15:** `liveSessions(group): number` in `dagcanvas.ts`: tasks in `running`, `verifying` or `reviewing`, plus 1 when `planreview.state === "reviewing"`, plus 1 when `final.state` is `checking`, `final` or `verifying`. The header's Cancel calls `confirmCancelRun(group.channelid, group.runid, liveSessions(group), setError)` (`agents/runactions.ts`) and shows a refusal in a `text-warning` line beside it. Hooks: `data-dag-cancel` on the button, `data-dag-cancel-error` on the line.
- [ ] **Tests** (`dagcanvas.test.ts`, `dagstore.test.ts`): a cancelled dag's failed task → `actions: []`, fact `run cancelled`; a done dag's stalled task → `run ended`; a running dag's failed task keeps `["retry","skip","escalate"]` and `attempt 1 · retry or skip`; skipped on a cancelled dag → `run cancelled`, on a running dag → `""`; a pending task with all deps done on a `plan-review` dag → `waits on plan review`, on a running dag → `next to start`; `chipGroups` of one failed task with `ended` → label `failed`, without → `need you`; `progressText` of 7 skipped → `"0/7 done · 7 skipped"`, of 3 done 1 pending → `"3/4 done"`; `liveSessions` of 2 running + a reviewing plan review → 3, of an all-done dag → 0; a merged task's `meta` → `""`.
- [ ] Run `npx vitest run frontend/app/view/orchestrate/dagcanvas.test.ts frontend/app/view/orchestrate/dagstore.test.ts`: PASS. Run `task check:ts`: clean.
- [ ] Scenario steps: `dag-peek` F4, F9 and `plan-review-rounds` F10, F12, F15, F19 (Task 8).

### Task 4: The task peek: review note, finished-task facts, placement, Verify text, escalate label (F6 view half, F7, F8 activity, F16, F23)
**Depends on:** none
**Files:** `frontend/app/view/orchestrate/dagpeek.ts`, `frontend/app/view/orchestrate/dagpeek.test.ts`, `frontend/app/view/orchestrate/dagtaskpeek.tsx`, `frontend/app/view/agents/routepicker.tsx`, `frontend/app/view/agents/route.ts`, `frontend/app/view/agents/routepicker.test.ts`

Decisions: spec F6, F7, F8 (activity), F16, F23.

- [ ] **F7:** the review row in `taskPeek` (`const reviewNote = firstLine(task.reviewnote)`) carries the whole trimmed `reviewnote` (not `firstLine`), its `review<verdict>: ` prefix kept. `PeekRow` gains `clamp?: boolean`, set on the review row. `dagtaskpeek.tsx` renders a clamped row with `line-clamp-3` and, when it overflows, a `Show the whole note` / `Show less` toggle. Hooks: `data-peek-review-note` on the row, `data-peek-review-toggle` on the toggle.
- [ ] **F8 activity:** `activityText` (`dagpeek.ts` ~141): for a task in `running`, `stalled`, `verifying` or `reviewing`, today's text; for any other state with both stamps, `worked <formatElapsed(last − first)>`; with only one stamp or none, no row. Hooks: `data-peek-activity` on that row, `data-peek-meta` on the meta (which Task 3 empties for merged tasks).
- [ ] **F6 view:** `verifySection`'s `tail` has CSI/SGR escapes removed (a local regex matching `\x1b\[[0-9;?]*[ -/]*[@-~]`, the same as `utilfn.StripANSI`'s CSI rule). Hook: `data-peek-verify-tail` on the tail block.
- [ ] **F16:** `peekMiddleware`'s `shift` gets `crossAxis: true`.
- [ ] **F23:** `emptyRouteLabel(canInherit: boolean, inheritedLabel?: string): string` in `agents/route.ts`: an explicit `inheritedLabel` wins; else `Inherit route` when `canInherit`, `Pick a model` when not. `RoutePicker` drops its `inheritedLabel = "Inherit route"` default and uses the helper for its face (~93) and its inherit row (~255). Hook: `data-route-picker-empty` on the face's element when it shows the empty label.
- [ ] **Tests:** `dagpeek.test.ts`: a done task with `firstactivity` 1_000_000 and `lastactivity` 1_000_000 + 8 min → row `worked 8m`; a running task keeps the `ago` text; a review note of three lines (`"verdict line\nsecond\nthird"`) gives one row with `clamp: true` whose text contains `second` and `third` and starts with `review`; `verifySection` of a done task whose `verifyoutput` is `"\x1b[2m > \x1b[22mok\x1b[32m ✓\x1b[39m"` → tail `" > ok ✓"` trimmed; `peekMiddleware(...)` includes a shift with `crossAxis: true` (read its `options`). `routepicker.test.ts` (it already tests `route.ts` helpers): `emptyRouteLabel(false)` → `Pick a model`; `emptyRouteLabel(true)` → `Inherit route`; `emptyRouteLabel(false, "Same as lead")` → `Same as lead`.
- [ ] Run `npx vitest run frontend/app/view/orchestrate/dagpeek.test.ts frontend/app/view/agents/routepicker.test.ts`: PASS. Run `task check:ts`: clean.
- [ ] Scenario steps: `dag-peek` F6, F7, F8, F16, F23 (Task 8).

### Task 5: Final stage: cancelled before it ran, empty and earlier rounds (F11, F22)
**Depends on:** none
**Files:** `frontend/app/view/agents/finalstage.ts`, `frontend/app/view/agents/finalstage.test.ts`, `frontend/app/view/agents/finalstageviews.tsx`, `frontend/app/view/agents/finalstagerail.tsx`, `frontend/app/view/agents/finalstagepane.tsx`, `frontend/app/view/orchestrate/dagfinalpeek.tsx`, `frontend/app/view/jarvis/finalshotsviewer.tsx`, `frontend/app/view/jarvis/finalshotsmodel.ts`, `frontend/app/view/jarvis/finalshotsmodel.test.ts`

Decisions: spec F11, F22.

- [ ] **F11:** in `finalStageView` (`finalstage.ts` ~389-398), when `group.status === "cancelled"` and `group.final` is absent, `headline` and `nodeMeta` are `did not run · run cancelled` and `subline` is `did not run`, ahead of the `waitsOn` and `starting` branches.
- [ ] **F22 lines:** `FinalRoundLine` gains `detail: string` (that round's failure detail, `""` when none) and `hasShots: boolean`. `PastRound` (`finalstageviews.tsx` ~287) becomes a disclosure: clicking the line toggles its detail (preformatted, scrolls inside); when `hasShots`, a `screenshots` link opens `FinalShotsViewer` at that round. `FinalPastRounds` / `FinalOutcome` take the `group: TaskGroup` they need for it as a required prop; update every caller: `dagfinalpeek.tsx` (~157), `finalstagerail.tsx` (~63), `finalstagepane.tsx` (~93) and the two inside `finalstageviews.tsx` (~344, ~347). Hooks: `data-final-past-round={round}` (exists) on the line, `data-final-past-round-detail` on the detail, `data-final-past-round-shots` on the link.
- [ ] **F22 empty state:** `emptyRoundText(final: FinalStage | undefined): string` in `finalshotsmodel.ts`: a round that ended at a step before the Final command → `Round <n> ended at <step title>, before the Final command ran.`; otherwise `No screenshots`. The viewer's empty state (`finalshotsviewer.tsx` ~195) renders it (hook `data-final-shots-empty`) from the round's entry in `final` / `pastfinals`.
- [ ] **Tests:** `finalstage.test.ts`: a cancelled group with no `final` → headline `did not run · run cancelled`; a running group with no `final` and pending tasks still reads `waits on every task`; a past round failed at Verify has its detail and `hasShots: false`. `finalshotsmodel.test.ts`: `emptyRoundText` of round 2 failed at Verify → `Round 2 ended at Verify, before the Final command ran.`; of an undefined final → `No screenshots`.
- [ ] Run `npx vitest run frontend/app/view/agents/finalstage.test.ts frontend/app/view/jarvis/finalshotsmodel.test.ts`: PASS. Run `task check:ts`: clean.
- [ ] Scenario steps: `plan-review-rounds` F11 and `final-shots` F22 (Task 8).

### Task 6: Graph viewport, keys, stage line and the avatar (F2, F17 refit, F18, F24, F26)
**Depends on:** Task 3, Task 2 (the exported `DAG_MODAL_ID` and the modal's registration on the modal stack, which the key guard reads)
**Files:** `frontend/app/view/orchestrate/daggraph.tsx`, `frontend/app/view/orchestrate/dagcanvas.ts`, `frontend/app/view/orchestrate/dagcanvas.test.ts`, `frontend/app/view/jarvis/petview.tsx`

Decisions: spec F2, F17 (refit), F18, F24, F26.

- [ ] **F2:** the graph's window keydown handler (`daggraph.tsx`, `const onKey = (e: KeyboardEvent) =>`) returns first thing when `!isTopModal(DAG_MODAL_ID)` (`isTopModal` from `@/app/modals/modalstack`, `DAG_MODAL_ID` from `./dagmodalstate`, both added/registered by Task 2). Not `anyModalOpen()`: the run sheet behind the modal is a registered `ModalShell` and would silence every graph key (spec F2).
- [ ] **F18:** `openView(tasks, pos, pane, hasLanes, ended: boolean)`: returns `{ fitIds: null, minZoom: ZOOM_MIN }` when it fits at the floor, when `ended`, or when no task is attention, live or ready; the focused open at `ZOOM_FLOOR` only when such a set exists. The opening-fit effect passes the ended flag.
- [ ] **F17 refit:** while the user has not moved the viewport (a ReactFlow move/zoom start carrying a user event; programmatic fits carry none), a change of the pane's size re-runs the opening view. After a user move, resizes leave the viewport alone, as today.
- [ ] **F24:** the stage line row (`daggraph.tsx` ~404, the `Run route ·` row) gets `flex-wrap` and a row gap; each entry and each plan reviewer span is `whitespace-nowrap`. Hook: `data-dag-stage-entry` on each entry (the reviewer spans keep `data-plan-reviewer`).
- [ ] **F26:** `PetView`'s floating sprite (`petview.tsx` ~472, the `fixed z-[60]` element) adds `invisible` while `dagModalStateAtom` is non-null or `finalShotsViewerOpenAtom` is true; it stays mounted. Hook: `data-pet-sprite` on that element.
- [ ] **Tests** (`dagcanvas.test.ts`): `openView` with `ended` and a graph too big for the floor → `{ fitIds: null, minZoom: ZOOM_MIN }`; with no attention/live/ready task and not ended → the same; with one live task and not ended → `fitIds: [that id]`, `minZoom: ZOOM_FLOOR` (unchanged).
- [ ] Run `npx vitest run frontend/app/view/orchestrate/dagcanvas.test.ts`: PASS. Run `task check:ts`: clean.
- [ ] Scenario steps: `dag-peek` F2, F26; `dag-motion` F17, F18; `plan-review-rounds` F24 (Task 8).

### Task 7: Timeline rail: finished runs, drawer, row targets, counts (F5, F17 drawer, F20, F21)
**Depends on:** Task 2
**Files:** `frontend/app/view/orchestrate/timelinerail.tsx`, `frontend/app/view/orchestrate/timelinegroups.ts`, `frontend/app/view/orchestrate/timelinegroups.test.ts`, `frontend/app/view/orchestrate/timelinefilter.ts`, `frontend/app/view/orchestrate/timelinefilter.test.ts`, `frontend/app/view/agents/runtimeline.ts`, `frontend/app/view/agents/runtimeline.test.ts`, `frontend/app/view/orchestrate/dagmodal.tsx`

Decisions: spec F5, F17 (drawer), F20, F21. Uses Task 2's `dagmodal.tsx`, which renders the rail from the loaded group.

- [ ] **F5:** `TimelineRail` takes `ended: boolean`; `dagmodal.tsx` passes `runFinished({ dag: group, status: group.status })`. Pure helpers in `timelinegroups.ts`: `axisEnd(events, ended, nowMs)` (last event's ts when ended, else `nowMs`; `stripTicks` takes the end instead of `nowMs`); `needsDate(events, nowMs)` (events span more than one local day, or the last is not from today); `spanText(ms)` (`45s`, `12m`, `1h17m`, `29d`). `tsLabel(ts, withDate = false)` in `runtimeline.ts` returns `Oct 16 13:59` with the date (English month abbreviation). The rail passes `withDate` to every time it prints; the strip's right label is `ended <time>` when ended, `now <time>` otherwise; its middle label is `spanText`; `NowMarker` is not drawn when ended; the status pill hides `live` when ended; `GapRow` prints `spanText(...) quiet`. Hooks: `data-timeline-strip`, `data-timeline-strip-end` (right label), `data-timeline-now`, `data-timeline-status`, `data-timeline-gap`.
- [ ] **F17 drawer:** the activity strip is not drawn in the drawer layout.
- [ ] **F20:** `applyTarget` (`timelinerail.tsx` ~640): `child-run` → `dismissDagModal()` then `setActiveRunId`; `evidence` → `dismissDagModal()` then scroll `[data-evidence-block]` into view once it is in the DOM (poll a few frames, bounded). `eventDetail` (`timelinegroups.ts` ~254): `lead-wake-failed` → `{ text: reason, pre: lines.join("\n") }`; a detail whose text equals the row's title (`eventTitle`) is `{ text: "", pre: "" }`, and a row with no detail and no plan-review reviewers renders no expand affordance. Hook: `data-timeline-row-detail` on an expanded detail.
- [ ] **F21:** filter chip counts are event counts: `eventCount(groups)` (sum of each group's events) in `timelinegroups.ts`, used for every chip; the header stays `events.length`. Hooks: `data-timeline-count` on the header count, `data-timeline-filter-count={filter id}` on each chip's count.
- [ ] **Tests:** `timelinegroups.test.ts`: `spanText` of 45 s, 12 min, 77 min, 29 days 19 h → `45s`, `12m`, `1h17m`, `29d`; `axisEnd` ended vs live; `needsDate` across midnight → true, all today → false, all yesterday → true; `stripTicks` with an ended end puts the last event at `frac` 1; `eventDetail` of `lead-wake-failed` `{ reason: "lead exited", lines: ["a","b"] }` → `{ text: "lead exited", pre: "a\nb" }`; of `evidence-sealed` with no note → empty; `eventCount(filterGroups(groupEvents(evs), "task", "t-3"))` equals `taskLifecycle(evs, "t-3").length` (`peeklifecycle.ts`) for a fixture mixing bursts and tasks. `runtimeline.test.ts`: `tsLabel(ts, true)` → `Oct 16 13:59` for a fixed local date; `tsLabel(ts)` unchanged.
- [ ] Run `npx vitest run frontend/app/view/orchestrate/timelinegroups.test.ts frontend/app/view/orchestrate/timelinefilter.test.ts frontend/app/view/agents/runtimeline.test.ts`: PASS. Run `task check:ts`: clean.
- [ ] Scenario steps: `dag-observability` F1, F5, F20, F21 and `dag-motion` F17 (Task 8).

### Task 8: Scenario steps for the run view (F1-F12, F14-F26)
**Depends on:** Task 2 (the subtitle, owner and `dag:` address hooks), Task 3 (the card fact, state word, progress and cancel hooks), Task 4 (the peek hooks), Task 5 (the Final round hooks), Task 6 (the stage-line and pet hooks), Task 7 (the timeline hooks)
**Files:** `scripts/cdp/scenarios-runs.mjs`

Add steps only; no product code. Each step text names its finding (`"F7: …"`) and is numbered after the last step already in its scenario. Each runs at the size named, set with `Emulation.setDeviceMetricsOverride` (`{width: 1600, height: 950, deviceScaleFactor: 1, mobile: false}` or `{width: 1000, height: 700, …}`) and cleared in the scenario's teardown or a `finally`. A step measures the state (rects, `scrollWidth` vs `clientWidth`, text, attributes) and records pass/fail; a shot alone is not a step. Seed states with the existing helpers (`seedDag`, `arrangeSheetDagRun`, `eventpublish` of `RunEventData` for events, `fstWriteRun` / `object.UpdateObject` for a stand-in child run; `docs/reference/cdp-run-fixtures.md`). Select through the `data-*` hooks named in Tasks 2-7; scope every query to its container.

- [ ] **`dag-lifecycle`, 1600x950:**
  - F25: `[data-dag-modal-runid]` text equals the run id's first 8 characters, lowercase, and its computed `text-transform` is `none`.
  - F3: a stand-in worker run (quick, deferred, with `dagoref` and `taskid: "t-1"`) opened through `window.__openAddress("run:<id>")`: its sheet's `[data-run-sheet-open-dag]` reads `Open in the run's DAG`; clicking it shows the modal whose `[data-dag-modal-runid]` is the owner run's 8-char id, whose "Run route ·" text names the owner's runtime/model, and with t-1 selected. Cancel and remove the stand-in in teardown.
  - F14: `window.__openAddress("dag:<dag oid>#t-2")` opens the modal on that dag with t-2 selected (its node has `aria-pressed="true"`); `dag:<a random uuid>` leaves no modal open and reports the "no longer exists" reason.
- [ ] **`dag-observability`, 1600x950:**
  - F1: publish 230 `run:event` events for the run (spread over several tasks, unique ids, ts ascending); `[data-timeline-count]` reads at least 230 events and the `All` chip's `[data-timeline-filter-count]` equals the same count.
  - F21: with t-1 selected, the `Task · t-1` chip's count equals the number in the peek's `Lifecycle N events`.
  - F5: seed the dag `done` and publish events whose ts span two days ending yesterday: `[data-timeline-strip-end]` starts with `ended`, `[data-timeline-now]` is absent, `[data-timeline-status]` does not read `live`, row times carry a month abbreviation, and a `[data-timeline-gap]` reads in `h`/`d`, never `min`.
  - F20: an `evidence-sealed` row has no expand affordance and clicking it closes the modal (`[data-dag-modal-subtitle]` gone); a `lead-wake-failed` event with `{ reason, lines }` expands to a `[data-timeline-row-detail]` containing the reason.
- [ ] **`dag-peek`, 1600x950 unless named:**
  - F7: seed t-2 (done) with a 30-line `reviewnote` (Task 4 renders the whole note, not its first line): `[data-peek-review-note]` height is at most 3 line-heights + 2px, and the peek's Verify block is within the card's visible rect without scrolling; clicking `[data-peek-review-toggle]` grows the row.
  - F8: t-2 with `firstactivity`/`lastactivity` 8 min apart and `merged: true`: `[data-peek-activity]` starts with `worked` and has no `ago`; `[data-peek-meta]` is empty or absent.
  - F6: t-2's `verifyoutput` seeded with `"\x1b[2m > \x1b[22mok\x1b[32m ✓\x1b[39m"`: `[data-peek-verify-tail]` text has no `[2m`, `[22m` or `\x1b`.
  - F9: the tagged card (t-4): its `[data-dag-node-word]` is visible (`scrollWidth <= clientWidth` and inside the card rect) next to the tag.
  - F23: t-3 (failed) Escalate… opens the picker; `[data-route-picker-empty]` reads `Pick a model`.
  - F4: seed the dag `cancelled`: t-3's peek has no Retry, Skip or Escalate buttons, its card's `[data-dag-node-fact]` reads `run cancelled`, and no header chip contains `need you`.
  - F2: first, with no overlay, press `j` with a node selected: the selection moves (the guard is not vacuous). Then open the Final peek, then its screenshots viewer (`[data-final-shots-viewer]`; seed shots as `final-shots` does), press `k`, `j`, `f`, `+`: the viewer is still open and the selected node is unchanged. Remember the CDP key events need page focus (dispatch on the focused document).
  - F26: while the modal is open, `[data-pet-sprite]` computes `visibility: hidden`; after closing it, `visible`.
  - F16 at 1000x700: select t-4; the peek card's rect does not intersect the zoom controls' rect.
- [ ] **`plan-review-rounds`, 1600x950:**
  - F19: while the dag is in `plan-review`, every pending card's `[data-dag-node-fact]` reads `waits on plan review`.
  - F24: with 5 plan reviewers seeded, every `[data-dag-stage-entry]` and `[data-plan-reviewer]` has `getClientRects().length === 1`.
  - F15: `[data-dag-cancel]` with a reviewer in flight opens a confirm dialog; choosing `Keep running` leaves the dag's status unchanged (read via `dagstatus`).
  - F10, F11, F12: seed the dag `cancelled` with every task `skipped` and no `final`: `[data-dag-progress]` contains `0/<n> done · <n> skipped`; the Final node reads `did not run · run cancelled`; no card text contains `by you`, and every `[data-dag-node-fact]` reads `run cancelled`.
- [ ] **`dag-motion`:**
  - F18 at 1600x950: seed a 21-task done dag in lanes (or extend the scenario's tasks): every `[data-dag-node]` rect is inside the graph pane's rect at open.
  - F17 at 1000x700: open the Lifecycle drawer: `[data-timeline-strip]` is absent and the graph pane is at least 300px tall. Then open the DAG at 1600x950, switch to 1000x700 without touching the graph: the Final node's rect is inside the pane.
- [ ] **`final-shots`, 1600x950:** F22: seed a round 2 that failed at Verify with no shots, and a round 1 with shots: the viewer on round 2 shows `[data-final-shots-empty]` reading `Round 2 ended at Verify, before the Final command ran.`; in the Final peek, clicking `[data-final-past-round="1"]` shows `[data-final-past-round-detail]`, and its `[data-final-past-round-shots]` opens the viewer on round 1.
- [ ] Run `node --check scripts/cdp/scenarios-runs.mjs` and `task check:ts`: clean.
