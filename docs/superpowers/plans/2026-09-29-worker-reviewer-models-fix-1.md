# Worker and reviewer models: fix round 1

**Verify:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" node scripts/verify.mjs ./pkg/jarvis/... ./pkg/orchestrate/... ./pkg/wshrpc/... ./pkg/waveobj/... ./cmd/wsh/...`
**Check:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go vet ./pkg/wshrpc/... ./cmd/wsh/...`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke new-run-window model-picks`

**Spec:** `docs/superpowers/specs/2026-09-29-worker-reviewer-models-design.md`, sections 1 and 7. The workers
setting is one pair: Reviewer picks, or a worker route. A caller that names either part owns both.

## Global Constraints

- Edit only the files named in the task. No wire change, no `task generate`.
- `gofmt -l` only the files you touched; never `--write` the tree.
- Comments say why, never what, and only when necessary.
- Commit messages: `type(scope): description`. No attribution trailers of any kind.

---

### Task 1: `wsh runs start --worker-runtime` owns the whole workers setting

**Depends on:** none

The final verifier found this defect. `wsh runs start --worker-runtime R [--worker-model M]` is refused
whenever the project's resolved profile is on Reviewer picks:

- `runsStartData` (`cmd/wsh/cmd/wshcmd-runs.go`, the `if o.workerRuntime != ""` block) sets `s.WorkerRoute`
  and leaves `s.ReviewerPicks` nil.
- `CreateRunCommand` (`pkg/wshrpc/wshserver/wshserver_runs.go`) reads a nil `ReviewerPicks` as "use the
  profile's workers setting". It keeps the caller's route, takes `ReviewerPicks=true` from the profile, and
  `validateWorkersSetting` refuses the pair.

Fix it on the caller's side, which is the contract `CommandCreateRunData.ReviewerPicks` already documents:
"non-nil = the caller owns it". Leave the server unchanged.

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-runs.go` (`runsStartData`)
- Test: `cmd/wsh/cmd/wshcmd-runs_reviewer_test.go` (add cases to `TestRunsStartDataReviewerFlags`)
- Test: `pkg/wshrpc/wshserver/wshserver_reviewer_settings_test.go` (add one case to `TestCreateRunReviewerPicksInheritance`
  reuse the package's helpers `boolPtr`, `createEngineRun` and so on; declare no new
  top-level helper whose name is already taken in that package)

- [ ] **Step 1: Write the failing CLI tests.** Add these cases to `TestRunsStartDataReviewerFlags`:
  - `"a worker runtime owns the workers setting"`: `runsStartOpts{goal: "g", mode: orch, workerRuntime: "pi", workerModel: "m"}`.
    Expect `d.WorkerRoute` to equal `{pi m}`, and `d.ReviewerPicks` to be non-nil and false.
  - Keep the existing `"no workers flag leaves the profile's setting"` case, which expects `ReviewerPicks` to stay nil.
- [ ] **Step 2: Write the failing server test.** In the wshserver test file, add a CreateRun case: the profile has
  `ReviewerPicks=true`, and the request has `WorkerRoute={claude, <a model the test's harness stub accepts>}` and
  `ReviewerPicks=boolPtr(false)`. Expect success, the run on that route, and `run.ReviewerPicks == false`.
  Use the case's existing setup pattern. This case pins the contract the CLI now relies on. If it already
  passes before Step 3, that is fine: it guards the server side.
- [ ] **Step 3: Run the tests.** Run `go test ./cmd/wsh/cmd/ -run TestRunsStartDataReviewerFlags` and expect the
  new CLI case to FAIL, with `ReviewerPicks` nil.
- [ ] **Step 4: Implement.** In `runsStartData`, inside the `if o.workerRuntime != ""` block, also send
  `ReviewerPicks` as false. A worker route is the whole workers setting, so the profile's Reviewer picks must
  not fill the other half:

```go
	if o.workerRuntime != "" {
		s.WorkerRoute = &waveobj.RoutePin{Runtime: o.workerRuntime, Model: o.workerModel}
		noPicks := false
		s.ReviewerPicks = &noPicks // a worker route is the whole workers setting; the profile's picks must not fill it in
	}
```

- [ ] **Step 5: Run the tests again.** Run `go test ./cmd/wsh/cmd/ ./pkg/wshrpc/wshserver/` and expect PASS.
- [ ] **Step 6: Commit** `fix(runs): wsh runs start --worker-runtime owns the whole workers setting`.
