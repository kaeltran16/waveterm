# Channel data-model scaling, Phase 3: final-stage fix round 1

**Spec:** `docs/superpowers/specs/2026-07-21-channel-data-model-scaling-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/wstore ./pkg/waveobj ./pkg/jarvis ./pkg/jarvisstate ./pkg/jarvisvolunteer ./pkg/consult ./pkg/reporadar ./pkg/orchestrate ./pkg/wshrpc/wshserver`
**Check:** `go build ./pkg/... ./cmd/... && go vet ./pkg/wstore/ ./pkg/jarvis/ ./pkg/wshrpc/wshserver/ && go vet -tags liveprobe ./pkg/jarvis/ && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke attention-cross-channel brief-peek`

## What failed

Final passed `surface-smoke` and `brief-peek` (16 steps) and errored in `attention-cross-channel`:
`advancing run: phase index 1 out of range`.

The scenario is stale, and was before this run. It parks a run at a review gate by completing phases 0
and 1 of a pipeline run and expects `status === "awaiting-review"` with `phases[2]` pending. Runs have
one phase now (`QuickPlaybook`, `DefaultOrchestratorPlaybook` in `pkg/jarvis/run.go`), the plan gate is
gone, and nothing sets a run to `awaiting-review` any more (`recomputeStatus` cannot produce it and
there is no `HoldPhase`). So the second `advancerun` has no phase to act on. This run changed only the
scenario's `getRun` helper (it reads `getchannelruns`); the arrange it fails in is unchanged.

What `GetAttention` still reports for a channel that is not active is an engine DAG's item:
`AttentionDagGate` for a done, unreleased gated task of an `awaiting-review` DAG, and
`AttentionDagBlocked` for a `blocked` DAG (`pkg/jarvis/attention.go`, the `in.Dags` loop and
`dagGateItems`).

### Task 1: attention-cross-channel parks an attention item the engine still produces

**Depends on:** none

**Files:** `scripts/cdp/scenarios.mjs` only. No Go, no frontend source.

The scenario keeps its purpose and its five steps: an item that needs the human, in a channel that is
not the active subject, lights the Jarvis nav badge while the Usage surface is showing. Only how the
item comes to exist changes.

- Replace the two-phase `createrun` + `advancerun` arrange with a run that owns a DAG in the probe
  channel, in a state `GetAttention` reports. `docs/reference/cdp-run-fixtures.md` is the recipe:
  the helpers (`arrangeSheetDagRun` or its parts, the read-write-read-back seeding pattern of
  `seedFinalShots`, `waveService`, `teardownFixtureRun`) already exist in `scenarios.mjs`; reuse them
  and add no parallel copy. A deferred orchestrator run starts no lead. Choose the DAG state (blocked,
  or awaiting-review with a done gated task) by which one a seeded DAG holds reliably against the
  watchdog tick, and say which in the report.
- Step 1 asserts the stored state that was parked (read back over RPC, not assumed from the write).
- Step 2 asserts `getattention` returns an item for that run with the probe channel's id, the kind the
  seeded state produces, and `waitingsince > 0`. It stays ahead of any DOM read, as today.
- Steps 3 to 5 (select `attn-other`, go to Usage, poll the badge, assert it from Usage) stay as they
  are, including the 500 ms poll.
- The second channel (`attn-other`) is still created and removed by the scenario. Teardown removes
  every worker block, both channels and the temp dir it made, and nothing found by label.
- Rewrite the scenario's header comment to describe what it does now. It must no longer mention the
  pipeline, phase 1 or `wsh jarvis hold`.
- Leave the Go side alone: `reviewGateIdx`'s run-level gate path may now be unreachable; report it
  under Found not fixed if so, do not remove it.

**Done when:** with a dev app attached, `task verify:ui -- attention-cross-channel` passes all five
steps twice in a row, and `brief-peek` and `surface-smoke` still pass. If no dev app can be attached
without starting one, say so under Not verified: Final is then the first run.

**Final step that shows it:** `attention-cross-channel` steps 1, 2 and 5, and its screenshot
`cdp-shots/attention-cross-channel.png` (the Usage surface with the Jarvis badge lit).
