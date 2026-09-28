# Orchestrator findings 48 and 49: fix round 1

**Verify:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" node scripts/verify.mjs ./pkg/orchestrate/... ./pkg/jarvis/... ./pkg/wshrpc/...`
**Setup:** `node scripts/worktree-junctions.mjs prepare`
**Check:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go vet ./pkg/orchestrate/... ./pkg/jarvis/... ./pkg/wshrpc/... ./cmd/server/...`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `TestAConflictMidBatchDefersTheBatchVerifyToTheContinue` from leaking a running final stage into the next test, which fails `TestABatchOfOneFailsWithoutBisecting` in the final stage of round 1.

**Architecture:** Test-only. The conflict test finishes every task, so the continue's Verify ticks the dag into `finalizing`. The tick starts the final stage on its own goroutine (`startFinalCommands`, `pkg/orchestrate/final.go`), and the test returns without waiting for it. That goroutine outlives the test. After `t.Cleanup` restores the `planCommand` stub and removes the temp project, it runs the real Verify (`task test`) in the deleted `-final` tree, fails, and sends a "final stage failed" wake. The package-global waker (`newFakeLead`, `wake_test.go`) delivers that wake to whatever test runs next. The leak predates this run: on 790facc8 the goroutine happened to finish while the stubs were still installed. Commit eae12c47 moved the lane-tree removal after the continue's Verify starts. That changed the timing, so the goroutine now outlives the stubs every time.

**Tech Stack:** Go tests in `pkg/orchestrate`.

**Spec:** `C:\Users\kael02\IdeaProjects\waveterm\.waveterm\worktrees\6c7652be-b7d3-424a-87ff-6f3db8b6de9b\docs\superpowers\specs\2026-09-28-orchestrator-findings-48-49-design.md`

## Global Constraints

- No product code changes: the final stage starting once every task has landed is intended behavior.
- Never write Co-Authored-By, Claude-Session or any other attribution trailer.

## Review Focus

- Another test that drives a dag to `finalizing` without waiting for the final stage leaks the same way. Run the whole package three times in one process and check that no test gets a wake it did not cause.

---

### Task 1: The conflict test waits for the final stage it starts

**Depends on:** none

**Files:**
- Modify: `pkg/orchestrate/verifybatch_test.go` (`TestAConflictMidBatchDefersTheBatchVerifyToTheContinue`)

**Interfaces:**
- Consumes: `awaitFinal(t)` (`pkg/orchestrate/final_test.go`), which blocks until one final stage's commands have run, their result is recorded and the dag was ticked; `worktreeDir(project, key)`; `f.projectPath(t)`, `f.ownerID`; `calls.list()` entries carry `dir`.
- Produces: nothing new.

- [ ] **Step 1: Reproduce the failure**

Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/orchestrate/ -run 'TestAConflictMidBatchDefersTheBatchVerifyToTheContinue$|TestABatchOfOneFailsWithoutBisecting$' -count=5`
Expected: FAIL, `verifybisect_test.go: today's wake, got ["wake: the final stage failed on the merged result in round 1 ... chdir ...TestAConflictMidBatchDefersTheBatchVerifyToTheContinue...-final: The system cannot find the path specified." ...]`.

- [ ] **Step 2: Wait for the final stage, and count only the continue's Verify**

In `TestAConflictMidBatchDefersTheBatchVerifyToTheContinue`, install `finalDone := awaitFinal(t)` beside `await := awaitVerify(t)` (before the first `AutoMergeReady`), and call `finalDone()` right after the continue's `await()`. Once the final stage has run, its own Verify is also in `calls`, in the tree `worktreeDir(f.projectPath(t), f.ownerID+"-final")`. Change the `n != 1` assertion after the continue so it counts only calls whose `dir` is not that final tree. Its message stays "the continue's Verify judges both lanes, want 1 run". Keep every other assertion as it is. Add one lower-case why-comment on the `finalDone()` line: every task lands here, so the tick starts the final stage, which must not outlive this test's stubs.

- [ ] **Step 3: Run the pair and the package**

Run: the Step 1 command. Expected: PASS.
Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/orchestrate/ -count=3 2>&1 | grep -E "^(--- FAIL|ok|FAIL)"`. Expected: `ok`, with no `--- FAIL`. If another test fails with a wake or a Verify call it did not cause, find the test that started the leaked stage (the temp dir named in the message) and give it the same wait in this task.

- [ ] **Step 4: Commit**

```bash
git add pkg/orchestrate/verifybatch_test.go
git commit -m "test(orchestrate): the mid-batch conflict test waits for the final stage it starts"
```
