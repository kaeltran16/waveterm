# Brief code review fixes Implementation Plan

**Goal:** Fix the 22 findings (F1-F22) of the 2026-11-05 Brief (Jarvis) code review.

**Architecture:** Each fix puts its decision in a pure model file (`briefingmodel.ts`, `briefrows.ts`, `briefnav.ts`,
`briefmutations.ts`, `briefqueueactions.ts`) with a test beside it, and the `.tsx` files only wire it. Every fixed
visual state or interaction gets a numbered step in the `brief-act` CDP scenario. The spec holds each finding's
verified cause, the decision and why; read the section for your findings before you start.

**Tech Stack:** React 19, jotai, vitest, CDP scenarios (`scripts/cdp/`).

**Spec:** `docs/superpowers/specs/2026-11-05-brief-code-review-fixes-design.md` (the review report itself, gitignored, is at
`C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\brief-code\report.md`)

**Verify:** `node scripts/verify.mjs ./pkg/jarvisstate`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs brief-act brief-surface brief-design-parity brief-inline-tracker brief-peek`

Verify names `./pkg/jarvisstate` because `verify.mjs` requires a Go package pattern; it is not there to test Go. At a
merge, a changed `.ts`/`.tsx` makes it run tsc and `vitest related` on the changed files; with `ARC_VERIFY_CHANGED`
unset (the final stage) it runs that package's quick tests and the whole vitest suite.

## Global Constraints

- All paths are under `frontend/app/view/jarvis/` unless given in full. Every line number below is pre-edit (at `35ee176bb`).
- Logic in pure `.ts` files with tests beside them; a `.tsx` only calls it (AGENTS.md "Logic is extracted, not rendered").
- Every count printed is the rows beneath it; overflow is stated as "+N more" of hidden rows.
- On the Brief a failed write or act reports through `briefUndo.error(...)`; a success toast appears only after the write resolved.
- Colors and spacing from existing `@theme` tokens only (DESIGN.md); no new token, no raw color.
- New scenario steps go into `brief-act` in `scripts/cdp/scenarios-brief.mjs`, numbered after the steps already there, each step's text starting with its finding (`"12. F7: ..."`). Fixture-driven steps use a new `review` fixture in `briefingfixtures.ts` (added to `BriefingFixtureName`), so the existing `act` fixture and the steps that read it stay as they are. A changed selector or head shape that another Brief scenario asserts (grep `scenarios-brief.mjs` for it) is updated in the same task.
- No keybinding changes. Lint and format only the files you touch (`npx eslint <paths>`, `npx prettier --check <paths>`); keep prettier off `scripts/*.mjs`.
- Out of scope: the report's "Not new" section; run surfaces other than the Brief (`agents/runcards.tsx` and others) beyond the optional parameter Task 1 adds to `confirmCancelRun`.

## Review Focus

- A reload already in flight when Unblock / Done is clicked returns pre-write data: the settled row must stay hidden (Task 2 test "keeps a chunk settled against a snapshot that started before the act").
- Two run rows with no navtarget both key `run:`: ids must stay unique and stable across a roster change (Task 3 test "keeps colliding run keys unique without their position").
- A Retry land that holds again is not a failure: it toasts "Still held · <reason>" as a notify, not an error (Task 2 test "a land that holds again notifies, not errors").
- A filter that matches only Shipped rows: Behind you's delta part shows `NoMatch` while Shipped shows its matches, and mark seen still shows (Task 2 step for F17).
- Landing on a chunk whose initiative is both archived and outside the picked project and the query: every change applies at once (Task 4 test "reveals an archived initiative outside the project and the query").

---

### Task 1: Write failures reach the user (F11, F12, F22 shared fix)
**Depends on:** none
**Files:** `frontend/app/view/jarvis/briefmutations.ts`, `frontend/app/view/jarvis/briefmutations.test.ts`, `frontend/app/view/jarvis/recordactions.ts`, `frontend/app/view/jarvis/recordactions.test.ts`, `frontend/app/view/jarvis/decisionlog.tsx`, `frontend/app/view/agents/runactions.ts`, `frontend/app/view/agents/runactions.test.ts`

Spec sections: F11, F12, F22. This task changes no scenario file: Task 3 adds the F22 step (it wires the Brief's Stop), Task 4 the F11 and F12 steps.

**Interfaces produced:**
- `confirmCancelRun(channelId: string, runId: string, liveCount: number, onError?: (message: string) => void): void` in `agents/runactions.ts`. A rejected cancel calls `onError(message)`; `channelId === ""` calls `onError("This run names no channel, so it can't be cancelled from here")` and sends no RPC. Omitted, it logs through `fireAndForget` as now.
- `effortOps` / `moveToProjectItems` keep their signatures.

Steps:
- [ ] Tests first, in `briefmutations.test.ts`: "togglePause toasts only after the write resolves" (fake `setEffortStatus` held on a deferred: no `notify` until it resolves, then `notify("Paused", fn)`); "a rejected archive reports through undo.error and toasts nothing" (`error` called with the rejection's message, `notify` never); "a failed undo reports through undo.error"; "Move to project toasts Moved to X after the write and reports a rejection". Same shape for `archive` and `unarchive`.
- [ ] Implement: `effortOps` and `moveToProjectItems` await the store write, then `undo.notify(text, undoFn)`; a rejection (of the write or of the undo's inverse) goes to `deps.undo.error(message)`. They no longer route through `deps.run` (`trackerEdits`' plan-row edits keep `run` and `mutateError`). `remove` (scheduled delete) is unchanged.
- [ ] Tests in `recordactions.test.ts`: replace the `tasksErrorAtom` assertion with "a failed write toasts its reason and leaves tasksErrorAtom alone" (the `briefToastAtom` holds an error toast containing "disk full"; `tasksErrorAtom` stays null) for `appendDecision` (returns false) and `setDossierStatus`.
- [ ] Add "a refused edge write toasts its reason and leaves tasksErrorAtom alone" for `detachEdge` ("Couldn't detach the run") and `acceptEdge` ("Couldn't attach the run").
- [ ] Implement in `recordactions.ts`: one report function, used by `write` and by `detachEdge` / `acceptEdge` (which have their own catch at lines 134-157 today), reports through `briefUndo.error("Couldn't <what>: <reason>")` plus `console.error`, each caller naming its `<what>` ("set the record's status", "record the decision", "detach the run", "attach the run"). No record write sets `tasksErrorAtom` any more (`grep -n "set(tasksErrorAtom" recordactions.ts` finds nothing). Update `decisionlog.tsx`'s comment (the form still stays open on failure).
- [ ] Tests in `runactions.test.ts`: "a refused cancel reaches onError", "a channel-less cancel reaches onError without the RPC", "no onError still logs" (existing behavior). Implement.
- [ ] Run `npx vitest run frontend/app/view/jarvis/briefmutations.test.ts frontend/app/view/jarvis/recordactions.test.ts frontend/app/view/agents/runactions.test.ts`: all pass.

Acceptance: the tests above pass; Check is clean. The rendered states are shown by Task 3's F22 step and Task 4's F11 and F12 steps.

### Task 2: Waiting on you and Behind you (F1, F2, F7, F8, F9, F14, F17, F18)
**Depends on:** none
**Files:** `frontend/app/view/jarvis/briefingmodel.ts`, `frontend/app/view/jarvis/briefingmodel.test.ts`, `frontend/app/view/jarvis/briefqueueactions.ts`, `frontend/app/view/jarvis/briefqueueactions.test.ts`, `frontend/app/view/jarvis/briefrows.ts`, `frontend/app/view/jarvis/briefrows.test.ts`, `frontend/app/view/jarvis/briefundo.ts`, `frontend/app/view/jarvis/petactrun.ts`, `frontend/app/view/jarvis/briefbehind.tsx`, `frontend/app/view/jarvis/briefprimitives.tsx`, `frontend/app/view/jarvis/briefwaiting.tsx`, `frontend/app/view/jarvis/briefsurface.tsx`, `frontend/app/view/jarvis/briefingfixtures.ts`, `scripts/cdp/scenarios-brief.mjs`, `scripts/cdp/scenarios-shared.mjs`

Spec sections: Waiting on you (F7, F8, F9, F14 with mark seen), Behind you (F1, F2, F17, F18).

**Interfaces produced (Tasks 3 and 4 use them):**
- `failRpc(h, command, message)` in `scripts/cdp/scenarios-shared.mjs`: replaces `RpcApi[command]` with a function rejecting `new Error(message)`, storing the original in `window.__heldRpc` so `releaseRpc(h, command)` restores it.
- The `review` fixture in `BRIEFING_FIXTURES`, which Task 3 extends.
- `export function RegionHead(...)` from `briefprimitives.tsx` (props unchanged).
- `QueueActionDeps` gains `rpc.landRun(data: CommandLandRunData): Promise<RunLand>` and `settle(key: string, on: boolean): void`. `QueueAct` gains kinds `"land-run"` (label "Retry land") and `"dismiss-land"` (label "Dismiss").
- In `briefundo.ts`: `settledChunksAtom: PrimitiveAtom<Map<string, number>>` (a `chunkKey` to the act time).
- In `briefingmodel.ts`: `withoutSettledChunks(efforts: EffortCardModel[], settled: Map<string, number>, snapshotTs: number): EffortCardModel[]` and `effectiveCursor(snapshotCursor: number, visitCursor: number | null | undefined): number`.
- In `briefrows.ts`: `capBehind(groups: LineGroup[], cap: number, expanded: boolean): { groups: LineGroup[]; more: number }` (delta groups only; `more` = folded lines hidden).

Steps:
- [ ] F1 test in `briefingmodel.test.ts`: "Behind you lists the newest events first across projects" (a decision in project `""` older than a run in `C:/x` and an effort event in `zeta`: `delta` order is newest first, ties by key). Implement the sort in `projectBriefing`.
- [ ] F7 tests: `queueLine(...).kind` reads "unverified" for `run-unverified` and "land held" for `run-land-held`; `summarizeAttentionQueue` reads "2 unverified" and "2 held lands". Implement in `queueKindLabel` / `KIND_PLURAL`; make `queueKindLabel` the one kind source (drop `QUEUE_KIND_LABEL` and `QueueRow.kind` if a grep finds no other reader, else derive `kind` from it). Fix the test at `briefingmodel.test.ts:969-975` to pin the drawn kind.
- [ ] F8 tests: `queueActions` of a held land with channel and run id is `[Retry land, Dismiss]`; in `briefqueueactions.test.ts`, "Retry land toasts Landed when the land lands", "a land that holds again notifies, not errors" ("Still held · <reason>"), "Dismiss acks with land: true", "a refused Dismiss reports through undo.error". Implement; export `LAND_TIMEOUT_MS` and `LAND_STATE_LANDED` from `petactrun.ts` and use them; add `landRun` to `QUEUE_RPC` in `briefsurface.tsx`.
- [ ] F9 test: `queueActions` is `[]` for a channel-less ask and for a blocker with an empty oref; a chunk row keeps Unblock / Done. Implement. Confirm `WaitingRow` draws no act cell for `[]`.
- [ ] F14 tests: `withoutSettledChunks` drops a settled chunk from `blockedChunks` while `snapshotTs` is older than the settle time; "keeps a chunk settled against a snapshot that started before the act"; a snapshot started after the act shows it again; the card's "N blocked" (`initiativeLine`) follows. In `briefqueueactions.test.ts`: Unblock / Done call `settle(key, true)` before the RPC, a rejected write calls `settle(key, false)`, and the re-block undo calls `settle(key, false)`. `effectiveCursor` returns the later of the two (null visit cursor → the snapshot's). Implement; in `briefsurface.tsx` build the settled efforts once, before the queue (`withoutSettledChunks(model_.efforts, settled, snapshot.queryStartedAt)`), and pass that one list to `buildAttentionQueue` (line 299, which today reads `model_.efforts` directly) and to everything that reads `efforts` (line 305 onward), so the Waiting row, its summary and the Initiatives "N blocked" all agree. Project with `effectiveCursor(snapshot.actualCursor, visitCursor)`.
- [ ] F2 tests in `briefrows.test.ts`: 40 notes on one initiative today fold to one digest reading "40 notes" with `more` 0; seven distinct rows capped at 5 give `more` 2; Shipped is untouched. Implement `capBehind`; in `briefsurface.tsx` group and fold the whole `model_.delta`, filter, then `capBehind(..., DELTA_CAP, behindOpen || filtering)`, replacing `deltaWindow`.
- [ ] F17 and F18 in `briefbehind.tsx`: takes `filtering`, `only` and `onOnly`; with a filter and no matching delta line it draws `NoMatch` (Shipped the same); mark seen shows while the unfiltered delta has rows (pass that count); the label is `RegionHead` wired to `toggleOnly("behind")`, with since and mark seen as siblings outside the button.
- [ ] Add `failRpc` to `scenarios-shared.mjs` and the `review` fixture: a run-unverified pair, one run-land-held item (channel and run ids set), one channel-less ask, six decisions (project `""`) older than an initiative digest and a run from today, and one initiative with 40 notes today.
- [ ] Add `brief-act` steps, each with a shot: **F7** the review fixture's Waiting rows read "unverified" / "land held" and the summary reads "2 unverified"; **F8** the held row's buttons are `["Retry land", "Dismiss"]`, and Dismiss sends `AckRunCommand` with `land: true` (stub `RpcApi.AckRunCommand` to record its argument and resolve, then restore it); **F9** the channel-less ask's row has no `[data-jarvis-queue-act]`; **F1** the first Behind you line is today's initiative digest or run, not a decision; **F2** the 40-note initiative reads as one digest "40 notes" with no "+N more" beneath it; **F17** a query matching nothing ("zz-no-match") shows Behind you's `NoMatch` with mark seen still visible, and Shipped its own `NoMatch`; **F18** clicking Behind you's head leaves only `[data-jarvis-brief-region="behind"]` drawn, and a second click restores all four; **F14** (live, the arranged effort, no fixture; arrange one more blocked chunk if the existing ones are used up) Unblock removes its Waiting row within 1 s and the initiative row's "N blocked" drops by one, Undo brings both back; then mark seen empties Behind you within 1 s and its Undo restores the rows.
- [ ] Run `npx vitest run frontend/app/view/jarvis/briefingmodel.test.ts frontend/app/view/jarvis/briefqueueactions.test.ts frontend/app/view/jarvis/briefrows.test.ts`: all pass.

Acceptance: the tests above pass, Check is clean, and the `brief-act` steps F1, F2, F7, F8, F9, F14, F17, F18 exist and show each state.

### Task 3: Runs, snapshot health and the pet (F5, F6, F10, F15, F16, F20, F22 wiring)
**Depends on:** Task 1 (wires the `onError` parameter it adds to `confirmCancelRun`), Task 2
**Files:** `frontend/app/view/jarvis/briefingmodel.ts`, `frontend/app/view/jarvis/briefingmodel.test.ts`, `frontend/app/view/jarvis/briefingstore.ts`, `frontend/app/view/jarvis/briefingstore.test.ts`, `frontend/app/view/jarvis/briefrows.ts`, `frontend/app/view/jarvis/briefrows.test.ts`, `frontend/app/view/jarvis/briefnav.ts`, `frontend/app/view/jarvis/briefnav.test.ts`, `frontend/app/view/jarvis/briefprimitives.tsx`, `frontend/app/view/jarvis/briefruns.tsx`, `frontend/app/view/jarvis/briefbehind.tsx`, `frontend/app/view/jarvis/briefinitiatives.tsx`, `frontend/app/view/jarvis/briefsurface.tsx`, `frontend/app/view/jarvis/briefingfixtures.ts`, `scripts/cdp/scenarios-brief.mjs`, `docs/keyboard-shortcuts.md`

Spec sections: Runs (F5, F6, F15, F16, F22), Snapshot health (F10), the pet (F20).

**Interfaces produced:**
- `missingLegs(sources: SourceHealth): string[]` in `briefingmodel.ts`, naming "Runs", "Records", "Initiatives" in that order; read by `projectBriefing` and by `briefingstore`'s `complete` (`missingLegs(state.sources).length === 0`).
- `RunRowFace.answer: "sheet" | "agent" | null`.
- `liveRunKindCounts(legs: { activeRuns: RunRow[]; directAgents: AgentRow[] }, now: number): Record<RunKindFilter, number>` in `briefrows.ts`.
- `runNavFold(line: BriefLine, drawnIds: Set<string>): "shipped" | "stale" | "more" | null` in `briefnav.ts`.

Steps:
- [ ] F5 tests in `briefingmodel.test.ts`: "a run row's key does not change when an asking agent arrives above it"; "keeps colliding run keys unique without their position" (two items with no navtarget, including two with the same ts). Implement (spec F5): a key shared by several rows becomes `<key>:<ts>`, and rows that still share it take an ordinal counted among those identical rows only, in sorted order, so a roster change elsewhere never moves it. Fix any test pinning `":0"` suffixes.
- [ ] F6 tests in `briefrows.test.ts`: `runRowFace` of a direct agent's line has `answer: "agent"`; of a run line with no loaded Run, `answer: "sheet"` and `type` from the snapshot mode (`"orchestrator"` / `"quick run"`), not `"agent"`. Implement, carrying `mode` through `ActiveWorkRow` to the session line. In `briefprimitives.tsx`, Answer dispatches on `face.answer` (`jumpToAgent(model, line.agentId)` for "agent").
- [ ] F22 wiring: `BriefRunRow`'s Stop passes `briefUndo.error` as `confirmCancelRun`'s `onError`.
- [ ] F15 test: `liveRunKindCounts` with 12 stale orchestrator runs and 2 live quick runs gives `all 2 · orchestrator 0 · quick 2`, equal to the live count. Implement and use it for `runCounts` in `briefsurface.tsx`.
- [ ] F16 tests in `briefnav.test.ts`: `runNavLines` over a 12-run Shipped list walks all 12; `runNavFold` names "shipped" for a Shipped line past the cap, "stale" for a stale session line, "more" for a live one past `ACTIVE_CAP`, null for a drawn line. Implement: publish the whole kind-filtered list to `briefRunListAtom`, build the run-nav lines for it, and on landing open the fold `runNavFold` names. Reword `docs/keyboard-shortcuts.md` line 193 to say the list includes rows behind the region's folds.
- [ ] F10 tests: `missingLegs` for each false source, in order; sessions false names nothing; `briefingstore` marks a snapshot incomplete when `efforts` is false. Implement; add the partial band under the toolbar in `briefsurface.tsx` (`data-jarvis-brief-band="partial"`, the stale band's recipe, text per the spec, Retry → `refreshBriefing`), and the "couldn't read" sentences in Runs (`briefruns.tsx`), Shipped (`briefbehind.tsx`) and Initiatives (`briefinitiatives.tsx`) when their leg is missing. Make the `partial` fixture's `complete` follow `missingLegs`, and set its `efforts` false too.
- [ ] F20: in `briefsurface.tsx`, replace the container's `onScroll` dismissal with `onWheel`, `onTouchMove`, `onPointerDown` and `onKeyDown`.
- [ ] Extend the `review` fixture with an asking direct agent, 12 stale orchestrator runs beside 2 live quick runs, and more than `SHIPPED_CAP` shipped runs.
- [ ] Add `brief-act` steps, each with a shot: **F5** with the cursor on a Runs row, an asking agent added above it (swap the fixture's agents, then re-render) leaves the cursor on the same row and the scroll position unchanged, and that row's opacity stays 1 (no entrance replay); **F6** the asking agent's Answer lands on the Agent surface with that agent focused (`model.focusIdAtom`); **F15** the "all" chip's count equals the head's "N live"; **F16** with the sheet on a shipped run the published list's length equals Shipped's head count, and stepping past the third run draws the fourth row under the cursor with Shipped's fold open (drive `j` the way other brief scenarios do, or the list-nav controller when key events do not reach the page); **F10** the `partial` fixture shows the band naming "Runs, Initiatives" with Retry, and Runs, Shipped and Initiatives say they couldn't be read; **F20** update step 10 to close "Where we were" with a wheel event, and add a step where a cursor move that scrolls the rows leaves it open: move the cursor to a row below the fold with no key or pointer event (through the list-nav controller's `setCursor`, or the cursor atom), so the only thing that happens is the cursor effect's `scrollIntoView`; a `j` key press would close it by design (F20 dismisses on keydown); **F22** with `failRpc(h, "CancelRunCommand", ...)` on a real run (`arrangeFixtureRun` / `teardownFixtureRun`), Stop (confirming if asked) shows an error toast with the message and the row still reads running.
- [ ] Run `npx vitest run frontend/app/view/jarvis/briefingmodel.test.ts frontend/app/view/jarvis/briefingstore.test.ts frontend/app/view/jarvis/briefrows.test.ts frontend/app/view/jarvis/briefnav.test.ts`: all pass.

Acceptance: the tests above pass, Check is clean, and the `brief-act` steps F5, F6, F10, F15, F16, F20 and F22 exist and show each state.

### Task 4: Initiatives landing and plan state (F3, F4, F13, F19, F21; steps for F11, F12)
**Depends on:** Task 1 (effortOps and recordactions reporting the F11 and F12 steps show; same briefmutations files), Task 2 (failRpc and the review fixture), Task 3 (same briefsurface.tsx, briefinitiatives.tsx and scenarios-brief.mjs)
**Files:** `frontend/app/view/jarvis/briefmutations.ts`, `frontend/app/view/jarvis/briefmutations.test.ts`, `frontend/app/view/jarvis/effortstore.ts`, `frontend/app/view/jarvis/effortstore.test.ts`, `frontend/app/view/jarvis/briefinitiatives.tsx`, `frontend/app/view/jarvis/briefsurface.tsx`, `scripts/cdp/scenarios-brief.mjs`

Spec sections: Initiatives (F3, F4, F13, F19, F21); F11 and F12 for their steps.

**Interfaces:**
- Consumes: `failRpc` (Task 2), `effortOps` / `recordactions` reporting (Task 1).
- Produces: `revealChanges(input: { oref: string; live: EffortCardModel[]; archived: EffortCardModel[]; project: string | null; windowORefs: string[]; query: string; only: RegionId | null }): { clearProject: boolean; expandInitiatives: boolean; showArchived: boolean; clearQuery: boolean; clearOnly: boolean }` in `briefmutations.ts`; `RevealDeps.pendingDeletes: () => Set<string>`; `effortLoadErrorAtom: PrimitiveAtom<Map<string, string>>` in `effortstore.ts`.

Steps:
- [ ] F3 / F4 tests in `briefmutations.test.ts`: a query matching a chunk's needs but not the initiative line sets `clearQuery`; a matching query does not; an archived oref sets `showArchived`; "reveals an archived initiative outside the project and the query" sets all of them at once; a live drawn initiative changes nothing. Implement `revealChanges` (the line match through `filterLines([initiativeLine(card)], query)`) and apply it in `showInitiative` in `briefsurface.tsx` (the query and Show archived are its state).
- [ ] F21 test: with the only chunk of the first stage pending delete, `openChunkInPlan` opens the stage id `trackerRows` draws for the target chunk. Implement via `pendingDeletes`, filtering with `chunkKey` as `stepTarget` does; the surface passes `() => globalStore.get(pendingDeleteKeysAtom)`.
- [ ] F13 tests in `effortstore.test.ts`: a failed `loadEffortDetail` records its message under the oref and rethrows; a later success clears it. In `briefmutations.test.ts`: `openChunkInPlan` stops (opens no stage) when `loadPlan` rejects. Implement; `briefinitiatives.tsx` draws the error in place of the loading line with a Retry (`data-jarvis-plan-retry`) that loads again.
- [ ] F19: in `briefsurface.tsx`, reset `detailsOpen` and `renamingTitle` whenever `openInitiative` changes.
- [ ] Add `brief-act` steps on the live arranged initiative (arrange more chunks, a second initiative or stages as the steps need, and delete them in teardown), each with a shot: **F3** with the filter "G4 label" (matches a Waiting row's needs, not its initiative line), opening that row lands on its chunk with the sidebar open and the filter cleared; **F4** for an archived initiative, the reveal the ↳ link calls (`briefRevealChunkAtom`) turns Show archived on and opens its plan on the chunk; **F13** with `failRpc(h, "EffortGetCommand", ...)`, opening an uncached initiative shows the error and Retry, and after `releaseRpc` Retry draws the plan; **F19** with `holdRpc(h, "EffortGetCommand")`, Details from the menu of an unloaded initiative, collapse it, release, open another initiative: no Details form shows; **F21** with the only chunk of the first stage deleted and its undo still pending, landing on a later stage's chunk unfolds that stage with the cursor on it (then Undo the delete); **F11** with `failRpc(h, "EffortMutateCommand", ...)`, the menu's Pause shows an error toast and no "Paused" toast; **F12** with `failRpc(h, "SetDossierStatusCommand", ...)`, a status change from the record peek shows an error toast naming the reason (reach a record the way `brief-peek` does).
- [ ] Run `npx vitest run frontend/app/view/jarvis/briefmutations.test.ts frontend/app/view/jarvis/effortstore.test.ts`: all pass.

Acceptance: the tests above pass, Check is clean, and the `brief-act` steps F3, F4, F11, F12, F13, F19 and F21 exist and show each state.
