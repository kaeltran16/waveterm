# Brief live pass fixes Implementation Plan

**Spec:** `docs/superpowers/specs/2026-11-05-brief-live-review-fixes-design.md` (each finding's traced cause and the decision taken; read your findings' sections before starting)
**Verify:** `node scripts/verify.mjs ./pkg/jarvisattrib ./pkg/jarvis && npx vitest run frontend/app/view/jarvis`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs brief-act brief-inline-tracker record-band-detach-restore run-sheet-polish jira-check jira-details`

**Goal:** Fix findings F1-F16 of the Brief live pass (`C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\brief-live\report.md`, gitignored; screenshots beside it named by shot number), checked at 1000x700 and 1600x950.

**Architecture:** Two Go tasks (attribution claim rule; attention for channel-less asks) and two frontend tasks (Brief counts and Waiting; tracker, forms and labels) run at once. The titles and run-sheet task follows the Brief task, whose `briefrows.ts` it shares (an accepted serial edge: the Shipped title must be wired in `briefrows.ts`, and splitting Task 3 to land that file first adds a review round for one line). The scenario task for the tasks that do not own `scenarios-brief.mjs` also follows the Brief task, beside the titles task. React 19 + Tailwind 4 + jotai on the frontend; logic in pure `.ts` files tested beside them.

## Global Constraints

- Logic goes in a pure `.ts` with its test beside it, or a Go function with a `_test.go` beside it; a `.tsx` only calls it. A class-name-only change is proven by a scenario step.
- Existing `@theme` tokens only (`frontend/tailwindsetup.css`); no new token and no edit to `tailwindsetup.css` (run 2c86fd26 edits it). Copy is sentence case (DESIGN.md Copy).
- Every fixed visual state or interaction gets a step in the named existing scenario, run at the size where it broke via `Emulation.setDeviceMetricsOverride` (`{width: 1000, height: 700, deviceScaleFactor: 1, mobile: false}` or 1600x950), cleared in that scenario's teardown or `finally`. A step measures the state (rects, `scrollWidth` vs `clientWidth`, computed style, text) and records pass/fail; a shot alone is not a step. Step text names its finding: `"35. F2: ..."`, numbered after the last step already in the scenario.
- Scope queries to a `data-*` container; never select by window position near the title bar (docs/reference/cdp-verification.md). Add a `data-*` hook where a step needs one.
- Never attach to or kill a dev app on :9222; live checks run only through Final (`final-verify.mjs`'s isolated app). Workers do not run Final.
- Fixture-driven Brief steps extend `BRIEFING_FIXTURES` in `frontend/app/view/jarvis/briefingfixtures.ts` (an existing fixture or a new name added to `BriefingFixtureName`); only the task that owns that file edits it.
- Out of scope: the report's "Tooling gaps" section and its top live-check confirmations.

## Review Focus

1. A record whose layer-1 ref names a non-lead run (written before `0b1f5dcca`): the claim map must apply `assembleEdges`'s own keep rule, so such a ref claims nothing (Task 1 test).
2. A run a human accepted onto two records: both confirmed edges stay; a confirmed edge is never dropped (Task 1 test).
3. A record's confirmed ref that a human detached: that record no longer claims the run, so the run's guesses for other records come back (Task 1 test).
4. A filter that matches nothing or everything: counts read "0 of M" / "M of M"; with the filter cleared they read exactly as before (Task 3 tests).
5. A goal with no sentence end (one long line, a Windows path full of dots, a `;`): the title is still bounded by `HEADLINE_MAX` and never ends at a `;`; a summary with no H1 falls back to the goal (Task 4 tests).

---

### Task 1: Attribution: a run claimed by one record is not a guess for another (F3, F5)
**Depends on:** none
**Files:** `pkg/jarvisattrib/lifecycle.go`, `pkg/jarvisattrib/lifecycle_test.go`, `pkg/jarvisattrib/extract.go`, `pkg/jarvisattrib/claims_test.go`

Decisions are in the spec's "Record attribution" section (F3 and F5).

- [ ] **Interface:** add `claimedRuns(dossiers []*jarvisdossier.Dossier, runs []*waveobj.Run, overrides map[string]string) map[string]string` (run oref → claiming dossier id) in `extract.go` beside `assembleEdges`. A dossier claims each layer-1 ref `assembleEdges` keeps (extract the keep rule into one helper both call: a ref whose run is in the store and not lead is skipped; a ref to a missing run is kept), plus every `accept` override; a `detach` override for the pair removes that claim. When two dossiers claim one run, the map may hold either: the drop rule below only needs "claimed by someone other than me", so store a set per run if that is simpler (`map[string]map[string]bool`) and name it accordingly.
- [ ] **Drop rule:** `edgesForDossier` takes the claim map and drops an edge whose `State != StateConfirmed` when its run is claimed by any dossier other than `d.ID`. `EdgesFor` builds the map by loading every dossier in the tasks collection (as `AllEdges` does) without any per-dossier git call; `AllEdges` builds it once from the dossiers it already loads (load them in one pass, then assemble). Update the existing direct call in `lifecycle_test.go` (~line 178) to the new signature.
- [ ] **Tests in `claims_test.go`** (use the package's existing test helpers and fakes from `edges_test.go` / `edgesfor_test.go`; no vault or git where the pure functions suffice):
  - `TestClaimedGuessDropped`: dossiers A and B share a repo and window; run rA is a layer-1 ref of A; B's edges hold no edge to rA, and A's edge to rA is confirmed.
  - `TestUnclaimedGuessKept`: a lead run no dossier refs stays a weak (layer-3, informing) edge of B.
  - `TestAcceptedOnTwoRecordsKept`: rA accepted onto B via an override; B keeps its confirmed edge to rA and A keeps its own.
  - `TestDetachReleasesClaim`: A's ref to rA detached; rA is a guess of B again.
  - `TestNonLeadRefClaimsNothing`: A's layer-1 ref names a worker run; B's guess of that run is unaffected (it is not lead, so it is no candidate either; assert the claim map has no entry for it).
  - Existing `EdgesFor`/`AllEdges` tests still pass.
- [ ] Run `go test ./pkg/jarvisattrib -run 'TestClaimedGuessDropped|TestUnclaimedGuessKept|TestAcceptedOnTwoRecordsKept|TestDetachReleasesClaim|TestNonLeadRefClaimsNothing|TestEdgesFor|TestAllEdges'`: PASS.
- [ ] Scenario steps for F3 and F5 are added by Task 6 in `record-band-detach-restore`; do not edit `scripts/cdp/scenarios-brief.mjs` here.

### Task 2: Attention: a channel-less ask carries its agent's tab (F2, Go half)
**Depends on:** none
**Files:** `pkg/jarvis/attention.go`, `pkg/jarvis/attention_test.go`

Decision is in the spec's F2 section, Go bullet.

- [ ] In the pending-ask loop of `BuildAttention` (`attention.go`, the `for oref, p := range in.PendingAsks` block): when the ask has no owning channel (`ch.OID == ""`) AND `in.AskWorkerORef[oref]` starts with `"tab:"`, set `Oref` to that tab oref, the name fallback is `"agent"` (was `"worker"`), and `Why` is exactly `"The agent is paused until you answer."`. Every other ask (with a channel, or channel-less with no tab oref) keeps today's shape exactly: `"worker"` fallback, the `"%s is paused until you answer."` why, no `Oref`. No wire type change (`AttentionItem.Oref` exists), so no `task generate`.
- [ ] **Tests in `attention_test.go`:**
  - `TestStandaloneAskCarriesTabORef`: a pending ask with no `AskChannel` entry and `AskWorkerORef` = `"tab:t1"` yields an item with `Oref == "tab:t1"`, `ChannelId == ""`, `Source == "agent"`, `Why == "The agent is paused until you answer."`.
  - `TestStandaloneAskWithoutTabHasNoORef`: `AskWorkerORef` is a `block:` oref → `Oref == ""`, `Source == "worker"`, `Why == "worker is paused until you answer."` (today's shape).
  - `TestChannelAskUnchanged`: an ask with a channel keeps `Source == "worker"` when no worker name resolves, and no `Oref`.
- [ ] Run `go test ./pkg/jarvis -run 'TestStandaloneAskCarriesTabORef|TestStandaloneAskWithoutTabHasNoORef|TestChannelAskUnchanged|TestBuildAttention'`: PASS.

### Task 3: Brief: header projects, agent asks, Waiting counts, blocked initiatives, filtered counts (F1, F2, F8, F14, F16)
**Depends on:** none
**Files:** `frontend/app/view/jarvis/briefingmodel.ts`, `frontend/app/view/jarvis/briefingmodel.test.ts`, `frontend/app/view/jarvis/briefrows.ts`, `frontend/app/view/jarvis/briefrows.test.ts`, `frontend/app/view/jarvis/briefsurface.tsx`, `frontend/app/view/jarvis/brieftoolbar.tsx`, `frontend/app/view/jarvis/briefrowviews.tsx`, `frontend/app/view/jarvis/briefwaiting.tsx`, `frontend/app/view/jarvis/briefinitiatives.tsx`, `frontend/app/view/jarvis/briefprimitives.tsx`, `frontend/app/view/jarvis/briefbehind.tsx`, `frontend/app/view/jarvis/briefruns.tsx`, `frontend/app/view/jarvis/briefqueueactions.ts`, `frontend/app/view/jarvis/briefqueueactions.test.ts`, `frontend/app/view/jarvis/briefingfixtures.ts`, `scripts/cdp/scenarios-brief.mjs`

Decisions are in the spec's F1, F2 (frontend bullet), F8, F14 and F16 sections. The channel-less ask's `oref` is already on the wire type; this task does not wait for Task 2 (fixtures supply it).

- [ ] **F1:** `workProjectCount(keys: string[], projects: Record<string, { path?: string }>): number` in `briefrows.ts`; extract `projectName`'s path normalizer into one shared helper both use. `briefsurface.tsx` passes `snapshot.state.projects.map(p => p.project)` and `projectsAtom`. Tests: keys `["C:/x/waveterm", "waveterm", "C:/Users/me/AppData/Local/arc-wt/5638249e-t-1", "(none)", "C:/Temp/verify-diff-states-1"]` with registry `{ waveterm: { path: "C:\\x\\waveterm\\" } }` → 1; an empty registry → 0; a key that equals a registered name counts once with its path.
- [ ] **F2:** `buildAttentionQueue` input gains `agents?: { id: string; name: string }[]`; `queueNav` routes a channel-less `ask` whose `oref` starts with `tab:` to `{ kind: "oref", oref }`; its row has `action: "Answer"`, `source`/`detail` = the roster name when the tab id is in `agents`, else the wire source; `queueActions` returns `[{ label: "Answer", kind: "open" }]` for it. `briefsurface.tsx` passes the roster it already holds. Tests: such an ask with a roster entry `{ id: "t1", name: "calc helper" }` → nav `{ kind: "oref", oref: "tab:t1" }`, acts `["Answer"]`, detail `"calc helper"`; without the roster entry → detail is the wire source; a channel-less ask with no oref still has no acts (the F9 rule of the earlier pass, existing test kept). `briefqueueactions.test.ts`: the `open` act on that row calls the open path with target `tab:t1`.
- [ ] **F14:** `summarizeAttentionQueue` counts every kind (`"1 ask"`, `"1 blocked"`, `"2 asks"`); update the comment and the tests that pinned the bare word (`briefingmodel.test.ts` ~1425 expects `"blocked"` → `"1 blocked"`). In `briefrowviews.tsx` the Waiting row's age cell is `whitespace-nowrap` at one width for every row that fits "just now" at 11px mono.
- [ ] **F8:** `initiativeWindow<T extends { blockedChunks: unknown[] }>(cards: T[], cap: number, expanded: boolean): CappedRows<T>` in `briefingmodel.ts` replaces the `capRegion` call for initiatives (`briefsurface.tsx:369-372`). `initiativesMeta` leads with `"N blocked"` (initiatives with ≥1 blocked chunk). Tests: 10 cards where cards 7 and 9 are blocked, cap 6 → shown ids are cards 1-4, 7, 9 in that order, `more` 4; expanded → all 10; no blocked → identical to `capRegion`; 8 blocked of 10 with cap 6 → the first 6 blocked; `initiativesMeta` with 2 blocked, 1 paused → `"2 blocked · 1 paused"` (keep the existing parts' order after it).
- [ ] **F16:** `filterCount(matched: number, total: number, filtering: boolean): string` in `briefrows.ts` (`"12"` unfiltered; `"3 of 12"` filtering). While filtering: the Waiting summary is built from the matching queue rows and its title reads `"N of M waiting match the filter"`; the Initiatives project chips, the Shipped kind chips and the Runs region's kind chips (same `runKindFilter`, spec F16) count the matching lines per option, each label from `filterCount`. The filter-slot option `count` (`briefprimitives.tsx`) becomes a string label; `runKindFilter`'s `counts` parameter and `briefruns.tsx`'s `runCounts` prop change type with it. Tests: `filterCount(0, 41, true) === "0 of 41"`, `filterCount(41, 41, false) === "41"`; a summary over 2 matching of 11 rows while filtering has title `"2 of 11 waiting match the filter"`.
- [ ] **Scenario steps in `brief-act` (`scripts/cdp/scenarios-brief.mjs`), numbered after step 34, extending the `review` fixture or a new fixture in `briefingfixtures.ts` as needed:**
  - F1 at 1600x950: with a fixture whose `state.projects` holds a registered project by path and by name plus a worktree path and `(none)`, the toolbar fact reads `all work · 1 project` (scope to the toolbar's `data-*` hook; add one if none).
  - F2 at 1600x950: a fixture ask with no channel and `oref: "tab:<REVIEW_ASKER id>"` shows the agent's name and one `Answer` act; clicking it lands on the Agent surface with that agent focused (as step 22 checks).
  - F14 at 1600x950: the ask row's age reads `just now` on one line (the age cell's height equals one line-height, `scrollWidth <= clientWidth`) and the summary contains `1 ask`.
  - F8 at 1600x950: with a fixture of 10 initiatives where the 8th and 9th by activity are blocked, both are visible without pressing `+N more`, and the Initiatives head shows `2 blocked`.
  - F16 at 1600x950: with a filter matching nothing, the Waiting summary reads `0 of N`, the Initiatives `all` chip reads `0 of M`, and the Shipped `all` chip reads `0 of K`; cleared, they read `N`, `M`, `K` again.
  - F14 again at 1000x700: the age cell does not wrap.
- [ ] Run `npx vitest run frontend/app/view/jarvis/briefingmodel.test.ts frontend/app/view/jarvis/briefrows.test.ts frontend/app/view/jarvis/briefqueueactions.test.ts`: PASS. Run `task check:ts`: clean.

### Task 4: Titles and the short run sheet (F4, F7)
**Depends on:** Task 3
**Files:** `frontend/app/view/jarvis/effortfeed.ts`, `frontend/app/view/jarvis/effortfeed.test.ts`, `frontend/app/view/jarvis/runreport.ts`, `frontend/app/view/jarvis/runreport.test.ts`, `frontend/app/view/jarvis/briefrows.ts`, `frontend/app/view/jarvis/briefrows.test.ts`, `frontend/app/view/jarvis/briefpeek.ts`, `frontend/app/view/jarvis/briefpeek.test.ts`, `frontend/app/view/jarvis/briefpeekview.tsx`, `frontend/app/view/jarvis/recordrunrow.test.ts`, `frontend/app/view/jarvis/runsheet.tsx`, `scripts/cdp/scenarios-runs.mjs`

Decisions are in the spec's F4 and F7 sections.

- [ ] **F4 headline:** `headline` (`effortfeed.ts`) ends a sentence only at `.`, `!` or `?` followed by whitespace or the end. Tests: `"Fix all findings in C:\\a\\report.md (gitignored, read it by that path; its shots sit beside it). Then land."` → `"Fix all findings in C:\\a\\report.md (gitignored, read it by that path; its shots sit beside it)."`; a 400-char line with no sentence end → at most `HEADLINE_MAX` + `"…"`. Update any test (here or in `briefrows.test.ts`, `recordrunrow.test.ts`, `briefpeek.test.ts`) that pinned the `;` cut; grep for them.
- [ ] **F4 runTitle:** `runTitle(goal: string, summary: string): string` in `runreport.ts`: the summary's `# ` heading with a leading `Run report:` (case-insensitive) dropped, else `shortTitle(goal)`. Move `shortTitle` into `runreport.ts` and re-export it from `briefrows.ts` (briefrows imports `runTitle`, so the other direction would cycle). Tests: summary `"# Usage surface review fixes (F1-F21): lead report\n\n..."` → `"Usage surface review fixes (F1-F21): lead report"`; `"# Run report: Palette fixes"` → `"Palette fixes"`; empty summary → the goal's first line's lead sentence. Shipped rows (`briefrows.ts`, the `title: s.goal` line) and the run sheet's collapsed heading (`runsheet.tsx`, the `line-clamp-2` branch) use it; the expanded heading still renders the whole goal.
- [ ] **F4 record title:** `recordTitle(objective: string, runs: Pick<Run, "goal" | "evidence">[] | undefined): { title: string; fromRun: boolean }` in `briefpeek.ts`: `runTitle` of the first run whose trimmed goal equals the trimmed objective (`fromRun: true`), else `objectiveParts(objective).headline` (`fromRun: false`); `runs` is `undefined` while the scope loads (`RecordPeekInput.runs`), which falls back to the headline. `buildRecordPeek` (`briefpeek.ts:176-185`) uses it for the title, and when `fromRun` the body is the whole objective (`peekBody` takes the flag; the clamp and its "Show the full objective" link still apply), since the lead sentence no longer shows in the title. Tests: a run whose goal equals the objective and whose summary has an H1 → title is that H1 and the body starts with the objective's first sentence; no matching run → the objective headline and today's body; `runs` undefined → the headline.
- [ ] **F7:** in `runsheet.tsx`'s run body (`data-run-sheet` column), below 800px viewport height (`[@media(max-height:799px)]:` arbitrary variants, no new variant in `tailwindsetup.css`): the outer column scrolls; the inner `div.sc` is no longer its own scroller (`flex-none`, `overflow-visible`); the `Reading` head and the `Dock` scroll with it; `RunComposer` stays pinned (`sticky bottom-0` with its current background). `Dock` and `RunComposer` share one `<footer>` today (`runsheet.tsx` ~255-258): split it into the `Dock` footer (keeps `data-jarvis-brief-sheet-face="settings"`, its border and background) and a composer wrapper, so the two can behave differently. At ≥800px height they stay pinned together as now.
- [ ] **Scenario steps in `run-sheet-polish` (`scripts/cdp/scenarios-runs.mjs`):**
  - F7 at 1000x700: the run sheet's scrolling container has `clientHeight >= 400`; scrolling it by 300px moves the `Reading` head's top up (it is not pinned); the composer's bottom stays within 2px of the sheet's bottom.
  - F7 at 1600x950: scrolling the body leaves the `Reading` head and the "Ran with" dock rects unchanged (still pinned).
  - F4 at 1600x950: the collapsed heading is the report's H1 when the fixture run's summary has one (seed one if the arrange does not), and its text has no `;`-cut ending; with no report it is the goal's lead sentence.
- [ ] The Shipped-row and record-peek title steps are added by Task 6 in `brief-act`; do not edit `scripts/cdp/scenarios-brief.mjs` here.
- [ ] Run `npx vitest run frontend/app/view/jarvis/effortfeed.test.ts frontend/app/view/jarvis/runreport.test.ts frontend/app/view/jarvis/briefrows.test.ts frontend/app/view/jarvis/briefpeek.test.ts frontend/app/view/jarvis/recordrunrow.test.ts`: PASS. Run `task check:ts`: clean.

### Task 5: Tracker, forms and labels (F6, F9, F10, F11, F12, F13, F15)
**Depends on:** none
**Files:** `frontend/app/view/jarvis/inlinetracker.ts`, `frontend/app/view/jarvis/inlinetracker.test.ts`, `frontend/app/view/jarvis/inlinetrackerview.tsx`, `frontend/app/view/jarvis/effortcreateform.tsx`, `frontend/app/view/jarvis/effortmodel.ts`, `frontend/app/view/jarvis/effortmodel.test.ts`, `frontend/app/view/jarvis/jiracheck.ts`, `frontend/app/view/jarvis/jiracheck.test.ts`, `frontend/app/view/jarvis/jiracheckdialog.tsx`, `frontend/app/view/jarvis/peek/peekeffortmodel.ts`, `frontend/app/view/jarvis/peek/peekeffortmodel.test.ts`, `frontend/app/view/jarvis/petjoin.ts`, `frontend/app/view/jarvis/petjoin.test.ts`, `frontend/app/view/jarvis/recordbandview.tsx`, `scripts/cdp/scenarios-jira-check.mjs`, `scripts/cdp/scenarios-jira-details.mjs`

Decisions are in the spec's F6, F9, F10, F11, F12, F13 and F15 sections.

- [ ] **F10:** the facts line in `inlinetracker.ts` is `"<counted> chunks · <done> done"`, plus `" · <n> skipped, not counted"` when skipped > 0 (counted = all − skipped; `"1 chunk"` singular). Tests: 37 chunks, 12 done, 1 skipped → `"36 chunks · 12 done · 1 skipped, not counted"`; the existing `"3 chunks · 1 done"` case unchanged.
- [ ] **F15:** sentence case for every footer label in `inlinetrackerview.tsx` (Rename, Details, Activity, Post to Jira, Pause/Resume, Archive, Unarchive, Delete, the confirm's Cancel and Delete). Keep the `action(...)` keys and `data-*` hooks; only visible text changes. Grep `scripts/cdp/*.mjs` for the old lowercase texts: fix any in the two Jira scenario files you own; leave `scenarios-brief.mjs` to Task 6, which greps it.
- [ ] **F13:** export `EFFORT_CREATED_NOTE = "effort created"` from `effortmodel.ts` (comment: mirrors `wshserver_effort.go`'s first note); `effortPeekModel`'s objective is the oldest note whose text is not it, else null. Tests: notes `[{ts:1,"effort created"},{ts:2,"Ship the G4 label"}]` → `"Ship the G4 label"`; only the marker → null.
- [ ] **F11:** drop the Edit footer's "changes apply immediately" (New keeps "ticked lines save as already done"). Parent becomes a type-to-filter picker modelled on `RecordPicker` (`recordpicker.tsx`): shows the chosen parent's title, lists matches under the input, Escape stops at the picker, a clear control empties it; the submitted value stays the bare oid. Matching is `parentChoices<T extends { oref: string; title: string; ticket?: string }>(cards: T[], query: string, selfOid: string | null, max: number): T[]` in `effortmodel.ts` (title or ticket, case-insensitive; excludes the card whose bare oid is `selfOid`). Tests: excludes self; matches by ticket; empty query returns the first `max`. The live initiatives come from the atom the Brief already reads (no new fetch).
- [ ] **F12:** `footerLine(covered: number, listed: number): string`: "more" only when `listed > 0` (`"2 assigned tickets already have an initiative."` with nothing listed). `jiracheckdialog.tsx` passes the listed count. Tests: `(2, 0)` and `(2, 3)` and `(1, 0)` → `"1 assigned ticket already has an initiative."`.
- [ ] **F9:** `eventFromResume`'s text is the summary alone. Update `petjoin.test.ts`.
- [ ] **F6:** in `recordbandview.tsx` the "open this record" span is `flex-none whitespace-nowrap`; the `EdgeChip` wrapper truncates (`min-w-0`).
- [ ] **Scenario steps:**
  - `jira-check` (`scenarios-jira-check.mjs`), at 1000x700 (the size of shot 42): with every assigned ticket already on an initiative, the footer reads `N assigned tickets already have an initiative.` with no `more`.
  - `jira-details` (`scenarios-jira-details.mjs`), at 1600x950: the Edit initiative footer has no "changes apply immediately"; typing part of another initiative's title into Parent lists it, picking it shows its title, saving persists its oid as the parent (read back through the effort RPC the scenario already uses), and the initiative being edited is not offered.
  - F6, F9, F10, F13 and F15 steps live in `scenarios-brief.mjs` and are added by Task 6.
- [ ] Run `npx vitest run frontend/app/view/jarvis/inlinetracker.test.ts frontend/app/view/jarvis/effortmodel.test.ts frontend/app/view/jarvis/jiracheck.test.ts frontend/app/view/jarvis/peek/peekeffortmodel.test.ts frontend/app/view/jarvis/petjoin.test.ts`: PASS. Run `task check:ts`: clean.

### Task 6: Brief scenario steps for attribution, titles and labels (F3, F4, F5, F6, F9, F10, F13, F15)
**Depends on:** Task 3
**Files:** `scripts/cdp/scenarios-brief.mjs`, `frontend/app/view/jarvis/briefingfixtures.ts`

Add steps only; no product code. Number each after the last step present in its scenario. The behavior these steps assert lands in Tasks 1, 4 and 5, which may merge after this task; Final runs them on the merged result. Write each step from the spec and the Interfaces named in those tasks (`runTitle`, `recordTitle`, the copy strings, the facts line format), using existing `data-*` hooks.

- [ ] **`record-band-detach-restore`:** arrange two records in one project and time window, each with its own lead run confirmed by a layer-1 ref (the scenario's existing arrange shows how it makes a record and run; extend it), plus one lead run neither record refs.
  - F3 at 1600x950: record A's peek lists under "Runs on this record" A's run and the unclaimed run, and not B's run.
  - F5 at 1600x950: run A's sheet record band shows A's record confirmed and no `guessed` row for record B.
  - F6 at 1600x950 and 1000x700: every expanded band row's "open this record" span is one line (`getClientRects().length === 1`, `scrollWidth <= clientWidth` on its row).
- [ ] **`brief-inline-tracker`:**
  - F10 at 1600x950: an initiative with a skipped chunk (arrange one) shows a facts line reading `<n> chunks · <d> done · 1 skipped, not counted` whose `<n>` equals the row's progress total.
  - F15 at 1600x950: every footer action label starts with an uppercase letter. Grep `scenarios-brief.mjs` for steps matching the old lowercase footer texts (rename, details, activity, post to Jira, pause, resume, archive, unarchive, delete, cancel) and switch them to the sentence-case labels.
- [ ] **`brief-act`:**
  - F4 at 1600x950: a Shipped row whose fixture summary has an H1 shows the H1 as its title; its `title` attribute is under 200 chars.
  - F4 record peek at 1600x950: a record whose objective is a long goal with a `;` mid-sentence has a peek title that does not end at the `;` (it is the origin run's report H1 when the fixture gives one).
  - F9 at 1600x950: build the bubble with `eventFromResume` imported via `mod("app/view/jarvis/petjoin.ts")` from a resume payload (a card with `summary` and `updated`), set it on `petBubbleAtom`, and check the drawn bubble's text equals the summary and does not start with `Where we were`. Also replace the two stale injected literals `"Where we were — verify"` (steps 10 and 26, ~lines 5284 and 5709) with summary-only text.
  - F13 at 1600x950: Ctrl-click peek of a Waiting row's initiative whose notes are the creation marker plus one written note shows the written note, never `effort created`.
- [ ] Run `node --check scripts/cdp/scenarios-brief.mjs` and `task check:ts`: clean.
