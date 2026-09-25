# Orchestrator findings fixes: reporting, landing, final verification, pre-submit review

Fixes the findings of `docs/orchestrator-findings-2026-09-25.md` (untracked; the essentials are restated
here). Numbers in brackets are the finding numbers. Finding 3 (attention row) is out of scope.

## Decisions (human, 2026-09-25)

- Engine runs land on `wave/<runId>` by default; the engine merges the branch back itself (`--no-ff`)
  after the final verification stage. `--landing checkout` opts out. No DAG-shape heuristic.
- Final stage = deterministic (Check + an optional plan `**Final:**` command) + a fresh verifier session.
  No automated board rendering.
- A failed final stage wakes the lead, who submits a fix round on the same run (`dag submit --round`),
  at most 2 rounds, then the human.
- Land-back happens on `passed` or `unverified`; only `failed` holds the branch.
- An engine plan reviewer runs at `dag submit`, before any worker starts.

## 1. Reporting and wrap-up

### 1.1 Worker report is sealed from a file [14]

Today the worker brief (`pkg/orchestrate/engine.go` `workerContract`) says "the lead reads your final
message", then "Commit, then `wsh jarvis complete --commit …`". Workers complete first and write the report
after, so `SealEvidence` (`pkg/jarvis/evidence.go`) seals the line before `complete` as the summary (7/7
tasks in the observed run). `wsh jarvis complete --report <file>` already exists.

- The engine names a report path per task attempt: `<os.TempDir()>/arc-reports/<dagOID>/<taskID>.md`,
  creating the directory before spawn. It lives outside every worktree, so it can't be committed.
- The brief replaces the "final message" sentence: write the report to that path with your file-writing
  tool, covering what you did, what you did differently from the task and why, what a later task must know,
  and anything you could not verify and why. Then run
  `wsh jarvis complete --commit $(git rev-parse HEAD) --report <path>`.
- The server refuses a task worker's `complete` without a report (`AdvanceRunCommand`, when the run has a
  `TaskId` and is not `Review`), with an error that names the flag and the path to write. Reviewer runs,
  leads and non-DAG runs are unaffected.
- The reviewer's brief carries the whole report, not the 600-rune `truncateNote` cut. Dependents'
  handoff and the digest's `Result` keep their existing bounds.

### 1.2 Worker brief: edit with the edit tool [10]

One sentence in `workerContract`: edit files with your edit tool, and don't script multi-kilobyte
replacements through the shell (large shell heredocs fail in the Claude Code Bash tool on Windows).

### 1.3 Reviewer caveats are a field, printed whole [15]

Today the `passed review` wake line truncates the note at 600 runes (`review.go`, `PostQuiet … truncateNote`),
and reviewers put caveats last.

- `wsh jarvis dag review pass "<note>" --unverified "<what was not verified, and why>"`. Only with
  `pass` (a fail's findings already say it). Same 2000-rune refusal as the other notes. Stored as
  `TaskNode.ReviewUnverified`.
- The reviewer brief says when to use it: the task asked for a check (a test, a screenshot, a live run)
  that the diff and the worker's report show was not done.
- The `passed review` wake line prints `unverified: <text>` in full, first, and the note's recap after it
  (still truncated).
- `DagTaskDigest` gets `ReviewUnverified`; `DagReportDigest` gets `UnverifiedNotes []{taskid, text}`;
  `wsh jarvis dag status` prints each in full.

### 1.4 Wrap-up rule [17]

`OrchestrationRules`' "run finished" line (`pkg/jarvis/leadprompt.go`) is rewritten to the agreed rule:

- On `run finished`: check what landed, fix and commit leftovers in this tree (a stale doc line, an
  orphaned file), write the report to a file, and add each open issue as an effort chunk (unchanged).
- Then **complete on your own**: `wsh jarvis complete --report <file>`. Ask through AskUserQuestion only
  when a decision is needed: a verification failed, a deviation needs the human's call, or you propose a fix
  round.
- "Not verified" never blocks completion: the run completes with an unverified outcome (section 3.5).
- Never put a question to the human in plain text.

### 1.5 Token totals per role and task [19]

- A pure function sums token classes (input, output, cache read, cache write 5m, cache write 1h, and
  message count, per model) from a transcript, reusing `usagestats.TranscriptUsage`.
- The run's sessions are: the lead (its phase `WorkerOrefs` through `TranscriptPathForTab`, relaunched
  leads included) and every child run with a `SessionId` (task workers, task reviewers, the plan reviewer
  and the final verifier, section 4.1 and 3.3) through `agentsessions.TranscriptForSession`. Roles: `lead`,
  `worker`, `reviewer`, `plan-reviewer`, `verifier`. Children carry `TaskId`.
- Computed once when the DAG reaches its final outcome (before the `run finished` wake), stored on the dag
  (`TaskGroup.Usage`), and recomputed at `SealEvidence` into `RunEvidence.Usage`, so the lead's wrap-up
  counts. A transcript that can't be read leaves a zero row marked `missing`, never an error.
- `DagReportDigest.Usage` carries it. The `dag status` report prints per-role totals and per-task
  worker+reviewer totals. `wsh runs show` prints per-role totals (from evidence when sealed, else the dag).
- Tokens only. Dollars stay in the frontend's single price table (`usagepricing.ts`); the run card is
  unchanged.

## 2. Landing

### 2.1 `--landing` and the branch default [12]

- `wsh runs start --landing branch|checkout` sets `CommandCreateRunData.Landing`, which wins over the
  profile; validated with `jarvis.ValidateLanding`.
- An empty profile landing now means **branch**. `checkout` stays an explicit choice. As today, a run with no
  base (unborn repo, not git) lands in the checkout.
- At create, the run records `BaseBranch` (the checkout's current branch). A detached HEAD records none, and
  such a run lands on a branch that is never merged back automatically (section 2.3 holds it).

### 2.2 Spec and plan snapshot at submit [8]

- For a branch-landed run, `dag submit` stages the spec and plan in the landing tree and commits them there
  (`docs(<topic>): spec and plan for <title>` with the `Arc-Run: <runId>` trailer) before any lane is cut.
  A path outside the landing tree is copied to its repo-relative path first (`foldIntoTree` already does
  this). Every lane branches from that commit, so relative references in the plan resolve in every worktree,
  and every task reads the same version.
- `TaskGroup` keeps the repo-relative paths. Workers, reviewers, the verifier and the plan reviewer get the
  file inside their own tree, which is the committed snapshot. The lead's copy, which is live in the landing
  tree, never reaches them. A resubmit after a failed plan review commits the revised files again.
  `laneFold` returns nil for a branch-landed dag. A checkout-landed dag keeps today's absolute paths and
  `laneFold` behavior.
- The launch prompt's "Don't commit the spec or plan" becomes: the engine commits them to the run's branch
  at submit, and they land with the run.

### 2.3 Land-back [12, 2, 9]

The engine merges `wave/<runId>` into `BaseBranch` in the project checkout when the run completes (the
lead's `complete`, or `MaybeCompleteLeadFreeRun`) and the final outcome is `passed` or `unverified`.
Landing is its own step with its own state, so completion never waits on it.

- `Run.Land`: `{state: pending|landed|held, reason, commit, notes[]}`.
- Preconditions, each a `held` with a reason: the checkout is on `BaseBranch`; the checkout's index is clean
  (`IndexClean`); the final outcome is not `failed`.
- If the landing tree's HEAD moved past the commit the final stage verified (the lead's wrap-up commits),
  Check and Verify run again in the landing tree first. A failure is `held`.
- An untracked file in the checkout at a path the merge adds, with identical content, is removed first (the
  lead's spec or plan written before submit). Different content is `held`.
- `git merge --no-ff -m "<plan title or goal's first line>" -m "Arc-Run: <runId>" wave/<runId>`. git
  refuses to overwrite uncommitted edits to files the merge touches: that is `held`, and the edits stay.
  A conflict runs `git merge --abort` and is `held` with the conflicting files.
- If `BaseBranch` moved since the run's base, the land records the note "merged onto N commits that landed
  on <base> during the run; the combination was not verified" on `Run.Land.notes`. The note is not written
  into sealed evidence, which can't change after the seal. The `run-unverified` attention item reads it
  (3.5).
- On `landed`, the engine removes the landing tree and deletes `wave/<runId>` (the evidence keeps the tip
  SHA, section 2.4).
- `held` raises an attention item (`run-land-held`) with the reason. `wsh runs land <run-id>` retries.
  `--force` lands a `failed` outcome, for the human only; the lead is never told about it.

### 2.4 Evidence counts only the run's own commits [18]

- Branch-landed: the lead's `complete` already reports the landing tree's HEAD as `EndCommit`. The seal
  diffs `BaseCommit..EndCommit`, which is exactly the branch's own history. No change beyond a test.
- Checkout-landed: the seal walks `BaseCommit..EndCommit` and keeps only commits whose `Arc-Run` trailer
  value is the run id or starts with `<runId>-`. It sums per-file numstat and status across them. The lead
  prompt tells the lead to end each commit it makes with `Arc-Run: <runId>` (a run marker, not
  attribution), so the lead's own fixes count.

### 2.5 Lane commit subject and `Arc-Task` lines [13]

`mergeMessage` (`pkg/orchestrate/merge.go`) keeps the `Arc-Run: <lane key>` trailer (retried merges
recognize their commit by it) and adds one `Arc-Task: t-N` line per task the lane landed. A lane with more
than one task takes `laneMergeMessage` (the task titles, joined) as its subject, with the workers' commit
messages as the body.

## 3. Final verification stage [11, 16, proposal]

### 3.1 Where it sits

The DAG's derived status reaches `done` only after the final stage. When every task is terminal and merged,
the engine starts `TaskGroup.Final` (`{state, round, commit, check, final, verifierRunId, verdict,
defects, unverified[]}`) instead of announcing `done`. The final tree is the landing tree. A
checkout-landed dag uses a detached worktree at the checkout's HEAD, with Setup run in it and removed after.
It never runs in the shared checkout.

### 3.2 Deterministic steps

1. Check (the plan's Check) on the merged result [16]. Non-zero is `failed`.
2. `**Final:**`: a new optional plan preamble line holding one command. It runs in the final tree in a POSIX
   shell with `ARC_FINAL_OUT=<dir>`, a per-round output directory for screenshots and a contact sheet. Exit
   0 passes. Exit `FinalExitUnverified` (3) means it could not verify: its last output line becomes an
   unverified reason. Any other non-zero exit is `failed` with the output tail. It has a timeout like
   Verify's.
3. `**Prototype:**`: a new optional preamble line with the path of a design canvas, given to the verifier.
- `PlanFormat` documents both lines.
- For this repo, `scripts/cdp/final-verify.mjs` is the Final command: it starts a dev app from the final
  tree on its own CDP port and WebView2 profile, with stdin held open, and runs `verify:ui` into
  `ARC_FINAL_OUT`. It stops only the PIDs it started and exits 3 with a reason when it can't start the app.

### 3.3 Verifier session

After the deterministic steps (unless they failed), the engine spawns a fresh session in the final tree,
on the lead's route like task reviewers. Model tiers were removed, so no cheap-model setting is added; the
usage totals in 1.5 show whether one is worth adding later. The verifier gets: the spec and plan paths,
`git diff <base>..<head>` of the final tree, `ARC_FINAL_OUT`, the Prototype path, and every reviewer
`unverified` note. It checks the combined change against the spec, looks for problems that only exist once
tasks are combined, and compares screenshots to prototype boards structurally (which elements, their order,
copy, and controls at that width; pixel diffs are useless against invented data). It classifies each
difference as allowed (listed in the spec's Deviations) or a defect. Read only.

It ends with `wsh jarvis dag final pass "<summary>" [--unverified "<what, why>"]` or
`wsh jarvis dag final fail "<defects: each, where, fix>"`. Timeout and one respawn work as for reviewers.
A verifier that ends without a verdict twice gives the unverified reason "the verifier did not finish".

### 3.4 Outcome and fix round

- `passed`: no failure and no unverified reasons. `unverified`: no failure, one or more reasons (Final exit
  3, the verifier's `--unverified`, reviewers' `unverified` notes, the plan has no Verify, or a moved base
  at land-back). `failed`: Check, Final or the verifier failed.
- `passed`/`unverified`: the DAG is `done`. The usage is computed, and the lead gets the `run finished` wake,
  which states the outcome and prints every unverified reason in full.
- `failed`: the lead is woken with the defects in full. If rounds are left, it writes a fix plan and runs
  `wsh jarvis dag submit --round --plan <fix plan>`. Otherwise, or if the fix is a product call, it forwards
  to the human. `--round` is accepted only when `Final.state` is `failed` and `round < MaxFinalRounds` (2).
  It appends the plan's tasks as `t-(n+1)…`, mapping the plan's own numbers and Depends, and keeps the
  dag's Verify, Setup, Check, Final and Prototype. The new tasks cut from the landing tree's head. The
  `Final` stage is cleared with `round+1`, and scheduling resumes. Fix rounds skip plan review (every task
  is still reviewed). The run's "one dag per lifetime" rule is kept: a round extends the same dag.

### 3.5 Run outcome

- `RunEvidence.Verification`: `{state: passed|unverified|failed, reasons[]}`, sealed from `Final`.
- `wsh runs show` prints it and `Run.Land`. A done run whose Verification is `unverified`, or whose
  `Land.notes` is non-empty, raises an attention item (`run-unverified`) that names each reason. It clears on `wsh runs ack <run-id>`, and the cockpit's attention row calls the same RPC.

## 4. Before submit

### 4.1 Plan review at submit [7]

- `dag submit` creates the dag with `PlanReview: {state: reviewing, round: 1}`. The scheduler dispatches
  nothing until `PlanReview.state` is `passed` or `accepted`. A dag submitted as JSON (no plan file) and fix
  rounds skip it.
- The engine spawns a fresh plan-reviewer session in the landing tree, on the lead's route. Its brief: read
  the spec, the plan and the files they name. Check that every spec requirement has a task; that no two tasks
  edit the same file without a Depends between them; that names (types, functions, flags) agree across
  tasks; that each task names its tests; and that the plan's commands exist. Report spec gaps and
  contradictions too. Read only. It ends with `wsh jarvis dag planreview pass "<summary>"` or
  `… fail "<findings>"`. Timeout and respawn work as for reviewers. The spawn, timeout and respawn are shared
  with the verifier (one helper, two briefs).
- `fail`: the lead is woken with the findings in full, revises the plan (and forwards spec changes to the
  human), and runs `dag submit` again. A resubmit **replaces** the proposal while no task has dispatched and
  the plan review failed, then re-reviews with `round+1`. After round 2 fails, the lead must forward. If the
  human says to proceed, the lead runs `wsh jarvis dag planreview accept "<the human's reason>"`.
- A plan run with no lead (`wsh runs start --plan`) gets its lead launched by the failure wake, as today.

### 4.2 Less ceremony; the design goes in a file [4, 5, 6]

The launch prompt (`writeLaunchPrompt`) says:

- State the path you take (spike, bounded, architectural) and proceed. Ask about the path only when it is
  genuinely unclear [4].
- Architectural: ask the decisions you need as AskUserQuestion questions with options. Write the design
  straight into the spec file. Don't ask for approval section by section, since the `Spec review` is the one
  approval [6]. Any approval of something longer than its question carries the file's absolute path on its
  first line [5].
- After `dag submit`, don't ask the human to review the plan or pick an execution mode: the engine reviews
  it (this resolves writing-plans' handoff) [7].

### 4.3 Principles that contradict the engine contract [1]

- Every prompt that renders principles into an engine run (the goal lead, `PlanLeadPrompt`, and the worker,
  reviewer, plan-reviewer and verifier briefs if they carry them) follows them with one line: where a
  principle conflicts with this run's contract (who merges, who executes the plan, where work lands), the
  contract wins.
- `RenderPrinciples` drops a principle whose normalized text (lower case, collapsed whitespace, trailing
  punctuation removed) repeats an earlier one. The profile write path refuses such a duplicate with an error
  naming the earlier one. Near-duplicates ("Use worktree" and "Use worktree instead of branch") are the
  human's to edit; no semantic dedupe.

## 5. Out of scope

Finding 3 (attention row); automated board rendering and board-to-scenario pairing; a cheap-model route
setting; an idle-lead watchdog after `dag-done` (the wrap-up rule and the unverified attention item cover
it); pricing in Go.

## 6. Testing

Go unit tests next to each change, in the existing `*_test.go` style of `pkg/orchestrate`, `pkg/jarvis`,
`pkg/wshrpc/wshserver` and `cmd/wsh/cmd`. Required:

- `complete` without `--report` is refused for a task worker and accepted for a lead and a reviewer.
- A `--unverified` note survives whole into the wake line and the digest.
- Land-back: conflict → held and aborted; uncommitted overlapping edit → held and the edit intact;
  unrelated uncommitted edit → landed and the edit intact; identical untracked spec → removed and landed;
  wrong branch → held.
- Checkout-landed evidence excludes a commit without the run's trailer.
- The status stays not-done until `Final` is terminal. Final exit 3 → unverified with its reason. `--round`
  is refused unless `failed` with rounds left, and appended tasks are renumbered.
- The scheduler dispatches nothing during plan review. A resubmit replaces the proposal only after a fail.
- Usage sums a fixture transcript per role and task and marks an unreadable transcript missing.
- Principle dedupe and the precedence line.
- `scripts/cdp/final-verify.mjs`: exits 3 with a reason when the dev app can't start.

Frontend: the new optional TS fields stay optional; the attention row's acknowledge action gets a model
test if it has logic.
