# Orchestrator findings fixes Implementation Plan

**Verify:** `go test ./pkg/orchestrate/... ./pkg/jarvis/... ./pkg/wshrpc/... ./pkg/usagestats/... ./pkg/gitinfo/... ./cmd/wsh/... && npx vitest run`
**Setup:** `task worktree:prepare`
**Check:** `go build ./... && go vet ./pkg/orchestrate/... ./pkg/jarvis/... ./pkg/wshrpc/... ./cmd/wsh/... && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

**Goal:** Fix the reporting, landing, verification, and pre-submit gaps found by watching orchestrator run
b2d7fab1 end to end.

**Architecture:** Changes land in the Go engine (`pkg/orchestrate`), the run model and prompts (`pkg/jarvis`),
the RPC layer (`pkg/wshrpc`, then `task generate`), and the `wsh` CLI (`cmd/wsh/cmd`), with a thin frontend
touch for new status and attention values. Engine runs land on `wave/<runId>` by default. A new final stage
(Check, then a `**Final:**` command, then a verifier session) runs before the DAG is `done`. The engine
merges the branch back with `--no-ff` when the run completes. A plan-review session gates dispatch at submit.

**Tech Stack:** Go 1.x (engine, wsh), React/TypeScript with vitest (frontend), Node ESM scripts (`scripts/cdp`), git.

**Spec:** `C:/Users/kael02/IdeaProjects/waveterm/docs/superpowers/specs/2026-09-25-orchestrator-findings-fixes-design.md`.
Read the sections your task names before you start. The spec is not committed, so use that absolute path.

## Global Constraints

- Go is the source of truth for wire types. After changing any `waveobj`, `wshrpc` or `wconfig` type, run
  `task generate` and commit the regenerated files. Never hand-edit `frontend/types/gotypes.d.ts`,
  `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`, or the `metaconsts.go` files.
- New struct fields are `omitempty` so stored rows and TS fixtures keep decoding and compiling.
- Tasks run in parallel. To keep squash-merges conflict-free, add each new flag registration, command, case
  or struct field **next to the related existing lines**, never appended at the end of a shared `init()`
  block, switch or struct, and don't reformat code you didn't change. Run `gofmt -w` only on files you
  touched (HEAD is not gofmt-clean).
- Comments say why, not what, in lower case, and only where needed. Match the prose-y comment style of
  `pkg/orchestrate`.
- Prompt text written for agents is plain, direct, and names exact commands in backticks.
- `NoAttributionRule` stays in every prompt that commits. The `Arc-Run:` and `Arc-Task:` lines are run
  markers, not attribution.
- Frontend colors come only from existing `@theme` tokens. No new design tokens.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Never run
  `task check:ts` or `task dev` in a worktree: they run a real `npm install` and destroy the junctions.
- Tests test behavior next to the code, in the existing `*_test.go` style (table tests, fake `git` repos
  through the package's existing test helpers, `var` seams for spawn and git).

## Review Focus

- Land-back into a checkout that is mid-merge or mid-rebase (`MERGE_HEAD` or `rebase-merge` present) must
  be held, never merged on top (Task 13).
- A spec or plan already tracked, with identical content, at submit must not fail the snapshot with an empty
  commit (Task 7).
- A `**Final:**` command that hangs must time out and fail the stage with "timed out", not hang the DAG
  (Task 10).
- `dag submit --round` while the final stage is still running, or after it passed, must be refused with the
  reason (Task 12).
- A run whose lead was relaunched must count every lead session's tokens, not only the last one (Task 4).

---

### Task 1: Worker report is sealed from a file; worker brief says to use the edit tool
**Depends on:** none

Spec sections 1.1 and 1.2. Today `workerContract` (`pkg/orchestrate/engine.go`, about line 655) tells
workers "the lead reads your final message", then "Commit, then `wsh jarvis complete --commit …`". Workers
complete first, so `SealEvidence` seals the line before `complete`. `wsh jarvis complete --report <file>`
already exists (`cmd/wsh/cmd/wshcmd-jarvis.go`); `applyRunAction` copies `data.Report` onto `run.Report`,
which the seal uses as the summary.

**Files:**
- Modify: `pkg/orchestrate/engine.go` (`workerContract`, and the dispatch path that spawns a task worker)
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (`AdvanceRunCommand`)
- Test: `pkg/orchestrate/engine_test.go`, `pkg/wshrpc/wshserver/` (the test file that covers `AdvanceRunCommand`; find it with `grep -ln AdvanceRunCommand pkg/wshrpc/wshserver/*_test.go`)

**Interfaces:**
- Produces: `func WorkerReportPath(dagOID, taskID string) string` in `pkg/orchestrate`, which returns
  `filepath.Join(os.TempDir(), "arc-reports", dagOID, taskID+".md")`, and
  `const ErrWorkerReportRequired` (the error text prefix) in `pkg/wshrpc/wshserver`.

- [ ] **Step 1: Failing tests.** In `engine_test.go`, assert that `workerContract(g, task, "claude")` contains
  `--report ` + `WorkerReportPath(g.OID, task.ID)`; contains the four report parts (what you did, what you
  did differently and why, what a later task must know, what you could not verify and why); contains
  "edit tool"; and no longer contains "reads your final message". In the wshserver test, assert that a
  `complete` for a run with `TaskId: "t-1"` and no `Review` and an empty `Report` returns an error that
  contains `--report`, and that the same call with `Review: true`, or with no `TaskId`, succeeds.
- [ ] **Step 2: Run** `go test ./pkg/orchestrate/ -run WorkerContract` and the wshserver test. Expect FAIL.
- [ ] **Step 3: Implement.** Add `WorkerReportPath`. Where the engine spawns a task worker, call
  `os.MkdirAll(filepath.Dir(WorkerReportPath(...)), 0o755)`; log a failure, don't fail the spawn. In
  `workerContract`, replace the "lead reads your final message" sentence with: write your report with your
  file-writing tool to `<path>` (the four parts), then run
  `wsh jarvis complete --commit $(git rev-parse HEAD) --report <path>`. Add: "Edit files with your edit tool;
  don't script multi-kilobyte replacements through the shell." In `AdvanceRunCommand`, before
  `applyRunAction`, when `data.Action == complete` and `preRun.TaskId != "" && !preRun.Review &&
  strings.TrimSpace(data.Report) == ""`, return
  `fmt.Errorf("a task worker completes with --report <file>: write what you did, what you did differently and why, what a later task must know, and what you could not verify, then run wsh jarvis complete --commit <sha> --report <file>")`.
- [ ] **Step 4: Run** the tests and expect PASS. Then run `go test ./pkg/orchestrate/... ./pkg/wshrpc/...`
  and update any test whose expected brief text changed.
- [ ] **Step 5: Commit** `fix(orchestrate): seal the worker's report from a file it passes to complete`.

### Task 2: Reviewer `--unverified` caveats, printed whole; the reviewer gets the whole report
**Depends on:** none

Spec section 1.3, plus the reviewer half of 1.1. Today `applyReviewVerdict` (`pkg/orchestrate/review.go`,
about line 236) posts `PostQuiet(... "%s passed review: %s", truncateNote(note, handoffMaxSummaryLen))`,
and `reviewPrompt` gives the worker's summary through `truncateNote(..., 600)`.

**Files:**
- Modify: `pkg/waveobj/wtype.go` (`TaskNode`: add `ReviewUnverified string \`json:"reviewunverified,omitempty"\`` next to `ReviewDownstream`)
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` (`CommandDagActionData.Unverified`, `DagTaskDigest.ReviewUnverified`, `DagReportDigest.UnverifiedNotes []DagUnverifiedNote`, new `type DagUnverifiedNote struct{ TaskId string \`json:"taskid"\`; Text string \`json:"text"\` }`)
- Modify: `pkg/orchestrate/review.go` (`RecordReviewVerdict`, `applyReviewVerdict`, `reviewPrompt`), `pkg/orchestrate/digest.go`, `pkg/orchestrate/dag.go` (the reset list at about line 256 that clears review fields on retry must clear `ReviewUnverified` too)
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (`review-pass` case passes `data.Unverified`)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` (`dag review` flag `--unverified`; print the digest fields)
- Test: `pkg/orchestrate/review_test.go`, `pkg/orchestrate/digest_test.go`, `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`

**Interfaces:**
- Produces: `RecordReviewVerdict(ctx, dagID, reviewerRunID, verdict, note, downstream, unverified string, downstreamFor []string) error`
  (the new `unverified` parameter comes before `downstreamFor`), `TaskNode.ReviewUnverified`, and
  `DagReportDigest.UnverifiedNotes`. Task 10 reads `ReviewUnverified` into the final outcome.

- [ ] **Step 1: Failing tests.** Test that `RecordReviewVerdict(... "fail", ..., unverified: "x")` is refused
  ("--unverified goes with a pass"), and that an unverified note over `MaxReviewNoteLen` runes is refused.
  Test that a pass with a 1500-rune unverified note and a 1500-rune note produces a quiet line that contains
  the whole unverified text, after the prefix `unverified: `, before the note recap. Test that the digest
  carries `ReviewUnverified`, and that `Report.UnverifiedNotes` lists `{t-7, text}`. Test that `reviewPrompt`
  includes a 1500-rune worker summary whole and says when to use `--unverified`. Test that `wsh jarvis dag
  review pass "n" --unverified "u"` sends `Unverified: "u"`.
- [ ] **Step 2: Run** `go test ./pkg/orchestrate/ -run 'Review|Digest'` and expect FAIL.
- [ ] **Step 3: Implement.** Validate the new note in `RecordReviewVerdict` next to the downstream checks,
  and include it in the rune-limit loop. Store `t.ReviewUnverified`. In `applyReviewVerdict`, build the
  quiet line as `"%s passed review. unverified: %s. %s"` when it is set (whole), otherwise as today. In
  `reviewPrompt`, drop the `truncateNote` on the worker summary, and after the review-pass bullet add: "add
  `--unverified \"<what was not verified, and why>\"` when the task asked for a check (a test, a screenshot,
  a live run) that the diff and the worker's report show was not done". Fill the digest fields, and make
  `wsh jarvis dag status` print `unverified: <text>` whole under the task row and in the report section. Run
  `task generate`.
- [ ] **Step 4: Run** `go test ./pkg/orchestrate/... ./cmd/wsh/...` and the Check. Expect PASS.
- [ ] **Step 5: Commit** `feat(orchestrate): carry a reviewer's unverified caveat whole to the lead`.

### Task 3: Lead and launch prompts; principles that contradict the contract
**Depends on:** none

Spec sections 1.4, 2.2 (last bullet), 2.4 (the lead trailer), 4.2 and 4.3. This task owns every
`OrchestrationRules`/`writeLaunchPrompt` sentence of this plan. Other tasks only add wake texts.

**Files:**
- Modify: `pkg/jarvis/leadprompt.go`
- Modify: `pkg/jarvis/profile.go` (`RenderPrinciples`, `ValidateGlobalPrinciples`, and the project principle patch validation if it exists: `grep -n "func Validate" pkg/jarvis/profile.go`)
- Modify: every place that renders principles into an engine run's prompt (`grep -n "RenderPrinciples(" pkg/jarvis/*.go`: `leadprompt.go`, `run.go` about lines 255 and 270, `classify.go` about line 55). Add the contract line only where the prompt belongs to an orchestrator run.
- Test: `pkg/jarvis/leadprompt_test.go`, `pkg/jarvis/profile_test.go`

**Interfaces:**
- Produces: `const ContractWinsLine = "Where a principle above conflicts with this run's contract below (who merges, who executes the plan, where work lands), the contract wins."`
  and `func normalizePrinciple(s string) string` in `pkg/jarvis`.

- [ ] **Step 1: Failing tests** in `leadprompt_test.go`:
  - `writeLaunchPrompt` says to state the path and proceed (asks about it only when genuinely unclear); to
    write the design into the spec file with no section-by-section approvals; that any approval of
    something longer than its question carries the file's absolute path on its first line; and that after
    `dag submit` the lead doesn't ask for a plan review or an execution mode, because the engine reviews
    the plan.
  - "Don't commit the spec or plan" is replaced by "the engine commits the spec and plan to the run's
    branch at submit".
  - `OrchestrationRules("r1", "", "")` "run finished" line contains `wsh jarvis complete --report` without
    "only when the human says so". It says to complete on your own and to ask with AskUserQuestion only
    when a verification failed, a deviation needs the human's call, or you propose a fix round. It contains
    "not verified never blocks completion" and
    `wsh jarvis dag submit --round --plan <fix plan>` for a failed final stage (at most 2 rounds, then
    forward). It contains `wsh jarvis dag planreview accept "<the human's reason>"` for a plan review that
    failed twice and the human said to proceed. It contains the commit-trailer rule "end each commit you
    make for this run with the line `Arc-Run: r1`".
  - `PlanLeadPrompt` with principles contains `ContractWinsLine` right after the principles.

  In `profile_test.go`: `RenderPrinciples` of `["Use worktree", "use  worktree.", "KISS"]` renders two lines,
  and `ValidateGlobalPrinciples` refuses the list with an error naming the earlier item.
- [ ] **Step 2: Run** `go test ./pkg/jarvis/ -run 'Prompt|Rules|Principle'` and expect FAIL.
- [ ] **Step 3: Implement** the sentences above in `leadprompt.go`. Keep each rule one line in the existing
  voice. `normalizePrinciple`: lower case, `strings.Fields` joined by single spaces, then trailing `.,;:!`
  trimmed. Dedupe in `RenderPrinciples` (keep the first), and refuse duplicates in validation.
- [ ] **Step 4: Run** `go test ./pkg/jarvis/... ./pkg/wshrpc/...` (fix tests that pinned the old wording) and
  expect PASS.
- [ ] **Step 5: Commit** `feat(jarvis): let the lead complete on its own and state the engine contract over principles`.

### Task 4: Token totals per role and task
**Depends on:** none

Spec section 1.5. `usagestats.TranscriptUsage(path) ([]Bucket, error)` (`pkg/usagestats/usagestats.go:622`)
returns per-model and per-day buckets (`Input, Output, CacheRead, CacheCreate, CacheCreate1h, Msgs`). A lead
transcript resolves from its phase `WorkerOrefs` through `TranscriptPathForTab` (see `workerTranscripts`
in `pkg/jarvis/evidence.go:559`). A child run (`Run.SessionId`, `TaskId`, `Review`) resolves through
`agentsessions.TranscriptForSession(root, runtime, cwd, sessionId)`, which `sessionTranscriptLines` in
evidence.go already wraps.

**Files:**
- Create: `pkg/jarvis/usage.go`, `pkg/jarvis/usage_test.go`
- Modify: `pkg/waveobj/wtype.go` (new `UsageRow`; `TaskGroup.Usage []UsageRow`; `RunEvidence.Usage []UsageRow`)
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` (`DagReportDigest.Usage []waveobj.UsageRow`)
- Modify: `pkg/orchestrate/engine.go` (compute when the dag becomes done, in the `DagStatus_Done` notify case, about line 584), `pkg/orchestrate/digest.go`
- Modify: `pkg/jarvis/evidence.go` (`SealEvidence` sets `ev.Usage`; keep the edit next to the `ev := waveobj.RunEvidence{` literal)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` (`reportLine` area), `cmd/wsh/cmd/wshcmd-runs.go` (`runs show`)
- Test: `pkg/jarvis/usage_test.go`, `cmd/wsh/cmd/wshcmd-runs_test.go`, `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`

**Interfaces:**
- Produces:
  ```go
  type UsageRow struct {
      Role         string `json:"role"`             // lead | worker | reviewer | plan-reviewer | verifier
      TaskId       string `json:"taskid,omitempty"`
      Model        string `json:"model,omitempty"`
      Input        int    `json:"input"`
      Output       int    `json:"output"`
      CacheRead    int    `json:"cacheread"`
      CacheWrite   int    `json:"cachewrite"`   // 5-minute writes
      CacheWrite1h int    `json:"cachewrite1h"`
      Msgs         int    `json:"msgs"`
      Missing      bool   `json:"missing,omitempty"` // the transcript could not be read
  }
  func UsageRole(r *waveobj.Run) string            // Review -> reviewer; TaskId -> worker; else lead
  func RunUsage(ctx context.Context, owner *waveobj.Run, children []*waveobj.Run) []waveobj.UsageRow
  func SumUsage(rows []waveobj.UsageRow) waveobj.UsageRow
  ```
  One row per (session, model). Rows are ordered lead first, then by task id, worker before reviewer.
  Tasks 9 and 11 extend `UsageRole` for `plan-reviewer` and `verifier`.

- [ ] **Step 1: Failing tests.** Write two fixture Claude transcripts to a temp dir (copy the assistant-line
  shape from `pkg/usagestats/usagestats_test.go`). Point `transcriptRootFor` (a var in evidence.go) at them.
  Assert that `RunUsage` returns the lead row (from two lead tabs, both counted: the relaunched-lead case),
  a worker row for t-1, and a reviewer row for t-1 with the fixture token sums. An unreadable session gives
  a row with `Missing: true` and zeros. Assert that `SumUsage` totals them. For the CLI: `runs show`
  prints `usage  lead 1.2M · workers 3.4M · reviewers 0.5M` (use the existing token formatter if one exists
  in cmd/wsh, otherwise add one). The dag status report prints per-role totals and a per-task line.
- [ ] **Step 2: Run** `go test ./pkg/jarvis/ -run Usage` and expect FAIL.
- [ ] **Step 3: Implement.** In `RunUsage`, collect the children the same way the digest does. For the owner
  and each child, resolve transcript paths, then `usagestats.TranscriptUsage`, then sum the buckets per model
  into rows. The engine computes `g.Usage` once when the done notification fires. It loads the dag's child
  runs from the runs map it already has (or `wstore` by `DagORef`) and sets `g.Usage` before the
  `UpdateDag` write. `SealEvidence` recomputes into `ev.Usage` (children loaded with the run's channel runs
  whose `DagORef == run.DagORef`). Tokens only, no prices. Run `task generate`.
- [ ] **Step 4: Run** the Verify packages for jarvis, orchestrate and cmd/wsh, and the Check. Expect PASS.
- [ ] **Step 5: Commit** `feat(orchestrate): total a run's tokens per role and task`.

### Task 5: `--landing` flag, branch as the default, base branch recorded
**Depends on:** none

Spec section 2.1. `CreateRunCommand` (`pkg/wshrpc/wshserver/wshserver_runs.go`, about line 397) lands on a
branch only when `resolved.Landing == jarvis.Landing_Branch`. `ValidateLanding` treats `""` as checkout.

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_runs.go` (`CommandCreateRunData.Landing string \`json:"landing,omitempty"\``)
- Modify: `pkg/waveobj/wtype.go` (`Run.BaseBranch string \`json:"basebranch,omitempty"\`` next to `LandPath`)
- Modify: `pkg/jarvis/profile.go` (the comments on the `Landing_*` consts and `ValidateLanding`: empty now means branch; add `func EffectiveLanding(requested, profile string) string`)
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (`CreateRunCommand`)
- Modify: `cmd/wsh/cmd/wshcmd-runs.go` (`runs start --landing`)
- Modify: `frontend/app/view/jarvis/briefprofileview.tsx` (about line 65: the label of the empty value must say it means branch)
- Test: `pkg/jarvis/profile_test.go`, the wshserver CreateRun tests (`grep -ln CreateRunCommand pkg/wshrpc/wshserver/*_test.go`), `cmd/wsh/cmd/wshcmd-runs_test.go`

**Interfaces:**
- Produces: `jarvis.EffectiveLanding(requested, profile string) string`. It returns requested if it is
  non-empty, else profile if it is non-empty, else `Landing_Branch`. It also produces `Run.BaseBranch`,
  which Task 13 uses to merge back.

- [ ] **Step 1: Failing tests.** `EffectiveLanding("", "") == "branch"`, `("", "checkout") == "checkout"`, and
  `("checkout", "branch") == "checkout"`. A CreateRun with `Landing: "sideways"` is refused with
  `ValidateLanding`'s error before anything persists. An engine CreateRun in a git fixture with no profile
  landing gets a `LandPath` (branch) and `BaseBranch == "main"` (or the fixture's branch). With
  `Landing: "checkout"` it gets no `LandPath`. On a detached HEAD, `BaseBranch` is empty. `wsh runs start
  --landing checkout` sends `Landing: "checkout"`.
- [ ] **Step 2: Run** the tests and expect FAIL.
- [ ] **Step 3: Implement.** Validate `data.Landing` first thing after the plan checks. Record `BaseBranch`
  from `git rev-parse --abbrev-ref HEAD` in the project, where `BaseCommit` is captured (`"HEAD"` means
  detached, so store empty). Replace the landing condition with
  `jarvis.EffectiveLanding(data.Landing, resolved.Landing) == jarvis.Landing_Branch`. Update the frontend
  label. Run `task generate`.
- [ ] **Step 4: Run** the tests and the Check. Expect PASS.
- [ ] **Step 5: Commit** `feat(runs): land engine runs on their own branch by default, with --landing to choose`.

### Task 6: Lane commits name every task
**Depends on:** none

Spec section 2.5. `mergeMessage(ctx, projectPath, runID, fallback)` (`pkg/orchestrate/merge.go:148`) joins the
branch's commit messages and appends `Arc-Run: <lane key>`. `laneMergeMessage(g, lane)` (`lane.go:95`) builds
the task titles. Callers are in `pkg/orchestrate/mergetask.go` (about lines 114 and 231, through
`mergeWorktree`/`continueMerge`). Don't edit `lane.go`; Task 7 edits it.

**Files:**
- Modify: `pkg/orchestrate/merge.go`, `pkg/orchestrate/mergetask.go`
- Test: `pkg/orchestrate/merge_test.go`

**Interfaces:**
- Produces: `mergeMessage(ctx, projectPath, runID string, lane MergeLane) string` with
  `type MergeLane struct{ Title string; TaskIDs []string }` (Title is `laneMergeMessage`'s string), plus
  `const taskTrailer = "Arc-Task"`. `mergeWorktree` and `continueMerge` take a `MergeLane` in place of the
  fallback string.

- [ ] **Step 1: Failing tests** (`merge_test.go` already builds a repo fixture). A one-task lane's message ends
  with `Arc-Run: <key>\nArc-Task: t-1`, and its subject is the worker commit's subject. A two-task lane
  (`t-1`, `t-4`) has the subject `<title1>; <title4>`, the worker messages in the body, and two `Arc-Task`
  lines. `landedHead` still recognizes the commit by its `Arc-Run` trailer. The fallback when the branch
  messages are empty is the title.
- [ ] **Step 2: Run** `go test ./pkg/orchestrate/ -run Merge` and expect FAIL.
- [ ] **Step 3: Implement.** Build the lane from `laneOf(g, taskID)`, skipping skipped tasks (as
  `laneMergeMessage` does), at the call sites.
- [ ] **Step 4: Run** `go test ./pkg/orchestrate/...` and expect PASS.
- [ ] **Step 5: Commit** `fix(orchestrate): name every landed task in a lane's squash commit`.

### Task 7: Snapshot the spec and plan on the run's branch at submit
**Depends on:** Task 1, Task 2

Spec section 2.2. It depends on Tasks 1 and 2 because it edits the first lines of `workerContract` and
`reviewPrompt`, which those tasks also change. `DagSubmitCommand` (`pkg/wshrpc/wshserver/wshserver_dag.go:142`)
sets `proposed.PlanPath, proposed.SpecPath = data.PlanPath, data.SpecPath` (absolute) and runs Setup in
`run.LandPath`. `laneFold` (`pkg/orchestrate/lane.go:113`) stages both into the first squash commit.
`foldIntoTree(ctx, tree, path)` (`merge.go`) copies an outside file to its repo-relative path.

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (`DagSubmitCommand`)
- Modify: `pkg/orchestrate/lane.go` (`laneFold`), plus a new `pkg/orchestrate/snapshot.go` for the commit helper
- Modify: `pkg/orchestrate/engine.go` (`workerContract`: resolve doc paths in the worker's tree), `pkg/orchestrate/review.go` (`reviewPrompt`: same)
- Modify: `pkg/waveobj/wtype.go` (update the `PlanPath`/`SpecPath` comment: repo-relative for a branch-landed dag)
- Test: `pkg/orchestrate/snapshot_test.go`, `pkg/orchestrate/lane_test.go`, `pkg/orchestrate/engine_test.go`, `pkg/orchestrate/review_test.go`

**Interfaces:**
- Produces:
  ```go
  // SnapshotDocs commits spec and plan into the landing tree and returns their repo-relative paths.
  func SnapshotDocs(ctx context.Context, landTree, runID, title string, paths ...string) ([]string, error)
  // DocPath resolves a dag's spec or plan path for a reader working in tree.
  func DocPath(g *waveobj.TaskGroup, tree, p string) string // relative p -> filepath.Join(tree, p); absolute unchanged
  ```

- [ ] **Step 1: Failing tests.**
  - `SnapshotDocs` with one file inside the tree and one outside the repo's tree (but in the same repo)
    commits both, with the message `docs: spec and plan for <title>\n\nArc-Run: <runID>`, and returns the
    relative paths.
  - Called again with identical content, it commits nothing and returns no error (the Review Focus case).
  - Called with revised content, it makes a second commit.
  - `laneFold` returns nil when the owner lands on a branch. That needs the owner or a flag: pass
    `branchLanded bool` from the call sites, which know the owner.
  - `workerContract` for a dag with `PlanPath: "docs/superpowers/plans/p.md"` and a worker tree `W` names
    `filepath.Join(W, "docs/superpowers/plans/p.md")`. `reviewPrompt` does the same with the reviewer's
    tree.
- [ ] **Step 2: Run** the tests and expect FAIL.
- [ ] **Step 3: Implement.** In `DagSubmitCommand`, when `run.LandPath != ""` and the plan came from a file,
  call `SnapshotDocs` after Setup and before `CreateDagForRun`, and store the relative paths on `proposed`. A
  snapshot error fails the submit with the path and git's output. `workerContract` and `reviewPrompt` take
  the worker's or reviewer's tree (the lane worktree path the spawn already has) and use `DocPath`.
  `OrchestrationRules` keeps getting the lead's own absolute paths: pass
  `filepath.Join(LandPath, rel)`.
- [ ] **Step 4: Run** `go test ./pkg/orchestrate/... ./pkg/wshrpc/...` and expect PASS.
- [ ] **Step 5: Commit** `feat(orchestrate): commit the spec and plan to the run's branch at submit`.

### Task 8: Evidence counts only the run's own commits
**Depends on:** Task 4

Spec section 2.4. `SealEvidence` (`pkg/jarvis/evidence.go:402`) diffs `BaseCommit..EndCommit` with
`gitinfo.GetRangeChanges`. On a shared `main`, that range includes other sessions' commits. It depends on
Task 4 only because both edit `SealEvidence`.

**Files:**
- Modify: `pkg/jarvis/evidence.go`
- Modify: `pkg/gitinfo/` (add a helper next to `GetRangeChanges`: `GetTrailerCommitsChanges(ctx, repo, from, to, trailerKey, match func(string) bool) (*Changes, error)`)
- Test: `pkg/jarvis/evidence_test.go`, `pkg/gitinfo/*_test.go`

**Interfaces:**
- Consumes: `runTrailer = "Arc-Run"` (`pkg/orchestrate/merge.go`). Don't import orchestrate from jarvis;
  define `const RunTrailerKey = "Arc-Run"` in jarvis and point the orchestrate const at it
  (`runTrailer = jarvis.RunTrailerKey`).
- Produces: a `*gitinfo.Changes` with the same `Numstat`/`StatusZ` shape, summed over matching commits.

- [ ] **Step 1: Failing tests.** In a repo fixture: base, then a commit with `Arc-Run: R-t-1`, then a commit with
  no trailer (another session), then a commit with `Arc-Run: R` (the lead). A checkout-landed run `R`
  (`LandPath == ""`) seals files from the first and third commits only. A run with `LandPath` set keeps the
  plain range. A commit with `Arc-Run: R2-t-1` (another run whose id shares a prefix) is excluded: match
  `== R` or the prefix `R + "-"`.
- [ ] **Step 2: Run** `go test ./pkg/jarvis/ -run Evidence` and expect FAIL.
- [ ] **Step 3: Implement.** Use `git log --format=%H%x00%(trailers:key=Arc-Run,valueonly)%x00 from..to`.
  For each matching commit, `git show --numstat -z --format=` and `git show --name-status -z --format=`,
  summed per path. The last status wins for a path touched twice. Use the helper only for
  `LandPath == ""`.
- [ ] **Step 4: Run** `go test ./pkg/jarvis/... ./pkg/gitinfo/...` and expect PASS.
- [ ] **Step 5: Commit** `fix(jarvis): seal a checkout run's evidence from its own commits`.

### Task 9: Plan review at submit
**Depends on:** Task 4, Task 7

Spec section 4.1. This introduces the shared judging-session helper that Task 11 reuses. The model for it is
the per-task reviewer: `spawnReviewer`, `reviewerLost`, `spendReviewRespawn`, `ReviewTimeout`,
`MaxReviewRespawns` in `pkg/orchestrate/review.go`, and `childRunFromSpec`/`spawnWorker`.
`RecomputeDagStatus` (`pkg/orchestrate/dag.go:327`) derives the status. Verdicts come in through
`DagActionCommand` (`wshserver_dag.go`, the `review-pass` case pattern, which schedules in a goroutine after
the durable write).

**Files:**
- Create: `pkg/orchestrate/stagesession.go` (the shared spawn, timeout and respawn for a dag-level judging session), `pkg/orchestrate/planreview.go`, and tests for both
- Modify: `pkg/waveobj/wtype.go` (`TaskGroup.PlanReview *PlanReviewStage`; `Run.StageRole string \`json:"stagerole,omitempty"\`` next to `Review`)
- Modify: `pkg/orchestrate/dag.go` (the `DagStatus_PlanReview = "plan-review"` status, derived first after cancelled, while `PlanReview` is non-nil and not passed or accepted), `pkg/orchestrate/scheduler.go` (dispatch nothing during plan review), `pkg/orchestrate/engine.go` (the tick advances the plan review), `pkg/orchestrate/queue.go` (wake texts)
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (create with `PlanReview`; allow a replace; `planreview-pass|fail|accept` actions)
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` (action list comment)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` (`wsh jarvis dag planreview pass|fail|accept "<text>"`)
- Modify: `pkg/jarvis/usage.go` (`UsageRole`: `StageRole` wins)
- Modify: `frontend/app/view/agents/runmodel.ts` (label `plan-review` as "reviewing plan" with the `review` tone) and its test
- Test: `pkg/orchestrate/planreview_test.go`, `pkg/orchestrate/stagesession_test.go`, `pkg/wshrpc/wshserver/` dag submit tests (`b1b_dagsubmit_test.go` shows the shape), `frontend/app/view/agents/runmodel.test.ts`

**Interfaces:**
- Consumes: `UsageRole` (Task 4), `DocPath` (Task 7).
- Produces:
  ```go
  type PlanReviewStage struct {
      State    string `json:"state"`              // reviewing | passed | failed | accepted
      Round    int    `json:"round"`
      RunID    string `json:"runid,omitempty"`    // the reviewer session's child run
      Findings string `json:"findings,omitempty"` // fail findings or pass summary, whole
      Respawns int    `json:"respawns,omitempty"`
      StartedTs int64 `json:"startedts,omitempty"`
  }
  const MaxPlanReviewRounds = 2
  // StageSession is one dag-level judging session (plan reviewer, final verifier).
  type StageSession struct{ Role, Label, Tree, Prompt string }
  func spawnStageSession(ctx, spawnCtx context.Context, g *waveobj.TaskGroup, owner *waveobj.Run, s StageSession) (runID string, err error)
  func stageSessionLost(ctx context.Context, g *waveobj.TaskGroup, runID string, startedTs, now int64) string // "" = alive; else the reason
  func RecordPlanReviewVerdict(ctx context.Context, dagID, reviewerRunID, verdict, text string) error
  func AcceptPlanReview(ctx context.Context, dagID, reason string) error
  ```

- [ ] **Step 1: Failing tests.**
  - A plan-file submit creates the dag with `PlanReview{State: reviewing, Round: 1}`, status `plan-review`,
    and no task dispatched after `Schedule`. A JSON submit (no plan file) has `PlanReview == nil`.
  - The tick spawns one plan reviewer (spawn seam) in the landing tree (or the project path when
    checkout-landed). Its prompt names the spec and plan and lists the five checks from spec 4.1.
  - `pass` sets `passed` and the next `Schedule` dispatches the first layer.
  - `fail` sets `failed`, stores the findings whole, and posts a wake that contains them whole with the
    resubmit instruction.
  - A resubmit while `failed` and no task ever dispatched replaces the tasks and the plan, re-snapshots, and
    sets `round 2, reviewing`. A resubmit while `reviewing` or `passed` keeps today's "dag conflict" error.
  - After round 2 fails, the wake says to forward to the human. `accept "<reason>"` sets `accepted` and
    dispatch starts. `accept` while `reviewing` is refused.
  - A reviewer silent past `ReviewTimeout` is respawned once. The second loss wakes the lead with "the plan
    reviewer did not finish" and sets `failed`.
  - `UsageRole` returns `plan-reviewer` for `StageRole: "plan-reviewer"`.
  - The frontend label test.
- [ ] **Step 2: Run** the tests and expect FAIL.
- [ ] **Step 3: Implement.** `spawnStageSession` resolves the route exactly as `spawnReviewer` does (the
  owner's runtime and model). It creates the child run with `StageRole` set, `SessionId`, and no `TaskId`,
  and appends a run event `stage-session-started {role, runid}`. The plan-review prompt: you are the plan
  reviewer for run X; read the spec (`DocPath`), the plan and the files they name; check that every spec
  requirement has a task; that no two tasks edit the same file without a Depends between them; that
  types, functions and flags have the same names across tasks; that each task names its tests; that the
  plan's commands exist; and report spec gaps or contradictions. Only read. Finish with exactly one of
  `wsh jarvis dag planreview pass "<summary>"` or `wsh jarvis dag planreview fail "<findings: each problem, where, the fix>"`,
  each within `MaxReviewNoteLen` characters. Reuse `reviewPrompt`'s read-only wording ("Only read: never
  edit, stage or commit, and ask no questions"). Add the `planreview` CLI next to `dag review` (resolve the reviewer's own
  run id the same way `dag review` does), and `accept` for the lead. Run `task generate`.
- [ ] **Step 4: Run** the Verify packages and vitest for runmodel, and the Check. Expect PASS.
- [ ] **Step 5: Commit** `feat(orchestrate): review the spec and plan before any worker starts`.

### Task 10: Final stage: Check, then the Final command, then the outcome
**Depends on:** Task 2, Task 9

Spec sections 3.1, 3.2, 3.4 (outcome and wakes; the fix round is Task 12) and 3.5 (evidence Verification).
The verifier session is Task 11. This task leaves a hook where it goes: after the deterministic steps pass,
call `startVerifier`, which is a no-op here that moves straight to the outcome.

**Files:**
- Create: `pkg/orchestrate/final.go`, `pkg/orchestrate/final_test.go`
- Modify: `pkg/waveobj/wtype.go` (`TaskGroup.Final *FinalStage`, `TaskGroup.FinalCmd`, `TaskGroup.Prototype`, `RunEvidence.Verification *RunVerification`)
- Modify: `pkg/jarvis/plan.go` (parse `**Final:**` (one backticked command, at most one) and `**Prototype:**` (a path, not in backticks, at most one) before the first task, like `**Verify:**` and `**Effort:**`; document both in `PlanFormat`), `pkg/jarvis/plan_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (copy `plan.Final` and `plan.Prototype` onto the dag next to Verify, Setup, Check)
- Modify: `pkg/orchestrate/dag.go` (`RecomputeDagStatus`: `allTerminal` with `Final` not passed or unverified gives `DagStatus_Finalizing = "finalizing"`; `Final.State == failed` gives `DagStatus_Blocked`, with `BlockingKind` `final-failed`), `pkg/orchestrate/engine.go` (the tick advances `Final`; the done notify case is unchanged, so usage (Task 4) and the run-finished wake now fire after the final stage)
- Modify: `pkg/orchestrate/queue.go` (`runFinishedWake` becomes a function of the outcome; a new `finalFailedWake`)
- Modify: `pkg/jarvis/evidence.go` (`SealEvidence` sets `ev.Verification` from the owner's dag `Final`)
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` (`DagStatusDigest.Final *waveobj.FinalStage`), `pkg/orchestrate/digest.go`, `cmd/wsh/cmd/wshcmd-jarvisdag.go` (print the final stage)
- Modify: `frontend/app/view/agents/runmodel.ts` (label `finalizing` as "verifying" with the running tone) and its test
- Test: the files above

**Interfaces:**
- Consumes: `TaskNode.ReviewUnverified` (Task 2), `DagStatus_PlanReview` ordering in `RecomputeDagStatus` (Task 9).
- Produces:
  ```go
  type FinalStage struct {
      State      string   `json:"state"`               // checking | final | verifying | passed | unverified | failed
      Round      int      `json:"round"`               // 1-based; Task 12 increments
      Tree       string   `json:"tree,omitempty"`      // where it runs
      Commit     string   `json:"commit,omitempty"`    // the tree HEAD it verified
      OutDir     string   `json:"outdir,omitempty"`    // ARC_FINAL_OUT
      Detail     string   `json:"detail,omitempty"`    // failure output tail or defects, whole
      Unverified []string `json:"unverified,omitempty"`
      VerifierRunID string `json:"verifierrunid,omitempty"` // Task 11
      Respawns   int      `json:"respawns,omitempty"`      // Task 11
      StartedTs  int64    `json:"startedts,omitempty"`
  }
  type RunVerification struct {
      State   string   `json:"state"` // passed | unverified | failed
      Reasons []string `json:"reasons,omitempty"`
  }
  const FinalExitUnverified = 3
  const MaxFinalRounds = 2
  const FinalTimeout = 30 * time.Minute
  func finalTree(ctx context.Context, g *waveobj.TaskGroup, owner *waveobj.Run) (tree string, cleanup func(), err error)
  func runFinalCommand(ctx context.Context, tree, cmd, outDir string, timeout time.Duration) (exit int, tail string, err error)
  func startVerifier(ctx, spawnCtx context.Context, g *waveobj.TaskGroup, owner *waveobj.Run, afterCommit *[]func()) // Task 10: sets the outcome; Task 11 replaces the body
  func finishFinal(g *waveobj.TaskGroup, afterCommit *[]func()) // computes the outcome from Detail and Unverified
  func RunFinishedWake(f *waveobj.FinalStage) string
  ```

- [ ] **Step 1: Failing tests.**
  - The plan parser reads `**Final:**` and `**Prototype:**`. A second Final line is refused. A Final line
    after the first task is task text.
  - `RecomputeDagStatus` gives `finalizing` for all-merged tasks with `Final` nil or running, `done` for
    `passed` and `unverified`, and `blocked` for `failed`.
  - The final stage with `Check: "exit 1"` fails, with Detail holding the tail.
  - With `FinalCmd` exiting 3 and printing `no dev app: cargo missing` last, the outcome is `unverified` and
    the reason is `no dev app: cargo missing`.
  - Exit 2 fails.
  - A command that sleeps past a 1-second test timeout fails with "timed out" (Review Focus).
  - No FinalCmd and nothing unverified passes.
  - A task's `ReviewUnverified` makes the outcome `unverified` with `t-N: <text>`. A dag with no Verify
    line adds "the plan has no Verify".
  - The checkout-landed final tree is a detached worktree (fixture repo) removed by cleanup. The
    branch-landed tree is `LandPath`. A non-git dag is `unverified` with "not a git repository".
  - `ARC_FINAL_OUT` is set and the directory exists.
  - `RunFinishedWake` for `unverified` lists every reason whole.
  - `onlyRunFinished` (`pkg/orchestrate/wake.go:337`) compares held lines with the old constant, so a lead-free
    run that finishes `passed` or `unverified` would now launch a lead. Keep the finished line's first
    line constant (`runFinishedWake`), put the outcome on the lines after it, and make `onlyRunFinished`
    match that first line. Test that a lead-free run that finishes `passed` or `unverified` launches no
    lead.
  - The stage starts when `g.Final == nil` (Round 1) or `g.Final.State == ""` (the round Task 12 set up;
    keep its Round).
  - The failed wake contains the Detail whole and `wsh jarvis dag submit --round`.
  - The seal writes `Verification`.
  - The runmodel label.
- [ ] **Step 2: Run** the tests and expect FAIL.
- [ ] **Step 3: Implement.** The final stage runs off the tick like Verify does. Look at `startVerify` in
  `pkg/orchestrate/verify.go` for the pattern of running a command in a tree without holding the dag lock,
  and for how its result is written back under `withDagMutation`. Reuse its shell invocation for Check and
  FinalCmd. `OutDir`: `filepath.Join(os.TempDir(), "arc-final", g.OID, fmt.Sprint(round))`. Keep Check
  and FinalCmd output tails with the bound Verify uses. Run `task generate`.
- [ ] **Step 4: Run** the Verify command and the Check. Expect PASS. Existing tests that expected `done` right
  after the last merge now go through the final stage: give those fixtures no Check and no FinalCmd, and let
  the tick pass the stage (still `finalizing` for one tick at most); update the expectations.
- [ ] **Step 5: Commit** `feat(orchestrate): verify the merged result in a final stage before the run is done`.

### Task 11: Final verifier session
**Depends on:** Task 10

Spec section 3.3. It replaces `startVerifier`'s no-op body from Task 10 and reuses `spawnStageSession` and
`stageSessionLost` from Task 9.

**Files:**
- Modify: `pkg/orchestrate/final.go` (`startVerifier`, verdict application), plus a new `pkg/orchestrate/verifier.go` for the prompt
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (`final-pass|final-fail` actions, next to the `planreview-*` cases), `pkg/wshrpc/wshrpctypes_dag.go` (action list comment)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` (`wsh jarvis dag final pass "<summary>" [--unverified "<what>"]`, `wsh jarvis dag final fail "<defects>"`, next to `planreview`)
- Modify: `pkg/jarvis/usage.go` (`verifier` role test only, if `StageRole` already covers it)
- Test: `pkg/orchestrate/verifier_test.go`, `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`

**Interfaces:**
- Consumes: `spawnStageSession`, `stageSessionLost`, `StageSession` (Task 9); `FinalStage`, `finishFinal` (Task 10); `DocPath` (Task 7).
- Produces: `func RecordFinalVerdict(ctx context.Context, dagID, verifierRunID, verdict, text, unverified string) error`.

- [ ] **Step 1: Failing tests.**
  - After the deterministic steps pass, one verifier with `StageRole: "verifier"` is spawned in
    `Final.Tree`. Its prompt contains the spec and plan paths, `git diff <owner.BaseCommit>..<Final.Commit>`,
    `Final.OutDir`, the Prototype path when set, and every task's `ReviewUnverified`. It says: compare
    screenshots to prototype boards structurally (elements, order, copy, controls at that width), not by
    pixels; classify each difference as allowed (in the spec's Deviations) or a defect; only read.
  - `final pass "s"` gives `passed`. `pass --unverified "u"` gives `unverified` with `u`. `fail "d"` gives
    `failed` with Detail `d` whole.
  - A verifier lost twice gives `unverified` with "the verifier did not finish".
  - `fail --unverified` is refused. A verdict from a run that isn't the current verifier is refused.
  - The CLI sends `Action: "final-pass"`, `Notes`, and `Unverified`.
- [ ] **Step 2: Run** the tests and expect FAIL.
- [ ] **Step 3: Implement.** Bound each note by `MaxReviewNoteLen`, refused and not clipped (as
  `RecordReviewVerdict` does). Run `task generate`.
- [ ] **Step 4: Run** the Verify command and the Check. Expect PASS.
- [ ] **Step 5: Commit** `feat(orchestrate): judge the combined result with a fresh verifier session`.

### Task 12: Fix round with `dag submit --round`
**Depends on:** Task 10

Spec section 3.4, the fix-round bullet. `DagSubmitCommand` refuses a second, different dag ("a run holds
exactly one dag"). A round extends the same dag instead.

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` (`CommandDagSubmitData.Round bool \`json:"round,omitempty"\``)
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (`DagSubmitCommand`: a `data.Round` branch before `CreateDagForRun`)
- Create: `pkg/orchestrate/round.go`, `pkg/orchestrate/round_test.go`
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` (`dag submit --round`)
- Test: `round_test.go`, the dag submit tests, `wshcmd-jarvisdag_test.go`

**Interfaces:**
- Consumes: `FinalStage`, `MaxFinalRounds` (Task 10).
- Produces: `func AppendRound(ctx context.Context, dagID string, tasks []waveobj.TaskNode) (*waveobj.TaskGroup, error)`.
  The appended tasks are renumbered `t-(n+1)…`, and their `DependsOn` is mapped from the fix plan's own
  numbering.

- [ ] **Step 1: Failing tests.**
  - `AppendRound` on a dag whose `Final.State == failed` and `Round == 1`, given plan tasks 1..2 (2 depends
    on 1), appends `t-8`, `t-9` (with `t-9` depending on `t-8`) to a 7-task dag, sets
    `Final = &FinalStage{Round: 2}` (empty State: not started, so Task 10's stage starts again when the
    new tasks land), and after `Schedule` dispatches `t-8` cut from the landing tree's head.
  - It is refused when `Final` is nil, running or passed ("the final stage has not failed"), and when
    round 2 has failed ("no fix rounds left; forward to the human") (Review Focus).
  - A fix plan's Verify, Setup, Check and Final lines are ignored in favor of the dag's.
  - `wsh jarvis dag submit --round --plan f.md` sends `Round: true`.
- [ ] **Step 2: Run** the tests and expect FAIL.
- [ ] **Step 3: Implement.** In `DagSubmitCommand`, when `data.Round` is set: load the run's dag, call
  `AppendRound` under the dag mutation lock, skip plan review (fix rounds are not plan-reviewed), and
  schedule. The fix plan's spec path is ignored.
- [ ] **Step 4: Run** the Verify command and the Check. Expect PASS.
- [ ] **Step 5: Commit** `feat(orchestrate): let the lead run a fix round on a failed final stage`.

### Task 13: Land-back, held landing, unverified attention
**Depends on:** Task 5, Task 10

Spec sections 2.3 and 3.5 (the attention item and ack). The completion paths are the lead's `complete`
(`AdvanceRunCommand`, which ends in `SealDoneRunEvidenceAsync`, `wshserver_runs.go:91`) and
`MaybeCompleteLeadFreeRun` (`pkg/orchestrate/leadclose.go:145`, which ends in `SealRunEvidenceHook`).
Land-back runs **after** the seal, in the same goroutine. Attention items are derived in
`pkg/jarvis/attention.go` (`BuildAttention`; follow the `AttentionDagBlocked` item). `IndexClean` exists in
`pkg/orchestrate`. `RemoveRunWorktree(ctx, projectPath, runID)` exists.

**Files:**
- Create: `pkg/orchestrate/land.go`, `pkg/orchestrate/land_test.go`
- Modify: `pkg/waveobj/wtype.go` (`Run.Land *RunLand`, `Run.VerificationAckTs int64 \`json:"verificationackts,omitempty"\``)
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (land after seal; the new `LandRunCommand`, `AckRunCommand`), `pkg/orchestrate/leadclose.go` (the same hook)
- Modify: `pkg/wshrpc/wshrpctypes_runs.go` (new commands: `LandRunCommand(ctx, CommandLandRunData{ChannelId, RunId string; Force bool})`, `AckRunCommand(ctx, CommandAckRunData{ChannelId, RunId string})`)
- Modify: `pkg/jarvis/attention.go` (items `run-land-held` and `run-unverified`), `pkg/jarvis/attention_test.go`
- Modify: `cmd/wsh/cmd/wshcmd-runs.go` (`runs land <run-id> [--force]`, `runs ack <run-id>`, and `runs show` prints `Land` and `Verification`)
- Modify: the frontend attention row that renders item actions (find it with `grep -rn "AttentionDagBlocked\|dag-blocked" frontend/app`). Give `run-unverified` an Acknowledge action that calls `RpcApi.AckRunCommand`, and `run-land-held` an Open-run action like `dag-blocked`. Put any logic in the existing model file, with a test.
- Test: `land_test.go`, `attention_test.go`, `wshcmd-runs_test.go`, the frontend model test

**Interfaces:**
- Consumes: `Run.BaseBranch`, `EffectiveLanding` (Task 5); `FinalStage` (Task 10); `IndexClean`,
  `RemoveRunWorktree`, the `git` helper.
- Produces:
  ```go
  type RunLand struct {
      State  string   `json:"state"`            // pending | landed | held
      Reason string   `json:"reason,omitempty"`
      Commit string   `json:"commit,omitempty"` // the merge commit
      Notes  []string `json:"notes,omitempty"`  // e.g. merged onto a moved base
  }
  func LandRun(ctx context.Context, channelID, runID string, force bool) (*waveobj.RunLand, error)
  ```

- [ ] **Step 1: Failing tests** in a fixture repo with a real `wave/<runId>` worktree. Build it with
  `CreateRunWorktree`.
  - A clean checkout on `main` lands with a `--no-ff` merge whose message has the plan title and
    `Arc-Run: <runId>`. The landing tree is removed and the branch deleted, and `Land.State == landed` with
    the merge sha.
  - A checkout on another branch is held ("checkout is on x, not main").
  - A staged change is held.
  - `MERGE_HEAD` present is held ("a merge is in progress") (Review Focus).
  - An uncommitted edit to a file the branch changes is held, and the edit is byte-identical afterward.
  - An uncommitted edit to an unrelated file lands, and the edit is intact.
  - An untracked file identical to one the branch adds is removed, then the run lands. A different one is
    held.
  - A conflict is held with the file list, and `git status` is clean of merge state (aborted).
  - `Final.State == failed` is held unless `force`.
  - The landing tree's HEAD past `Final.Commit` re-runs Check and Verify first, and a failing Verify is held.
  - `main` advanced by 2 commits during the run lands, with the note "merged onto 2 commits that landed on
    main during the run; the combination was not verified".
  - A checkout-landed run (`LandPath == ""`) does nothing.
  - Attention: a done run with `Verification.State == unverified` and no ack yields `run-unverified` naming
    the reasons; `Land.Notes` yield it too; an ack clears it. `Land.State == held` yields `run-land-held`
    with the reason.
  - The CLI commands send the RPCs.
- [ ] **Step 2: Run** the tests and expect FAIL.
- [ ] **Step 3: Implement.** Order of checks: already landed (return), not branch-landed (return nil),
  final failed without force, `BaseBranch` empty ("the run started on a detached HEAD"), checkout branch,
  merge or rebase in progress, index clean, re-verify if moved, untracked identical removal, then the merge
  (`git merge --no-ff -m <title> -m "Arc-Run: <runId>" wave/<runId>`; on failure, `git merge --abort` and
  hold with the output's file list), the moved-base note (`git rev-list --count <BaseCommit>..<pre-merge
  HEAD>` on the base branch, excluding the run's own commits), then cleanup. Persist `Run.Land` under
  `wstore.UpdateRun`, and publish the run update. Held attempts append a run event
  `land-held {reason}`. Run `task generate`.
- [ ] **Step 4: Run** the Verify command and the Check. Expect PASS.
- [ ] **Step 5: Commit** `feat(orchestrate): merge a finished run's branch back and hold it when it cannot`.

### Task 14: This repo's Final command
**Depends on:** none

Spec section 3.2, last bullet. A plan for this repo will use `**Final:** \`node scripts/cdp/final-verify.mjs\``.
Read AGENTS.md "Worktrees (Windows)" and "Visual verification (dev)". `scripts/cdp/verify.mjs` runs
scenarios; `CDP_PORT` picks the port; a worktree dev app needs its own port and WebView2 profile
(`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=<port>"`,
`WEBVIEW2_USER_DATA_FOLDER=<dir>`). `task dev` exits when its stdin closes, so hold stdin open. Stop only the
PIDs you started, never by image name: the user's packaged Arc uses the same image names.

**Files:**
- Create: `scripts/cdp/final-verify.mjs` (pure helpers exported, `main` guarded by an `import.meta` entry check, as other scripts do)
- Create: `scripts/cdp/final-verify.test.mjs` (vitest, like `report.test.mjs`)

**Interfaces:**
- Produces: exports `pickPort(start) -> Promise<number>` (first free TCP port from `start`, default 9230),
  `unverified(reason) -> never` (prints the reason as the last line, exits 3), and `const EXIT_UNVERIFIED = 3`.
  The CLI env it reads: `ARC_FINAL_OUT` (required; exits 3 with "ARC_FINAL_OUT is not set" when missing).
  The args are scenario names passed through to `verify.mjs`.

- [ ] **Step 1: Failing tests** for `pickPort` (it skips a port a test server holds). With `ARC_FINAL_OUT`
  unset, running the script (child process) exits 3 with that reason as its last stdout line. When the dev
  app doesn't answer CDP within the timeout (inject a 1 s timeout through an env var such as
  `ARC_FINAL_BOOT_MS`, and don't start `task` in the test: inject the start command through
  `ARC_FINAL_DEV_CMD`), it exits 3 with "dev app did not answer on :<port>", and the process it started is
  gone.
- [ ] **Step 2: Run** `npx vitest run scripts/cdp/final-verify.test.mjs` and expect FAIL.
- [ ] **Step 3: Implement.** Pick a port. Build the profile dir under `ARC_FINAL_OUT`. Spawn
  `ARC_FINAL_DEV_CMD` (default `task dev`) with stdin as a pipe kept open, `cwd` = `process.cwd()` (the
  final tree), and the two WebView2 env vars. Poll `http://127.0.0.1:<port>/json` until it answers or
  `ARC_FINAL_BOOT_MS` (default 600000) passes. Then run `node scripts/cdp/verify.mjs <scenarios>` with
  `CDP_PORT=<port>` and copy `cdp-shots/` into `ARC_FINAL_OUT`. Kill the spawned process tree by PID in
  `finally` (`taskkill /PID <pid> /T /F` on Windows, `process.kill(-pid)` elsewhere). Exit with
  verify.mjs's code: 0 is pass, nonzero is fail. Keep the file's 4-space indent, and don't run prettier on
  it.
- [ ] **Step 4: Run** the test and expect PASS.
- [ ] **Step 5: Commit** `feat(scripts): a Final command that verifies the UI from the final tree's own dev app`.

### Task 15: Docs
**Depends on:** Task 3, Task 8, Task 11, Task 12, Task 13, Task 14

**Files:**
- Modify: `docs/orchestrator-guide.md` (landing default and `--landing`; land-back and held states;
  `wsh runs land`/`ack`; plan review at submit; the final stage, `**Final:**`/`**Prototype:**`, exit 3;
  the fix round; the worker report; `--unverified`; usage in `dag status`/`runs show`)
- Modify: `AGENTS.md` (the "Plans the engine runs" paragraph: add the Final and Prototype lines and the
  plan review; one line saying engine runs land on `wave/<runId>` and merge back when they complete)
- Modify: `docs/open-issues.md` (add the out-of-scope items from spec section 5 that remain real issues:
  automated board rendering, a cheap-model route for judging sessions, an idle-lead watchdog)

- [ ] **Step 1:** Read the landed code for each item (`git log --grep Arc-Task` lists the tasks), and write the
  docs from the code, not from this plan.
- [ ] **Step 2:** Check every command named in the docs exists: run `wsh`'s cobra help through
  `go run ./cmd/wsh <cmd> --help`, where it runs without a server.
- [ ] **Step 3: Commit** `docs(orchestrator): document landing, the final stage and plan review`.
