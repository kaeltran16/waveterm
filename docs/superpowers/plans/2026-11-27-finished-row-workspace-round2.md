# Finished-row workspace: round 2 fix

Round 1's final stage stopped at Verify on one test that was already failing on the base. Commit 5695cd10c (2026-11-27,
"plan commands yield the CPU, except Final") added `TestPlanCommandPriorityByCommand`, whose Final case asserts that a
Final command's child runs at the "Normal" priority class. Under the engine, `go test` itself runs inside Verify's job,
which carries the below-normal priority class, and a Final command's job sets no class, so its child inherits
"BelowNormal" from the test process. The assertion holds only when the test is started at normal priority by hand. In
production wavesrv runs at normal priority, so Final's child is "Normal" there. The test is wrong; the code is not.

### Task 1: The plan-command priority test holds when its own process is lowered
**Depends on:** none
**Files:** `pkg/orchestrate/plancmd_owner_windows_test.go`

**What to build:** `TestPlanCommandPriorityByCommand` states what the code decides rather than the class of the
process that happens to run the test. Verify's child runs at "BelowNormal". Final's job does not lower priority, so
Final's child runs at the test process's own priority class, read at test time. A test-only change; `yieldsCPU`,
`plancmd_windows.go` and `jobobject` are unchanged.

**Acceptance:**
- `go test ./pkg/orchestrate -run '^TestPlanCommandPriorityByCommand$'` passes when started at normal priority, and also
  when started at below-normal priority (for example from a PowerShell process whose `PriorityClass` was set to
  `BelowNormal`, or `start /belownormal` from cmd), with both subtests running rather than skipping.
- The Verify case still fails if `yieldsCPU` stops lowering Verify's job while the test runs at normal priority.
