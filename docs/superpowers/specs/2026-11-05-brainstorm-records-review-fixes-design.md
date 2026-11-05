# Brainstorm pane, run records and mod cards review: fixes (design)

Source: the review at `C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\brainstorm-records-mods\report.md`
(gitignored; screenshots 01-21 beside it). It lists 22 findings, F1-F22. The review's "Checked, not defects"
and "Tooling gaps" sections are out of scope. None of the findings is in the claude mods, so no mod source changes.

Every cause below was checked against the code at `31ab859d1`. Where this design differs from the report's
suggested fix, the reason is given.

## Shared rules

- Logic goes in pure model files with tests beside them (`foo.ts` + `foo.test.ts`, or Go functions with tests).
  The `.tsx` files only render.
- Visual fixes use only the existing `@theme` tokens. No new colors or spacing tokens.
- Each fixed view, visual state or interaction gets a step in a CDP scenario that shows it. A step that only
  opens the surface does not count. Narrow-window states are checked at 1000x700 with
  `Emulation.setDeviceMetricsOverride`, then the override is cleared. This is the same pattern
  `scenarios-agent.mjs` uses.
- Other runs in flight (8028cea5 Brief, f537df33 Usage, 0d857f6c palette) may land first. If main by then has a
  shared child-run or stage-role predicate, use it instead of the one named here. Conflicts are resolved so that
  every run's behavior is kept.

## Go

### F1: CRLF front matter (records, decisions, memory)

- `pkg/wavevault/parse.go` `parseNode`: before splitting the front matter, normalize `\r\n` to `\n`. Both the
  front matter and the returned body are normalized. `ContentHash` stays on the raw bytes, because it is the
  invalidation key for the file as stored. Reason: the body is parsed further for dossier sections and
  wikilinks, so normalizing it once fixes every reader downstream.
- `pkg/wavevault/region.go` (an addition to the report's fix): the write-path splice also matches only `---\n`.
  A status write to a CRLF record would therefore prepend a second front matter. The fix: detect CRLF,
  normalize, splice, then write the file back with CRLF. Reason: keeping the file's own line endings avoids a
  whole-file diff in the vault's git on every status write.
- Tests: a CRLF record through `jarvisdossier.LoadDossier` gets its objective, status and updated time; a CRLF
  decision loads its fields; a CRLF memory note gets its frontmatter id and description through the vault
  read; and a region splice on a CRLF file keeps one front matter and its CRLF endings.

### F18: hidden-role runs are attributed to records (cause traced)

- Traced cause: `pkg/jarvisattrib/lifecycle.go` `gatherLookups` loads every stored Run, and
  `extract.go` `assembleEdges` runs the layer-2 (ticket) and layer-3 (window/paths) extractors over all of
  them. This includes the engine's worker and reviewer children and every stage-role run (`plan-reviewer`,
  `verifier`, `builder-check`, `brainstorm-judge`). The record scope (`buildSpaceScope`), the ambient map and the
  band all read these edges, so the runs show up everywhere.
- Fix: only a lead run can be attributed. The predicate is the existing `jarvis.UsageRole(r) ==
  jarvis.UsageRole_Lead`. It already says "stage role, review child, task child, else lead", so this adds no
  new filter. `jarvisattrib` already imports `pkg/jarvis` (`extract.go`), so this adds no new dependency.
  The rule applies in `assembleEdges` to every layer. A layer-1
  ref to a stored non-lead run is dropped. A layer-1 ref to a run that is not in the store keeps today's
  behavior: it is surfaced, not dropped.
- Not fixed: opening a hidden run by oref (`run:f53d3936`) lands on another run's sheet. That is `openref.ts`,
  which run 8028cea5 owns. After this fix a record no longer links to such runs, so the path is not reachable
  from records. Task 2 records it in `docs/open-issues.md`.

### F7: every record on one ticket gets the same label

- `ambientLabel` (`wshserver_jarvis.go:788`) returns the objective's first line, bounded to `ambientLabelMax`.
  It no longer returns the ticket. `wshrpc.AmbientTask` gains `Ticket string json:"ticket,omitempty"`, and the
  band draws the ticket as its own small chip. Then `task generate`.
- Not done: collapsing weak/medium edges behind a count. Lead-only attribution (F18) already removes most of
  the noise, so measure again before adding this (YAGNI).

## Brainstorm pane

- **F3**: `pollAndMerge` keeps polling a removed brainstorm. `pollBrainstormOnce` returns `{}` when the file is
  still missing and the state is already removed, so a gone file does not re-render on every poll. The pane
  shows the gone view after two consecutive misses (a `missedStats` counter, the same idea as
  `FAILED_READS_FOR_ERROR`). Reason: an agent's delete-then-rename write leaves the file missing for one poll.
- **F22**: the design shows decisions newest first on purpose (`042a99068`). The cause is two orderings: the
  pane reverses the list itself, while `progressView` keeps file order. A single model function,
  `drawnDecisionParts(f)`, returns the drawn order, and both the pane and `progressView` use it. In that order
  the non-builder decisions are newest first and the builder part stays last. Reason: `orderedParts` puts the
  builder part last on purpose ("the agent writes this last"), and the bare `.reverse()` moved it to the top
  by accident.
- **F15**: the Decisions section becomes an `@container` (container queries are already used in
  `agentrow.tsx`). When the section is narrow, the part row stacks: the title goes above the gist instead of
  the fixed `w-[200px]` column, and the action group moves under the gist instead of `min-w-[150px]`. The
  expanded body's left indent follows the layout: it lines up with the gist when wide and with the dot when
  stacked. When wide, the layout is unchanged. Reason: DESIGN.md Layout says content is fluid and fixed widths
  are for rails only. The "Decided so far" rail keeps its sizing.
- **F20**: `brainstormGoneText(path)` in `brainstormmodel.ts` says only what is known: the file is no longer at
  `<path>`. When the path is under an `arc-wt` run worktree, it says that the run's worktree was removed. The
  claim "usually because the feature shipped" is dropped.

## Builder check, review, run rails

- **F16**: one exported constant, `BS_RAIL`, in `brainstormui.tsx`: `w-[32%] min-w-[280px] max-w-[460px]
  flex-none`. The check, review and run rails use it. The design rail's own sizing
  (`max-w-[500px]`) is left as it is, because the review flags no defect there.
- **F17**: `checkReview` marks for each row whether it has a `was`. The toggle reads "Show what it was" only
  when there is a `was`, and "Show it" / "Hide it" otherwise. The section caption "open one to see what it
  was" is shown only when at least one row has a `was`. The `Enter` hint, the `bindings.ts` label and
  `docs/keyboard-shortcuts.md` become "Open or close the decision". The skill is not changed to write `was`:
  the UI should be honest with the files that exist today.
- **F19**: the rail sentences in `brainstormcheck.tsx` and `brainstormreview.tsx` move into model functions
  that use `plural()` from `brainstormmodel.ts`.

## Run records

- **F1 check in the app**: a seeded CRLF record opens in the peek with its title, status and objective.
- **F2**: the record picker's input and the Add decision form handle `Escape` themselves and call
  `stopPropagation()`. Escape in the picker closes the picker. Escape in the form closes the form, the same as
  Cancel. The sheet stays open in both cases. Reason: `ModalShell` listens on window, and stopping
  propagation at these two inputs fixes both. Teaching every ModalShell to honor `defaultPrevented` would
  change the Escape behavior of every modal, which is a much larger change.
- **F4**: the peek footer's "N decisions" becomes a toggle that shows the record's `DecisionLog`, Add decision
  included, inside the peek body. When `pendingDecisionAnchorAtom` names a decision of the open record, the
  peek opens with the log shown, and the existing flash then clears the anchor. The anchor is also cleared when
  the peek closes or switches record. The words "on the Brief" are dropped from the line. Reason: the peek is
  a record's only home (`openref.ts` `openRecordPeek`), so it has to show and add decisions.
- **F5**: `buildRecordPeek` takes `runs: Run[] | undefined`. `undefined` means not loaded yet: it shows
  skeleton rows (`SkeletonLine`) and no "No session has ever been attributed" sentence.
- **F6**: `reloadRecordScope` loads the runs with `Promise.all`, keeping the scope's order. No cap: F18 cuts
  the list down to lead runs.
- **F12**: `runRow`'s headline is the first prose line of the evidence summary. Markdown heading, list and
  emphasis markers and code ticks are stripped, the line is bounded with `headline()` from `effortfeed.ts`, and
  lines that are only a heading are skipped.
- **F13**: the peek's `peekBody` logic becomes an exported `objectiveParts(objective)` in `briefpeek.ts`. It
  returns the headline, the body and the "show more" label. The body is the rest of the objective after the
  headline sentence. When `headline()` had to cut the first sentence (it ends in "…"), the body is the whole
  objective. The peek's body changes to this too: today it repeats the headline that is already its title, which
  breaks DESIGN.md Copy ("each piece of text does one job"). The record detail (`taskdetail.tsx`) shows the
  headline as its `h2` and the body clamped, with the same toggle. Reason: a single source for how an objective
  is shortened.
- **F14**: `statusConfirmCopy(status)` in `briefpeek.ts` returns `{title, body}` with the peek's wording
  ("Mark this record …?", "the record's status"). It is used by both the peek and `taskdetail.tsx`.
- **F8**: the collapsed band row drops the raw `taskId`. The id goes into the chip's `title`.
- **F9**: the machine glyph is drawn only when the shown edge is inferred (not `confirmed`). The lock icon
  becomes lucide `Bot`, with the tooltip "Guessed by Jarvis: expand to confirm or detach it". Reason: a lock
  reads as "can't change", which is the opposite of what it means.
- **F10**: `edgeLabel` maps internal values to user words: `confirmed` → "confirmed" (no bucket, since a
  confirmed link has no confidence to show); any other state → "guessed · " plus `strong` → "strong",
  `medium` → "likely", `weak` or unknown → "weak". An unknown value never reads as stronger than weak. The
  tooltip in `ambientviews.tsx` uses the same function.
- **F11**: the picker drops the 8-character id column and shows the record's ticket as a chip when it has
  one. `recordPickerMatches(records, q)` in `recordband.ts` matches the objective, the id and the ticket.
  `Enter` attaches the top match. `docs/keyboard-shortcuts.md` (Jarvis) lists `Enter` and `Esc` in the picker.
  These are keys local to the input, not registered bindings, and the cheat sheet is generated from
  `bindings.ts`, so the cheat sheet has nothing to update.
- **F21**: delete the band's `subject` case: `BandCase.subject`, the `kind === "dossier"` arm, `showPanel`'s
  subject arm and the "Selected directly from Records" row. Also delete `BandInput.kind`, the `kind` prop and
  `TaskDetail`'s `showDecisions` parameter, which only the subject case used. The callers in `briefsheet.tsx`
  are updated to match.
