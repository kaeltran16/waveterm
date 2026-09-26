# Orchestrator remaining findings: 20, 22, 26, 28 and test hygiene

Source: `docs/orchestrator-findings-2026-09-25.md`, findings 20, 22, 26 and 28, the "run auditor" proposal,
and the "new" rows of "Re-validation: run 18d08579" about test hygiene and `dag answer`. Each section below
names the finding, the cause found in the code, and the change.

## Scope

In:

1. Finding 20: each `task-spawned` event carries its own task's spawn time.
2. Finding 28: CPU is sampled on every tick for running tasks, `dag status` tells busy from quiet, and it shows
   the latest tool call.
3. Finding 26: a wake leads with its action lines and unverified caveats; recaps come after.
4. Finding 22: the engine flags a worker that is active but not progressing, in code, and wakes the lead once
   per stuck episode.
5. Test hygiene: `wshserver_ctx_test.go` repeats under `-count>1`; `wshserver` tests stop writing dossiers into
   the real vault; `wsh jarvis dag answer` stops reporting a timeout for an answer that landed.
6. The findings doc records each fix in a new fix table.

Out, and why:

- The run auditor's Layer 1 (checks appended to the report at `dag-done`) and Layer 2 (an opt-in model pass).
  The goal's item 4 asks for the runtime piece of that proposal, the no-progress detection that wakes the lead.
  The report-time checks are a separate feature and stay open in the findings doc.
- An acting watchdog agent. The proposal rejects one: the engine flags, the lead judges.
- The other wake events finding 26 lists ("complete without `--report`", now refused by the server; "a worker
  that never ran Verify or Check"). The goal's item 3 is the order of what a wake carries.
- A token signal for finding 22 (decided: see section 4.2).
- The cockpit worker row for finding 28. It already shows the live tool detail from the agent-status hook
  (`StatusLine` / `ActivityLine` in `dagoverview.tsx`); the gap is the lead's `dag status`.

## 1. Finding 20: spawn time per task

**Cause.** `scheduleLocked` (`pkg/orchestrate/engine.go`) spawns each ready task in turn, but queues each
`task-spawned` append in `afterCommit`, which runs after the whole batch has persisted. `wstore.AppendRunEvent`
stamps `ts` with `time.Now()` at write time, so every row carries the batch-end time.

**Change.**

- `pkg/wstore/wstore_runevent.go`: add `AppendRunEventAt(ctx, ts, channelId, runId, kind, phaseIdx, detail)`,
  which stores the given `ts`. `AppendRunEvent` becomes a call to it with `time.Now().UnixMilli()`. One insert
  path, not two.
- `pkg/orchestrate/engine.go`: an `appendRunEventAt` var beside `appendRunEvent`, with the same publish
  behavior. `appendRunEvent` delegates to it with the current time, so the existing test stubs of
  `appendRunEvent` keep working for every other event.
- The spawn loop records `spawnedAt := time.Now().UnixMilli()` when `spawnWorker` returns, and the
  `task-spawned` closure appends with that time. The write stays after commit, as today. The event's detail
  (`worktreems`, `setupms`, `spawnms`) is unchanged.

The spawns themselves stay serial. The finding says concurrent worktree creation and Setup pay off only if Setup
grows, and with `task worktree:prepare` it takes 0.5–2.2 s.

**Test.** Two ready tasks, with a `spawnWorker` stub that advances a clock between the calls: the two
`task-spawned` rows carry different `ts`, each equal to its own task's spawn return, and both earlier than the
tick's commit.

## 2. Finding 28: busy vs quiet, and the latest tool call

**Cause.** `dag status` prints "idle Nm" from `FreshnessTs` = `t.LastActivity`, the last transcript write
(`taskSignal`, `cmd/wsh/cmd/wshcmd-jarvisdag.go`). A worker in a foreground `go test` writes nothing while the
test runs. `childStillWorking` (`pkg/orchestrate/liveness.go`) samples the worker's process-tree CPU, but only
as a veto once the transcript has been quiet past `StallThreshold` (15 min). When it finds CPU use, it also sets
`t.LastActivity = now`, which mixes CPU activity into the field the display reads as "last transcript write".

**Change.**

- `TaskNode` (`pkg/waveobj/wtype.go`) gains:
  - `BusyTs`: the last CPU sample that showed the worker's tree working.
  - `LatestTool`: the detail of the worker's latest agent status, e.g. "running go test ./pkg/x" or
    "editing digest.go". Bounded to 80 characters.
- `liveness.go`: `childStillWorking` splits into:
  - `sampleWorkerCPU(ctx, t, run, now)`, which runs on every tick for a `running` or `stalled` task at most once
    per `CPUSampleEvery` (20 s, a named const). The throttle keeps the delta meaningful when event-driven
    Schedule calls land seconds apart. It updates `CPUSample`/`CPUSampleTs` as today, and sets `BusyTs = now`
    under the same rule as today: the tree's total fell, or rose by at least `IdleCPUShare` of the interval.
  - The stall veto, which reads the sample instead of taking it.

  `LastActivity` stays transcript-only: the `t.LastActivity = now` bump goes away.
- The stall rule keeps its meaning with the new fields:
  - A task is quiet when `now - max(LastActivity, BusyTs) > StallThreshold`. Before, a busy CPU sample restarted
    the silence clock through `LastActivity`; now `BusyTs` does.
  - The turn-ended case stalls only when the latest sample was not busy.
  - A task with no previous sample still defers its verdict by a tick, as today.
  - No CPU reading at all leaves the transcript rule alone, as today.
- Every tick, for a running task, `LatestTool` is set from `latestAgentStatus(blockId, tabId)` (`wake.go`): its
  `Detail` when the state is `working`, else "". The PreToolUse hook sets the detail for claude (`detailForTool`,
  `wshcmd-agenthook.go`), and pi's status extension does the same. PostToolUse reports `working` with no detail,
  so the field is non-empty exactly while a tool call is in progress, which is the case this finding is about.
- `MarkRunning` (`scheduler.go`), which every dispatch passes through, including every retry, resets
  `CPUSample`, `CPUSampleTs`, `BusyTs` and `LatestTool`, so an earlier attempt's readings never describe the new
  worker. Today only `autoRetryStalled` clears the CPU sample, and a lead's `dag retry` does not; that reset
  moves into `MarkRunning`.
- Digest (`DagTaskDigest`, `pkg/wshrpc/wshrpctypes_dag.go`) gains:
  - `Busy bool`: derived once in `buildTaskDigest`, true when `BusyTs` is within `BusyWindow` (2 ×
    `CPUSampleEvery`) of the snapshot's `Now`.
  - `LatestTool string`.
- CLI `taskSignal`: for a running or stalled task,
  - busy: `running a command <age>`, where `<age>` is the time since the last transcript write, which is how long
    the command has run;
  - otherwise: `idle <age>`, as today;
  - either way, ` · <latest tool>` when `LatestTool` is set.

  The ask and Verify cases are unchanged and come first. A suspect task (section 4) is shown ahead of both.

**Tests.**

- `liveness_test.go`: CPU is sampled on a tick well inside `StallThreshold`, and sets `BusyTs`.
- The same file: `LastActivity` is not moved by CPU.
- The same file: a busy worker past `StallThreshold` of transcript silence is not stalled; an idle one is.
- The same file: the throttle skips a second sample inside `CPUSampleEvery`.
- A lead's `dag retry` clears the fields (through `MarkRunning`).
- `digest_test.go`: `Busy` inside and outside `BusyWindow`.
- `wshcmd-jarvisdag` test: the three signal texts, "running a command 4m · running go test ./pkg/x",
  "idle 4m" and "idle 4m · editing a.go".

## 3. Finding 26: action first, recaps after

**Cause.** `withQuiet` (`pkg/orchestrate/wake.go`) puts the queued quiet lines (review passes, notes that
reached later tasks, plan-review and verifier passes) ahead of the wake's own lines, and `flushLocked` /
`launchLocked` append the questions line ("N questions waiting") after both. A pass with an unverified caveat
is one quiet line: "t-3 passed review. unverified: … <note>". So the action line, the run-finished block with
its unverified list, and the questions line all come last. Run 18d08579's merge-conflict wake was 9,564
characters with the conflict at the end.

**Change.**

- `runWake` gains `caveats []string`, beside `quiet`. `PostCaveat(ctx, channelId, runId, line)` queues one. Like
  `PostQuiet`, it never starts a wake: it rides on the next one, and a dead lead's caveats are dropped (its
  replacement reads `dag status`).
- In `advanceReviews` (`review.go`), a pass with an unverified caveat posts two lines:
  - `PostCaveat`: "t-3: <unverified, whole>";
  - `PostQuiet`: the recap without the caveat, "t-3 passed review: <note, cut as today>".

  A pass with no caveat is unchanged.
- `withQuiet` is replaced by `composeWake(lines, questions, caveats, quiet []string) string`. Both
  `flushLocked` and `launchLocked` use it, and it emits, in order:
  1. the wake's own lines (action lines, including the run-finished block with its unverified list);
  2. the questions line;
  3. `Unverified:` and the caveats;
  4. `Since your last wake:` and the recaps.

  Empty groups and their headings are left out.

**Tests.** `wake_test.go`:

- A wake with a merge-conflict line, two recaps and one caveat reads conflict first, then `Unverified:` with the
  caveat, then the recaps.
- The run-finished wake's unverified block comes before any recap.
- The questions line comes right after the action lines.
- A launch (`launchLocked`) uses the same order.

## 4. Finding 22: active but not progressing

### 4.1 Why the engine, and why no agent

Liveness asks only whether a worker is alive. A worker that retries the same failing test for an hour writes
its transcript throughout and counts as healthy. The proposal's split holds: code flags, the lead judges with
the actions it already has (`dag tell`, `dag retry`, `dag escalate`, forward, or let it run). There is no
watchdog agent and no automatic action.

### 4.2 Signals

Measured on the 9 worker transcripts on this machine (runs 29347c08 and bf3a2fe3; the findings doc's runs are
on another machine): no Bash command ran more than once in a session, no error repeated, and the longest
stretch without an edit or commit was 3.8 min. None looped, so the thresholds below are conservative guesses,
named constants, and recorded as unmeasured.

- **Stagnation.** The task's worktree is unchanged for `StagnationThreshold` (20 min) while the worker is active,
  meaning a transcript write or a busy CPU sample (section 2) within `ActiveWindow` (5 min). A worker that is not
  active is the stall path's (15 min silent), not this one's.
- **Repeated failure.** The same failing tool call, with the same error, `RepeatedFailureMin` (3) or more times
  in the transcript's recent tail. Matching on the error as well as the command keeps normal red-green work,
  which reruns one test with a changing failure, from counting.
- No token signal. A big task is legitimately costly (b2d7fab1's workers ranged from 0.56M to 4.07M tokens), a
  run median needs finished tasks, and it would need a full usage scan of each transcript on each check.

### 4.3 The worktree fingerprint

The fingerprint is one `git status --porcelain=v2 -z --branch --untracked-files=all` in the worker's worktree
(`run.ProjectPath`), plus the size and mtime of every path it lists, hashed with sha256.

- `--branch` carries HEAD's commit id, so a commit is progress.
- The status lists changed and untracked paths. Their size and mtime catch a further edit to an already-changed
  file, which the status text alone does not show.
- It is one git process and a few `stat` calls: no `git diff` of a possibly large change.
- Ignored files (`node_modules`, build output) are not listed, so a test run's artifacts are not progress.

The check runs inside the tick for a `running` task that has a worktree, at most once per `ProgressCheckEvery`
(1 min). It runs under the dag lock like the rest of the tick. The cost is one `git status` per running task per
minute, measured at 70–80 ms in this run's worktree on this machine. A tree that git cannot read (the error is logged)
skips the check for that tick: no flag and no reset.

`TaskNode` gains:

- `ProgressHash`, the last fingerprint;
- `ProgressTs`, when it last changed, seeded at spawn;
- `ProgressCheckTs`, the last check;
- `SuspectTs`, when the current episode was flagged, 0 while armed;
- `SuspectReason`, the flag's text.

`MarkRunning` resets all five, like the section 2 fields, and seeds `ProgressTs` with the spawn time.

### 4.4 The repeated-failure scan

The scan reads the last 256 KB of the worker's own transcript (`transcriptForRun`, the file liveness already
stats), on the same `ProgressCheckEvery` cadence. It pairs tool calls with their results and keeps the failed
ones:

- claude: an assistant `tool_use` (`id`, `name`, `input.command`) with a user `tool_result` (`tool_use_id`,
  `is_error`);
- pi: an assistant `toolCall` (`id`, `name`, `arguments.command`) with a `toolResult` message (`toolCallId`,
  `isError`).

The key is the command, trimmed (or the tool name when there is no command), plus a hash of the result's last
400 characters. The largest group of 3 or more is the finding: its command, cut to 80 characters, and its count.
The tail's partial first line is dropped, as `tailLines` in `wshcmd-agenthook.go` does. A runtime with no
readable transcript skips the scan. The scan is a pure function over lines, in its own file
(`pkg/orchestrate/progress.go`, beside the fingerprint), so it is unit-tested without a store.

### 4.5 The flag and the wake

On a check:

- A stagnant or repeated-failure task with `SuspectTs == 0` gets `SuspectTs = now` and a `SuspectReason` such as
  "worktree unchanged 22m while active; `go test ./pkg/x` failed the same way 4x", naming whichever signals
  fired. Then, after commit:
  - a `task-suspect` run event (a new `RunEventKind`), with detail `taskid`, `unchangedms`, `command` and
    `count`;
  - `PostWake`: "wake: task t-3 may be stuck: <reason>. Tell it (`wsh jarvis dag tell t-3 "…"`), retry, escalate,
    or let it run. wsh jarvis dag status".
- A fingerprint change clears `SuspectTs` and `SuspectReason`, which re-arms the flag. So one stuck episode
  wakes the lead once, however long it lasts, and a worker that moves and then sticks again gets a new wake.
- A task that leaves `running` (done, stalled, failed, asking) stops being checked. A worker waiting on an ask is
  not checked at all: the question queue owns it, as in `hungWake`.

Display:

- The digest's `DagTaskDigest.Suspect` carries `SuspectReason` while `SuspectTs > 0`.
- The CLI signal column shows `stuck? <reason>`, ahead of the busy/idle text.
- The run timeline (`frontend/app/view/agents/runtimeline.ts`, `timelinefilter.ts`) gets a label and a filter
  group for `task-suspect`, the same as the other task events.

### 4.6 Tests

- `progress_test.go`: the fingerprint changes on a commit, on an edit to an already-modified file, and on a new
  untracked file.
- The same file: the fingerprint does not change on an ignored file.
- The same file: the scan counts claude and pi failures, keys on the command plus the error, ignores successes,
  and does not count the same command with different errors.
- `engine_test.go`: a running task whose fingerprint holds for 20 min while its transcript advances is flagged
  once, gets one `task-suspect` event and one wake, and is re-armed by a fingerprint change.
- The same file: a quiet task is not flagged.
- The same file: a task with a pending ask is not flagged.
- The same file: the check runs at most once per `ProgressCheckEvery`.
- CLI and digest: `Suspect` is carried and printed.

## 5. Test hygiene

- **Fixed block ids.** The three tests in `pkg/wshrpc/wshserver/wshserver_ctx_test.go` insert blocks and runs
  with literal UUIDs, so a second pass in one process fails with "UNIQUE constraint failed: db_block.oid". Each
  id becomes `uuid.NewString()`, built into the orefs the test uses. Proof: `go test -count=3 -run JarvisCtx
  ./pkg/wshrpc/wshserver` passes.
- **Dossiers in the real vault.** `CreateRun` calls `jarviscapture.CaptureRunDispatch`, which writes to
  `memroots.VaultRoot()`. With no `memory:vaultpath` in the test config, that is `~/.waveterm/vault`.
  `wconfig.GetWatcher().GetFullConfig()` is empty until the watcher starts, so setting the config home alone does
  nothing.
  - The package's `TestMain` (`maintest_test.go`) creates a temp config home with a `settings.json` holding
    `memory:vaultpath` = a temp vault dir, points `wavebase.ConfigHome_VarCache` at it, and calls
    `wconfig.GetWatcher().Start()` before `m.Run()`, as `pkg/jarvisattrib/liveprobe_test.go` already does.
  - A test asserts `memroots.VaultRoot()` is under that temp dir.
  - Any other test package whose tests reach `CaptureRunDispatch` gets the same setup; the worker greps for them.
- **`dag answer` timeout.** A free-text answer is typed one keystroke per character, `agentask.KeystrokeDelay`
  (60 ms) apart (`freeTextKeys`, `proseTextKeys`). The CLI's fixed 10 s budget expires on any answer longer than
  about 150 characters, while the server keeps typing and the answer lands. In t-12's case the `child-answered`
  row came 54 s later.
  - `dagAnswerCmd` computes its timeout as 10 s + (runes of every answer's `Text`) × `KeystrokeDelay` × 2.
  - The server is unchanged, so a typing failure still reaches the caller as an error, and the exit code stays
    truthful.
  - The helper is a pure function with a test: a short answer gets 10 s; an 800-character answer gets
    10 s + 96 s.

## 6. Docs

- `docs/orchestrator-findings-2026-09-25.md`: a new section after "Fixes after the handoff", in the same
  `| # | Fix | Test |` table form, with one row per fix: 20, 28, 26, 22, and the three test-hygiene items.
  - It adds a "Not verified live" note: none of this has run in a live orchestrator run.
  - The note says what the next run after an Arc rebuild should show: staggered `task-spawned` stamps,
    "running a command" in `dag status` during a long test, and no false `stuck?` flags.
  - The 22 thresholds are recorded as unmeasured.
- `docs/orchestrator-guide.md`:
  - The wake table gets a row: "Worker may be stuck (worktree unchanged 20 min while active, or the same failure
    3x)", lead actions: `dag tell`, `retry`, `escalate`, or let it run.
  - The text on `dag status` signals mentions "running a command" and `stuck?`.

## Decisions

- Finding 22 flags on worktree stagnation (20 min while active) or a repeated identical failure (3x); there is
  no token signal.
- A flag wakes the lead once per stuck episode, re-armed by a worktree change. `dag status` shows `stuck?`. There
  is no automatic action and no watchdog agent.
- The worktree fingerprint is `git status --porcelain=v2 --branch` plus the size and mtime of the listed paths,
  checked once a minute per running task, under the dag lock.
- Finding 28 samples CPU on every tick (throttled to 20 s), keeps `LastActivity` transcript-only, adds `BusyTs`
  and `LatestTool`, and prints "running a command Nm · <tool>" or "idle Nm". The cockpit row is unchanged.
- Finding 26: a wake's order is action lines, questions, `Unverified:` caveats, then recaps. A review caveat
  becomes its own line.
- Finding 20 stamps `task-spawned` at each task's spawn return through `AppendRunEventAt`. Spawns stay serial.
- `dag answer`'s CLI timeout scales with the typed length; the server is unchanged.
- The run auditor's report-time checks (Layer 1) and model pass (Layer 2) stay out of scope.
