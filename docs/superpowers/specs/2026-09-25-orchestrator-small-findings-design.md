# Orchestrator small findings: attention source, Verify failure excerpt, WOS race, evidence labels

Fixes four findings from `docs/orchestrator-findings-2026-09-25.md` (numbers in brackets). Each is
independent of the others. Finding 10 (edit with the Edit tool) is already shipped: `workerContract`
(`pkg/orchestrate/engine.go:697`) carries the line since a9650e6c, and `engine_test.go:1465` covers it.
No UI code changes; what the UI shows changes only through the data (a shorter source, a `ran` result).

## Decisions (human, 2026-09-25)

- [3] Every attention row that carries a run goal gets the shortened goal as its source, not only ask and
  escalation rows. The classifier keeps the full goal.
- [21] Transcript-derived verification lines get the result `ran` and never `pass`/`fail`. Backend only:
  the frontend shows `ran` through its existing fallback (the `?` badge, counted as unknown).
- [21] A transcript command counts as verification only when a runner leads one of its shell segments,
  so greps and `sed` edits drop out.

## 1. Attention source shows the goal's headline, and the question whole [3]

Today `runWorkerTask` (`pkg/jarvis/resolve.go:204`) returns `"<kind> phase (<skill>) of run goal: <goal>"`
with the whole goal. `ResolveAskOwner` (`watcher.go:120`) returns that one string to two callers:
`handleAsk`, which hands it to the classifier as task context, and `GatherAttentionFromLedger`
(`attention.go:761`), which stores it as the ask's worker name. That name then becomes the `Source` (and
the `Why`) of ask and escalation rows. Gate, land-held and unverified rows (`attention.go:325, 483, 517`)
and `dagSource`'s run fallback (`:690`) put `run.Goal` in `Source` directly. Separately, the CLI row
(`cmd/wsh/cmd/wshcmd-runs.go:730`) prints `Source` in full and clips the question (`Text`) to
`runsGoalWidth` (70).

- `goalHeadline(goal string) string` in `pkg/jarvis/attention.go`, beside `firstLine`: trim the goal, take
  its first line (reusing `firstLine`), trim again, and cut it to `attentionSourceMaxLen = 80` runes with a
  trailing `…` when cut. An empty goal stays empty.
- `resolve.go`: the frame moves into `runWorkerFrame(run, phaseIdx, goal string)`, including the
  out-of-range fallback. `runWorkerTask` becomes `runWorkerFrame(run, idx, run.Goal)` (unchanged output),
  and a new `runWorkerSource` becomes `runWorkerFrame(run, idx, goalHeadline(run.Goal))`.
- `ResolveAskOwner` returns `(channel, task, source)`: for a run worker, `runWorkerTask` and
  `runWorkerSource`; for a concierge worker, the dispatch text and `goalHeadline` of it. `handleAsk`
  takes `task`, and the attention builder takes `source`. One resolution serves both callers.
- Every `Source: run.Goal` in `BuildAttention`'s rows, and `dagSource`'s return values (title or goal),
  go through `goalHeadline`.
- CLI: `runsAttentionLines` clips `Source` to `runsGoalWidth` and prints `Text` whole, flattened to one
  line (whitespace runs collapse to one space, the same normalization `runsClip` does) but not cut.
  `--json` needs no CLI change: the server already sends the short source.

Tests: `goalHeadline` (multi-line goal, a first line over 80 runes, a leading blank line, short and empty
goals); `runWorkerTask` still carries the full goal, and `runWorkerSource` carries only the headline;
`BuildAttention` with a multi-line, >80-rune goal gives a short `Source` on gate, escalation, ask, land-held
and unverified rows; `runsAttentionLines` keeps a 200-character question whole and clips a long source.

## 2. A failed Verify keeps the lines that name the failure [25]

Today `execPlanCommandEnv` (`pkg/orchestrate/plancmd.go:124`) writes the command's output into a
`tailBuffer` that keeps only the last `MaxPlanOutputLen` (8000) bytes. A noisy failing Go package pushes
its `--- FAIL: TestX` block out of that window. `firstFailureExcerpt` (`:61`) then tries `failureMarkers` in
order per line, and `FAIL` is listed before `--- FAIL`. The detail therefore opens at the bare
`FAIL` summary.

- `tailBuffer` also scans the full stream, line by line, and keeps failure blocks:
  - a line whose trimmed text starts with `--- FAIL:` opens a block. Each following line that begins with
    whitespace (the test's indented log and assertion output) continues it. A line that does not begin with
    whitespace closes it.
  - a line that starts with `panic:` opens a block of that line plus the next `panicBlockLines = 20` lines
    (the goroutine trace).
  - a line that starts with `FAIL` followed by a tab or space and more text (go test's per-package
    `FAIL\t<pkg>\t<time>`) is kept as a one-line block.
  - a line split across `Write` calls is joined before it is scanned, and a trailing `\r` is dropped.
  - blocks are kept earliest first, up to `MaxFailureBlocksLen = 4000` bytes in total. Once that budget is
    spent, later blocks are dropped.
- On a failed command, the recorded output (`planCommandError.output`, and so `VerifyOutput`,
  `VerifyError` and the event detail) is the kept blocks, a `…` separator line, and then the tail. The
  tail's front is cut so the whole fits in `MaxPlanOutputLen`. When nothing was dropped from the tail
  (the total output fit), the output is the tail alone, so nothing is duplicated. A passing command and
  the progress publishing keep today's tail-only behavior.
- `firstFailureExcerpt` searches in two tiers: first the whole output for a line opening with `--- FAIL` or
  `panic:`, then, only if there is none, today's remaining markers (`FAIL`, `error:`, `assert`). So the
  wake and event detail starts at the first failing test.
- `VerifyLastLine` (the status row) stays the output's last line, which is still the tail's.

Tests (in `plancmd_test.go`): a stream with a `--- FAIL: TestX` block and its indented assertion, then more
than 8000 bytes of unindented log noise, then `FAIL\tpkg\t1.0s`: the output keeps the block and the
summary, and `failureDetail` starts `exit 1: --- FAIL: TestX`. A block split across two writes is kept whole.
A `panic:` block keeps the trace lines. The block budget caps the kept bytes. A short failing output is
not duplicated. A passing command still returns the tail only. The excerpt prefers a later `--- FAIL` over
an earlier bare `FAIL`. One case runs through `execPlanCommand` with a real shell (`printf`) and exit 1.

## 3. A pushed update wins over an older in-flight fetch [24, WOS part only]

Today `createWaveValueObject` (`frontend/app/store/wos.ts:173`) stores the fetch in `wov.pendingPromise`
and drops a result only when `pendingPromise` no longer points at that fetch. `updateWaveObject` (`:285`)
sets the atom from a pushed update but leaves `pendingPromise` alone. A fetch that started before the
object existed (so it returns `null`) and resolves after the update therefore overwrites the update.
Nothing refetches after that.

- `updateWaveObject` sets `wov.pendingPromise = null` before it writes the atom, in both the update and
  the delete branch. The late fetch then fails the existing guard and is dropped. `loadAndPinWaveObject`
  returns the pushed value, since it reads the atom when nothing is pending.
- The engine-side ordering (save the child run before spawning its tab) is out of scope.

Tests: a new `frontend/app/store/wos.test.ts` mocks the fetch boundary (`@/util/fetchutil`'s `fetch`,
which `callBackendService` uses; WOS internals are not stubbed) with a deferred response. It checks three
cases. A fetch in flight, then a pushed update, then the fetch resolving `null`: the atom holds the update.
A pushed delete during a fetch that resolves with an object: the atom holds `null`. A fetch with no update
still lands its value.

## 4. Sealed evidence labels transcript commands as what the worker ran [21]

Today `isVerifCommand` (`pkg/jarvis/evidence.go:43`) accepts a command with a verification word anywhere
and a runner token anywhere, so a grep with `--include=*.go` qualifies. `classifyVerif` (`:49`) calls it
`pass` when the tool result is not an error and has output, and a pipe (`go test … | tail -3`) hides the
exit code. Only `dagVerifs` (`:343`) reads real exit codes, from the engine's own Verify runs.

- `isVerifCommand` splits the command into segments on `&&`, `||`, `;`, `|` and newlines. In each segment
  it skips leading `NAME=value` assignments and takes the first word's base name (without a `.exe`
  suffix). A segment qualifies when that word is in the runner set and the segment matches
  `verifPattern`. The command qualifies when any segment does. The runner set gains `node` (for
  `node … tsc.js`) and `task`. This is still a heuristic: a `|` inside a quoted argument splits there
  too, which at worst drops a line.
- Every transcript-derived line gets `Result: "ran"` (a named constant), whether or not the tool result
  is an error or empty. `Detail` keeps today's runner summary line (`verifSummaryLine`), so `ok pkg`,
  `FAIL pkg` or `12 passed` still shows. `dagVerifs` keeps `pass`/`fail`.
- The `EvidenceVerif.Result` comment in `pkg/waveobj/wtype.go` lists `ran`. Sealed evidence is
  immutable, so older runs keep their `pass`/`unknown` lines. If the comment reaches a generated file,
  run `task generate` and commit what it writes.
- Consequences, accepted: radar's `VerifsPass`/`VerifsFail` (`pkg/reporadar/investigation.go:35`) count
  only engine Verify results, so a run with no dag reports none. The run-completion surface and the run
  sheet count `ran` as unknown. `wsh runs show` prints `verify   ran  <cmd>`.

Tests (in `evidence_test.go`; existing `pass`/`fail`/`unknown` expectations for transcript lines move to
`ran`). The four commands from the finding: the grep is not verification; the piped `go test … | tail -3`
and the `sed -i … && … && go build …` chain are verification and read `ran`. Also: `CGO_ENABLED=0 go test`,
`cd x && npm test`, `node … tsc.js --noEmit`, and `git commit -m "test: add auth"` (not verification). An
errored `go test` reads `ran` with its `FAIL` summary as detail. A dag run's sealed evidence still carries
`pass`/`fail` from `dagVerifs`.

## Out of scope

The engine-side spawn ordering of finding 24; a pipefail line in the worker brief (finding 21's optional
direction); the other findings in the document.
