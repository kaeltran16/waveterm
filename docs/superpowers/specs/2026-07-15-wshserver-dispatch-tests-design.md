# wshserver command-dispatch tests — design

Date: 2026-07-15
Status: design (spec)
Scope owner: backend / `pkg/wshrpc/wshserver`

## Goal

Add table-driven Go tests around `wshserver.go`'s command handlers before the next feature
lands, prioritizing the handlers touched by two recent commits:

- **cancel-run** — `d207ac3c` *fix(runs): Cancel run terminates its live Claude workers*
  (added `stopRunWorkers`, extended `CancelRunCommand`).
- **usage-stats** — `70bbf499` *feat(agents): per-session token-usage breakdown* (added
  `GetTranscriptUsageCommand` + the `Bucket → wshrpc.UsageBucket` adapter).

These two clusters are the regression-risk hot spots: both are recent, both are hand-written
adapter/side-effect code over already-tested lower layers, and neither handler method has a
direct test today.

## What "command dispatch" means here

Each exported `func (ws *WshServer) XxxCommand(ctx, data) (...)` method **is** a dispatched
wshrpc command — the frontend/wsh reach it through `wshrpc` routing, and the method is the
server-side entry point. Testing "command dispatch" therefore means constructing `&WshServer{}`
and calling the handler method directly with a crafted `data` struct, then asserting on the
returned value/error and any persisted side-effect.

This matches the existing convention in the package:

- `maintest_test.go`'s `TestMain` points the wave data dir at a throwaway temp dir and runs the
  embedded wstore SQLite migrations, so DB-backed handlers run against a real empty store.
- `projects_test.go`, `wshserver_profile_test.go`, and `wshserver_run_test.go` already
  instantiate `&WshServer{}` and call handler methods / package helpers directly.

We extend that convention; we do not introduce a new harness.

## Scope decision (assumption — flag if wrong)

Tests target the **dispatch/adapter contract** of each handler:

1. **Argument validation** — the `if data.X == "" { return err }` guards that every command
   opens with. This is the actual dispatch contract and is pure and deterministic.
2. **Error wrapping** — a downstream error surfaces as a non-nil, context-carrying error (the
   `fmt.Errorf("...: %w", err)` wrappers), and a benign downstream result surfaces cleanly.
3. **Struct field-mapping** — the hand-written field-for-field copies (`Bucket → UsageBucket`,
   cache-write → rtn) map every field to the correct slot. These copies are the classic
   swap-a-field regression and have no other guard.
4. **Best-effort / idempotent side-effects** — specifically the behavior the cancel-run commit
   introduced: `stopRunWorkers` and `CancelRunCommand` must be no-ops on bad/absent workers and
   must flip persisted state as documented.

**Explicitly out of scope, with rationale:**

- **Re-testing downstream pure logic.** `pkg/usagestats` already has thorough table tests for
  the parsers/bucketers (`TranscriptUsage`, `SumTranscript`, `LastCacheWrite`, `WindowTokens`,
  `extractClaude/Codex`, `dedupe`, `bucket`). `pkg/jarvis` owns the run engine transitions
  (`CompletePhase`, `ApproveGate`, `CancelRun`, …). Duplicating those assertions here would
  violate DRY and single-source-of-truth. The wshserver test asserts the *adapter*, using at
  most one realistic fixture as a mapping guard.
- **Worker-spawning happy paths.** `CreateRunCommand` and the spawn branch of
  `AdvanceRunCommand` call `spawnRunWorkers → jarvis.EnsureWorkers → blockcontroller`, which
  launches real `claude` processes and mutates tabs/blocks. There is no process-mock seam today,
  and building one is out of proportion to the goal (YAGNI). We cover these handlers' *validation
  and error* branches only, and note the spawn path as an untested seam.
- **Streaming commands** (`ConsultCommand`, `JarvisCommand`, `StreamAgentTranscriptCommand`) —
  not touched by either commit; out of scope.

Rationale summary: KISS/YAGNI, tests must be hermetic and deterministic (no network, no spawned
processes, no dependence on `~/.claude`), and we do not abstract for a single use.

## Test targets

### Cluster A — cancel-run (extend `wshserver_run_test.go`)

| Target | Kind | Cases (table rows) |
|---|---|---|
| `CancelRunCommand` | validation + state | empty `ChannelId` → err; empty `RunId` → err; seeded channel+run, no workers → no err, run status flips to `cancelled`, no panic; unknown channel/run → error surfaced (wrapped) |
| `stopRunWorkers` | best-effort/idempotent | run with no phases → no-op; phase with empty `WorkerOrefs` → no-op; malformed oref (`"garbage"`, non-`tab:` oref) → logged no-op, no error, no panic; oref to a missing tab → no-op; seeded `tab:<id>` with a block (no live controller) → block's `cmd:runonstart` flipped to `false`, `DestroyBlockController` is a safe no-op |
| `applyRunAction` (extend existing) | pure dispatch table | one row per action: `Complete`, `Approve`, `SendBack`, `Hold`, `Triage`, and `""`/unknown → error. (Currently only `Triage` and unknown are covered.) Assert the correct `jarvis` transition is invoked and the returned run reflects it; do not re-assert deep engine semantics. |
| `AdvanceRunCommand` | validation | empty `ChannelId` → err; empty `RunId` → err. (Post-validation happy path spawns workers → out of scope.) |
| `ReportRunPhaseCommand` | validation + fail-safe | empty `ORef` → err; well-formed oref that no run owns → returns `nil` (stray report is a no-op, not an error) |

Key grounding facts (verified in source):

- `wstore.CreateChannel(ctx, name, projectPath)`, `AppendRun(ctx, channelId, run)`,
  `GetRun(ctx, channelId, runId)`, `UpdateRun(ctx, channelId, runId, fn)` exist and are the
  seed/read helpers.
- `jarvis.NewRun(goal, ws, projectPath, principles, mode, playbook, tsMillis)` builds a run
  (used already in `wshserver_run_test.go`).
- `stopRunWorkers` clears `waveobj.MetaKey_CmdRunOnStart` via `wstore.UpdateObjectMeta` then
  calls `blockcontroller.DestroyBlockController`, which returns early when no controller is
  registered (`blockcontroller.go:314-318`) — so a DB-only seeded block makes the whole path a
  safe no-op except the persisted meta flip, which is exactly what we assert.

### Cluster B — usage-stats (new file `wshserver_usage_test.go`)

| Target | Kind | Cases (table rows) |
|---|---|---|
| `GetTranscriptUsageCommand` | field-mapping + passthrough | temp Claude transcript (opus+haiku fixture) → buckets mapped field-for-field into `wshrpc.UsageBucket` (Provider/Model/Day/Input/Output/CacheRead/CacheCreate/CacheCreate1h/Msgs all in the right slot); temp Codex rollout → provider `codex`, cache-write class zero; missing file → empty `Buckets`, no error |
| `GetTranscriptTokensCommand` | passthrough + missing | temp transcript → token total passed through; missing file → `0`, no error |
| `GetCacheStatusCommand` | mapping + nil-branch | transcript with a 1h cache write → `LastWriteTs = TS.Unix()`, `OneHour = true`; no-cache transcript → zero-value rtn (`LastWriteTs == 0`), no error |
| `GetWindowTokensCommand` | mapping | cutoffs map `sums[0] → FiveHourTokens`, `sums[1] → WeekTokens` |
| `cutoffFromEpoch` (helper) | pure table | `0 → zero time`; negative → zero time; positive `sec` → `time.Unix(sec, 0)` |

`GetUsageStatsCommand` note: it shares the identical `Bucket → UsageBucket` copy block with
`GetTranscriptUsageCommand`, but its source (`usagestats.ScanUsage`) reads the real `~/.claude` /
`~/.codex` roots and takes a window in days — not hermetically seedable without a roots-injection
seam that doesn't exist. Since the mapping is proven by `GetTranscriptUsageCommand`, we **do not**
add a fragile environment-dependent test for it; we record it as sharing the covered mapping.

Fixtures: reuse the exact JSONL line shapes already proven in
`pkg/usagestats/usagestats_test.go` (`TestTranscriptUsage`, `TestLastCacheWrite`), written to
`t.TempDir()` files. This keeps a single source of truth for "what a transcript line looks like."

## Test structure / conventions

- **Style:** table-driven subtests via `t.Run(tc.name, ...)`. Validation tables are
  `[]struct{ name string; data <CmdData>; wantErr bool }`. Mapping/side-effect tables use a
  per-row `assert func(t, got, err)` or explicit field checks, matching the existing
  `wshserver_profile_test.go` and `usagestats_test.go` idiom.
- **Server construction:** `ws := &WshServer{}` per test; `ctx := context.Background()`.
- **DB isolation:** the shared `TestMain` already bootstraps one SQLite store for the package.
  DB-backed rows use unique channel names per test (e.g. `"cancel-noworkers-chan"`) so tests
  don't collide — the store is shared across the package run, matching the existing
  `wshserver_profile_test.go` pattern (it creates freshly-named channels per test).
- **No new dependencies, no new production code.** Handlers are tested as-is. If a handler proves
  genuinely untestable without a seam (e.g. `GetUsageStatsCommand` roots), we document the seam
  in this spec rather than refactor speculatively.
- **File layout:** cancel-run rows extend the existing `wshserver_run_test.go`; usage rows go in a
  new `wshserver_usage_test.go`. Both live in `package wshserver` and share the one `TestMain`.

## Success criteria

1. `go test ./pkg/wshrpc/wshserver/` passes, including the new rows.
2. Every validation guard listed above has a table row asserting the guard fires (and one
   asserting a valid input passes the guard).
3. `stopRunWorkers` has explicit coverage for: no-op on bad/absent workers, and the persisted
   `cmd:runonstart=false` flip on a seeded worker block — the exact behavior `d207ac3c` added.
4. The `Bucket → wshrpc.UsageBucket` field mapping is guarded against field-swap regressions by
   at least one realistic fixture.
5. No test depends on the network, a spawned process, real `~/.claude`/`~/.codex` data, or wall
   time (fixtures carry fixed timestamps).
6. New tests do not duplicate assertions already owned by `pkg/usagestats` or `pkg/jarvis`.

## Risks / open questions

- **Shared package store:** the single `TestMain` store is shared across all tests in the
  package. Mitigation: unique object names per test (already the established pattern); no test
  asserts global counts.
- **`applyRunAction` depth:** rows should assert the *transition was dispatched* (e.g. `Approve`
  moves the gate), not re-derive full engine semantics — that boundary keeps this test from
  becoming a shadow copy of the `jarvis` engine tests. Flagged so implementation stays shallow.
- **`GetUsageStatsCommand` seam:** left uncovered by choice (see Cluster B note). If a future
  change makes its roots injectable, add a row then — not now.
