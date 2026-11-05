# Brainstorm pane, run records review fixes Implementation Plan

> **For agentic workers:** each task below runs as one engine worker. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-11-05-brainstorm-records-review-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/wavevault ./pkg/jarvisdossier ./pkg/jarvisattrib ./pkg/wshrpc/...`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs brainstorm-mode brainstorm-main brainstorm-check-review brainstorm-builder-check brainstorm-run-landed brief-peek record-band-detach-restore`

**Goal:** Fix findings F1-F22 of the brainstorm pane / run records / mod cards review
(`C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\brainstorm-records-mods\report.md`, read by that absolute
path; screenshots 01-21 beside it).

**Architecture:** Two Go fixes in the vault parser and attribution, then three frontend areas: the brainstorm pane,
the brainstorm check/review/run rails, and the run-record peek and band. The spec gives each decision and its reason.
Workers implement from it and must not re-decide anything it settles.

**Tech Stack:** Go (wavesrv), React 19 + jotai + Tailwind 4, vitest, CDP scenarios (`scripts/cdp/scenarios-*.mjs`).

## Global Constraints

- Logic in pure `.ts` model files with a `.test.ts` beside them, or in Go functions with tests. `.tsx` only renders
  (AGENTS.md "Logic is extracted, not rendered").
- Visual fixes use only the existing `@theme` tokens from `frontend/tailwindsetup.css`. Add no new token and no raw color.
- Every fixed view, visual state or interaction gets a step in the named CDP scenario, and the step shows that
  state. A step that only opens the surface does not count. Check narrow states at 1000x700 with
  `h.cdp("Emulation.setDeviceMetricsOverride", …)` and clear the override at the end of the step (pattern:
  `scenarios-agent.mjs` `MODELS_VIEWPORT`).
- Keyboard changes update `docs/keyboard-shortcuts.md`, and the `bindings.ts` label where the key is a registered
  binding. The cheat sheet is generated from `bindings.ts`.
- Three other runs may land on main first: 8028cea5 (openref.ts, briefsurface.tsx, briefsheet files),
  f537df33 (Usage; hides brainstorm judge and builder-check runs), 0d857f6c (palette; filters engine child runs).
  If one of them added a shared child-run or stage-role predicate, use it instead of adding another. When
  resolving conflicts, keep both sides' behavior.
- Run lint and format only on the paths you touched (`npx eslint <paths>`, `npx prettier --check <paths>`). Never
  run prettier on `scripts/*.mjs`.
- Never attach to or kill the dev app on :9222. A snapshot review app runs there.

## Review Focus

1. A CRLF record that also has a UTF-8 BOM. Expected: it parses like a plain CRLF record (Task 1 test).
2. A status write to a CRLF record. Expected: one front matter after the write, still CRLF (Task 1 test).
3. A brainstorm file that is missing for exactly one poll and then comes back. Expected: the gone view is never
   shown (Task 3 test).
4. A record whose only layer-1 ref names a stored reviewer child. Expected: no edge. A ref to a run that is not in
   the store is still kept (Task 2 test).
5. A run summary whose every line is a heading or a code fence. Expected: no headline, so the row falls back as
   it does today (Task 5 test).

---

### Task 1: CRLF front matter in the vault parser and region splice (F1)
**Depends on:** none
**Files:** `pkg/wavevault/parse.go`, `pkg/wavevault/parse_test.go`, `pkg/wavevault/region.go`, `pkg/wavevault/region_test.go`, `pkg/wavevault/write.go`, `pkg/wavevault/write_test.go`, `pkg/wavevault/read_test.go`, `pkg/jarvisdossier/dossier_test.go`, `pkg/jarvisdossier/decision_test.go`

Decisions (spec "F1"):
- `parseNode` normalizes `\r\n` to `\n` before splitting, and a leading UTF-8 BOM is skipped. The front matter and
  the returned body are both normalized. `ContentHash` still hashes the raw bytes.
- `region.go`'s front matter splice (around `:86-107` and `:150-171`) detects CRLF, splices on the normalized
  text, and writes the file back with CRLF. An LF file stays LF. The write guard on the same path
  (`write.go` `Vault.Write` → `spliceRegions` → `validateMachineOnly` → `humanProjection`, `region.go:132-179`)
  also matches only `---\n`, so it gets the same treatment: compare the normalized old and new content. Put the
  normalize step in one helper that the parser, the splice and the guard all call.

- [ ] **Step 1: Write the failing tests.**
  - `TestParseNodeCRLF` (parse_test.go): `"---\r\nid: t-1\r\nstatus: completed\r\nobjective: x\r\n---\r\n\r\nbody [[m-1]]\r\n"`
    gives `Frontmatter["status"] == "completed"`, `ID == "t-1"`, `Links == ["m-1"]`, and a body that does not
    start with `---`. A BOM-prefixed copy gives the same result.
  - `TestSpliceRegionsCRLF` (region_test.go): splicing a status field into a CRLF record leaves exactly one
    `---\r\n` opening, the new value set, and no bare `\n` line ending.
  - `TestWriteStatusCRLF` (write_test.go): a status write through `Vault.Write` to a CRLF record file is accepted
    by the machine-only guard (no error). The file on disk afterwards has one front matter, the new status, and
    only CRLF line endings, and the human body is byte-identical apart from the region.
  - In `dossier_test.go`, `TestLoadDossierCRLF`: a CRLF record loads its objective, status and updated time.
  - In `decision_test.go`, `TestLoadDecisionCRLF`: a CRLF decision loads its actor, status and rationale.
  - In `read_test.go`, `TestMemoryNoteCRLF`: a CRLF memory note is read with its frontmatter id and description.
- [ ] **Step 2:** `go test ./pkg/wavevault ./pkg/jarvisdossier -run 'CRLF'`. Expect FAIL.
  (F1 in the running app is checked by Task 5's `brief-peek` step, on the merged tree in Final.)
- [ ] **Step 3:** Implement the two decisions above.
- [ ] **Step 4:** `go test ./pkg/wavevault ./pkg/jarvisdossier -run 'CRLF|ParseNode|Splice'`. Expect PASS.

### Task 2: Attribute only lead runs; give ambient tasks a ticket (F18, F7 backend)
**Depends on:** none
**Files:** `pkg/jarvisattrib/extract.go`, `pkg/jarvisattrib/extract_test.go`, `pkg/wshrpc/wshserver/wshserver_jarvis.go`, `pkg/wshrpc/wshserver/wshserver_ambient_test.go`, `pkg/wshrpc/wshrpctypes_jarvis.go`, `frontend/types/gotypes.d.ts`, `docs/open-issues.md`

Decisions (spec "F18", "F7"):
- In `assembleEdges`, a run is a candidate only when `jarvis.UsageRole(r) == jarvis.UsageRole_Lead`, unless main
  has a newer shared predicate (see Global Constraints). This applies to every layer. A layer-1 ref to a
  stored non-lead run adds no edge. A layer-1 ref to a run missing from the store keeps today's behavior.
  `buildSpaceScope`, `buildAmbient` and `buildDossierGraph` all read these edges, so they need no filter of
  their own.
- `wshrpc.AmbientTask` gains `Ticket string \`json:"ticket,omitempty"\``. `buildAmbient` fills it in.
  `ambientLabel(d)` returns the first non-empty line of `d.Objective` bounded by `boundRunes(…, ambientLabelMax)`,
  and falls back to the bounded ticket when there is no objective. Then run `task generate`.

- [ ] **Step 1: Write the failing tests.**
  - `TestAssembleEdgesLeadOnly` (extract_test.go): a dossier whose ticket appears in the goals of a lead run, a
    worker child (`TaskId` set), a review child (`Review`), and runs with `StageRole` set to `plan-reviewer`,
    `verifier`, `builder-check` and `brainstorm-judge`. Only the lead gets an edge. A layer-1 ref to the
    reviewer child gives no edge. A layer-1 ref to an unknown oref is kept.
  - `TestAmbientLabelObjectiveAndTicket` (wshserver_ambient_test.go, beside `TestAmbientLabelAndTitleAreBounded`):
    two dossiers on ticket `SIEM-1739` with different objectives get different labels, and both have
    `Ticket == "SIEM-1739"`. A multi-line objective gives its first line, bounded.
  - Update `TestBuildAmbientProjectsTagsAndDecisions` in the same file. It asserts `label["task-1"] == "PROJ-142"`
    (the ticket wins), which is the behavior F7 changes. Assert the objective's first line as the label and
    `Ticket == "PROJ-142"` instead.
- [ ] **Step 2:** `go test ./pkg/jarvisattrib -run 'TestAssembleEdgesLeadOnly'` and
  `go test ./pkg/wshrpc/wshserver -run 'TestAmbientLabel|TestBuildAmbient'`. Expect FAIL.
- [ ] **Step 3:** Implement, then run `task generate`.
- [ ] **Step 4:** Rerun both. Expect PASS. `go test ./pkg/jarvisattrib -run 'Edges'` still passes.
- [ ] **Step 5:** Add an entry to `docs/open-issues.md`, in its existing format: opening a hidden run (stage
  role, review or task child) by oref, e.g. `wsh ui reveal run:<judge run>`, lands on another run's sheet. The
  code is in `openref.ts`, which run 8028cea5 owns. Since F18, records no longer link to such runs.

### Task 3: Brainstorm pane: gone-file recovery, part order, narrow rows, gone copy (F3, F15, F20, F22)
**Depends on:** none
**Files:** `frontend/app/view/agents/brainstormpoller.ts`, `frontend/app/view/agents/brainstormpoller.test.ts`, `frontend/app/view/agents/brainstormmodel.ts`, `frontend/app/view/agents/brainstormmodel.test.ts`, `frontend/app/view/agents/brainstormpane.tsx`, `frontend/app/view/agents/brainstormstore.ts`, `frontend/app/view/agents/brainstormstore.test.ts`, `scripts/cdp/scenarios-brainstorm.mjs`

Decisions (spec "Brainstorm pane"):
- F3: `pollAndMerge` no longer returns early on `s.removed`. `BrainstormState` gains `missedStats: number`.
  `pollBrainstormOnce` returns `{ missedStats: n }` on the first miss and `{ removed: true, missedStats: n }` from the
  second consecutive miss. Once the state is already removed, it returns `{}`. A stat that finds the file resets
  `missedStats` to 0 on every branch. The early "mod time has not moved" branch therefore returns
  `{ missedStats: 0 }` when `s.missedStats > 0`, and `{}` otherwise. Use the constant `MISSES_FOR_REMOVED = 2`. Add the field wherever `BrainstormState` is built
  (`brainstormstore.ts`).
- F22: `drawnDecisionParts(f: BrainstormFile): BrainstormPart[]` in brainstormmodel.ts returns the non-builder
  decisions newest first, then the builder part last. `progressView` and the pane's Decisions list both use it.
  The pane drops its own `.reverse()`.
- F15: the Decisions section is an `@container`. Below the container width at which the title column and a
  150px action group leave the gist under ~240px (pick the breakpoint and state it in a comment), a part row
  stacks: the title above the gist, and the actions on their own line under the gist. The expanded body's
  indent follows: under the gist when wide, under the dot when stacked. At wide widths the layout is unchanged.
- F20: `brainstormGoneText(path: string): string` in brainstormmodel.ts. For a path containing an `arc-wt`
  segment: "It lived in a run's worktree (arc-wt\<key>), which has been removed." Otherwise: "It is no longer at
  <path>." `Removed` renders it in place of the "usually because the feature shipped" sentence. Keep "The switch
  disappears once you go back to the terminal."

- [ ] **Step 1: Write the failing tests.**
  - brainstormpoller.test.ts: "recovers after a removed file comes back". A state with `removed: true` and a
    stat that exists gives `removed: false` and the file. "one missing poll does not mark it removed". "two
    missing polls mark it removed". "an already removed file returns no patch". "an unchanged mod time after one
    miss resets missedStats": a state with `missedStats: 1` and the same `modifiedMs` gives `{ missedStats: 0 }`.
  - brainstormmodel.test.ts: `drawnDecisionParts` on parts `[a, b, builder]` gives `[b, a, builder]`, and
    `progressView(f).segments.map(s => s.id)` equals the same order. `brainstormGoneText` covers a path under
    `C:\Users\x\AppData\Local\arc-wt\be10d02a\…` (names `arc-wt\be10d02a`) and a plain path (names the path).
- [ ] **Step 2:** `npx vitest run frontend/app/view/agents/brainstormpoller.test.ts frontend/app/view/agents/brainstormmodel.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement the model and poller, then the pane.
- [ ] **Step 4:** Rerun the vitest files. Expect PASS.
- [ ] **Step 5: Scenario steps.**
  - `brainstorm-mode`: after step 12 (file gone), add steps for the gone view's new copy (no "feature
    shipped") and for "restoring brainstorm.json returns from the gone view to the design". The latter writes
    the file back after the gone view showed, then waits with `bsUntil` (`BS_POLL_WAIT_MS`) for the design view.
    The one-poll gap is not timed in a scenario, because it would be flaky. It is pinned by the poller unit
    tests above.
  - `brainstorm-main`: add a step showing the progress segments' order equals the rows' order. Add a step at
    1000x700 showing that no part row's title overlaps its actions (bounding rects do not intersect) and that the
    gist is wider than 200px. Each step takes a screenshot.

### Task 4: Builder check, review and run rails (F16, F17, F19)
**Depends on:** Task 3
**Files:** `frontend/app/view/agents/brainstormmodel.ts`, `frontend/app/view/agents/brainstormmodel.test.ts`, `frontend/app/view/agents/brainstormui.tsx`, `frontend/app/view/agents/brainstormcheck.tsx`, `frontend/app/view/agents/brainstormreview.tsx`, `frontend/app/view/agents/brainstormrun.tsx`, `frontend/app/store/keybindings/bindings.ts`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios-brainstorm-review.mjs`, `scripts/cdp/scenarios-brainstorm-builder.mjs`, `scripts/cdp/scenarios-brainstorm-run.mjs`

Decisions (spec "Builder check, review, run rails"):
- F16: `export const BS_RAIL = "w-[32%] min-w-[280px] max-w-[460px] flex-none"` in brainstormui.tsx. The rails in
  brainstormcheck.tsx (`:213`), brainstormreview.tsx (`:437`) and brainstormrun.tsx (`:104`) use it in place of
  `w-[460px] flex-none`. The main column next to each rail keeps `min-w-0`.
- F17: each `ReviewModel` row gains `hasWas: boolean`, and the model gains `anyWas: boolean`. When `hasWas` is
  true the toggle label reads "Show what it was" / "Hide what it was", otherwise "Show it" / "Hide it". The
  caption "open one to see what it was" shows only when `anyWas` is true. The review hint for `Enter`, the
  `bindings.ts` label (`:1123`) and `docs/keyboard-shortcuts.md` (`:174`) become "Open or close the decision".
- This task also owns the record picker's lines in `docs/keyboard-shortcuts.md` (Jarvis section), so Task 6 does
  not need to wait for it: `Enter` in the record picker attaches the top match, and `Esc` closes only the picker.
  Task 6 builds that behavior.
- F19: `checkRailLine(questions: number): string` ("It had 1 question." / "It had N questions.") and the review
  rail summary (currently the function ending `brainstormreview.tsx:496`) move into brainstormmodel.ts and use
  `plural()`.

- [ ] **Step 1: Write the failing tests** (brainstormmodel.test.ts), with these exact names:
  - `it("checkRailLine pluralizes")`: `checkRailLine(1)` contains "1 question." and `checkRailLine(2)` contains
    "2 questions".
  - `it("review rail summary pluralizes")`: the summary with 1 question says "It had 1 question:".
  - `it("checkReview marks hasWas")`: a touched row with no `was` has `hasWas === false`, a row with `was` has
    `hasWas === true`, and `anyWas` matches.
- [ ] **Step 2:** `npx vitest run frontend/app/view/agents/brainstormmodel.test.ts -t "pluralizes|hasWas"`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expect PASS.
- [ ] **Step 5: Scenario steps.**
  - `brainstorm-check-review`: a step opens a touched row with no `was`. It asserts the toggle reads "Show it",
    no caption says "what it was", and the hint for Enter reads "Open or close the decision". A step reads the
    review rail's summary (`aside[aria-label="The builder check"]`) on a check file with exactly one builder
    question, writing such a file with `bsWrite` if the scenario's file has more, and asserts "It had 1
    question:" (F19). A step at 1000x700 asserts the review's main column is wider than 400px and the Approve
    button is inside the viewport with no horizontal scroll.
  - `brainstorm-builder-check`: a step with one builder question asserts the rail reads "It had 1 question".
    A step at 1000x700 asserts the main column is wider than 400px.
  - `brainstorm-run-landed`: a step at 1000x700 asserts "Open run" does not overlap the title, and takes a
    screenshot.

### Task 5: Record peek: decisions, loading state, parallel runs, run headlines, shared copy (F4, F5, F6, F12, F2 form, F13/F14 helpers, F1 in the app)
**Depends on:** none
**Files:** `frontend/app/view/jarvis/briefpeek.ts`, `frontend/app/view/jarvis/briefpeek.test.ts`, `frontend/app/view/jarvis/briefpeekview.tsx`, `frontend/app/view/jarvis/decisionlog.tsx`, `frontend/app/view/jarvis/jarvissubjectstore.ts`, `frontend/app/view/jarvis/recordrunrow.ts`, `frontend/app/view/jarvis/recordrunrow.test.ts`, `scripts/cdp/scenarios-brief.mjs`

Decisions (spec "Run records"):
- Produces for Task 6:
  `objectiveParts(objective: string): { headline: string; body: string | null; bodyMore: string | null }`
  (today's `peekBody` clamp and "Show the full objective · Nk" logic, with the empty-objective case left to the
  caller). Its `body` is the rest of the objective after the headline sentence, trimmed, and null when nothing
  is left. When `headline()` cut the first sentence (its result ends in "…"), `body` is the whole objective.
  The peek uses this body too, so it stops repeating its own title (spec F13). `bodyMore` is measured on `body`.
  Also exported: `statusConfirmCopy(status: string): { title: string; body: string }`, which returns
  `Mark this record ${status}?` and `This sets the record's status to "${status}". You can reactivate it later.`
  Both are exported from briefpeek.ts. The peek uses them.
- F4: the footer's `logLine` becomes a button (`data-jarvis-peek-decisions`), labeled "1 decision" / "N decisions"
  / "No decisions yet". "on the Brief" is dropped. It toggles a Decisions section in the peek body that renders
  `<DecisionLog decisions dossierId>`, Add decision included. When `pendingDecisionAnchorAtom` names a decision
  of the open record, the section opens. When the peek closes or switches record, it sets the anchor to null.
  Add the pure rule `decisionsOpenOnMount(anchor, decisions): boolean` in briefpeek.ts.
- F5: `RecordPeekInput.runs: Run[] | undefined`. `undefined` gives `runsLoading: true`, the view shows three
  `SkeletonLine` rows, and `runsAbsent` is null. The view passes `runsByRecord[recordId]` without `?? []`.
- F6: `reloadRecordScope` loads the runs with `Promise.all`, keeps the scope's order, and drops failed loads, as
  today.
- F12: `runRow`'s headline comes from `reportHeadline(summary: string): string | null` in recordrunrow.ts. It takes
  the first line that has prose left after stripping heading `#`, list and quote markers, `**`/`_` emphasis and
  backticks, and skipping fence lines. The result is bounded with `headline()` from effortfeed.ts.
- F2 (form): AppendForm's inputs handle `Escape` with `e.stopPropagation()` and cancel the form (`onDone`).

- [ ] **Step 1: Write the failing tests.**
  - briefpeek.test.ts: `buildRecordPeek` with `runs: undefined` gives `runsLoading === true` and
    `runsAbsent == null`, and with `[]` it gives the absence sentence. The log button labels for 0, 1 and 3
    decisions are as above. `decisionsOpenOnMount("dec-2", [{id:"dec-2"}])` is true, and false for an id not in the
    list. `statusConfirmCopy("completed").title === "Mark this record completed?"`. `objectiveParts`: a one-sentence
    objective gives `body: null`. `"Fix the band. It repeats the ticket.\n\nMore detail."` gives headline
    `"Fix the band."` and a body starting `"It repeats the ticket."` with no headline in it. A first sentence
    longer than the headline cap gives the whole objective as `body`. A body over `BODY_CLAMP_CHARS` sets
    `bodyMore`.
  - recordrunrow.test.ts: `"# SIEM-1739 run F…\n\n## Done\nCommit \`cf6e2462dc\` landed the fix."` gives
    `"Commit cf6e2462dc landed the fix."`. A summary that is only headings or fences gives null, and the row then
    falls back to the goal rule.
- [ ] **Step 2:** `npx vitest run frontend/app/view/jarvis/briefpeek.test.ts frontend/app/view/jarvis/recordrunrow.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expect PASS.
- [ ] **Step 5: Scenario steps in `brief-peek`.**
  - Seed a CRLF record file in the scenario's vault, open its peek, and assert its title is the objective
    headline, it shows status buttons, and the body does not start with `---` (F1).
  - F5, holding the scope read: import `jarvissubjectstore.ts` and `@/app/store/wshclientapi` in the page
    through the dev server's `/@fs/<repo>/frontend/...` module URL (the same module the app runs, so the patch
    is seen). Remove the record's entry from `recordRunsAtom` and `recordScopeAtom`, replace
    `RpcApi.ResolveFocusScopeCommand` with a function returning a promise that never settles, and open the peek.
    Assert there is no "No session has ever been attributed" text and that skeleton rows are present. Then
    restore the original function, reload the scope, and assert the run rows appear.
  - F4, footer: click `[data-jarvis-peek-decisions]` and assert the Decisions section opens with an "Add
    decision" button. Click it again and assert the section closes.
  - Assert the run rows' headlines contain no `#` and no backtick (F12).
  - Open the record with `wsh ui reveal task:<id> --anchor <decision id>` (or the openref path the scenario
    already uses) and assert the decision card is visible and highlighted, and that the anchor atom is null
    after the flash and after the peek closes (F4).
  - Open Add decision, type, press Escape, and assert the form closed and the peek is still open (F2).

### Task 6: Record band, picker and detail (F2 picker, F7 chip, F8, F9, F10, F11, F13, F14, F21)
**Depends on:** Task 2 (the ambient `ticket` wire field in gotypes.d.ts), Task 5
**Files:** `frontend/app/view/jarvis/recordband.ts`, `frontend/app/view/jarvis/recordband.test.ts`, `frontend/app/view/jarvis/recordbandview.tsx`, `frontend/app/view/jarvis/recordpicker.tsx`, `frontend/app/view/jarvis/taskdetail.tsx`, `frontend/app/view/jarvis/briefsheet.tsx`, `frontend/app/view/agents/ambient.ts`, `frontend/app/view/agents/ambient.test.ts`, `frontend/app/view/agents/ambientviews.tsx`, `scripts/cdp/scenarios-brief.mjs`

Decisions (spec "Run records"):
- F7: `AmbientTag` gains `ticket?: string`, copied from `AmbientTask.ticket` in ambient.ts. `EdgeChip` shows it as
  a small mono chip after the label.
- F8: the collapsed "one" row drops the `band.edge.taskId` span. The chip gets `title={taskId}`.
- F9: `bandGlyph(band: BandCase): boolean` in recordband.ts is true only when the shown edge (one: `edge`,
  several: `primary`) is not `confirmed`. The glyph is lucide `Bot` with the title "Guessed by Jarvis: expand to
  confirm or detach it".
- F10: `edgeLabel(tag)` maps `confirmed` to "confirmed". Any other state maps to "guessed · " plus
  strong→"strong", medium→"likely", weak/unknown→"weak". ambientviews.tsx's tooltip (`:41`) uses `edgeLabel`.
- F11: `recordPickerMatches(records: { id: string; objective: string; ticket?: string }[], q: string, max: number)`
  in recordband.ts matches case-insensitively on objective, id and ticket. The picker shows the ticket chip
  (when there is one) instead of `id.slice(0, 8)`. `Enter` attaches the first match. `Escape` closes only the
  picker (`e.stopPropagation()`). Task 4 already documents these two keys in `docs/keyboard-shortcuts.md`.
- F13/F14: `TaskDetail` uses `objectiveParts` (Task 5) for its `h2` headline and a clamped body with the
  "Show the full objective" toggle, and uses `statusConfirmCopy` (Task 5) for the ConfirmDialog.
- F21: delete `BandCase`'s `subject` case, `BandInput.kind`, the `kind` prop, the subject row, `showPanel`'s
  subject arm, and `TaskDetail`'s `showDecisions` parameter (its log always renders). Update the callers in
  briefsheet.tsx (`:321`, `:421`). Grep for every other reference before deleting.

- [ ] **Step 1: Write the failing tests.**
  - recordband.test.ts: the `edgeLabel` mappings, with `{state:"informing", bucket:"bogus"}` giving "guessed ·
    weak". `bandGlyph` is false for a confirmed one-edge band and true for an informing one. For
    `recordPickerMatches`, "1739" matches a record by ticket, a slug fragment matches by id, and the result is
    capped at `max`. The subject-case test is removed.
  - ambient.test.ts: a task with `ticket` yields tags carrying `ticket`.
- [ ] **Step 2:** `npx vitest run frontend/app/view/jarvis/recordband.test.ts frontend/app/view/agents/ambient.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expect PASS.
- [ ] **Step 5: Scenario steps in `record-band-detach-restore`.**
  - Collapsed band: assert no raw record id text before the chip, and a chip label reading "confirmed" or
    "guessed · …" (never "informing"). Assert no glyph on a confirmed edge and a glyph with the new title on a
    guessed one.
  - Expanded band with two records on one ticket: assert distinct labels and a ticket chip.
  - Expanded detail: assert the `h2` is one line (the objective headline) and the status confirm reads "Mark
    this record …?".
  - F13 body: on a record whose objective is longer than `BODY_CLAMP_CHARS` (seed one if the scenario's record
    is short), assert the body under the `h2` is clamped, does not repeat the headline, and has a "Show the full
    objective" toggle. Click it and assert the body grows and the label reads "Show less".
  - Attach a record: assert the picker rows show no 8-character id. Type a ticket fragment and assert it
    matches. Press Enter and assert the record attached. Open the picker again, press Escape, and assert the
    picker closed while the run sheet is still open.
