# Start-at-done round 1: discard a restarted lane's tree when its head is skipped

**Effort:** effort:78e4fe20-5d7c-4701-9360-8dd67c792731
**Spec:** `docs/superpowers/specs/2026-11-06-start-at-done-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/orchestrate ./pkg/jarvis ./pkg/waveobj ./pkg/wshrpc/... ./cmd/wsh/cmd`
**Check:** `go vet ./pkg/orchestrate ./pkg/jarvis ./pkg/waveobj ./pkg/wshrpc/... ./cmd/wsh/cmd`

**Goal:** a restarted early lane whose head is skipped or cancelled still has its tree and branch discarded before
its next task runs.

**Architecture:** one change in `restartLane` (pkg/orchestrate/earlystart.go) plus its test. Spec decision 5 ("the
tree is discarded at the next dispatch") is unchanged; this fixes where the flag lands.

**Tech Stack:** Go (pkg/orchestrate), real git in the test via `newMergeFixture`.

## Global Constraints

- A restart is never a failure: `g.Failures` and `Attempts` stay as they are.
- Locate code by symbol, not line number. Comments say why, lower case, only when needed.

## Review Focus

- A lane whose head was skipped by the lead after its early start, with a later lane task running, must not keep
  working on the branch that holds the base's rejected commits, and must not merge it (Task 1 test).

---

### Task 1: DiscardTree on the first task the restart sends back to pending
**Files:** `pkg/orchestrate/earlystart.go`, `pkg/orchestrate/earlyrestart_test.go`

The defect: `restartLane` sets `DiscardTree` on `head` (`lane[0]`), but a skipped or cancelled head keeps its state
and is never dispatched, and `dispatchTasks` (engine.go) runs `discardLaneTree` only for the task it dispatches. So
the lane's next task re-dispatches on the existing branch `wave/<key>` (`earlyTreeBase` takes it for a retry), which
still holds the base's rejected commits; and because the restart cleared the head's `EarlyBase*`, the lane no longer
waits for the base lane's merge (`earlyBaseUnmerged`), so it can squash those commits onto the project branch.

- [ ] In `restartLane`, set `DiscardTree = true` on the first task in `ids` (the first lane task the restart sent
  back to pending), not on `head`. When `ids` is empty (every lane task skipped or cancelled) set it on nothing: no
  task will dispatch on the branch. `EarlyRestarts`, `RestartTs` and the cleared `EarlyBase*` stay as they are (the
  record and the count live on `head`, which `earlyBaseUnmerged` and the digest read).
- [ ] Test in pkg/orchestrate/earlyrestart_test.go, `TestRestartWithSkippedHeadDiscardsTreeForNextTask`, on
  `newMergeFixture` like `TestDispatchDiscardsTreeBeforeRebranching`: a two-task early lane H -> H2 based on lane A,
  H `skipped`, H2 `running` on the lane's branch; A goes back to `pending` with `ReviewRound > 0`. After the tick:
  H2 is `pending` with `DiscardTree` true, H is still `skipped` with `DiscardTree` false. At H2's next dispatch the
  old branch is gone and the new tree's HEAD is not the old branch's commit (the base's rejected commits are not in
  it).
- [ ] Update `TestRestartKeepsSkippedTask` only if it asserts `DiscardTree` on a skipped head.
- [ ] Run `go test ./pkg/orchestrate -run 'TestRestart|TestPredecessor|TestDispatchDiscards' -count=1`.
