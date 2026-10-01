# Structured worker reports, routed by section, with no silent loss

Effort `0d2feabb` ("Orchestrator: structured worker reports routed by section, no silent loss"). The four
decisions, with the measurements behind them, are the done notes of its `Decide:` chunks; this spec turns them
into changes. Probe scripts: `%TEMP%/arc-probe/{sections,review,leadreport}.mjs` (gitignored scratch, not part of
the change).

## The problem

A dag worker's report is the one account of what a task did, what it skipped and what it changed for later tasks.
Only the reviewer reads it whole (`reviewPrompt`, `review.go`). Everyone else gets the first 600 characters
(`handoffMaxSummaryLen`, `engine.go:744`): the lead's `dag status` (`withReview`, `digest.go:81`), the lead's
no-commit line (`noCommitLine`, `queue.go:177`) and a dependent's handoff (`predecessorHandoff`, `engine.go:794`).
Measured 2026-09-30 over 161 reports: median 2437 characters, p90 5224, 93 over the cut; 83% of report text never
reaches the lead or a dependent. What does reach them past the cut is what the reviewer chose to copy into
`--downstream` and `--unverified`, and the final report is the lead's compression of that: worker → reviewer → lead.

The loss is silent. Nothing marks a report as cut, and the lead has no documented way to read the rest
(`DagTaskDigest` carries no run id, and the lead prompt never names `wsh runs show`).

## Scope

In:

1. A worker report is five fixed sections, refused at `complete` when malformed (decision 1).
2. The lead's wake carries the sections it acts on whole; `dag status` is compact; a size cap marks what it cuts
   and names a pull command (decision 2).
3. The reviewer checks the report instead of relaying it; For later tasks routes along plan edges; `--for` stays as
   an addition (decision 3).
4. The run's final record: code assembles the facts at the lead's seal, and the lead writes only judgment
   (decision 4).

Out, and why:

- An LLM condenser per task. Rejected in the effort's first note: one more lossy hop.
- Pointer-only reports (the lead reads a path). Rejected there too: the loss stays silent because nothing makes the
  lead read.
- Leads, spikes, reviewers, plan reviewers and the final verifier: their reports keep today's free form.
- Enforcing that the lead triages every Found not fixed or Not verified item. The code-built record lists every one,
  so an item the lead skips is still on the record (decision 4).
- A version gate for reports written under the old prompt. A worker running when this lands takes one refusal.

## 1. The report format

### Sections

| Section | Contents | Who reads it |
|---|---|---|
| `## Done` | what landed, and the checks run with their results | reviewer; the lead pulls it |
| `## Differs from plan` | each departure from the task or plan, and why | reviewer, lead |
| `## Not verified` | checks the task or plan asked for that were not done, and why | reviewer, lead, final verifier |
| `## For later tasks` | what a later task must know, including a departure that changes what it builds on | reviewer, later tasks; the lead when no later task exists |
| `## Found not fixed` | failures already on the base, out-of-scope defects | reviewer, lead |

### The parser

One pure function, `jarvis.ParseWorkerReport(text string) (WorkerReport, error)`, in a new
`pkg/jarvis/workerreport.go`. `pkg/jarvis` because the seal (`evidence.go`) needs it, and `pkg/orchestrate` and
`cmd/wsh` already import `pkg/jarvis`.

- A section starts at a line `## <name>`. The name is matched case-insensitively, after trimming whitespace.
- Each of the five appears exactly once, in any order.
- A section with nothing to say holds the literal `None` (case-insensitive, optional trailing period). The parsed
  field is then empty. A section with no text at all is refused, so an omitted section can't read as an empty one.
- `###` and deeper headings are content of the section they sit in.
- Refused: any non-blank text before the first `## `, an unknown `## ` heading, a duplicate.
- The error names every problem at once (missing, duplicate, unknown, empty, text before the first heading) so one
  retry fixes the report.

`WorkerReport` is a struct of five strings plus a `Section(name string) (string, bool)` lookup for the pull command.
It is not stored. The raw report stays the single source of truth (`Run.Report`, sealed into `Evidence.Summary` as
today), and every reader parses it. Parsing is cheap, and a validated report always parses.

**Reports written before this change** don't parse. Every reader falls back to today's behavior: the whole text,
under the cap below, labelled as an unstructured report. The fallback is one helper, used everywhere.

### Enforcement at complete

`AdvanceRunCommand` (`wshserver_runs.go:753`) already refuses a dag worker's `complete` with an empty report
(`ErrWorkerReportRequired`). The same condition (`TaskId != ""`, not `Review`) now also runs `ParseWorkerReport`
and refuses with its error, the report path, and the template. Same error prefix, so callers that match it keep
working.

### The worker prompt

`workerContract` (`engine.go:732`) replaces the prose list with the literal template, and says nothing goes before
the first heading. Measured 81 of 95 reports put text there, mostly a `Commit: <sha>` line, which `--commit` already
carries. The Not verified line says: only checks the task or plan asked for; don't list the full Verify the engine
runs; a failure already on the base goes under Found not fixed. The `baseCheckFailed` sentence ("name them in your
report") names Found not fixed.

## 2. What the lead reads

### The cap

`reportSectionMaxLen = 2500` (characters), beside `handoffMaxSummaryLen` in `engine.go`. No measured section
reached it (largest: Differs from plan, 2091). It's a safety net, not a trim. Over it, the text is cut at a line
boundary at or below the limit and ends `… <N> more characters: wsh jarvis dag report <task> <section>`. One
helper, `capSection(taskID, name, text)`, used by every inline delivery. Nothing is ever shortened without that
marker.

### The review-pass wake

`applyReviewVerdict` (`review.go:231`) posts the pass to the lead as today, followed by the worker's Differs from
plan, Not verified and Found not fixed, each capped, labelled, and skipped when empty. The reviewer's
`--unverified` follows the worker's Not verified as `reviewer: <text>`, through the existing `PostCaveat`. The
quiet line's own note keeps its `MaxReviewNoteLen` bound, since `RecordReviewVerdict` refuses longer notes.

`noCommitLine` (`queue.go:177`) does the same with the three sections in place of the 600-character summary.

### dag status

`withReview` (`digest.go:81`) stops setting `Result` from the summary. Instead each done task gets one presence
line: the section names that have content, then `(wsh jarvis dag report <task>)`. For example:
`t-3 report: differs, not verified, found not fixed (wsh jarvis dag report t-3)`. `DagTaskDigest.Result` becomes
`ReportSections []string`, and `wshcmd-jarvisdag.go:189` prints it. A legacy report prints
`t-3 report: unstructured (wsh jarvis dag report t-3)`.

### The pull command

`wsh jarvis dag report <task-id> [section]` (`cmd/wsh/cmd/wshcmd-jarvisdag.go`):

- It loads the dag with the existing `DagStatusCommand`, then the task's worker run by its `RunID` through the
  call `wsh runs show` already uses. No new RPC.
- With no section, it prints the whole sealed report. With one (`done`, `differs`, `not-verified`, `for-later`,
  `found-not-fixed`), it prints that section. It errors on an unknown section name, and on a legacy report when a
  section is asked for.
- It reads the store, never `%TEMP%/arc-reports`, which can be cleaned.

The lead prompt (`leadprompt.go`) names the command once, and every cap marker repeats it.

## 3. The reviewer, and routing to later tasks

### The reviewer's brief

`reviewPrompt` (`review.go:420-454`) keeps judging the diff against the task and spec. It adds a report check:

- Done matches the diff.
- Differs from plan names every departure the diff shows.
- Not verified names every check the task asked for that neither the diff nor Done shows done.

It drops the instruction to relay. `--unverified` is for what Not verified omits; `--downstream` is for what For
later tasks omits or gets wrong. Both say the worker's sections already reach the lead and later tasks whole, so
neither should restate them. `RecordReviewVerdict` is unchanged except for the `--for` rule below.

### For later tasks routes by plan edges

At a pass, the worker's For later tasks section (capped) goes to every unfinished descendant of the task. That
means the transitive closure of `Deps`, reversed. `pkg/orchestrate` has no such walk yet (`tasksAhead`, `review.go:513`, lists every unfinished task), so this adds one, `descendants(g, id)`.

- **Not started** (`amendable`): read at dispatch. `predecessorHandoff` (`engine.go:758`) walks every done
  ancestor, not just direct dependencies, and adds each ancestor's For later tasks section under its label. The
  commit and file lines stay direct-dependency only, as today. No copy is stored on the descendant.
- **Running**: typed to its worker as `routeDownstream` types a reviewer note today (`review.go:288-307`), with the
  same refusals: no live terminal, or waiting on a question. A refused delivery goes to the lead in the wake, as
  `missed` does now.
- **No unfinished descendant:** the section goes to the lead in the review-pass wake, with the other three.

A legacy report has no section. Descendants get today's 600-character note at dispatch, and nothing is typed.

### --for

`--for` stays as an addition to plan-edge routing. Measured 33 of 139 reviewer targets (24%) were not plan
descendants.

- `--for` without `--downstream` becomes valid. It forwards the worker's For later tasks section to the named
  tasks, through the same running and not-started delivery. If that section is empty, `RecordReviewVerdict` refuses
  with "the worker's For later tasks is None; give --downstream with what they must know".
- `--downstream` without `--for` goes to the unfinished descendants, else the lead. Today it always waits for the
  lead.
- `--downstream` with `--for` goes to the descendants and the named tasks, without duplicates.
- `downstreamTargets` (`review.go:389`) is unchanged.

## 4. The final record

### Assembled by code at the lead's seal

`SealEvidence` (`evidence.go`), for a dag owner, adds `Evidence.Dag *EvidenceDag`, built from the dag as it is
already loaded there:

```go
type EvidenceDag struct {
    Tasks      []EvidenceDagTask `json:"tasks,omitempty"`      // dag order; done, skipped and failed tasks
    Answered   int               `json:"answered"`
    Forwarded  int               `json:"forwarded"`
    Told       []string          `json:"told,omitempty"`       // what the human typed to workers
    LeftBehind []string          `json:"leftbehind,omitempty"` // task ids whose tree is retry-cleanup
}

type EvidenceDagTask struct {
    TaskId             string `json:"taskid"`
    Label              string `json:"label,omitempty"`
    State              string `json:"state"`
    Commit             string `json:"commit,omitempty"`
    ReviewRounds       int    `json:"reviewrounds,omitempty"`
    Differs            string `json:"differs,omitempty"`
    NotVerified        string `json:"notverified,omitempty"`
    ReviewerUnverified string `json:"reviewerunverified,omitempty"`
    FoundNotFixed      string `json:"foundnotfixed,omitempty"`
    ForLead            string `json:"forlead,omitempty"`      // For later tasks, only where it went to the lead
    Unstructured       string `json:"unstructured,omitempty"` // a legacy report, whole
}
```

- Sections are stored whole with no cap: this is the record, not a prompt.
- Done is left out; the pull command reads it.
- The outcome stays in `Evidence.Verification`, and usage stays in `Evidence.Usage`.
- It's a snapshot taken at the seal, so a later change to the dag can't rewrite it.
- `buildReport`'s `Answered`, `Forwarded` and `toldMessages` logic moves to one function both callers use, so the
  two can't disagree.

These are `waveobj` types: run `task generate`.

### What the lead writes

The run-finished rule (`leadprompt.go:65`) asks for judgment only:

- one line per task on what it did;
- the decisions the lead made (answers, skips, tells, sendbacks) and why;
- wrap-up commits;
- open issues, each with its effort chunk, chosen from the tasks' Found not fixed and Not verified sections and
  anything the lead noticed.

It drops landed commits, worktrees left behind, answered/forwarded counts and the unverified list, and says the
engine records those. `leadprompt_test.go` asserts the new wording; the assertion on the leftover-worktrees line
(`:323`) moves to the record test.

### Rendering

- `wsh runs show` (`wshcmd-runs.go:769`) prints the lead's report, then the record: per task, the non-empty
  sections under the task line, then counts, told messages and worktrees left behind. The formatter is a function
  with its own test.
- The run sidebar (`frontend/app/view/jarvis/chunksidebar.tsx:46`) renders the record below the report. The
  formatting goes in a pure `runrecord.ts` with `runrecord.test.ts`, per the frontend convention.
- `recordrunrow.ts` keeps the summary as the row headline.

### The other readers of reviewer caveats

Three places read `ReviewUnverified` as the only per-task caveat. Each switches to the worker's Not verified, then
the reviewer's addition:

- `buildReport` `UnverifiedNotes` (`digest.go:710`)
- `finishFinal` unverified reasons (`final.go:477`), still only when no verifier judged
- the verifier brief's "Earlier checks could not verify these" (`verifier.go:99`)

One helper returns both, so the three can't drift.

## Tests

Behavior, at the seams the codebase already tests:

- `workerreport_test.go`: every parse rule above, plus each error naming all the problems at once.
- `AdvanceRunCommand`: a malformed worker report is refused with the parser's error; a valid one seals; a lead's or
  reviewer's free-form report still seals.
- `capSection`: under the limit is unchanged; over it is cut at a line with the marker and the exact remaining count.
- Review pass: the wake carries the three sections whole and skips empty ones; For later tasks reaches a not-started
  descendant's dispatch prompt (direct and transitive), is typed to a running one, and goes to the lead when there
  is no descendant; `--for` alone forwards the worker's section and is refused when it is None; `--downstream`
  without `--for` reaches descendants.
- Digest and `dag status`: the presence line, the legacy line, no 600-character result.
- Seal: `Evidence.Dag` for a dag owner matches the dag (sections whole, Done absent, legacy whole); none for a
  worker's run.
- The three caveat readers list the worker's Not verified and the reviewer's addition.
- `wsh jarvis dag report`: whole report, one section, unknown section, legacy with a section.
- `runrecord.test.ts`: the sidebar formatter.

Run live once after landing: one real orchestrator run, checking that a worker's first report passes, that a
`dag status` line and a wake look as specified, and that the record appears under `wsh runs show`.

## Docs

`docs/orchestrator-guide.md`: the worker report paragraph (`:564-568`), the reviewer's notes (`:572-590`) and the
run-finished row (`:557`) describe the new format, routing and record. `docs/orchestrator-redesign-flaws.md`: read
2026-10-01, no row describes this loss (the effort's first note expected an overlap), so nothing changes there.
