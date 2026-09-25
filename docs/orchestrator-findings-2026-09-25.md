# Orchestrator findings, 2026-09-25

Bugs, gaps and improvements in the orchestrator (engine, lead prompt, cockpit and CLI surfaces), found
by watching a live run end to end. Each entry says what happened, what the evidence is, and how severe it
is. "Observed" means seen in the run; "read" means taken from source.

## Summary

The run succeeded mechanically: 7 of 7 tasks, 0 failures, 0 conflicts, 25 min from submit to done, and
51 min in total, including brainstorming and wrap-up. Parallel spawn, lanes, reviewer hand-offs, and
serialized merge plus Verify all worked (see "Worked as designed"). The weak point is **verification and
reporting**: a purely visual goal landed on `main` with no rendered check, and the channels that should
have said so dropped it. The lead caught it by its own diligence, and a human had to start the dev app.

| # | Finding | Severity | Fix size |
|---|---|---|---|
| 14 | Worker report lost in 7/7 tasks: summary sealed from the line before `complete` | high | brief line + `--report` check |
| 15 | Wake digest truncates review notes; the cut dropped the only "unverified" signal | high | caveat field, untruncated |
| 7 | No independent review of spec or plan; no human sees the plan | high | fresh reviewer before submit |
| 11 | UI tasks get no visual check; the plan's single CDP step was skipped | medium | final verification stage (proposal) |
| 12 | Checkout landing leaves `main` broken between merges; no `--landing` flag | medium | branch landing in its own worktree by default (chosen), land-back with a check on the merged result; `--landing checkout` opt-in |
| 18 | Sealed evidence counts other sessions' commits (16 of 61 files) | medium | evidence from trailers, not base..HEAD |
| 19 | No cost reporting anywhere; measured afterwards: 29.3M tokens, about $32 (lead 31%) | medium | tokens per role/task in the DAG report |
| 17 | Lead asks "complete?" in plain text; agreed rule: complete on its own, ask only on a decision | medium | wrap-up rule in `leadprompt.go` |
| 1 | Saved project principles contradict the engine contract | medium | per-mode filter + dedupe |
| 3 | Attention row shows the whole goal and cuts off the question | medium | truncate goal, keep question |
| 5 | Design approvals carry a one-line summary; the design is only in the lead's terminal | medium | design file path in the ask |
| 8 | Spec/plan untracked during the run; relative path misses; lead isn't told the engine folds them | low | snapshot at submit + one prompt clause |
| 16 | Check (tsc) never runs on the merged result | low | engine runs Check after the last merge |
| 13 | A multi-task lane lands as one commit titled and trailered by its first task | low | `Arc-Task:` lines |
| 10 | Workers' large heredoc edits fail in the Claude Code Bash tool on Windows (harness bug) | low | brief: use the Edit tool |
| 4, 6 | Obvious questions (the lead's own path) and a design approved twice; questions when unsure stay | low | prompt wording |
| 21 | Sealed "verify pass" lines include greps and edits; piped `go test` hides failures | medium | report engine Verify/Check only as verdicts |
| 23 | Per-merge Verify is the full suite (~7 min under load) and holds the merge queue; ~100 min serialized for 15 tasks | medium | Verify = quick check; full suite in Check/final stage |
| 22 | Nothing detects a worker that is active but not progressing (unmeasured; see the auditor proposal) | medium | deterministic suspect flag, woken to the lead |
| 20 | Parallel tasks spawn sequentially; every `task-spawned` is stamped at batch end | low | per-task spawn time in the event |
| 28 | A worker in a long `go test` shows "idle Nm" in `dag status`; the CPU probe that could tell busy from hung runs only after 15 min quiet | low | sample CPU every tick; show busy vs quiet and the latest tool call |
| 27 | Speed: workers spend 59% of their time in build/test; each dependency link waits ~7 min for its dependency's Verify; 2.0 of 5 slots in use | medium | targeted worker checks + incremental tsc; satisfy deps at merge; merge train with one Verify; scoped per-merge Verify + full Verify in Final; auto-retry an unrelated-package Verify failure once; lower worker effort not first (model is 32% of worker time) |
| 26 | The lead sees only what the engine wakes it for; lost reports, skipped checks and stalls emit no event, and wakes are thin or bury the action | medium | more deterministic wake events, richer and action-first wakes; not a polling lead |
| 25 | A failed Verify keeps an 8000-byte tail of log noise; neither it nor the 200-character detail names the failing test | medium | keep the `--- FAIL`/`panic` blocks; prefer `--- FAIL` over a bare `FAIL` |
| 24 | A worker can sit outside its run in the Agent tree until reload (cause inferred: tab reaches the app before its run is saved; a stale null fetch can overwrite the update) | low | save the run before the tab; a WOS update beats an older fetch |
| 2, 9 | Other sessions share the checkout: `main` moved, dirty tree at merge (not exercised) | watch | branch landing |

**Run under observation:** `b2d7fab1-00de-4fbb-b04d-9754d6248b45`, an orchestrator run with a goal, not a
plan file. Lead and workers are `claude` / `claude-opus-5-5`, base `6dd1600`, started 09:33 in prod Arc
(`dev.arc.app`). The lead's session is `06407caa-7e87-46ab-8fc5-04fb317d899c`. The goal itself (a UI
change) doesn't matter here; the run is the test subject.

## Timeline

| Time | Stage |
|---|---|
| 09:33:45 | `run-created`, `phase-started` (orchestrate). |
| 09:33:55 | Lead loads `superpowers:brainstorming`, as the lead prompt tells it to. |
| 09:34–09:37 | Lead explores: renders the mockups, reads about 20 source files. |
| ~09:37 | Lead asks 4 questions in one AskUserQuestion; it shows up as an `escalation` in `wsh runs attention`. |
| 09:38:17 | Human answers: architectural path (spec, plan, engine). |
| 09:39:44 | Lead presents the design in three sections (layout, pure models, plan shape) and asks to approve each. |
| ~09:44 | Spec written, lead self-review, `Spec review` ask; approved. |
| ~09:46–09:48 | Plan written (977 lines, 7 tasks), lead self-review, `dag submit` with no human plan review. |
| 09:48:19 | DAG `1d819212`: 7 tasks, parallelism 5, longest chain 3. |
| 09:48:46 | t-1, t-2, t-3, t-5, t-6 `task-spawned` (all five stamped at batch end; the spawns were sequential, see finding 20). Worktree creation took 1.9–3.2 s each, Setup 0.4–1.5 s. First activity 10–21 s after spawn (t-6: 11 s, reported 10 s later). |
| 09:49:05 | Engine types `/compact` into the idle lead, keeping the human's decisions and dropping code it read. |
| 09:53:01–09:53:47 | t-5, t-6, t-1 commit (about 4–5 min each); reviewers start within 1–10 s. |
| 09:54:20 | t-5 review passes (reviewer ran 33 s); merged `134a5fc7` at 09:54:28; worktree cleaned up; Verify starts 09:54:34. |
| 09:55:34 | t-1 review passes with a downstream note, which amends t-4. t-4 spawns into t-1's lane worktree (worktree 336 ms, no Setup). t-5 Verify passes (60.5 s). |
| 09:55:36 | t-6 review passes; its note goes to the running t-4 (`task-lead-told`) and amends t-7. Merged `3e8a7d82` 09:55:58. |
| 09:56:10 | t-2 review passes; note amends t-7. |
| 09:56:46–09:57:25 | t-6 Verify passes (40 s); t-2 merges `2099cbd5` and its Verify passes (38 s). |
| 09:59:09 | t-3 commits (about 10.5 min, the longest of the first wave). Review passes 10:00:30; merged `eaec13c8` 10:00:32. |
| 10:02:08 | t-4 commits (about 6.5 min after its 09:55:34 spawn). Review passes 10:03:32; the t-1+t-4 lane lands as one commit `42659f9d` at 10:03:33. |
| 10:04:47 | t-4 Verify passes (73.5 s); t-7 spawns 10:04:50, first activity 31.5 s later. |
| 10:10:51 | t-7 commits `cc55baba` (6 min). Its CDP step is skipped because no dev app is running; it says so only after `complete` (finding 14). |
| 10:12:44 | t-7 review passes (noting that the report shows no verify:ui table); merged `676c718c` 10:12:45; final Verify starts. |
| 10:13:15 | t-7 Verify passes (29.7 s), `dag-done`, and the lead is woken with a digest of truncated review notes (finding 15). DAG: 24m55s elapsed, 43m49s worker time. |
| 10:15–10:16 | Lead commits a comment fix (`e7609818`) straight to `main`, writes its report, opens effort `47db576c` for the live check, and asks the human two questions. |
| 10:16:39 | Human: "start dev", and delete the plan and keep the spec. Plan deleted in `398895ea`. |
| 10:17–10:18 | Lead starts `tail -f /dev/null \| task dev` in the main checkout; CDP is up after about 40 s. The page is blank: another session's half-finished `leadcardmodel.ts` edit breaks the module graph. |
| 10:21 | Lead asks "complete?" in plain text (finding 17). Human types "finish it". |
| 10:22–10:23 | App loads again. verify:ui: 3 of 4 pass. `git-history` fails its setup (source not in the picker) and passes on rerun; the lead attributes the failure to a race with the page reload. 26 steps pass in total. |
| 10:24:17 | Lead stops its dev app (clean: nothing left on 5174 or 9222) and runs `complete --report <file>`. Run `done`, 50m52s after creation. The mockup-parity chunk stays pending on effort `47db576c`. |

## Worked as designed

- **Parallel spawn.** Five independent tasks started within one second. Worktree creation took 1.6–3.2 s,
  Setup (`task worktree:prepare`) 0.4–1.5 s, and first activity came 10–32 s after spawn. No stuck
  claude start (the 2026-09-23 failure mode) this run.
- **Lanes.** t-4 depended only on t-1, so it reused t-1's worktree the moment t-1 passed review
  (336 ms, no Setup), and the two landed together.
- **Reviewer hand-offs.** Four reviewers (t-2, t-3, t-4, t-6) wrote downstream notes, and all four reached
  t-7's worker prompt verbatim (`task-amended`). One reached the already-running t-4 as a
  `task-lead-told`. The notes were concrete: exact props to pass, a duplicate `<HistoryFilterRow />` to
  remove at a named line.
- **Reviewer speed.** 33–75 s per review, starting 1–15 s after the worker's commit.
- **Merge, cleanup and Verify.** Every merge was followed by worktree cleanup (1–8 s) and a Verify of
  35–74 s. No failures, no conflicts.
- **Junction safety.** `removeWorktreeDir` unlinks reparse points before `git worktree remove --force`
  (`pkg/orchestrate/worktree.go:81`), so Setup's junctions can't take the main checkout's `node_modules`
  down with them.

## Findings

### 1. Saved project principles contradict the engine contract (observed, medium)

The lead prompt opens with the project's saved principles, "propagate them into every subagent you
dispatch". Three of them conflict with what the same prompt tells an orchestrator lead:

- "After you done, merge back to the initial branch and clean up the worktree": the lead is told not to
  execute the plan; the engine merges.
- "Prefer inline-execution to subagent execution": the architectural path hands work to engine workers.
- "Use worktree instead of branch" and "Use worktree" are the same principle twice.

Evidence: `db_run.principles` for this run and the lead transcript's first user message. Nothing
reconciles the principles against the mode. They were written for a quick run, and every
orchestrator run inherits them. A worker that obeys "merge back to the initial branch" would race the
engine's own squash-merge.

Direction: drop or rephrase principles that a mode's contract overrides (a per-mode filter, or a note in
the prompt that the engine's rules win), and dedupe on save.

### 2. The engine merges into a checkout with another session's uncommitted edits (observed, not exercised)

When the run started, the project checkout (`main`) had 4 modified files from another session. The
lead noticed and left them alone. Still to observe: what the engine's squash-merge does to a checkout
with uncommitted edits (refuse, stash, or clobber). Not exercised this run: the other session committed
its edits (`83e3742d`) before the first merge at 09:54:28.

### 3. The attention row shows the whole goal and cuts off the question (observed, medium)

`wsh runs attention` shows the lead's pending ask as `Decide escalation`. Its source is the **entire
goal** (2.9 KB here), and the question itself follows it, cut off after about 70 characters. You have
to scroll past the goal and still can't read what is being asked. `--json` has the same shape: `source`
holds the full goal.

Evidence: `pkg/jarvis/resolve.go:213`, `runWorkerTask` builds
`"%s phase (%s) of run goal: %s"` with the untruncated `run.Goal`, and that string is also used as the
escalation's source.

Direction: truncate the goal (first line, or about 80 chars) in the source and keep the question's text
whole. The question is what needs a decision.

### 4. The lead asks the human to pick its own process path (observed, low)

The lead prompt defines spike, bounded and architectural paths and leaves the choice to the lead. The
lead's first question asks the human to confirm it, even though this goal named five scope areas across
about 20 files, so the answer was clear. It is cheap here because it is batched with real questions,
but on a smaller goal it would be a question asked only for the ceremony of it. The prompt could tell
the lead to state the path and proceed, and to ask only when the path is genuinely unclear.

Positive in the same ask: the lead checked a defect claim in the goal against the code, found it was
already handled, and said so rather than "fixing" it. It also offered two out-of-scope extras as
explicit opt-ins rather than adding them silently.

Human's position (2026-09-25, during run 18d08579): asking when genuinely unsure beats assuming, but
obvious questions should not be asked, so the automation keeps going. That is the rule the fix spec
(section 4.2) writes: state the path and proceed; ask about it only when it is genuinely unclear. A
prompt change must cut the obvious questions without making the lead ask less when it is unsure.

### 5. The design approval card carries a one-line summary; the design itself is only in the lead's terminal (observed, medium)

At 09:39 the lead wrote about 60 lines of design (layout, 12 pure models, a 7-task plan shape) as
assistant prose, then asked "Section 1 (...). Approve?" three times through AskUserQuestion. Each
question compresses its section to one line. The prompt routes every question through AskUserQuestion
because plain text "does not reach the cockpit". The flip side is that the design the human is approving
doesn't reach the cockpit either. Someone answering from the attention list or the ask card approves
"Section 2 (pure models: paneHeaderLayout, changePosition, …). Approve?" without having read what those
are.

Direction: have the lead write the design to a file first (it already writes a spec file later) and put
the path in the question, which is what the `Spec review` gate already does, or let an ask carry a
markdown body that the cockpit renders.

### 6. The human approves the design twice (observed, low)

The brainstorming skill asks for section-by-section approval (finding 5), and the lead prompt then
requires a separate `Spec review` approval of the spec file written from those same sections. For a goal
that arrives already specified (a mockup plus a defect list here), that is two approval stops on the
same content before any worker starts. Pick one: skip the section approvals when a spec review follows,
or skip the spec review when every section was approved and nothing changed.

Human's position (as in finding 4): questions when unsure are welcome. What's redundant here is approving
identical content twice, not asking. The fix spec from run 18d08579 (section 4.2) keeps the decision
questions and drops only the section approvals, which fits that position.

Positive: the plan shape isolates every edit to the shared shell file (`filessurface.tsx`) in one final
task. Five tasks can then run at once without merge conflicts on that file. That is exactly what the
prompt's "split by what can proceed independently" asks for.

### 7. Nothing independent reviews the spec or the plan, and no human sees the plan (read, high)

- **Spec:** only the lead reviews it, in the same context that wrote it (brainstorming's "Spec
  Self-Review": placeholders, consistency, scope, ambiguity). The human then sees it at the
  `Spec review` gate.
- **Plan:** the lead self-reviews it (writing-plans "Self-Review": spec coverage, placeholders, type
  consistency, Review Focus), then `leadprompt.go:34` says to `dag submit` and stop. No human sees it.
  `DagSubmitCommand` (`pkg/wshrpc/wshserver/wshserver_dag.go:142`) validates only structure: parse,
  depends, route and harness resolution, effort.
- The first independent eyes are the per-task reviewer (`pkg/orchestrate/review.go`), after a worker has
  already spent its time. A plan-level defect costs a full lane before anyone can catch it: a missing
  requirement, a wrong split, two tasks editing one file, or an interface name that differs between
  tasks.
- Instruction conflict: writing-plans' Execution Handoff tells the lead to ask the human to review the
  plan, and the lead prompt says submit and stop. Which one wins is up to the model (to be observed).

Direction: one fresh-context reviewer (cheap model, reads spec, plan and the named files) between the
lead's self-review and `dag submit`, whose findings go to the lead. Alternatively, make `dag submit`
open a plan-review ask in the cockpit that carries the plan path. Either one also resolves the
instruction conflict.

### 8. The spec and plan exist only as untracked files in the main checkout (observed, low, watch)

The lead is told not to commit the spec or plan, so at submit both are untracked files in the main
checkout, and the task worktrees (branched from `main`) do not contain them. The engine passes workers
and reviewers absolute paths (`engine.go:661-663`, `review.go:409-413`), so they can read them. But:

- The plan's own text points at the spec by a **relative** path ("read it first:
  `docs/superpowers/specs/...`"). A worker that resolves that inside its worktree finds nothing.
  **Happened at 09:56:02:** t-4's worker ran `grep -n "" docs/superpowers/specs/2026-09-25-...` in its lane
  tree and got `No such file or directory`. It recovered 2 s later by `cd`-ing to the main checkout. The
  spec had already landed on `main` in t-5's merge, but t-4's lane branched before that.
- Workers read a file that is still live in someone else's checkout. An edit by the lead (or anyone)
  mid-run changes the spec under running workers, with no record of which version a task was built
  against.
- Correction, after the first merge: the engine does commit them. `laneFold` (`pkg/orchestrate/lane.go:111`)
  stages the spec and plan into the DAG's **first** squash commit. Here that was t-5's
  `134a5fc7 feat(diff): filter the source picker…`, which now carries a 976-line plan and a 193-line spec
  under a source-picker subject. Whichever task merges first gets them, so it varies from run to run.
  This matches AGENTS.md's "fold into the feature commit" in letter, not intent.
- **The lead isn't told the engine does this.** Its brief says "Don't commit the spec or plan", and
  nothing says the engine will. At wrap-up (10:16) the lead reported "A worker committed the spec and plan
  inside t-5's commit, even though the brief said not to" and raised it with the human as a deviation.
  That wrongly blames a worker, and it costs a human decision on a designed behavior. One clause in
  `leadprompt.go:34` ("the engine commits them with the first task that lands") prevents it.

Direction: have `dag submit` snapshot the spec and plan (copy them into the run's state, or commit them on
a run branch that every worktree starts from) so workers read a fixed version from inside their tree.

### 9. The project branch moved mid-run and another session is editing the orchestrator in the same checkout (observed, watch)

The run recorded base `6dd1600`. By submit time `main` was at `93f0c5e9` (another session's
`feat(jarvis)` commit), and the task worktrees branched from `93f0c5e9`. That's fine, and arguably
right, but `db_run.basecommit` no longer describes what the tasks were built on. The main checkout also
has uncommitted edits to `pkg/orchestrate/review.go` and `review_test.go` from another session, while
this run's engine is running from the installed binary. The squash-merges land in this checkout (see
finding 2).

### 10. Workers edit files through 10 KB Python-in-bash heredocs, and the shell sometimes can't parse them (observed, low)

Four of five workers used the standard Edit tool little or not at all. Instead they wrote
`python - <<'EOF' ... rep('''old''','''new''') ... EOF` scripts through Bash, some over 11,000 characters
(t-2: 3 such edits, t-3: 4, t-6: 2). Two of them (t-2 at ~09:50, t-3 at ~09:51) died with
`bash: -c: line 1xx: unexpected EOF while looking for matching '` and had to be regenerated in full,
which costs a whole script's output tokens per failure. The Edit tool was available (t-1 and t-6 used it).

A third one hit t-4 at ~09:58 (7.3 KB script). **Root cause is not the scripts:** all three failing
commands, extracted verbatim from the transcripts, pass `bash -n` (Git Bash). The delimiter line is
present and the heredoc is quoted (`<<'EOF'`). The failure is introduced between the model's tool call
and bash, most likely in how the Claude Code Bash tool on Windows wraps or quotes a long multi-line
command containing `'''`. That makes it a harness bug, not something the engine can fix.

Narrowed further (4 failures: t-2, t-3, t-4, t-7):
- **Size:** every failing heredoc command is ≥ 7,451 bytes. Every one of the 15 successful heredoc commands
  across the workers is ≤ 6,753 bytes, including one with 50 `'''` and non-ASCII text. So it's size-related,
  not about content.
- **Not a fixed truncation:** the line bash reports (which is where its input ended) falls at 5.6–7.5 K
  characters, and no escaping model tried (`"`/`\\` escaping, `'`→`'\''`, `'`→`'"'"'`) lines those up at a
  common limit.
- **The tool rewrites command text:** in this observing session, a quoted heredoc containing the regex
  `/["\\]/` reached node as `/["\]/` (one backslash dropped), which bash never does inside `<<'EOF'`.
  Writing this very paragraph through a shell heredoc dropped the same backslashes again; it was fixed
  with the Edit tool.

The workers that recovered did so by writing the script to a temp file (t-4: `$TEMP/t4_column.py`), which
is the practical workaround.

The model's choice to script edits is still the trigger. The worker brief is the one place that
could steer it. Direction: one line in the worker prompt ("edit with the Edit tool; don't script
multi-kilobyte replacements through the shell"). Measure the error rate before and after.

### 11. A UI task's reviewer only reads the diff; no one looks at the rendered UI until the end, if at all (observed, medium)

The t-5 reviewer (Opus, 33 s) ran `git diff`, checked that the color tokens exist in
`tailwindsetup.css`, grepped the spec's Deviations, and passed. Its brief says "don't run the full
suite; run a focused test only to settle a doubt", and nothing asks it to render anything. For t-5,
Step 3 ("Component"), a restyled popover with a filter field, is the part a diff read judges least well.
The only visual check in the plan is Task 7's CDP scenario, after every UI task has merged. A layout
regression from any of t-2..t-6 surfaces only there, attributed to the wrong task. That is the
defect class that prompted this goal in the first place: header overflow at 1600 px.

Direction: when a task's files include `.tsx`, have the reviewer (or the worker, before `complete`)
render the relevant mockup board next to a screenshot of the running component. Or have the
plan give each UI task its own `verify:ui` scenario, not only the last one.

**It got worse at the end.** t-7's Step 7 runs `task verify:ui` and screenshots only "if the dev app is
available (`curl -s localhost:9222/json` answers)". At 10:10 nothing answered on 9222 or 9223; only the
packaged Arc was running. So the plan's single rendered check was skipped, and the whole run lands
with **zero** visual verification of a purely visual goal. The condition has a second, quieter hole: a
dev app on 9222 started from the main checkout serves `main`'s files, not t-7's worktree. The step would
then "pass" against code that doesn't include the task being verified.

Direction: the engine, not the plan, should own UI verification. Start a dev app per verifying tree
(a worktree dev app on its own CDP port and WebView2 profile, per AGENTS.md), or run the CDP scenarios
after the final merge against a dev app started from the landed tree. Report "not verified" as a
first-class run outcome rather than a sentence in a completion report.

### 12. Landing in the checkout leaves `main` visibly broken between merges, and a CLI launch can't choose otherwise (observed, medium)

This project's profile lands engine runs in the project checkout. Each task squash-merges into `main` as
soon as it passes review and Verify. The plan, sensibly, gave every `filessurface.tsx` edit to the last
task (t-7), so the middle tasks change components whose wiring hasn't been updated yet. After t-3 merged
at 10:00:32, `HistoryPane` renders the filter row itself while `filessurface.tsx:546` still renders the
old one, so `main` shows **two filter rows** until t-7 lands. The t-3 reviewer spotted exactly this and
passed it on to t-7 as a note. Verify (vitest plus a Go package) passes throughout, because nothing
renders. Anyone running the dev app from `main`, or starting another agent from it, sees a
half-migrated surface for the rest of the run.

Evidence: the `task-review-passed` downstream note for t-3 at 10:00:30. Landing is chosen by
`resolved.Landing` from the project profile (`pkg/wshrpc/wshserver/wshserver_runs.go:397`); `landRunOnBranch`
(`:278`) is the alternative, landing on `wave/<runId>` for the human to merge. `wsh runs start` has no
flag for it.

Direction: add `--landing branch|checkout` to `wsh runs start` (and the launcher). Also consider having
the lead or the engine pick branch landing when the plan's DAG ends in an integration task that depends
on most of the others, which is the shape that guarantees broken intermediate states.

**Chosen direction (after run 18d08579): runs land on their own branch in their own worktree by
default.** Run 18d08579's t-5 (`a7bf040a`, "land engine runs on their own branch by default") already
makes an empty landing mean branch. The lead moves with it: it runs in `LandPath(run)`
(`pkg/jarvis/profile.go:118`), so a branch-landed run puts it in the `wave/<runId>` tree, not `main`. Checkout
landing stays as an explicit `--landing checkout` for small runs the human wants to watch land live.

Why, from run 18d08579, which landed in the checkout:
- The t-2/t-4 merge conflict left `main`'s working tree with conflict markers for 59 s while another
  session was active in the same checkout (findings 2, 12).
- Each 3–7 min Verify runs in the tree other sessions edit, so it is also a window for their half-saved
  files to fail it (finding 23).
- The lead committed its test fix `30dd2544` straight to `main`, outside the engine's merge.
- `main` was half-changed between merges: branch landing by default with no land-back until Task 13
  lands.
- Evidence attribution needs a trailer filter (t-8) only because a checkout-landed run's commits
  interleave with other sessions'. That filter caused this run's Verify failure. On its own branch,
  `BaseCommit..EndCommit` is the run's own history (finding 18).
- The spec and plan sat untracked in `main` until the first merge (finding 8); t-7 now commits them to
  the run's branch at submit.

What it costs, and what has to be in place:
- All of `main`'s divergence meets the run at one land-back merge. `main` moved three times during this
  run from other sessions. Land-back (Task 13) needs the plan's Verify, or the Final stage, run on the
  merged result before `main` moves.
- The Final stage runs the dev app from the run's tree, which needs its own Vite port
  (see the "Proposal corrected" row in the re-validation), or it fails whenever a dev app is already running.
- The human sees nothing in `main` until land-back. That is the intent, but a long run gets no early look.

### 13. A multi-task lane lands as one commit titled and trailered by its first task (observed, low)

t-1 (Go merge-base time, 5 files) and t-4 (compare column, 7 files) share a lane, so they landed as one
squash commit, `42659f9d feat(git): report when the compared refs split`. t-4's own subject is kept, but
only as a paragraph in the body. The trailer is `Arc-Run: b2d7fab1-…-t-1`, because `mergeMessage`
(`pkg/orchestrate/merge.go:148`) names the lane by its worktree key, which is its first task. So
`git log --oneline` shows a Go-only subject for a commit that is mostly frontend compare UI, and
`git log --grep t-4` finds nothing.

The trailer is also how a retried merge recognizes its own commit (`merge.go:184`), so it can't simply be
renamed. Direction: keep the lane-key trailer and add one `Arc-Task: t-N` line per task landed. When a
lane holds more than one task, either use the plan's task titles as the subject (`laneMergeMessage`
already builds that string and uses it only as a fallback) or land each task as its own commit.

### 14. The worker's report is lost in 7 of 7 tasks: the summary is sealed from the line before `complete` (observed, high)

The worker brief (`pkg/orchestrate/engine.go` ~670) says "the lead reads your final message: end with what
you did, anything you did differently from the task and why, and anything a later task must know", and
then "Commit, then `wsh jarvis complete --commit …`". Workers do exactly that, in that order: they call
`complete`, then write the report. The evidence summary is sealed at `complete` from the session's
**last chat line so far**, so the report written afterwards never reaches the run.

Every worker's sealed `db_run.evidence.summary` in this run:

| Task | Sealed summary |
|---|---|
| t-1 | "tsc clean (exit 0). Quick compile check of the wshrpc packages, then commit." |
| t-2 | "Tests (1782) and tsc both clean. Quick self-review of the diff, then commit." |
| t-3 | "Clean. Committing, then reporting completion." |
| t-4 | "One fix: the chip's `aria-label` would hide the ref names from screen readers, so I'll use a `title` instead." |
| t-5 | "Tests, tsc and prettier are all clean. Committing." |
| t-6 | "One stray blank line was left inside the Jarvis table; removing it." |
| t-7 | "Everything is clean, so I'm committing and reporting completion." |

This matters because the summary is what the reviewer is handed as "The worker reported: …"
(`pkg/orchestrate/review.go:444`), and what the lead's digest and final report draw on. t-7's real final
message said "I didn't run the CDP scenarios or take the screenshots: no dev app was running … that
verification still needs doing." Its reviewer got "Everything is clean, so I'm committing and reporting
completion." The one honest statement that the goal went unverified reached neither the reviewer nor
the run record.

`wsh jarvis complete` already has `--report <file>` ("sealed as the run's evidence summary"). The brief
just never mentions it.

Direction: tell workers to write the report to a file and pass `--report`, and make `complete` refuse a
worker completion without it (it's one sentence in the brief plus one check). Alternatively, seal the
summary from the transcript's final assistant message at session exit, not at `complete`. Reviewer
sessions show the same pattern (their sealed summaries are pre-verdict lines), but their real content
goes through `review pass|fail "<note>"`, so nothing is lost there.

### 15. The lead's wake-up digest truncates each reviewer note, and the cut removed the only "unverified" signal left (observed, high)

After finding 14, the one remaining trace of "the UI was never checked" was the last sentence of t-7's
review note: "The worker's report does not show the verify:ui table or the screenshot comparison from
Step 7." The lead's `run finished` wake (10:13:15, 7.5 KB) lists every task's review note, each
truncated with `...` at a fixed length, and t-7's is cut before that sentence. In its first four tool
calls after waking (`dag status | head -150`, git log, spec/plan check, a comment fix), nothing the lead
read mentions verify:ui, screenshots or CDP not having run.

So the one honest fact about this run's verification was dropped twice: once when the worker's summary
was sealed before its report (14), and once when the reviewer's note was truncated for the wake.
Truncation keeps the start of a note, which is the "what landed" recap, and drops the end, which is
where reviewers put caveats.

Partly offset: the lead recovered the fact on its own. Its report (`.superpowers/reports/diff-polish-run-b2d7fab1.md`)
lists "No CDP run: the dev app was not up" under Unverified, and it asked the human how to handle the live check,
presumably because it probed `:9222` itself. So the gap was caught by the lead's own diligence, not by
the engine's channels. The same report repeats the reviewer's loose "icon Fetch (f)", although the landed
button is labelled ("Fetch" plus an icon), which shows the lead trusts the truncated notes over the code.

Direction: give review verdicts a structured field for caveats (`review pass --unverified "<what>"` or
`--caveat`), and have the wake message print caveats in full, never truncated, with the recap
secondary. At minimum, truncate from the middle and keep the last sentence.

Worker hand-offs have the same problem (seen in run 18d08579; see the re-validation rows for 14 and 15).
The worker brief asks for "anything a later task must know" (`engine.go:670`), but the only way it reaches a
later task is the reviewer's downstream note. t-2's reviewer received the report cut at 600 characters and
passed with `downstream: ""`, so two of t-2's three hand-off items were dropped. Removing the cut isn't
enough: delivery still depends on the reviewer choosing to copy items forward.

Direction, agreed in discussion: the engine delivers; the lead stays out of it.

- The worker decides what to hand off, as structured flags on `complete`:
  `--handoff "t-10: <text>"`, repeatable, and `--handoff "lead: <text>"` for items that aren't about one task.
  The CLI refuses a task ID not in the DAG, so a typo fails loudly at `complete`.
- The reviewer checks the items: they are in its brief, and a wrong one is a reason to fail or to add its
  own downstream note. It is no longer the courier.
- The engine delivers each item after the review passes, through the two existing paths: amend a task
  that hasn't started, tell a running one (`task-lead-told`). An item for a finished task goes to the
  lead. Only the final attempt's items count, so a rejected attempt never misleads a dependent.
- Not the lead: it has been `/compact`ed since submit, and each hand-off would cost it a wake and tokens
  for a decision the worker already made.
- A flag, not parsing a heading in the report: headings drift, and a parser that misses fails silently,
  which is the defect being fixed.

### 16. The plan's Check (typecheck) never runs on the merged result (observed, low)

The plan's **Check** (`tsc --noEmit`) runs only inside each worker's tree before `complete`. **Verify**,
which the engine runs after every merge, is `npx vitest run && go test ./pkg/gitinfo/`, and vitest does
not typecheck. Seven branches, several touching the same props (t-2, t-4 and t-7 all meet in
`filessurface.tsx`), were combined on `main` and nothing typechecked the combination. The lead's report
says "tsc --noEmit clean per t-1, t-2, t-5, t-7 workers", which is true only of each tree on its own.

It happened to be fine: I ran tsc on `main` at `e7609818` after the run, exit 0 in 53 s. The gap is
structural, though. Direction: have the engine run Check once after the last merge (the lane is
already serialized there), or have `dag submit` warn when Verify contains no static check and Check is set.

### 17. At wrap-up the lead waits for a go-ahead in plain text, which its brief says never reaches the cockpit (observed, medium)

At 10:21 the lead ended a status summary with "I haven't run `wsh jarvis complete` yet; I'll run it once
you say so." That's a question to the human, in plain text. The lead prompt says "Put every question and
every approval through AskUserQuestion, never plain text, which does not reach the cockpit". The rule held
all through brainstorming and broke at the end, when the lead was idle with a 15-minute background wait
running. From the cockpit, the run shows `executing` with nothing in `wsh runs attention`, so it looks busy
while it's actually blocked on a human who can't see the question.

Direction (agreed with the human, 2026-09-25): **the lead completes on its own and asks only when there is a
decision to make.** Completing is low-risk: every task is already on the project branch, and a report can
still be attached after completion (`AttachReport`, `pkg/jarvis/run.go`). Asking permission for a step that
has nothing left to decide is ceremony, and in this run it was harmful because the question sat in plain text.

- **Complete without asking** when every task landed, the final verification ran and passed (see the
  proposal below), and the report is written.
- **Ask, through AskUserQuestion,** only when a verification failed, a deviation needs the human's call,
  or a fix round is proposed.
- **"Not verified" never blocks completion.** The run completes with a visible *unverified* status and
  an attention item naming what wasn't checked and why (for example: no dev app, the checkout was broken
  by another session, or a board has no scenario). The gap stays visible without holding the run open.
- Encode this in the wrap-up rule in `leadprompt.go:59` rather than leaving the ending to the model. As a
  backstop, the engine could raise an attention item when a lead has been idle for more than N minutes
  after `dag-done` without calling `complete`.

### 18. The run's sealed evidence counts other sessions' commits as its own (observed, medium)

At completion the run sealed `commits 6dd1600..16b08a8`: 61 files, +2299 −983. That range is simply
base..HEAD of the shared `main`. Three of its commits belong to other sessions that committed to the same
checkout during the run:

| Commit | Author session | Size |
|---|---|---|
| `93f0c5e9 feat(jarvis): quiet the Brief header…` | other session, before submit | 11 files, +135 −175 |
| `83e3742d fix(orchestrate): refuse over-long review notes…` | other session, mid-run | 2 files, +21 −4 |
| `16b08a8e feat(cockpit): calm the run card…` | other session, during wrap-up | 3 files, +410 −234 |

That's 16 files, about a quarter of the "61 files" credited to this run, and none of it is the run's work.
Anything downstream that trusts `evidence` (the run card, `wsh runs show`, cost-per-change, Radar or memory
records of what a run shipped) is inflated and names files the run never touched. The same base..HEAD view
is why `db_run.basecommit` didn't match the tree the tasks were built on (finding 9).

Direction: build the evidence from the run's own commits (the `Arc-Run:` trailers on the squash commits,
plus the lead's direct commits made from its session), not from a base..HEAD range on a shared branch.
Branch landing (finding 12) avoids it by construction.

### 19. Nothing reports what a run cost: not the report, not `wsh runs show`, not the run card (observed, medium)

The DAG report gives elapsed time and worker time (`elapsed=24m55s workers=43m49s`) but no tokens or money,
and the lead's report has none either. Arc already has both halves: `pkg/usagestats` scans transcripts
for per-message usage, and `frontend/app/view/agents/usagepricing.ts` is the single price table. Nothing
connects them to a run's own sessions.

Measured after the run from the 15 session transcripts (lead, 7 workers, 7 reviewers; usage deduped per
message id), priced with Arc's `opus` row ($5 input / $25 output / $0.50 cache read / $10 1-hour cache
write per 1M tokens):

| Role | Sessions | API calls | Tokens | Est. cost |
|---|---|---|---|---|
| Lead | 1 | 88 | 10.2M | $9.79 (31%) |
| Workers | 7 | 168 | 15.3M | $16.29 (51%) |
| Reviewers | 7 | 59 | 3.9M | $5.88 (18%) |
| **Total** | 15 | 315 | **29.3M** | **$31.96** |

- By component: cache reads 27.9M (about $13.90), cache writes 1.22M, all at the 1-hour rate (about $12.20),
  output 0.23M (about $5.80), uncached input about 0.
- Every cache write was billed at the 1-hour rate, which is 2x the base input price, including worker and
  reviewer sessions that lived only 1–10 minutes. Whether the TTL can be chosen per session wasn't checked;
  if it can, 5-minute writes would save about $4.60 (about 14%) on this run.
- Priciest tasks: t-3 (worker $4.11 + reviewer $1.04) and t-7 ($3.51 + $1.24). The lead's 31% share is
  mostly context carried forward: it read six full-size mockup renders while brainstorming.
- Not included: the lead's `/compact` summarization call, if the transcript doesn't record it, and the
  observing session.

Direction: at `dag-done`, total tokens per role and per task from the run's session transcripts (the
engine already resolves them via `TranscriptForSession`) and put them in the DAG report and `wsh runs show`.
Keep pricing in the frontend's single table: store token classes, not dollars. The lead's report then
quotes them, and the run card shows them.

### 20. Parallel tasks spawn one after another, and the timeline stamps them all at the end of the batch (observed in run 18d08579, read, low)

At 10:52:31 the lead submitted a 15-task plan with 7 ready tasks; parallelism 5 spawned t-1 to t-5. All
five `task-spawned` events carry 10:53:05. But `task-first-activity` for t-1 came at 10:53:07 with
`sincespawnms` 29092, so t-1 was spawned at about 10:52:38. The events' own fields add up to the gap:
worktree + Setup + spawn is 3.1 s (t-1), 3.9, 4.2, 5.6 and 6.7 s (t-5), 23.4 s in all.

Read: the schedule loop (`pkg/orchestrate/engine.go`, around :520–556) creates the worktree, runs Setup and
spawns the worker for each task in turn, and queues each `task-spawned` event in `afterCommit`, so every
event is written when the whole batch is done. Two effects:

- The fifth worker starts about 20 s after the first (3.1 s into the batch vs. 23.4 s). With `task worktree:prepare` as Setup (0.5–2.2 s)
  that is minor; a heavier Setup multiplies by the batch size.
- The event log can't show it. The b2d7fab1 timeline row "09:48:46 t-1, t-2, t-3, t-5, t-6 spawned
  together" read those batch-end stamps, so "together" is not evidence of concurrency.

Direction: stamp each `task-spawned` with the task's own spawn time, carried in the event data if the write
must stay after commit. Creating worktrees and running Setup concurrently is worth it only if Setup grows.

### 21. The sealed "verify pass" lines are any command that looks like a check and didn't error (observed in run 18d08579, read, medium)

`wsh runs show` for t-5's child run (`20a90a46`, 11:02) lists four `verify pass` lines. What they are:

- `go test ./pkg/jarvis/ -run EffectiveLanding 2>&1 | tail -3; go test … | tail -3`
- `git diff frontend/types/gotypes.d.ts && go test … 2>&1 | tail -30`
- `grep -rn "landing" frontend --include=*.ts … | grep -iv "^.*test" | head -20; grep -rln … --include=*.go …`, a
  search.
- `sed -i '599s/…/' pkg/waveobj/wtype.go && sed -i … && task generate … && go build ./... && go vet … && tsc …`,
  an edit followed by the Check.

Read: `isVerifCommand` (`pkg/jarvis/evidence.go:43`) accepts any command that has a verification word
(`test`, `build`, `tsc`, …) and a runner token (`go`, `npx`, …) anywhere. The grep qualifies through
`test` in its pattern and `go` in `--include=*.go`. `classifyVerif` (`:49`) then calls it `pass` when the
tool result isn't an error and has output. Two consequences:

- A search or an edit is reported as a passing verification.
- A pipe hides the exit code: `go test … | tail -3` exits with `tail`'s status, so a failing test would
  also read `pass`. Every `go test` line above is piped.

The human reads these lines as proof. The engine's own Verify runs (`dagVerifs`, `:343`) are real exit codes;
only the worker-transcript ones are heuristic.

Direction: in the sealed report, label the transcript-derived lines as what the worker ran, not as a
verdict, or keep only the engine's Verify and Check results as `pass`/`fail`. The worker brief could also
say to run checks without piping to `tail`/`head`, or with `set -o pipefail`.

### 23. Verify after every merge holds the merge queue, and here it takes about 7 minutes (observed in run 18d08579, medium)

The plan's Verify is the full Go suite for five package trees plus `npx vitest run`. Before submitting, the
lead timed it: go 309 s, vitest 34 s, 343 s in all. It still made that the per-merge Verify. The engine
runs Verify in the project checkout after each merge, and the next merge waits for it (`startVerify`,
`pkg/orchestrate/verify.go:79`; the `TaskState_Verifying` gate in `mergetask.go:359`).

Observed: t-5 merged at 11:04:24 and its Verify ran from 11:04:25 to 11:11:15 (`ms` 409848, 6 min 50 s,
slower than the lead's idle measurement because five workers were building and testing at the same time).
Meanwhile t-3 passed review at 11:08:45 and t-1 at 11:10:38. t-1 merged at 11:11:15, the moment Verify
passed, ahead of t-3 even though t-3 was reviewed first: `AutoMergeReady` (`mergetask.go:354`) takes the
ready tasks in plan order. At about 7 min per merge, 15 tasks spend about 100 min in serialized Verify. In b2d7fab1, Verify
was 38–60 s, so this didn't show.

It also starves dispatch. A dependency in another lane is satisfied only when it has landed (`depSatisfied` →
`laneLanded`, `scheduler.go:50`, `lane.go:78`): `Done` and `Merged`, and a task sits in `verifying`, not
`Done`, until its Verify passes. At 11:21, `dag status` showed 0 of 5 worker slots in use and 8 tasks pending,
while t-4, t-6 and t-14 had passed review and waited to merge behind t-2's Verify. t-7 (depends on t-1, t-2)
can't start until t-2's Verify passes; t-8 (depends on t-4) until t-4 merges and verifies, about 5 min after
that. So in the plan's second half, throughput is one task per Verify, whatever the parallelism.

Three more costs:
- A flaky test in the full suite can fail a merge. t-2's reviewer found `TestWatchdogTickDetectsStallInAwaitingReviewDag` fails in the `Review|Digest` set on the base commit too, and passes alone: it depends on test order. It's inside this plan's Verify (`./pkg/orchestrate/...`).
- Verify runs in the shared checkout, where other sessions edit (finding 2, 9), so a 7-minute test window
  is also a 7-minute window for someone else's half-saved file to fail it.
- The lead had the number and nothing told it what a per-merge Verify should cost.

Direction:
- Prompt and `PlanFormat`: Verify is the quick integration check run after every merge (aim for about a
  minute: build plus the packages the plan touches). The full suite belongs to Check (per worker, in
  parallel) and the final stage's Check on the merged result (finding 16, spec section 3.2).
- Engine, if needed later: merge every task that is ready, then run one Verify for the batch, and bisect
  only when it fails.

### 24. A worker can land outside its run in the Agent tree for good (observed in run 18d08579, cause inferred, low)

Observed by the human at about 11:30: t-7's worker sits outside the orchestrator's run in the Agent tree;
t-8, spawned 4 minutes later, nests. The store has the same data for both: each child run
(`49ea3880`, `f5d7882b`) has `dagoref` and `taskid`; the dag points each task at its run; each tab has
`jarvis:runoref` and each terminal block has `agent:runid` and `agent:taskid`. So the frontend is holding
a stale object.

The tree nests a tab when `runRoleOf` (`runlineage.ts:40`) finds its run through the run atom
(`runlineagestore.ts:80`), then the run's dag. The dispatch spawns the worker before it saves the run:
`SpawnRunWorker` flushes the new tab to the app when it returns (`runexec.go:199`), and only after that
does `appendChildRun` (`engine.go:549`) write the run row. The run's WOS update goes out later, after the
tick commits (`publishSpawnedRunUpdates`, `engine.go:616`). A frontend that fetches the run in that
window gets `null` (`DBGetORef` returns nil for a missing row), which WOS caches as a successful load.
The later update should repair it. But `updateWaveObject` (`wos.ts:291`) doesn't clear the in-flight
fetch's `pendingPromise`, so a `null` fetch that resolves after the update overwrites it
(`createWaveValueObject`, `wos.ts:180`). Nothing refetches after that, so the tab stays a plain agent
until the app reloads. This is the one code path found that fits identical store data. It is not
confirmed: the packaged app has no CDP and no frontend log to show the atom's history.

The block meta path is sound: `agent:runid` and `agent:taskid` are written before the controller starts
and before the tab is flushed (`runexec.go:107`).

Direction:
- Engine: save the child run before spawning its tab, and delete it if the spawn fails. Then the tab never
  names a run that isn't there yet.
- WOS: a pushed update wins over an older in-flight fetch. Clear `pendingPromise` in `updateWaveObject`
  so the late fetch is dropped. This is the general fix; any object created just after its referrer
  reaches the app can hit it.
- A check for the human: reloading the Arc window should nest t-7. That confirms the cause is a stale cache,
  not store data.

### 25. A failed Verify doesn't say which test failed (observed in run 18d08579, medium)

t-8 merged at 11:37:24 (`956e4fca`), and its Verify failed at 11:40:30: `FAIL github.com/.../pkg/wshrpc/wshserver`.
What the engine kept doesn't name the test:
- The task's `VerifyOutput` is the last `MaxPlanOutputLen` (8000) bytes (`plancmd.go:27`). For a failing
  package, `go test` prints the package's whole log. The wshserver tests log a lot (`CreateRun: capturing
  dossier failed`, `stamp worker tab:w-pi: bad worker oref`, over and over), so all 8000 bytes are that
  noise plus the final `FAIL` summary. The `--- FAIL: TestX` line and its assertion message are cut off.
- The event and wake detail is 200 characters (`MaxFailureDetailLen`, `retry.go:27`), starting at the first line
  that begins with a failure marker (`firstFailureExcerpt`, `plancmd.go:60`). In the kept tail, that is the
  bare `FAIL` line. So the lead is told `exit 1: FAIL / FAIL .../pkg/wshrpc/wshserver 26.299s`.

To learn what broke, the lead has to rerun the package in the shared checkout. That is the checkout
the merge queue waits on (finding 23), and other sessions edit it too (findings 2, 9).

Direction: keep the lines that name the failure, not the tail. For Go, scan the full output for
`--- FAIL:` and `panic:` blocks and keep them, plus the per-package `FAIL` summary. Make the marker match
prefer `--- FAIL` over a bare `FAIL`. Or run Verify with `go test -json`, or with the output going to a
file whose path goes in the wake, so nothing has to be cut.

### 27. Where a run's time goes, and what would make it faster (measured in run 18d08579 to 12:08, medium)

Measured from `db_runevent` (`runspeed.js`: each task's spawn, worker done, review, merge and Verify) and
the worker and reviewer transcripts (`toolspend.js`, `slowcmds.js`: time from each tool call to its
result). The run started at 10:33:20; the first workers spawned at 10:53:05. By 12:08, 75 min later,
9 tasks had run.

| Task | Work | Review | Waited to merge | Verify | Build/test share of work |
|---|---|---|---|---|---|
| t-1 | 15.6 | 1.8 | 0.6 | 4.7 | 11.5 of 16.3 |
| t-2 | 23.0 | 3.1 | 0.6 | 2.8 | 15.9 of 23.6 |
| t-3 | 13.9 | 1.4 | 7.2 | 4.1 | 8.6 of 14.4 |
| t-4 | 21.9 | 2.8 | 4.8 (+ conflict) | 3.3 | 11.2 of 22.2 |
| t-5 | 9.5 | 1.2 | 0.3 | 6.8 | 6.3 of 9.6 |
| t-6 | 14.4 | 2.1 | 6.3 | 4.1 | 11.3 of 14.5 |
| t-7 | 19.0 | 2.4 | 1.1 | 3.3 | 9.8 of 19.2 |
| t-8 | 8.3 | 1.1 | 0.3 | 2.8 (+ 3.1 failed) | 5.1 of 8.4 |
| t-14 | 4.9 | 0.8 | 16.7 | 2.9 | 2.6 of 5.0 |

(minutes; the wait from worker done to review start was 0.1–0.5 min throughout)

Where the time went, largest first:

1. **Workers' own builds and tests: 88 of 149 worker-minutes (59%).** Model time was 2–8 min per task;
   the rest was mostly `go test` (82 min over all sessions) and `tsc.js` (27 min, about 2 min per run).
   Single commands took 4–9 min: t-1's `go test ./pkg/orchestrate/... ./pkg/wshrpc/...` 537 s, t-6's
   test+build+vet+tsc chain 498 s, t-4's four-package `go test` 460 s. Workers run whole package trees,
   often more than once, and up to five at a time on one machine, plus the engine's Verify. The lead
   measured its Verify set at 343 s on an idle machine; t-5's per-merge Verify of the same set took 410 s
   while five workers ran. How much of each command is CPU contention is unmeasured.
   (Caveat: a tool call's time runs from the logged tool call to its result, so a command with a long
   input, such as a 10 KB heredoc, also counts the time to generate it. Build and test commands are short.)
2. **Every link of a dependency chain waits for its dependency to land.** A dependent starts only when
   its dependency is `Done` and `Merged`, after its Verify (`depSatisfied` → `laneLanded`). t-2's worker
   finished at 11:16 and t-7 started at 11:23:00; t-7 finished at 11:41:58 and t-9 started at 11:49:22.
   That is about 7 min per link beyond the work (review 2–3, merge queue, Verify 3–4). The plan's second half
   is a chain of six links (t-2 → t-7 → t-9 → t-10 → t-11, t-12, t-13 → t-15), so about 40 min of the run is
   this overhead.
3. **Worker slots sit idle.** On average 2.0 of 5 slots were in use; for 12 of the 75 min no worker ran at all,
   each time waiting on a Verify.
4. **The merge queue goes in plan order.** t-14 waited 16.7 min to merge, t-3 7.2, t-6 6.3, t-4 4.8. The
   order only costs time when a pending task waits on the queued one: t-4's wait delayed t-8 and t-9.
   `AutoMergeReady` (`mergetask.go:354`) takes ready tasks in plan order, not by what they unblock.
5. **Per-merge Verify runs the full suite, serialized: 35 min so far** (finding 23).
6. **20 min before any worker ran** (10:33 → 10:53): brainstorming, the lead's one-question asks and the human's answers,
   the spec and plan. Not broken down further here.

Directions, by expected saving:
- **Cheaper worker checks.** The brief or plan tells workers to run the tests of the packages they touched,
  filtered with `-run` while iterating, and the plan's full Verify set once before `complete`. Make `tsc`
  incremental (`--incremental` with a `.tsbuildinfo` per worktree), since workers typecheck 1–3 times each.
  Measure first: one Verify-set run on an idle machine against the same run beside four workers gives the
  contention factor. That shows whether the fix is fewer checks or fewer concurrent ones.
- **Start dependents earlier.** Satisfy a dependency when it merges, not when its Verify passes, and let the
  dependent start while Verify runs. A failed Verify then blocks the dependent's merge, not its start. That saves
  3–4 min per link, about 20 min on this plan. Further: start a dependent from the dependency's reviewed branch
  (a stacked base) as soon as review passes. That saves the merge wait too, at the cost of rebasing when the
  dependency changes.
- **Merge what unblocks work first.** Order `AutoMergeReady` by the number of pending tasks waiting on a
  task, then plan order.
- **Quick per-merge Verify** (finding 23). About 1 min instead of 3–7 would save most of the 35 min.
- **Plan shape.** The plan review (spec 4.1, t-9 of this run) could report the plan's critical path, as
  tasks and a rough time, so a six-link chain gets split before it runs.

**Lower worker effort: considered at 12:56, not the first lever.** The human asked whether a setting
should lower the workers' effort, since runs take long. There is none today. Workers inherit the user's
default Claude Code effort, and `wsh runs --effort` means an initiative, not reasoning effort. The 12
worker sessions to 12:56 break down as follows:

| | worker-min | share |
|---|---|---|
| build/test commands | 105 | 57% |
| model (thinking and writing code) | 60 | 32% |
| other tools | ~20 | 11% |

- Lower effort cuts at most part of the 32%, and it shortens wall time only on the critical path. The one
  task where model time dominated was t-10 (14.8 of 30.6 min), the hardest in the plan.
- It pushes on what already fails. Both Verify failures in this run came from narrow worker checks: t-8
  broke a caller's test, and t-10 failed in `pkg/wshrpc/wshserver` at 12:55. Each failure holds the
  merge queue for minutes and wakes the lead.
- The directions above are worth more and carry no quality risk: satisfy deps at merge (about 20 min
  here), a quick per-merge Verify (most of 35+ min), targeted worker checks (the 57%), and merge order.
- If a knob is still wanted later, make it a per-task effort hint in the plan (e.g. a docs task like
  t-15 at low), not one run-wide setting.

**Cutting the merge and Verify wait (measured at 13:46, asked by the human).** From the first spawn to 13:46,
170 min of wall time went as follows:

| | min |
|---|---|
| serialized Verify | 44 |
| no worker running at all | 48 |
| reviewed, waiting for its turn to merge | t-13 17.1, t-14 16.7, t-11 15.0, t-3 7.2, t-6 6.3 |
| queue blocked by the flaky Verify (`a2c2ca6e`) | t-10 10.5, t-12 21.8 |

In order of payoff:

1. **A scoped per-merge Verify, and the full one once in the Final stage.** Per merge, test the packages the
   task touched plus their reverse dependencies (`go list -deps`), and skip tsc when no frontend file
   changed: about 1 min instead of 3–4. The full Verify then runs once on the merged result, which is what
   the Final stage (t-10/t-11) is for, with its fix round when it fails. The cost: a regression outside
   the scoped packages shows up only at the end.
2. **A merge train.** Squash every reviewed task in the queue, then run one Verify. On a failure, bisect by
   verifying each merge alone. t-11, t-13 and t-14 would each have waited about 3 min instead of 15–17.
3. **Satisfy a dependency at merge, not at Verify pass** (above). A failed Verify blocks the dependent's
   merge, not its start: about 3 min per chain link, and this plan has six links.
4. **Keep the `--- FAIL` blocks** (finding 25). The flake cost 32 min of blocked queue. Most of it was the
   lead rerunning tests to learn which one failed.
5. **One automatic Verify retry when the failing package isn't one the task touched,** recorded as a
   retry. Code decides it, not the lead. That would have cleared t-12's second failure without a wake. It
   can hide a real flake, so the retry and its first failure stay visible in the digest.

The plainest case came last: t-15 changes only `AGENTS.md` and two docs. It still ran the full Go-and-tsc Verify
(started 14:02:54), and the run can't finish until that Verify passes. A scoped Verify would have run nothing.

Rough payoff for 1 to 3 together on a run like this: 40–60 min. That is summed from the per-task waits
above, not measured.

### 28. A worker running a long test shows as "idle", and the human has to ask whether it crashed (observed in run 18d08579, low)

t-10 (the Final stage, 33 files, +1169) ran from 12:18:31 to 12:48:56, the longest task in the run. At
12:48:48 the human asked the lead "is t10 crashed". `wsh jarvis dag status` showed t-10 as "running,
idle 3m34s". The lead needed three tool calls and 34 s to answer: it listed the worktree, tailed
the worker's transcript with `grep`, and reran `dag status`. Its answer was right: "No… Long `go test` runs
show up as idle." By then t-10 had committed `4cb33fbd` and called `complete`.

The "idle" figure is time since the worker last wrote its transcript (`taskSignal`,
`wshcmd-jarvisdag.go:222`, from `FreshnessTs` = `LastActivity`, `digest.go:477`). A worker in a
foreground `go test` writes nothing for as long as the test runs. The engine already has a better signal:
`childStillWorking` (`liveness.go:212`) samples the worker's process tree CPU. But it only runs as a veto
once a task has been quiet past `StallThreshold` (15 min, `engine.go:356-358`). So for the first 15 min of
any quiet stretch, a busy worker and a hung one print the same "idle Nm".

A Verify already gets better treatment: `verifySignal` shows its age and its latest output line.

Direction: sample CPU every tick for running tasks, not only at the stall check. Show "running a command
Nm" (busy) or "idle Nm" (quiet and no CPU), and add the latest tool call (command or file). The digest
has room for it, and the lead and the cockpit row would then answer "crashed?" without anyone reading a
transcript.

## Proposal: a final verification stage, with prototype parity

This follows from findings 11, 14, 15 and 16. Per-task review judges one diff at a time, so nothing owns
the combined result, and nothing owns what the result looks like. Proposed as an engine stage after
`dag-done`, not left to the lead's discretion. The lead wrote the spec and wants to close the run, and
its own fixes to `main` skip review and Verify.

1. **Deterministic, run by the engine:**
   - Start a dev app from the landed tree on its own CDP port and WebView2 profile, with stdin held open
     (`tail -f /dev/null | task dev`) and stopped by PID, never by image name.
   - "The landed tree" means a clean worktree checked out at the landed commit, **never the shared
     project checkout**. Observed at 10:19: the lead started `task dev` in the main checkout, which held
     another session's uncommitted `leadcardmodel.ts` edits. The dev app loaded a blank page, and the
     lead couldn't tell whether this run or the other session's work in progress caused it. A
     verification that serves someone else's edits can neither pass nor fail this run.
   - Run Check once on the merged result, then the plan's `verify:ui` scenarios.
2. **Prototype parity, when the goal has a prototype:**
   - A new optional plan preamble line, `**Prototype:** <path to a design canvas>`. For `.dc.html`
     canvases, `canvas.json` already lists each board with its size and title.
   - The engine renders every board in headless Chrome at its own size.
   - Each board maps to a `verify:ui` scenario that puts the live app into the board's state (for
     example "commit selected, 1600x950", or "history collapsed, 1000x700") and screenshots it at the
     same viewport.
   - The contact sheet (`cdp-shots/index.html`) shows each board next to its live screenshot.
3. **Judgment, by a fresh verifier session on a cheaper vision-capable model:**
   - Compare each board and live pair for structural parity: which elements are present, their order and
     grouping, copy, which controls appear at that width, and tokens as opposed to raw colors.
   - Pixel diffs are useless here because the boards use invented data, so the comparison has to be
     judged.
   - Classify each difference as allowed (listed in the spec's Deviations section) or a defect.
   - Also read the combined diff for problems that only exist once the tasks are merged.
4. **Fix round:**
   - Each defect becomes a fix task in a second DAG round with the normal worker, review and Verify.
   - Cap it at one or two rounds.
   - Whatever is still open goes to the human with the contact sheet.
   - "Not verified" (no dev app, no scenario for a board) becomes a run status, not a sentence in a
     report.

Open question: whether `dag submit` accepts a second round on a finished DAG, or the fix round needs its own
child run.

## Proposal: a run auditor and no-progress detection, not a self-healing watchdog agent

Raised during run 18d08579: should a watchdog agent supervise runs and heal them? Recommendation: no agent
that acts. Keep the observation, split between code and an optional model pass, and send the one real
runtime gap to the lead.

### Why not an acting watchdog agent

- The healing that exists is deterministic and in the engine: the watchdog tick (`pkg/orchestrate/watchdog.go`)
  retries worktree cleanup, relaunches a dead lead, retries unanswered wakes, respawns a reviewer that ended
  without a verdict, and flags stalls. Judgment calls go to the lead, which is already an LLM supervisor:
  in run 18d08579 it checked t-4's plan contradiction against the code and answered in 29 s. A third
  authority over the same run raises "who wins" and "who watches the watchdog".
- It would not have healed what these two runs found. Most findings (14, 15, 18, 21, 12) are design defects
  that recur every run; an agent would notice them every run and at best patch around them, while the fix
  is engine code, once. The few runtime ones (17's idle lead, 2's dirty checkout, 11's wrong-code dev app)
  need deterministic guards, not a model deciding to act.

### The run auditor

Layer 1: deterministic run-health checks, appended to the DAG report at `dag-done`, on every run. Each
comes from a check made by hand while watching:

| Check | Finding | Source |
|---|---|---|
| Stored report is a line from before `complete` | 14 | sealed summary vs. the worker's text after `complete` |
| "verify pass" lines that are greps or edits, or have piped exit codes | 21 | evidence verifs |
| Tool errors per worker, including heredoc parse failures | 10 | transcripts |
| Tokens per role and task | 19 | transcripts |
| Commits in the evidence range without the run's trailer | 18 | git log |
| `main` moved during the run; uncommitted files at each merge | 2, 9 | git + merge events |
| Spawn-to-first-activity per task; spawn spread across a batch | 20 | events |
| Worker asks the lead answered by correcting the plan | 7 | child-ask events |
| Time per stage: brainstorm, plan, execute, verify, wrap-up | new | events |

It costs nothing per run. Finding 14 would have shown up as "report sealed from pre-complete line: 7/7"
on the first run, with no one watching.

Layer 2: a model pass, opt-in only (a start flag, or `wsh runs audit <id>` afterwards). One session on a
cheap model reads the Layer 1 output, the event log and the lead's transcript. It explains why things
happened and proposes directions. It observes and never acts.

- Output goes on the run (`AttachReport`), not into the repo: runs happen in other projects, where a
  findings file would be noise.
- It sees only what was recorded. Three findings here needed a live observer: the attention row cutting
  the question off (3), a 283-line spec approved in 57 s (7), and the dev app serving another session's
  code (11). The final verifier covers 11; 3 and 7 stay human-noticed.

### Finding 22: nothing detects a worker that is active but not progressing (read, medium, unmeasured)

Liveness (`pkg/orchestrate/liveness.go`, `engine.go:350`) asks only whether a worker is alive: transcript
writes, CPU share (`IdleCPUShare`), whether its turn ended. A task is stalled after 15 min of silence
(`StallThreshold`) or 5 min with no first token (`FirstTokenDeadline`). The circuit breaker counts
failures. There is no per-task wall-time or token ceiling, so a worker that retries the same failing
test for an hour keeps writing its transcript and counts as healthy throughout.

Cheap deterministic signals for a "suspect" flag:

- Tokens against the run's own baseline. A fixed cap is wrong because tasks vary: b2d7fab1's worker
  sessions ranged from 0.56M to 4.07M tokens, median about 1.8M. Several times the run's median is a
  reasonable trigger.
- Diff stagnation: the worktree's `git diff --stat` unchanged for N minutes while the transcript grows.
- Repetition: the same command, or the same error text, three or more times.
- Churn: the same file edited back and forth with no net change.

The flag is code. The judgment ("stuck, or a hard task?") goes to the lead as a new wake, e.g. "t-3:
4.1M tokens, diff unchanged for 12 min, same test failure x4". The lead already has the actions: tell
the worker, retry with guidance, escalate, or let it run. No separate agent.

Measure before building. Neither run had a looping worker; the costliest tasks were just large. A script
over the transcripts of past runs on disk (b2d7fab1, 28caa81f, 700db496, …) should show whether
repetition or stagnation ever happened and where healthy tasks sit on each signal. That settles whether
this is worth building, and it gives real thresholds instead of guessed ones.

### Finding 26: the lead sees only what the engine wakes it for, and some failures emit no event (observed in run 18d08579, medium)

The question was whether the lead should be woken by events or watch the run continuously, the way
the human's observer session watched run 18d08579. That observer was event-driven too. Two scripts
(`runwatch.js` over `db_runevent`, `txwatch.js` over the lead and worker transcripts) filtered events,
and the model was invoked only when a line passed the filter. So the choice is not wake or poll. It is
which events wake the lead, and what each wake carries.

A polling lead is the wrong direction:
- Cost: every lead turn re-pays its whole context, and a lead's context is large. Polling every few
  minutes over a two-hour run is dozens of turns that mostly find nothing.
- Context: each poll result stays, pushing the lead toward compaction mid-run.
- Wakes already work when they fire. In this run, the lead answered t-4's question 29 s after the
  wake, resolved the t-2/t-4 merge conflict in 59 s, and had t-8's failed Verify fixed with the
  queue moving 2 min 41 s after the wake.

Where wakes fall short, and the fix for each:

| Gap | Seen in run 18d08579 | Direction |
|---|---|---|
| No event exists | Worker reports lost in 6 of 8 tasks (finding 14); t-8's worker and reviewer skipped the tests of `SealEvidence`'s callers, so the regression surfaced only in the post-merge Verify; a worker active but not progressing (finding 22) | The engine detects each in code and wakes the lead: `complete` without `--report`, a worker that never ran the plan's Verify or Check, a suspect flag |
| The event is too thin | The Verify failure said only `FAIL .../pkg/wshrpc/wshserver`; the lead reran the package for 46 s to learn the test name (finding 25) | The wake carries the failing test and its assertion |
| The action is buried | The merge-conflict wake was 9,564 characters with the conflict last (finding 15) | The wake leads with what needs acting on; recaps come after |

Most of what the observer caught was not something the lead needed mid-run: t-7's placement in the
Agent tree (finding 24), the reviewer detaching its worktree's HEAD, the 8000-byte output tail. Those are
findings about the engine, and they belong to the run auditor at dag-done (above), not to a lead that is
always watching.

Direction: code watches and decides when to wake; the model judges once it is woken (the
same split as finding 22 and the auditor). Widen the set of wake events and fix what the wakes carry;
don't make the lead poll.

## Re-validation: run 18d08579

A second run, `18d08579-9500-4b6b-9ca4-8b132e2696e3`, was started at 10:33:20 to fix these findings. The
goal referenced this file by absolute path. Lead and workers are `claude` / `claude-opus-5-5`, base
`c189224`, lead session `37263b50-0099-463c-92c0-42dfd6835616`. It is watched the same way, and each
finding is re-checked against what this run does. Status: **confirmed** (recurred), **not recurred**,
**not exercised**, or **changed** (the code or the facts moved since).

| # | Status | Evidence in this run |
|---|---|---|
| 1 | confirmed | The lead's principles message (transcript line 9) still has "merge back" and "inline-execution" once each, and "Use worktree" twice. |
| 2 | set up, then defused | At submit (10:52) the checkout has another session's uncommitted edits in `AGENTS.md`, `pkg/wshutil/{wshrouter,wshutil}.go` and five `src-tauri` files, plus untracked `applog.rs` and a test. The lead saw them in `git status` and submitted anyway: nothing tells it the engine merges into this tree. The plan's Task 15 (docs) edits `AGENTS.md`, so its merge would have met the dirty file. The other session committed them at 10:58 (`a8e3b232`), so the first merge (11:04) met a clean tree. Luck of timing, not a guard. |
| 9 | confirmed, twice | Base is `c189224`; `main` moved to `618ecd31` (another session, "let a lead-less run row open its run") during brainstorming, before submit, then to `a8e3b232` (10:58) mid-run. t-5 was cut from `618ecd3` and merged on top of `a8e3b232`. |
| 8 | confirmed | The spec and plan stayed untracked until the first merge; `laneFold` put both into t-5's commit `a7bf040a` ("land engine runs on their own branch by default"), which is unrelated to their content. Workers read them by the absolute paths in their brief. |
| 12 | confirmed, new shape | `a7bf040a` (t-5, 11:04) makes an empty landing mean branch. Land-back is Task 13, which depends on Tasks 5 and 10, so it lands last. Until then, `main` has branch landing by default and no land-back: a run started from a dev build of `main` in that window lands on `wave/<runId>` and waits for a manual merge. The packaged Arc is unaffected. The per-merge ordering is the plan's, and nothing in the plan format flags a task that leaves `main` half-changed. |
| 3 | confirmed, worse | 10:36:30, the first question (landing). `wsh runs attention` prints the whole goal, 17 lines this time since it holds newlines, then cuts the question at "Today branch landing leaves w…". The question's options never show. |
| 4 | not exercised | The lead's first question was a real design choice (landing), not its own process path. This goal named the groups and their priority and settled most of the design, so the path was obvious. That says nothing about an open-ended goal like b2d7fab1's. |
| 5 | improved | 10:45:57, the `Spec review` ask carried the spec's absolute path and a 15-line summary of the decisions. The design choices themselves went through four earlier one-question asks (landing, final-stage scope, fix round plus land-back rule, plan review), each with the trade-offs in the option text. |
| 6 | not exercised | No section-by-section design approvals; `Spec review` was the only approval. But the design was clear-cut: the goal and the findings file had settled most of it, and the few open choices went through one-question asks. The brainstorming skill the lead prompt loads still says "Present design — in sections … get user approval after each section" (`SKILL.md:134`), so a goal with an open design should still get the double approval. The spec's section 4.2 removes that. |
| 7 | confirmed | `Spec review` for a 283-line spec was asked at 10:45:57 and approved at 10:46:54, 57 s later. The ask carried a 15-line summary. My review notes arrived after the approval, including a spec defect: the dev-app port gap in the next row. Nothing independent read the spec before the plan was built on it. |
| 7 | confirmed again | 10:56:00, 3 min into the work: t-4 asked the lead. Its plan says a relaunched lead's tokens come from "two lead tabs" in the phase `WorkerOrefs`, but `RelaunchLead` calls `clearLeadTab` (`wake.go:440`), which removes the dead lead's tab. A plan claim the code contradicts, caught by a worker instead of a reviewer. Handled well: woken 10:56:03, it checked the code, answered at 10:56:29 (option 1, recorded lead session ids). 29 s round trip. |
| Proposal | corrected | The proposal says a second dev app needs only its own CDP port and WebView2 profile. It also needs its own Vite port: `frontend/tauri/vite.config.ts:28` pins `port: 5174, strictPort: true` and `src-tauri/tauri.conf.json` fixes `devUrl` to `http://localhost:5174`. Next to a running dev app, the second one either fails to start Vite or its window loads the running app's frontend, which is the wrong code. The AGENTS.md line on running a worktree dev app beside the main one has the same gap. The lead's spec (section 3.2) copied it. |
| Plan | observed | 10:51:49, `docs/superpowers/plans/2026-09-25-orchestrator-findings-fixes.md`: 721 lines, 15 tasks, 7 with no dependencies (1–6, 14), and docs last. Setup is `task worktree:prepare`. Check calls `tsc.js` directly, which avoids the `task check:ts` npm-install trap in worktrees. Task 14 (`final-verify.mjs`) gives the dev app its own CDP port and profile but not its own Vite port, so the proposal gap above went into the plan. Predicted, for when a Final stage first runs next to a live dev app (not exercised by this run, whose engine predates the Final stage): Vite's `strictPort` on 5174 fails; the worktree's `src-tauri/target` and `dist/bin` are junctions into the main checkout, so rebuilding `wave-tauri.exe` and `wavesrv` there hits the binaries the running dev app holds open; the script then exits 3 ("dev app did not answer"), so the result is unverified whenever a dev app is running. |
| 14 | contrast (t-1) | t-1 implements the fix for this finding, so it knew to write a report file and complete with `--report` (11:08). The already-installed engine stored the whole file: what it did, where it differed from the task and why, each with reasons. So `--report` works today, and the loss is only the brief not asking for it. t-1 also returns the report path with forward slashes, because a backslash path pasted into Git Bash loses its backslashes (the same harness trait as finding 10). |
| 14 | tally at 11:21 | Of t-1 to t-6, 4 lost the report: t-3 "Diff is clean. Committing.", t-4 "Diff is clean. Committing and reporting completion.", t-5 "All checks pass. Committing and completing.", t-6 "Now the full package tests and the required build/vet/typecheck." The two that kept it, t-1 and t-2, knew about `--report` only because t-1 implemented it and its reviewer's note reached t-2. |
| 14 | confirmed (t-5, t-3) | t-3 (11:07): the sealed report is "Diff is clean. Committing." t-5's last line before `complete` (11:02:33) was "All checks pass. Committing and completing."; `wsh runs show 20a90a46` prints exactly that as its report. The real report came 18 s after `complete`, where nothing reads it. |
| 14 | confirmed (t-8) | 11:35:39, t-8 ran `wsh jarvis complete --commit $(git rev-parse HEAD)` with no `--report`. `wsh runs show f5d7882b` gives its report as "Pre-existing gofmt drift, not mine; leaving it. Running the named tests and the build/vet/tsc gate." That is a mid-work line. t-8 was spawned at 11:27:23, after t-1's fix landed, but the installed engine's brief still doesn't ask for `--report`. Tally: 5 of 7 lost. |
| 14 | confirmed (t-7) | 11:41:58, `wsh jarvis complete --commit $(git rev-parse HEAD)`, no `--report`. Sealed report: "Removing the `Arc-Run` line I added: the engine writes the lane's own trailer when it squashes…", a line from mid-work. Tally: 6 of 8 lost. |
| 14 | confirmed (t-9) | 12:05:24, no `--report`. Sealed report: "Diff reads right. Committing." It covers a 21-file, +1060 change (plan review), the largest in the run so far. Tally: 7 of 9 lost. |
| 14 | confirmed (t-10) | 12:48:56, `wsh jarvis complete --commit $(git rev-parse HEAD)`, no `--report`. The lead read the sealed report as "Everything passes. Committing:". That covers 33 files, +1169, now the largest change in the run. Tally: 8 of 10 lost. |
| 14 | confirmed (t-12) | 13:19:43, `wsh jarvis complete --commit $(git rev-parse HEAD)`, no `--report` (`954be0ea`, 11 files, +571). Tally: 9 of 11 lost. It applied the lead's 13:05 answer exactly: `fixRoundLineFmt` "Fix round %d: this is task %d of the fix plan at %s; re-read it there…", resolved with `DocPath` in each reader's tree. It added a test asserting the line in the worker's own tree, and no `TaskNode` field. So the ask round trip worked end to end. |
| 14 | confirmed (t-11) | `wsh jarvis complete --commit $(git rev-parse HEAD)`, no `--report`. Tally: 10 of 12 lost. |
| 15 | worked as designed (t-11 → t-13) | t-11 passed review at 13:27:53, and its downstream note (`TestMain` sets `startVerifier = skipVerifier`) targeted t-13. t-13's worker had finished at 13:26:50 and its review had started at 13:26:54, so `routeDownstream` typed the note into t-13's reviewer (`tellRunID` returns `ReviewRunID` for a task in review). It arrived as a queued message at 13:27:55 and was read at 13:28:01. The reviewer weighed it ("the land tests set `Final` directly, so the `skipVerifier` test setup doesn't affect them") and passed at 13:29:12. A cross-task note reached the one session that could still act on it. The same pass let a small slip through: the new handlers in `wshserver_runs.go` sit between `SealRunEvidenceCommand`'s doc comment and its function, so that comment now documents the wrong function ("cosmetic… not worth a fail"). Nothing tracks it after the pass. |
| 14 | confirmed, sharpest case (t-15) | 14:01:07, t-15 (`7be726c7`, docs) ran `wsh jarvis complete --commit $(git rev-parse HEAD)` with no `--report`. A few minutes earlier it had written into `docs/orchestrator-guide.md` that a worker completes with "`wsh jarvis complete --commit $(git rev-parse HEAD) --report <that file>`" and that "the server refuses a task worker's `complete` without `--report`". The installed engine doesn't refuse it yet. Knowing the rule, even writing it down, didn't make the worker follow it. Only the brief, or the server's refusal (t-1's fix, live once Arc is rebuilt), will. Final tally: 12 of 14 lost. |
| 14 | confirmed (t-13) | 13:26:50, no `--report` (`ec7121b6`, 17 files, +1134). Tally: 11 of 13 lost. Only t-1 and t-2 kept their report, and both knew about `--report` only through t-1's own work. |
| 7, 11 | still open (t-10) | t-10 (`f1bb7767`, the engine side of the Final stage) runs the plan's `**Final:**` command in the final tree. Neither its diff nor its reviewer's pass mentions the Vite port. The transcripts mention Vite or 5174 only in the loaded `AGENTS.md` and memory, never in reasoning. The gap is still in t-14's `final-verify.mjs`, and no task in the plan fixes it. This run's own lead runs on the installed engine, so the Final stage won't run live here. The first plan that uses it will find the gap. |
| 25, 26 | confirmed, worse (t-10) | 12:55:22, t-10's Verify failed after 185 s: "FAIL github.com/…/pkg/wshrpc/wshserver 29.643s", with no test name. The wake that carried it was 6,942 characters. It recapped passes back to t-7, and the actionable line ("wake: Verify failed after merging task t-10") came last. The lead spent 4 min 35 s trying to learn which test failed. It ran `wshserver` once, then three times with `-count=1`, then the plan's full Go Verify (1 min 40 s): all passed. It then looked for the engine's full Verify log and found that it isn't kept. At 12:59:57 it ran `dag merge t-10 --continue` to rerun Verify. The failing test is now unknowable. The lead's stated likely cause is wrong: "another session merged `refactor/steering-sync-cleanup` (`94b84656`) around the same time". That merge landed at 11:59:03, 53 min before this Verify (12:52:17 to 12:55:22), and t-9's Verify had already passed on top of it. No commit reached `main` during the window. The known `wshserver` lead-complete TempDir cleanup flake (about 5 to 10% on Windows, under load) fits better. It is still unconfirmed, because the output is gone. So the lead reports a cause it never checked. A one-line reflog check would have ruled it out. |
| 25 | outcome (t-10) | Verify rerun passed at 13:02:46 (168 s) with no code change, which fits a flake. |
| 20, 27 | confirmed (t-10 → t-11, t-12, t-13) | All three dependents are stamped `task-spawned` at 13:03:05, 19 s after t-10's `task-verify-passed`. Their worktree, setup and spawn times add up to about 15 s one after another (4.3 s, 4.1 s, 7.0 s), which is finding 20's serial spawn with a batch-end stamp. This link took 14 min 9 s from t-10's `complete` (12:48:56) to the dependents' spawn: review 2 min 51 s, Verify 3 min 5 s (failed), lead diagnosis 4 min 35 s, second Verify 2 min 48 s, spawn 19 s. That is twice the link cost measured in finding 27, and the flaky Verify caused the extra half. |
| 4, 26 | worked as designed (t-12) | 13:05:10, t-12's worker asked a real design question through `AskUserQuestion`. Fix-round tasks inherit the dag's `PlanPath`, so its contract names "task 8 of the original plan", and the worker offered three options. It reached the engine as `child-ask` at 13:05:11. The lead's wake at 13:05:12 was one line, action first: "wake: 1 question waiting. wsh jarvis dag asks". This is the shape finding 26 asks for, in contrast to the 6,942-character Verify wake. The lead answered at 13:05:31, 19 s after the wake, without escalating. It picked the no-wire-change option, grounded it in t-7's `DocPath` so the worker reads the committed snapshot on a branch-landed dag, and asked for a test. This is an implementation choice inside the plan, rightly not passed to the human. |
| new | observed, known | 13:05:42, the lead's `wsh jarvis dag answer t-12 …` failed with "EC-TIME: timeout waiting for response" after 11 s, yet the answer landed: `dag asks` at 13:05:46 showed "no questions waiting". The lead knew to check before resending ("these answers often land anyway"), so no duplicate was sent. The `child-answered` event is stamped 13:06:25, 54 s after the answer and 39 s after `dag asks` already showed it cleared. A caller that trusts the exit code would resend, or report a failure that didn't happen. The handler does its slow work inside the client's 5 s RPC budget (`DefaultTimeoutMs`). Either answer before the slow part, or give `dag answer` and `complete` a longer timeout. |
| 25 | recurred (t-12) | 13:26:33, t-12's Verify failed in the same package, `pkg/wshrpc/wshserver`, now at 67.6 s against 29.6 s for t-10's, with t-11's review and t-13's worker running beside it. Again the failure named no test. The lead spent 6 min 6 s (to 13:32:39): `-count=4`, two runs at once, then a run under the full suite beside two more. It read `db_runevent` and `db_dag.verifyoutput` straight from the store (16,007 characters, no `--- FAIL`). Nothing reproduced the Verify failure, and it reran Verify. This time it stated the cause as unknown rather than guessing. Two failures of one package in one run, with the evidence gone both times, is the strongest case for finding 25. |
| 25, 12 | root-caused (t-12, third failure) | 13:34:30, Verify failed a third time, now in 24.5 s. The kept 8,000 characters (`db_dag.verifyoutput`) are two seconds of non-fatal log noise ("capturing dossier failed", "bad worker oref") and then `FAIL`. The line naming the test had been pushed out. The lead reproduced the failure by starving the package: six `go test -count=1 -cpu 1` at once, and 1 of 6 failed `TestLeadCompletingItsPlanRunRecordsTheProjectHead` with "TempDir RemoveAll cleanup: … .git: The directory is not empty". The cause: completing the fixture's owner run pokes `orchestrate.Schedule` in a goroutine, and the engine adds a worktree for the pending t-1 inside the temp repo while the test deletes it. That is the same flake behind t-10's failure, not the other session's merge the lead first blamed. The fix (`a2c2ca6e`, 13:39:57) adds a `scheduleAsync` seam beside `sealAsync`/`captureAsync`, which the fixture holds. 12 of 12 starved runs passed after it. The diagnosis is sound, found in 5 min 27 s once the lead starved the tests instead of repeating them. Two things repeat from finding 12. The lead committed a change to non-test source (`wshserver_runs.go`) straight into the shared main checkout, with no review, as it did with `30dd2544`. And the three Verify failures cost 24 min of queue time (t-10 10.5 min, t-12 13.5 min), time a kept `--- FAIL` block would have mostly saved. |
| new | observed, verified | Two test bugs the lead found while chasing t-12's failure. (1) `-count=4` fails `TestJarvisCtxResolvesOwnerRun`, `…BesideAnotherRunOfTheSameProject` and `TestJarvisCtxEmptyForUnrelatedBlock` (`wshserver_ctx_test.go:31/68/94`) after the first pass with "UNIQUE constraint failed: db_block.oid": fixed block ids, so the tests can't repeat in one process. That is not what Verify hits, since Verify runs each test once. (2) `wshserver` tests write run dossiers into the real home's vault. `CreateRun` captures a dossier at `memroots.VaultRoot()`, and with no `memory:vaultpath` in the test config that is `~/.waveterm/vault`. I checked the disk: that vault holds 7 commits, all test dossiers (`coupon-codes.md`, `do-it.md`, `g.md`, `test.md`, …) written 2026-09-22 12:47:11 to 12:47:24. Every later run logs "capturing dossier failed (non-fatal): … already exists" (148 lines in one `-count=4` log). The human's configured vault is `C:\Users\kael02\IdeaProjects\obsidian_vault`, so no real notes were touched here. On a machine that uses the default vault, the tests would commit junk into it. The lead's guess that this causes the intermittent Verify failure is unconfirmed: the write error is non-fatal. |
| 17 | better, not yet the new rule (wrap-up) | 14:05:10, `dag-done`, then a one-line wake "run finished". The lead checked state, made a wrap-up commit (`0c008b50`: a cancel fix in the graph header, both review nits, the plan deleted as shipped), wrote the report to a file and filed six open issues on effort b3eb8046. It then asked through `AskUserQuestion`, not plain text, so the question reached the human: "Complete now (Recommended)" or "Hold the tab open", plus a real next-step choice. It completed with `--report` at 14:09:01, 3 min 51 s after the wake. This lead launched under the old rule; t-3's "complete on your own" rule (`1c0781d1`) goes live only after Arc is rebuilt. The completion question would be gone under the new rule; the next-step question is a decision and would stay. |
| 18 | confirmed (wrap-up) | Sealed evidence: 123 files, +8464/−2166, which is exactly `git diff c1892249..0c008b50`. The range holds four other sessions' commits: `618ecd31` (10:37, 4 files), `a8e3b232` (10:58, 10 files), `4047a5e7` (11:58, 21 files, +721/−1833, the steering-sync refactor) and its merge `94b84656`. So about a quarter of the files and most of the deletions aren't this run's. t-8's fix (`956e4fca`) is on `main` but not in the installed engine. |
| 19 | confirmed (wrap-up) | `wsh runs show` gives "elapsed=3h12m workers=4h commits=15", with no tokens and no cost. t-4's per-role token totals aren't live yet. The lead's report gives only "~4h of worker time". |
| 14, 21 | confirmed (wrap-up) | In `wsh runs show`, 12 of 15 `result` lines are mid-work chat ("Diff is clean. Committing.", "Checking that the test fails without the fix, then passes with it."). The three `verify pass` lines are two `grep` commands and one `go test … \| tail -25` pipeline, whose exit status is `tail`'s. |
| 8 | new path, cause not traced | The run's spec and plan (untracked in the main checkout at submit) are in t-5's lane commit `a7bf040a`, "feat(runs): land engine runs on their own branch by default": 282 + 728 lines in a 13-file feature commit. t-5's worker ran `git add -A` in its own worktree (04:02:36Z), and a fresh worktree has no untracked files from the main checkout. The lead never staged them before 11:05. t-5 was the first task to merge (11:04:23), so the squash commit in the main checkout probably took them from its index, staged by something outside the run. Not proven. Either way the docs landed under a feature title with a task trailer, the thing t-7 (snapshot at submit) exists to do deliberately. |
| wrap-up | report quality | The lead's report (`arc-report-18d08579.md`) is accurate and complete. It lists all 15 landed tasks with hashes, its own three commits with reasons, the one conflict, both answered asks, and the unverified note ("None of the new behavior has run live"). It also records the six open issues and a live-check item, and it flags the human's near-duplicate principles as the human's call. It credits the TempDir race correctly, retracting nothing aloud: the earlier "moved checkout" guess just doesn't appear. "0 failures" means task failures. It doesn't mention the four Verify failures (t-8 once, t-10 once, t-12 twice), which cost 32+ min, except through the two fix commits. |
| 28 | new | 12:48:48, the human asked the lead "is t10 crashed". `dag status` said "idle 3m34s" while t-10 ran its final tests. See finding 28. |
| new | observed | 11:40:30, t-8's Verify failed after it merged (`956e4fca`): `TestLeadCompletingItsPlanRunRecordsTheProjectHead` (`pkg/wshrpc/wshserver`), "sealed files = [], want only the landed t-1.txt". t-8 narrowed a checkout run's evidence to commits carrying its `Arc-Run` trailer, and that test's fixture commits without one. The worker ran `pkg/jarvis`, `pkg/gitinfo` and `pkg/orchestrate -run Merge`; the reviewer ran `jarvis`/`gitinfo -run 'Trailer\|Evidence'`. Neither ran the tests of `SealEvidence`'s callers in `pkg/wshrpc`, and nothing requires either to run the plan's Verify before `complete` or `pass`. So a regression that a pre-merge full run would have caught reached `main` and blocked the queue. The lead learned the test name only by rerunning the package (46 s, finding 25). At 11:41:42 it fixed the fixture (the commit now carries the trailer, like real lane commits: a sound fix, not a weaker test) as an uncommitted edit in the shared main checkout. It reran the package (ok, 32.6 s), committed `30dd2544` at 11:43:10 with the run's own `Arc-Run` trailer (the bare run id), and continued t-8; the new Verify started at 11:43:11. From wake to resumed queue: 2 min 41 s, 46 s of it spent rerunning just to learn the test name. |
| 10 | not recurred (so far) | At 11:03, t-1 to t-5 had used 16 Python-in-bash heredocs and 44 Edit/Write calls, with no "unexpected EOF" failures. |
| 7, 11 | confirmed | t-14 (`a681ef19`, `scripts/cdp/final-verify.mjs`, 145 lines) passed review at 11:14:42. The script has no mention of Vite, 5174, `devUrl` or `node_modules`, and it starts the dev app with a plain `task dev` in the final tree. The reviewer checked the work against the task text, and the task text never mentioned the Vite port, so the premise went unchallenged all the way down: spec, plan, worker, reviewer. A per-task review can't catch a gap in the task itself; only a plan review, or the first live run of the Final stage, would. |
| 7 | watch: shared files | t-2 (`03ced0ea`) and t-4 (`08e8625c`) have no Depends between them and both edit six files: `cmd/wsh/cmd/wshcmd-jarvisdag.go` and its test, `pkg/orchestrate/digest.go`, `pkg/waveobj/wtype.go`, `pkg/wshrpc/wshrpctypes_dag.go`, and the generated `frontend/types/gotypes.d.ts`. The spec's own plan-review brief (section 4.1) lists "no two tasks edit the same file without a Depends between them" as a check, which this plan fails. Whether git merges them cleanly is pending. Outcome at 11:22:58: t-4's squash merge conflicted (`task-merge-blocked`, then `dag-blocked`) in `pkg/wshrpc/wshrpctypes_dag.go`; the other five shared files, including the generated `gotypes.d.ts`, merged textually. |
| 12, 2 | confirmed, worst case | That conflict sits in the shared checkout: from 11:22:58 `main`'s working tree has `UU pkg/wshrpc/wshrpctypes_dag.go` with conflict markers plus t-4's staged files, until the lead resolves it. Another session is active in the same checkout (a new untracked `docs/superpowers/plans/2026-09-25-steering-whole-file-sync.md` appeared); its builds and tests now see a conflicted tree, and its commits would have to avoid a half-merged index. A branch-landed run would have the same conflict in its own worktree. Resolved well and fast: the lead saw both tasks only added fields next to each other in `DagReportDigest`, kept both, ran `task generate` (no diff) plus `go build ./...` and `go vet`, checked `MergeContinue` to learn that the engine makes the commit, staged the file and ran `dag merge t-4 --continue`. `5b4eeccd` landed at 11:23:57, so the checkout was conflicted for 59 s. |
| 15 | partly | The wake that carried the conflict (11:22:58) was 9,564 characters: every pass since the last wake, each review note cut at about 600 characters, and each downstream note whole. The conflict itself came last, after about 9,000 characters of recaps. |
| 14, 15 | confirmed, new path | t-2 completed with `--report` (11:16). Its report ends with "What later tasks need to know", three items for Tasks 10 and 1 and for any new session kind. The reviewer's brief received the report cut at 600 characters (`truncateNote(worker.Evidence.Summary, handoffMaxSummaryLen)`, `review.go:443`; `handoffMaxSummaryLen = 600`, `engine.go:710`), ending "…and applies the…". Only the reviewer writes downstream notes, so a worker's hand-off section, written last, is the part the cut removes; it reaches later tasks only if the reviewer rediscovers it from the diff. t-2's own change removes this truncation (its diff replaces the line with `strings.TrimSpace(...)`). Outcome at 11:19:29: the reviewer passed t-2 with `downstream: ""`. None of the three hand-off items reached Tasks 10 or 1. One of them is moot: the reviewer found that `SealEvidence` fills `Evidence.Summary` from `run.Report`. The other two (where Task 10 reads caveats; new session kinds must satisfy the `--report` rule) were dropped. The second also went out through t-1's reviewer note, but to t-2, t-9, t-11 and t-12, not to t-10. |
| new | observed | 11:18:02, t-2's reviewer ran `git checkout -q 618ecd31 --` in the task worktree to compare a failing test (`TestWatchdogTickDetectsStallInAwaitingReviewDag`) against the base. With no paths after `--`, that detached the worktree's HEAD at the base. It noticed ("I accidentally detached HEAD"), used it to run the test at base, then `git switch`ed back to the task branch. Harmless here: the merge squashes the task branch (`merge.go:40`, `merge --squash <branch>`), not the worktree's HEAD. But the reviewer is "read only" by prompt alone. A reviewer that commits on the branch, or resets it, changes what lands, and nothing would notice. The engine could record the branch tip at review start and refuse the merge if it moved (it already keeps `ReviewCommit`). |
| 23 | confirmed | Per-merge Verify durations: t-5 410 s, t-3 247 s, t-2 168 s, t-4 200 s, t-6 243 s (11:27:19 to 11:31:23), t-14 175 s, t-8 failed after 185 s and then passed in 166 s, t-7 200 s. From 11:45:58 to 11:49:19, no worker ran: every pending task waited on t-7's Verify. t-14 passed review at 11:14:42 and merged only at 11:31:24, after four Verifies ahead of it in plan order. |
| 23 | shape | The plan's second half is a chain: t-9 (deps t-4, t-7) → t-10 (t-2, t-9) → t-11, t-12, t-13 (t-10) → t-15 (docs, deps all). From 11:49 one worker runs at a time until t-10 lands, whatever the parallelism of 5. Each link pays work, then review, then merge, then a 3–4 min Verify before the next can start. So a per-merge Verify of about a minute would save several minutes per link. The plan's Depends lines set the width, as `AGENTS.md` says, and nothing flags a plan whose critical path is most of its tasks. |
| 24 | new | t-7's worker (spawned 11:23:00) shows outside the run in the Agent tree; t-8 (11:27:23) nests. The store data is identical for both. See finding 24. |
| 19 | changed | Since `c1892249` (another session, 10:29) the run card's status line shows worker time and a token count (`runCost`, `leadcardmodel.ts:306`), still no dollars. The count undercounts: `runtokenstore.ts` sums one transcript per task run (`SessionTranscriptPath`, the worker's), so reviewers and the lead are left out. On run b2d7fab1 that is 15.3M of 29.3M tokens, about half. The report and `wsh runs show` still have none. |
