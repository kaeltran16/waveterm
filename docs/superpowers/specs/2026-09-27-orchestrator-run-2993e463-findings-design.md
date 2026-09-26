# Orchestrator findings from run 2993e463

Source: watching run 2993e463 (landed as `63ce6a224`) and dag 9b17c7e9 (run bf3a2fe3). Four findings, each
with its cause in the code and the change. The fixes are recorded in `docs/orchestrator-findings-2026-09-25.md`.

This run (c84aa179) goes through the engine on purpose, although the work is small: it is also the live check of
the plan review, the merge train, the stuck flags and the Agent tree rows, which that doc lists as not verified
live.

## Scope

In:

1. A human can answer a run's own pending ask (a lead's AskUserQuestion) from the CLI.
2. The land commit's subject is cut at a sentence or word boundary, never inside a path.
3. Sealed evidence lists only the commands that run a check, not the edits chained with them.
4. A blocked dag's attention item names each blocking state with its own reason and next action.
5. The findings doc gets a Fixes table for these, and a note on what this run showed live.

Out, and why:

- Showing a lead's ask anywhere new in the cockpit. The cockpit already answers it (the ask card on the lead's
  session); the gap is only the CLI.
- A land subject taken from the lead's own commit. A run's branch can hold many commits; the goal names the
  cut, not a new source.
- Detecting edits in a command (`sed -i`, `writeFileSync`, `cp`). Decided against: see section 3.

## 1. Answer a run's pending ask from the CLI

**Cause.** A lead's AskUserQuestion is registered in `agentask.GlobalRegistry` under the lead's block oref, the
same as any agent ask. The CLI has two ways to answer: `wsh jarvis dag answer <task-id>`, which walks the dag's
task runs (`DagAnswerCommand`, `wshserver_dag.go`) and needs a dag and dag ids, and none for a run's own session.
`wsh runs attention` lists the ask but gives no way to answer it or see its options. Run 2993e463 had no dag at
all.

**Change (decided: `runs show` plus `runs answer`).**

- Two RPCs in `wshrpctypes_runs.go`, served in `wshserver_runs.go`:
  - `RunAsksCommand(CommandRunAskData{ChannelId, RunId}) (*CommandDagAsksRtnData, error)`: the pending ask on
    the run's own blocks (`orchestrate.RunBlockORefs(run)`, which for a lead run is the lead's tab), the same
    one `RunAnswerCommand` answers, as a `DagAskItem` with an empty `TaskId`. A task's run is not walked: its
    asks are the dag's.
  - `RunAnswerCommand(CommandRunAnswerData{ChannelId, RunId, Answers})`: delivers the answer to the first of the
    run's blocks with a pending ask through `AnswerAgentCommand`, the path the cockpit and `dag answer` use, so
    the answer hooks stay shared. No pending ask is an error: `run <id> has no pending question`.
- One server helper, `pendingRunAsk(ctx, run) (blockORef string, pending, ok)`, finds the pending ask on a
  run's blocks. `DagAnswerCommand` uses it for the child run instead of its own loop; `gatherDagAsks` keeps its
  loop, since it lists every block's ask rather than the first.
- `task generate` for the client bindings.
- `wsh runs show <run-id>` prints a `question` block after the status lines when the run has a pending ask: the
  questions and numbered options, printed by the existing `dagQuestionLines`, then the answer line
  `answer:  wsh runs answer <run-id> '[{"selectedindexes":[0]}]'  (one item per question, in order; {"text":"..."} for free text)`.
  A failed read of the asks prints to stderr and leaves the rest of `show` as it is, like `runsDigest`.
- `wsh runs answer <run-id> <answers-json>` parses the answers like `dag answer`, finds the run with
  `runsFind`, and calls `RunAnswerCommand` with `dagAnswerTimeoutMs(answers)`.
- The `runs attention` footer names both: `a run's own question: wsh runs show <run-id>, then wsh runs answer`.
- `pi/skills/cockpit-runs/SKILL.md` and the command table in `docs/orchestrator-guide.md` list `runs answer`.

**Tests.**

- Server: a run whose block has a pending ask is listed by `RunAsksCommand` and answered by `RunAnswerCommand`
  (the registry entry is claimed); a run with no pending ask returns the error; `DagAnswerCommand`'s existing
  tests still pass on the shared helper.
- CLI: `runsShowLines` prints the question block and the answer line for a run with an ask, and nothing extra
  without one; `runsAttentionLines`' footer names `wsh runs answer`.

## 2. Land subject cut at a boundary

**Cause.** `landTitle` (`pkg/orchestrate/land.go`) uses the plan's title, else the goal's first line, and
`clipRunes` cuts either at 71 runes plus `…`. A run without a dag has no plan title, and a goal's first line is
often a whole paragraph with absolute paths, so run 2993e463 landed as
`Close the last open orchestrator gaps in C:\Users\cktra\Projects\wavete…`.

**Change (decided: base name, then cut).** A new `landSubject(s string) string` shapes both sources:

1. Each whitespace-separated token that is an absolute path (starts with a drive letter and `:\` or `:/`, `\\`,
   `/` or `~/`) becomes its base name, keeping trailing punctuation (`.,;:)`).
2. The text is cut at the end of its first sentence: the first `. `, `? ` or `! `; the full stop itself is
   dropped.
3. Over 72 runes, it is cut at the last space at or before rune 71, trailing `,;:` and spaces are trimmed, and
   `…` is appended. A text with no space in that range is clipped by runes, as now.

`landTitle` applies it to the plan's title (after dropping " Implementation Plan") and to the goal's first line.
For run 2993e463's goal the result is `Close the last open orchestrator gaps in…`: with base names the first
sentence is about 110 runes, and the first base name ends past rune 71.

**Tests.** `TestLandTitleNamesTheChangeOnOneLine` gains cases: 2993e463's goal verbatim; a goal whose base name
fits (`Fix the land title in land.go`, from a goal naming `C:\x\pkg\orchestrate\land.go`); a sentence cut
(`Fix it. Then more` → `Fix it`); a word cut on a long title; a single 100-rune token (rune clip). Every case
stays within 72 runes and none ends inside a path.

## 3. Evidence lists only checks

**Cause.** `isVerifCommand` (`pkg/jarvis/evidence.go`) accepts a whole command when any simple command in it is
a check, and `addTranscript` seals the whole command text as the line. The lead's commands in run 2993e463
chained an edit and a test: `node -e '<readFileSync…writeFileSync>' && npx vitest run …`, and
`cp x "$TMP/fv.bak" && sed -i … && npx vitest … ; cp "$TMP/fv.bak" x`. The report showed each as `verify ran`
with the edit script whole.

**Change (decided: seal only the check part).**

- `verifChecks(command string) []string` replaces `isVerifCommand`: it returns the simple commands in
  `command` that run a check, trimmed, in order. A simple command counts when a runner leads it (as now) and
  it names a verification action, and it is not an inline script: `node`/`bun` with `-e`, `--eval`, `-p`,
  `--print` or a bare `-`, and `python`/`python3` with `-c` or a bare `-`, never count.
- Heredoc bodies are removed before the split: after a `<<WORD`, `<<'WORD'`, `<<"WORD"` or `<<-WORD`, the lines
  up to the line that is `WORD` are dropped, so a script's body lines are never read as commands.
- `verifPattern` adds `vet` and `check`, so `go vet`, `cargo check`, `task check:ts` and `prettier --check`
  count. `checkout` does not match (`\b`).
- `addTranscript` seals the check parts joined with `; ` as the line's `Cmd`, and keys the merge of repeated
  runs on that text, so the same test run after different edits is one line holding its last result. The
  result stays `ran`, and the detail is still the summary line of the whole command's output.

For run 2993e463 this seals `npx vitest run scripts/cdp/final-verify.test.mjs 2>&1` and
`npx vitest run scripts/cdp/final-verify.test.mjs -t "one after the other" 2>&1`, and no edit script.

**Tests.** `TestIsVerifCommand` becomes a table over `verifChecks` with the check parts expected: finding 21's
four commands, 2993e463's `node -e … && npx vitest` and `cp && sed -i && npx vitest ; cp` commands, a
`node - <<'EOF'` heredoc whose body holds a `go test` line and whose tail runs vitest, `node -e
'…test…'` alone (none), `python -c` (none), `go vet ./pkg/...` and `task check:ts` (one each), and `git
checkout x` (none). An `addTranscript` test seals two commands that edit then run the same test as one line
with the check text only.

## 4. A blocked dag names each blocking state

**Cause.** A dag is blocked when a task is `failed`, `blocked-merge`, `verify-failed` or `review-failed`, or
when `Failures` reaches `MaxConsecutiveFailures` (`dag.go`). `dagBlockedReason` (`pkg/jarvis/attention.go`)
names a merge, a failed Verify and a failed final stage, and prints `<n> consecutive failures — decide
retry/skip.` for everything else. Dag 9b17c7e9's t-1 is `review-failed` ("reviewer gave no verdict within 20m")
with `Failures` 0, so its card read `0 consecutive failures`. `blockedTask` does not name a review-failed task
either, so the item's `TaskId` is empty.

**Change.** `dagBlockedReason` follows the digest's order (`buildNext`): review-failed, then a merge, a failed
Verify, the final stage, a failed task, the circuit break, and a fallback.

| State | Text | Why (after `n of m tasks done.`) |
|---|---|---|
| review-failed | `Review of <task> failed: <first line of ReviewNote>` | `The lead was woken to judge it: approve it as it is with `wsh jarvis dag approve <id>`, send it back with `wsh jarvis dag sendback <id> "<guidance>"`, or retry or skip it.` |
| blocked-merge, verify-failed, final | unchanged | unchanged |
| failed | `<task> failed` plus `: <LastFailureKind>` when set | `Retry it with `wsh jarvis dag retry <id>`, skip it, or escalate it to another model.` |
| circuit break (`Failures >= MaxConsecutiveFailures`, no task above) | unchanged: `<n> consecutive failures — decide retry/skip.` | unchanged |
| anything else | `The group is blocked: <task> is <state>` for each task not done, skipped or pending | ``wsh jarvis dag status` lists each task's actions.`` |

The bare `consecutive failures` line is printed only when `Failures` reaches the limit. `blockedTask` returns a
review-failed task first (`retry` false), then as now. The new commands name the task id alone, like the existing
merge line.

**Tests.** `attention_test.go`: a review-failed task with `Failures` 0 gets its review note in the text, the
approve and sendback commands in the why-line, its id in `TaskId`, and no `consecutive failures`; a failed task
names its failure kind; a review-failed task outranks a blocked merge; the circuit-break case keeps its current
text (`TestDagGateAndBlockedWhyCountSkippedTasksAsFinished` unchanged).

## 5. The findings doc

A new section `## Fixes: run 2993e463` in `docs/orchestrator-findings-2026-09-25.md`, a `| # | Fix | Test |`
table like the others, one row per finding above, with the test names as they landed. Findings are numbered on
from the doc's last (37 to 40), each row saying what it fixed in the style of the existing rows. The four also
get rows in the doc's Summary table, marked fixed.

After the run lands, the lead adds `Live check: run c84aa179` under that table: what this run showed of each
feature the doc lists as not verified live (plan-review, final-verification and verifying rows in the Agent tree,
the landing labels, staggered `task-spawned` stamps, `running a command` and `stuck?` in `dag status`, per-merge
Verify times, the merge train batch), and which it did not exercise (a worker answered after a 20+ min ask, two
final stages at once). Each claim names its evidence: an event row, a `dag status` line, a screenshot path.

## Plan shape

Four independent tasks, one per finding (1 is the only one touching generated files), then the doc table, which
depends on all four for the test names.
