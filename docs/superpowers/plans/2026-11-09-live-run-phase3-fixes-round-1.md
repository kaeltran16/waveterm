# Live-run states phase 3 fixes, round 1 Implementation Plan

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close what the phase 3 run left open: a held merge gate still reads stale and asks for attention, the
human's and the lead's retry rows bend the engine's retry evidence, and two stale texts.

**Architecture:** One Go task in the digest and one frontend task in the recovery line; they share no file.

**Tech Stack:** Go (pkg/orchestrate), React 19 + vitest, CDP scenarios.

**Spec:** `docs/superpowers/specs/2026-11-09-live-run-phase3-fixes-design.md` (D3 actor rows, D5, D6).
**Verify:** `node scripts/verify.mjs ./pkg/orchestrate ./pkg/wshrpc/wshserver ./pkg/jarvis ./pkg/waveobj ./cmd/wsh/cmd`
**Check:** `go vet ./pkg/orchestrate ./pkg/wshrpc/... ./pkg/jarvis ./pkg/waveobj ./cmd/wsh/cmd && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs lead-card-merge-gate agent-tree-rail cockpit-rail-help run-sheet-polish dag-peek brief-live-initiative doc-review`

## Global Constraints

- **CDP port:** never attach to CDP :9222 and never run `task verify:ui` against the default port. See a scenario
  only in an isolated app: `ARC_FINAL_OUT=<a new temp dir> node scripts/cdp/final-verify.mjs <scenario...>`.
- **Existing steps and tests:** never lower an existing bar; never renumber a step.
- **Actor rows:** since D3, `task-retried` rows written by `ApplyAction` carry `by` (`"human"` or `"lead"`) and
  `auto: false`; the engine's own retries carry no `by`. That field alone tells them apart.

## Review Focus

- A held tip whose gate is older than `MergeGateStaleAfter` neither counts in `Counts.Attention` nor turns health
  away from healthy, while the same tip once its holder clears (ready again) does. Task 1 tests both.
- A task that failed terminally and was then retried by the human still reads its last failure kind in the recovery
  line. Task 2 tests it.

---

### Task 1: Digest: a held gate is never stale; retry evidence is the engine's
**Depends on:** none
**Files:** `pkg/orchestrate/digest.go`, `pkg/orchestrate/digest_test.go`, `pkg/orchestrate/verify_test.go`

Spec D6 ("a held gate asks nothing of you"), D3.

- [ ] **Stale gate (D6):** `staleMergeGates` (or its caller in `BuildDigest`) leaves out a tip with a holder
  (`mergeHeldBy(g, t) != ""`), so a held tip is never in `Counts.Attention`, `taskAttention` or health's stale-gate
  reason. A held tip keeps its `MergeGateTs` (the row may still show how long it has waited). Tests in
  `digest_test.go`: `TestHeldMergeGateIsNeverStale` (a tip done past `MergeGateStaleAfter`, held by a verifying task:
  attention 0, health not degraded by the gate, `MergeGateTs` still set) and, in the same test, the holder moved to
  done: the tip is stale again and counts 1. `TestStaleMergeGateNeedsYou` stays as it is.
- [ ] **Retry evidence (D3):** `retriedTaskSet` counts only `task-retried` rows with no `by` key, so a done task the
  human or the lead retried does not read `RecoveredRetry`. Test: `TestRecoveredRetryIgnoresActorRetries` (one row
  with `by: "human"`, one with `by: "lead"`, one engine row on a third task: only the third is recovered, and
  `Counts.RecoveredRetry` is 1).
- [ ] **Comment:** the comment above `TestAManualMergeWaitsOnItsDependencysFailedVerify` in `verify_test.go` still says
  the lead's merge "still lands a lane that depends on nothing failing". Reword it to what the test now asserts (a
  failed Verify holds every manual merge of the dag, D6/D7). Comment only; no code line in that file changes.
- [ ] **Done when:** `go test ./pkg/orchestrate -run 'MergeGate|RecoveredRetry|TestAManualMergeWaitsOnItsDependencysFailedVerify|Digest'`
  passes and Check is clean.

### Task 2: Recovery line reads the engine's retries; L8's name
**Depends on:** none
**Files:** `frontend/app/view/orchestrate/recoverysummary.ts`, `frontend/app/view/orchestrate/recoverysummary.test.ts`, `scripts/cdp/scenarios-runs.mjs`

Spec D3, D5.

- [ ] **Recovery (D3):** `recoverySummary(events, taskId)` skips `task-retried` rows that carry `by`: a human's or
  lead's retry has no `kind` or `attempt`, and counting it overwrote the last failure kind with nothing and skewed
  `partial`. Tests in `recoverysummary.test.ts`: a `task-failed` row (`lastfailurekind: "verify", attempts: 3`) with
  two engine retries (`attempt` 1, 2), then a newer `task-retried {taskid, auto: false, by: "human"}`, gives
  `{ retries: 2, lastFailureKind: "verify", partial: false, terminalFailure: true }`; a task with only a human retry row
  returns `null`.
- [ ] **L8's name (D5):** step L8 in `lead-card-merge-gate` is named "…a failed Verify shows its first line (F8)",
  but since D5 it shows the Verify failure line. Rename the text to "…a failed Verify shows its failure line (F8)",
  keeping the "L8." prefix and the step's assertions as they are.
- [ ] **Done when:** `npx vitest run frontend/app/view/orchestrate/recoverysummary.test.ts` passes, Check is clean, and
  `lead-card-merge-gate` passes in an isolated app.
