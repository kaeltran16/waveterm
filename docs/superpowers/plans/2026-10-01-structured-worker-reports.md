# Structured worker reports, routed by section — Implementation Plan

**Effort:** effort:0d2feabb-ca35-4e0b-a3f4-b0a850c893e0
**Verify:** `node scripts/verify.mjs ./pkg/jarvis/... ./pkg/orchestrate/... ./pkg/wshrpc/... ./pkg/waveobj/... ./cmd/wsh/...`
**Check:** `go vet ./pkg/jarvis/... ./pkg/orchestrate/... ./pkg/wshrpc/... ./pkg/waveobj/... ./cmd/wsh/... && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement your task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Do not spawn subagents or forks.

**Goal:** A dag worker's report is five fixed sections, refused at `complete` when malformed; each section reaches
the reader that acts on it whole (lead wake, later tasks by plan edge, the run's final record), and anything cut is
marked with the command that reads the rest.

**Architecture:** One pure parser in `pkg/jarvis` (`ParseWorkerReport`). The raw report stays the single source of
truth (`Run.Report`, sealed into `Evidence.Summary`); every reader parses it on read, and a report that doesn't parse
(written before this change) falls back to one legacy helper. `pkg/orchestrate` routes sections: the review-pass wake
(lead), dispatch handoff and typed notes (descendants), and caveat readers (final stage). At the lead's seal,
`SealEvidence` snapshots a structured `Evidence.Dag` record from the dag; `wsh runs show` and the run sidebar render it.

**Tech Stack:** Go (`pkg/jarvis`, `pkg/orchestrate`, `pkg/wshrpc`, `pkg/waveobj`, `cmd/wsh`), React + TS (vitest).

**Spec:** `docs/superpowers/specs/2026-10-01-structured-worker-reports-design.md`. Read it before your task: it
carries the measurements and the four approved decisions. Don't re-open them.

## Global Constraints

- The five sections, in this order, with these headings and pull keys:
  `## Done` (`done`), `## Differs from plan` (`differs`), `## Not verified` (`not-verified`),
  `## For later tasks` (`for-later`), `## Found not fixed` (`found-not-fixed`). Declared once in `pkg/jarvis`; no
  other file spells a heading or key as a literal except tests.
- `reportSectionMaxLen = 2500` characters (runes, not bytes), beside `handoffMaxSummaryLen` in
  `pkg/orchestrate/engine.go`. Over it, text is cut at a line boundary at or below the limit and ends
  `… <N> more characters: wsh jarvis dag report <task> <key>` (no `<key>` for a whole legacy report). Nothing
  reaches the lead or a later task shortened without that marker.
- The report stays unstored-as-parsed: no parsed copy goes on a `Run` or `TaskNode`. The only stored structure is
  the seal-time `Evidence.Dag` snapshot (Task 3 types, Task 6 builds it).
- Leads, spikes, reviewers, plan reviewers and the final verifier keep free-form reports. Only a dag worker
  (`run.TaskId != ""` and not `run.Review`) is held to the format.
- No version gate: a worker running when this lands takes one refusal.
- Never hand-edit generated files (`frontend/types/gotypes.d.ts`, `wshclientapi.ts`, `wshclient.go`, …); edit Go,
  then `task generate`. Only Task 3 changes wire types.
- Tests test behavior at the seams the package already tests (see each package's `*_test.go`); frontend logic is a
  pure `.ts` with a `.test.ts` beside it, no render tests (AGENTS.md).
- Comments only for "why", lower case, matching the surrounding files' density. No attribution trailers in commits.

## Review Focus

1. **CRLF reports.** Windows workers write `\r\n`; `## Done\r` must parse as `Done`, and section text must not carry
   stray `\r`. Test in Task 1.
2. **A UTF-8 BOM at the start of the file** (some Windows editors write one) must not read as "text before the first
   heading". Test in Task 1.
3. **A `## ` line inside a fenced code block** (a worker quoting markdown) is section content, not a heading. Test in
   Task 1.
4. **A single line longer than the cap** (a long log line with no newline below the limit) still cuts, at the limit,
   with the marker; it never yields an empty body or the uncut text. And the count is runes: a section of multi-byte
   text exactly at 2500 runes is not cut. Test in Task 4.
5. **`--for` alone on a legacy report** is refused with the None message (a legacy report has no For later tasks),
   not silently accepted. Test in Task 5.

---

### Task 1: The report parser

**Depends on:** none

**Files:**
- Create: `pkg/jarvis/workerreport.go`
- Test: `pkg/jarvis/workerreport_test.go`

**Interfaces — Produces** (every later task relies on these names):
- `type WorkerReport struct { Done, Differs, NotVerified, ForLater, FoundNotFixed string }` — each field the
  trimmed section body; empty when the section held `None`.
- `func ParseWorkerReport(text string) (WorkerReport, error)`
- `func ReadWorkerReport(summary string) (rep WorkerReport, unstructured string)` — the one legacy fallback every
  reader uses (spec §1 "one helper, used everywhere"). A summary that parses: `rep` set, `unstructured == ""`. A
  non-empty summary that doesn't parse (written before this change): `unstructured` is the trimmed summary. Empty
  summary: both zero.
- `func (r WorkerReport) Section(key string) (string, bool)` — `ok` is false for an unknown key; a known empty
  section returns `("", true)`.
- `type WorkerReportSection struct { Key, Heading string }` and `var WorkerReportSections []WorkerReportSection`
  in report order (the table in Global Constraints).
- `const WorkerReportTemplate string` — the literal template below, used by the worker prompt and the refusal:

```
## Done
<what landed, and the checks you ran with their results>

## Differs from plan
<each departure from the task or plan, and why; or None>

## Not verified
<checks the task or plan asked for that you did not do, and why; or None>

## For later tasks
<what a later task must know, including a departure that changes what it builds on; or None>

## Found not fixed
<failures already on the base, and defects outside your task; or None>
```

**Rules** (spec §1 "The parser", plus Review Focus 1–3):
- A section starts at a line `## <name>`; the name matches a heading case-insensitively after trimming whitespace.
- Each of the five appears exactly once, any order. `###` and deeper are content of their section.
- `None` (case-insensitive, optional trailing period, surrounding whitespace) makes the field empty. A section with
  no text at all is refused, so an omitted body can't read as an empty one.
- Refused: non-blank text before the first `## `, an unknown `## ` heading, a duplicate, a missing section, an empty
  body. The error names every problem at once (one retry fixes the report), e.g.
  `missing: Not verified; duplicate: Done; unknown heading "## Notes"; empty (write None): For later tasks; text before the first heading: "Commit: 1a2b…"`.
  Quote at most ~60 characters of stray text.
- Accept `\r\n`; strip a leading BOM; lines inside a ``` fence never start a section.

- [ ] **Step 1: Write failing tests** in `workerreport_test.go`: a valid report in shuffled order parses into the
  right fields; `None`/`none.`/` NONE ` give empty fields; `None — nothing to add` is content; `### sub` stays
  content; each refusal on its own; one report with five different problems whose error names all five; CRLF; BOM;
  a fenced `## Fake` inside Done; `Section("not-verified")` and `Section("bogus")`; `ParseWorkerReport(WorkerReportTemplate)`
  succeeds (the template is structurally valid; its placeholder bodies are content); `ReadWorkerReport` for a structured, a legacy and an empty summary.
- [ ] **Step 2:** `go test ./pkg/jarvis -run 'WorkerReport'` fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `go test ./pkg/jarvis -run 'WorkerReport'` passes.
- [ ] **Step 5:** Commit.

### Task 2: Enforce the format at complete, and the worker prompt

**Depends on:** Task 1

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (the `ErrWorkerReportRequired` check in `AdvanceRunCommand`, ~line 753)
- Modify: `pkg/orchestrate/engine.go` (`workerContract` only, ~lines 720–740 — Tasks 4 and 5 edit other functions
  in this file)
- Test: `pkg/wshrpc/wshserver/wshserver_childrun_test.go`, `pkg/orchestrate/engine_test.go`

**Interfaces — Consumes:** `jarvis.ParseWorkerReport`, `jarvis.WorkerReportTemplate`.

**Decisions:**
- Same condition as today's empty-report refusal (`TaskId != ""`, not `Review`): an empty report keeps today's
  refusal; a non-empty one that fails `ParseWorkerReport` is refused with
  `"<ErrWorkerReportRequired>: <report path>: <parser error>. Rewrite it as:\n<WorkerReportTemplate>\nthen run wsh jarvis complete --commit <sha> --report <path>"`.
  The prefix stays `ErrWorkerReportRequired` so callers that match it keep working. The empty-report message also
  shows the template instead of today's prose list.
- `workerContract` replaces the prose list ("what you did, what you did differently…") with the template, and
  says: nothing goes before the first heading (the commit is already passed with `--commit`); a section with nothing
  to say holds `None`; Not verified lists only checks the task or plan asked for, never the full Verify the engine
  runs, and a failure already on the base goes under Found not fixed. The `baseCheckFailed` sentence says
  "name them under Found not fixed in your report".
- Update existing fixtures that complete a dag worker with free-form text to a valid report.

- [ ] **Step 1: Failing tests:** in `wshserver_childrun_test.go` (extend the table near line 368): a dag worker's
  malformed report is refused with the prefix, the path and the parser's problems; a valid report seals into
  `Evidence.Summary` unchanged; a lead's and a reviewer's free-form report still seal. In `engine_test.go`: the
  worker contract carries `WorkerReportTemplate` verbatim and the "nothing before the first heading" rule, and the
  base-check sentence names Found not fixed.
- [ ] **Step 2:** `go test ./pkg/wshrpc/wshserver -run 'Report'` and `go test ./pkg/orchestrate -run 'WorkerContract|BaseCheck'` fail
  (pick the exact test names you added).
- [ ] **Step 3:** Implement; fix fixtures that the new refusal breaks.
- [ ] **Step 4:** The same focused runs pass.
- [ ] **Step 5:** Commit.

### Task 3: Wire types, task generate, dag status presence line, and `wsh jarvis dag report`

**Depends on:** Task 1

**Files:**
- Modify: `pkg/waveobj/wtype.go` (`RunEvidence` gains `Dag *EvidenceDag \`json:"dag,omitempty"\``; add
  `EvidenceDag` and `EvidenceDagTask` exactly as spec §4 declares them)
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` (`DagTaskDigest.Result string` → `ReportSections []string \`json:"reportsections,omitempty"\``)
- Regenerate: `task generate` (writes `frontend/types/gotypes.d.ts` and the other generated files — commit them)
- Modify: `pkg/orchestrate/digest.go` (`withReview` only, ~line 79 — Task 6 edits `buildReport` in this file)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` (the `td.Result` line in `dagStatusLines` ~line 189; new `report` subcommand)
- Test: `pkg/orchestrate/digest_test.go`, `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`

**Interfaces — Produces:**
- Go: `waveobj.EvidenceDag{Tasks []EvidenceDagTask; Answered, Forwarded int; Told, LeftBehind []string}` and
  `waveobj.EvidenceDagTask{TaskId, Label, State, Commit string; ReviewRounds int; Differs, NotVerified, ReviewerUnverified, FoundNotFixed, ForLead, Unstructured string}`
  with the spec's json tags; `RunEvidence.Dag`.
- TS (generated): `EvidenceDag`, `EvidenceDagTask`, `RunEvidence.dag?`.
- `DagTaskDigest.ReportSections`: the keys (from `jarvis.WorkerReportSections`) of the sections with content, in
  report order, **excluding `done`** (the lead never gets Done inline; it is always present). A legacy report
  (`jarvis.ReadWorkerReport` returns `unstructured`) is `["unstructured"]`. No worker evidence: nil.
- CLI: `wsh jarvis dag report <task-id> [section]`.

**Decisions:**
- Presence line printed by `dagStatusLines` for a task with `ReportSections`:
  `t-3 report: differs, not verified, found not fixed (wsh jarvis dag report t-3)` — keys with `-` shown as spaces.
  A parsed report with none of the four: `t-3 report: done only (wsh jarvis dag report t-3)`. Legacy:
  `t-3 report: unstructured (wsh jarvis dag report t-3)`. No 600-character result anywhere in `dag status`.
- `wsh jarvis dag report`: task id `3` or `t-3` (normalize as `downstreamTargets` does). Load the dag with the
  existing `DagStatusCommand` (`rtn.Group.Tasks[i].RunID`), then the worker run from the dag's channel with the read
  `runsFind`/`runsOf` in `wshcmd-runs.go` already use — no new RPC. Print `Evidence.Summary` whole with no section;
  with a section key, the section body, or `None` when empty. Errors: unknown task, task with no run or no sealed
  evidence yet, unknown section (list the five keys), a section asked of a legacy report ("this report predates
  sections; run without a section"). Never reads `%TEMP%/arc-reports`. Keep the parse/print logic in a pure function
  so it tests without RPC. Both `withReview` and the command read the report through `jarvis.ReadWorkerReport`.

- [ ] **Step 1: Failing tests:** `digest_test.go` — replace `TestDigestCarriesTheWorkersResultAndReview`'s `Result`
  assertion: a structured report yields the right `ReportSections` (done excluded, empty sections excluded), a
  legacy one `["unstructured"]`. `wshcmd-jarvisdag_test.go` — the presence line, the done-only line, the legacy line,
  and no `result:` line; the report command's pure function: whole report, one section, an empty section prints
  `None`, unknown section, legacy with a section.
- [ ] **Step 2:** Run those tests by name (`go test ./pkg/orchestrate -run '<names>'`, `go test ./cmd/wsh/cmd -run '<names>'`); they fail.
- [ ] **Step 3:** Change the Go types, run `task generate`, implement `withReview`, the print, and the command.
- [ ] **Step 4:** The focused tests pass.
- [ ] **Step 5:** Commit, including the generated files.

### Task 4: Capped sections in the review-pass wake and the no-commit line

**Depends on:** Task 1, Task 2

**Files:**
- Create: `pkg/orchestrate/reportsections.go` (`capSection`, `workerReportOf`, the lead-facing section lines)
- Modify: `pkg/orchestrate/engine.go` (add `reportSectionMaxLen = 2500` beside `handoffMaxSummaryLen` only)
- Modify: `pkg/orchestrate/review.go` (`applyReviewVerdict`'s pass branch)
- Modify: `pkg/orchestrate/queue.go` (`noCommitLine`)
- Test: `pkg/orchestrate/reportsections_test.go`, `pkg/orchestrate/review_test.go`

**Interfaces — Produces** (Tasks 5 and 6 use these):
- `const reportSectionMaxLen = 2500`
- `func capSection(taskID, key, text string) string` — unchanged at or under the cap (runes); over it, cut at the
  last line boundary at or below the limit (at the limit itself when the first line is longer), then
  `"\n… <N> more characters: wsh jarvis dag report <taskID> <key>"`, N the exact remaining rune count. `key == ""`
  names the whole-report command.
- `func workerReportOf(run *waveobj.Run) (rep jarvis.WorkerReport, unstructured string)` — a thin wrapper:
  `jarvis.ReadWorkerReport(run.Evidence.Summary)`, both zero when the run or its evidence is nil. No parse or
  fallback logic of its own.
- `func leadSectionLines(taskID string, run *waveobj.Run) []string` — the lead-facing lines for Differs from plan,
  Not verified and Found not fixed, each `"<task> <heading>: <capped body>"`, skipped when empty; for a legacy report
  one `"<task> unstructured report: <capSection(task, "", text)>"`.

**Decisions:**
- At a pass, after today's `PostQuiet` pass line, post each `leadSectionLines` line with `PostCaveat` (flattened with
  `flatLine`, as caveats are today; cap before flattening). The reviewer's `--unverified` follows the worker's Not
  verified as `"<task> reviewer: <text>"` through the existing `PostCaveat`. The quiet pass line keeps its
  `truncateNote(note, handoffMaxSummaryLen)` (the note is already bounded by `MaxReviewNoteLen`).
- `noCommitLine` uses `leadSectionLines` in place of the 600-character summary.
- Leave `routeDownstream` and the For later tasks section to Task 5.

- [ ] **Step 1: Failing tests:** `reportsections_test.go` — `capSection` under/at/over the limit with the exact
  marker and count; Review Focus 4 (one over-long line; 2500 multi-byte runes uncut); `workerReportOf` for
  a nil run and nil evidence (the parse rules are Task 1's). `review_test.go` — extend `TestReviewPassPrintsTheUnverifiedCaveatWholeAheadOfTheNote`'s
  pattern: a pass posts the three sections whole and skips empty ones, the reviewer's addition follows Not verified
  labelled `reviewer:`, a legacy report posts one unstructured line; `TestWorkerWithoutACommitTellsTheLeadQuietly`
  asserts the sections instead of the clipped summary.
- [ ] **Step 2:** `go test ./pkg/orchestrate -run '<the names above>'` fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** The focused tests pass.
- [ ] **Step 5:** Commit.

### Task 5: For later tasks routed by plan edges; the reviewer checks instead of relaying

**Depends on:** Task 4

**Files:**
- Modify: `pkg/orchestrate/review.go` (`applyReviewVerdict` pass branch, `routeDownstream`, `RecordReviewVerdict`,
  `reviewPrompt`; add `descendants`)
- Modify: `pkg/orchestrate/engine.go` (`predecessorHandoff` only)
- Modify: `pkg/orchestrate/queue.go` (wake text helpers if their wording changes)
- Test: `pkg/orchestrate/review_test.go`, `pkg/orchestrate/engine_test.go`

**Interfaces — Consumes:** `workerReportOf`, `capSection`, `reportSectionMaxLen` (Task 4); `jarvis.WorkerReport`.
**Produces:**
- `func descendants(g *waveobj.TaskGroup, id string) []string` — every task that transitively depends on `id`, in
  dag order (reverse closure of `Deps`).
- The `task-review-passed` event detail gains `"forlead": true` when the worker's For later tasks section went to
  the lead (Task 6 reads it for `EvidenceDagTask.ForLead`).

**Decisions** (spec §3):
- Unfinished descendant = in `descendants` and (`amendable(state)` or `tellRunID != ""`).
- At a pass with a non-empty For later tasks (capped with key `for-later`):
  - not-started descendants: nothing is stored; they read it at dispatch (below). Report them in the quiet
    "reached" line as `(at dispatch)`.
  - running descendants: typed to the worker exactly as `routeDownstream` types a reviewer note, with the same
    refusals (no live terminal; waiting on a question) — a refusal goes to the lead as `missed` does now.
  - `--for` targets that are not descendants: delivered through the existing per-target path (amend `LeadNotes` if
    not started, typed if running).
  - no unfinished descendant and no `--for` target: posted to the lead with the pass's section lines
    (`"<task> For later tasks: …"`), and the event carries `forlead: true`.
- Reviewer `--downstream`: targets are unfinished descendants ∪ `--for`, deduplicated; with none, the lead's
  `downstreamWake` as today. `downstreamTargets` is unchanged.
- `RecordReviewVerdict`: drop the "`--for` needs `--downstream`" refusal. `--for` without `--downstream` loads the
  worker's run (`t.RunID`) and, when its For later tasks is empty or the report is legacy, refuses with exactly
  `the worker's For later tasks is None; give --downstream with what they must know`.
- `predecessorHandoff` walks every done ancestor (transitive `Deps`), adding each ancestor's For later tasks
  (capped) under its label. Commit and file lines stay direct-dependency only. A legacy ancestor report: direct
  dependencies keep today's `truncateNote(…, handoffMaxSummaryLen)` "It reported" line; nothing for transitive ones.
  A structured direct dependency no longer prints "It reported" (its For later tasks replaces it).
- `reviewPrompt`: keeps judging the diff against the task and spec, and adds the report check (Done matches the
  diff; Differs from plan names every departure the diff shows; Not verified names every asked-for check that
  neither the diff nor Done shows done). It drops the relay instruction: `--unverified` is for what Not verified
  omits, `--downstream` for what For later tasks omits or gets wrong, and both say the worker's sections already
  reach the lead and later tasks whole. It says `--for` alone forwards the worker's For later tasks. Keep
  `tasksAhead`.

- [ ] **Step 1: Failing tests:** `descendants` on a diamond and a chain; For later tasks reaches a not-started
  descendant's dispatch prompt (direct and transitive) and a direct dependency's commit/file lines stay
  direct-only; it is typed to a running descendant; a descendant waiting on a question goes to the lead as missed;
  with no descendant it goes to the lead and the event has `forlead: true`; `--for` alone forwards the section to a
  non-descendant; `--for` alone is refused when the section is None, and on a legacy report (Review Focus 5);
  `--downstream` without `--for` reaches descendants instead of waking the lead (rewrite
  `TestReviewPassWithDownstreamWakesTheLead` to the no-descendant case); the reviewer brief carries the report
  check and no relay instruction. Rename existing tests whose names describe the old behavior.
- [ ] **Step 2:** `go test ./pkg/orchestrate -run '<names>'` fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** The focused tests pass.
- [ ] **Step 5:** Commit.

### Task 6: The run's record at the lead's seal, and the caveat readers

**Depends on:** Task 3, Task 4

**Files:**
- Modify: `pkg/jarvis/evidence.go` (`SealEvidence` builds `ev.Dag`; new `dagRecord`)
- Create: `pkg/jarvis/dagtally.go` (the shared event tally)
- Modify: `pkg/jarvis/attention.go` (add `taskStateFailed = "failed"` beside the existing mirrored states)
- Modify: `pkg/orchestrate/digest.go` (`buildReport` and `toldMessages` only)
- Modify: `pkg/orchestrate/final.go` (`finishFinal` unverified reasons, ~line 477), `pkg/orchestrate/verifier.go`
  (the "Earlier checks could not verify these" notes, ~line 99)
- Modify: `pkg/orchestrate/reportsections.go` (add `taskCaveats`)
- Test: `pkg/jarvis/evidence_test.go`, `pkg/jarvis/dagtally_test.go`, `pkg/orchestrate/digest_test.go`,
  `pkg/orchestrate/final_test.go`, `pkg/orchestrate/verifier_test.go`

**Interfaces — Consumes:** `waveobj.EvidenceDag`/`EvidenceDagTask` (Task 3); `workerReportOf` (Task 4); `jarvis.ReadWorkerReport` (Task 1, the seal uses it directly);
`jarvis.ParseWorkerReport`; the `forlead` detail on `task-review-passed` (Task 5 writes it; test with fabricated events).
**Produces:**
- `func TallyDagEvents(evs []waveobj.RunEvent) DagTally` with `type DagTally struct { Answered, Forwarded int; Told []wshrpc.DagTold }`
  — the one place `child-answered`, `task-forwarded` and `task-told` are counted; `buildReport` and the seal both
  call it, so the two can't disagree.
- `func taskCaveats(t *waveobj.TaskNode, worker *waveobj.Run) []string` (orchestrate) — the worker's Not verified
  (or the legacy text), then `"reviewer: " + t.ReviewUnverified`, each non-empty.

**Decisions** (spec §4):
- `Evidence.Dag` is built only for the dag's owner run (`run.DagORef != ""`, `run.TaskId == ""`, `g.RunID == run.ID`,
  the same guard `dagVerifs` uses); a worker's run gets none. A dag read error fails the seal, as `dagVerifs` does.
- Tasks: dag order, states done/skipped/failed. Per task: `Label`, `State`, `Commit` = its worker run's `EndCommit`,
  `ReviewRounds` = `ReviewRound`, `Differs`, `NotVerified`, `FoundNotFixed` whole (no cap), `ReviewerUnverified`,
  `ForLead` = For later tasks only when the newest `task-review-passed` for that task has `forlead: true`,
  `Unstructured` = a legacy report whole. Done is never stored. Worker runs come from `DagChildRuns`.
- `Told` entries `"<task>: <text>"`. `LeftBehind` = task ids with `CleanupError != ""` (what `dag status` shows as
  retry-cleanup).
- `buildReport` keeps its shape; `UnverifiedNotes` comes from `taskCaveats` (one note per caveat line), counts and
  told from `TallyDagEvents`. `finishFinal` (still only when no verifier judged) and the verifier brief list
  `taskCaveats` lines prefixed with the task id.

- [ ] **Step 1: Failing tests:** `evidence_test.go` — a sealed dag owner's `Evidence.Dag` matches the dag (sections
  whole and uncapped over 2500 runes, Done absent, legacy whole in `Unstructured`, `ForLead` only with the event
  flag, counts, told, `LeftBehind` from a task with `CleanupError`); a worker's run seals with no `Dag`.
  `dagtally_test.go` — the counts and told order. `digest_test.go`/`final_test.go`/`verifier_test.go` — each caveat
  reader lists the worker's Not verified and then the reviewer's addition, for a structured and a legacy report.
- [ ] **Step 2:** `go test ./pkg/jarvis -run '<names>'` and `go test ./pkg/orchestrate -run '<names>'` fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** The focused tests pass.
- [ ] **Step 5:** Commit.

### Task 7: Render the record in `wsh runs show` and the run sidebar

**Depends on:** Task 3

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-runs.go` (`runsShowLines` after the report, ~line 769; new `runsRecordLines`)
- Test: `cmd/wsh/cmd/wshcmd-runs_test.go`
- Create: `frontend/app/view/jarvis/runrecord.ts`, `frontend/app/view/jarvis/runrecord.test.ts`
- Modify: `frontend/app/view/jarvis/chunksidebar.tsx` (`NoteRun`, ~line 46)

**Interfaces — Consumes:** `waveobj.EvidenceDag` / TS `EvidenceDag` (Task 3).
**Produces:** `func runsRecordLines(d *waveobj.EvidenceDag) []string`; `runrecord.ts` exports a pure
`runRecordRows(dag: EvidenceDag | undefined)` returning what the sidebar renders (task line, then labelled
non-empty sections, then counts, told, left behind).

**Decisions:**
- `wsh runs show` prints the lead's report, then a `record` block: per task `t-3 done  <short commit>  review rounds N`
  (rounds only when > 0), then each non-empty section indented under it labelled `differs:`, `not verified:`,
  `reviewer:`, `found not fixed:`, `for lead:`, `unstructured:` (multi-line bodies keep their lines, indented); then
  `answered N  forwarded N`, each told message, and `left behind: t-2, t-5` when any. Nothing when `Dag` is nil.
- The sidebar renders the record below the report (or the summary fallback) in `NoteRun`, using existing `@theme`
  tokens and the type scale already in the file (DESIGN.md; no new tokens, no raw colors). `recordrunrow.ts` keeps
  the summary as the row headline (no change).

- [ ] **Step 1: Failing tests:** `wshcmd-runs_test.go` — `runsRecordLines` for a two-task record (one with sections,
  one legacy), counts, told and left behind; nil prints nothing. `runrecord.test.ts` — the same cases for
  `runRecordRows`, plus empty sections skipped.
- [ ] **Step 2:** `go test ./cmd/wsh/cmd -run 'RecordLines'` and `npx vitest run frontend/app/view/jarvis/runrecord.test.ts` fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** The focused tests pass.
- [ ] **Step 5:** Commit.

### Task 8: The lead prompt and the orchestrator guide

**Depends on:** Task 2, Task 5, Task 6, Task 7
**Chunk:** Plan and implement

**Files:**
- Modify: `pkg/jarvis/leadprompt.go`, `pkg/jarvis/leadprompt_test.go`
- Modify: `docs/orchestrator-guide.md` (the run-finished row ~:557, the worker report paragraph ~:564–568, the
  reviewer's notes ~:572–590)

**Decisions** (spec §2 "The pull command", §4 "What the lead writes", "Docs"):
- The lead prompt names `wsh jarvis dag report <task> [section]` once (where it reads a task's outcome) and says
  every cut is marked with that command.
- The run-finished rule (`leadprompt.go:65`) asks for judgment only: one line per task on what it did; the decisions
  the lead made (answers, skips, tells, sendbacks) and why; wrap-up commits; open issues, each with its effort chunk,
  chosen from the tasks' Found not fixed and Not verified sections and anything the lead noticed. It drops landed
  commits, worktrees left behind, answered/forwarded counts and the unverified list, and says the engine records
  those. Keep the existing docs-wrap-up and effort-chunk instructions.
- `leadprompt_test.go` asserts the new wording; delete `TestRunFinishedReportNamesLeftoverWorktrees` (Task 6's seal
  test now covers left-behind worktrees).
- The guide describes the five-section format and its refusal, what reaches the lead and when (wake, presence line,
  pull command, cap marker), plan-edge routing and `--for`, and the sealed record. `docs/orchestrator-redesign-flaws.md`
  is unchanged (spec "Docs").

- [ ] **Step 1: Failing test:** `leadprompt_test.go` asserts the pull command and the judgment-only run-finished
  rule, and that the dropped items are no longer asked for.
- [ ] **Step 2:** `go test ./pkg/jarvis -run 'RunFinished|LeadPrompt|OrchestrationRules'` (the names you touched) fails.
- [ ] **Step 3:** Implement the prompt; update the guide.
- [ ] **Step 4:** The focused tests pass.
- [ ] **Step 5:** Commit.

## After landing (the lead)

Spec "Tests": run one real orchestrator run once, checking that a worker's first report passes `complete`, that a
`dag status` presence line and a review-pass wake look as specified, and that the record appears under
`wsh runs show`. Record the result on effort `0d2feabb`.
