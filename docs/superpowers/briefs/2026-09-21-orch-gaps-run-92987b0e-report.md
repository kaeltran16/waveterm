# Run 92987b0e report: orchestrator gaps (nine-fixes plan)

Plan: `docs/superpowers/plans/2026-09-21-orch-gaps-nine-fixes.md`. Dag 404763f4: 8 of 8 tasks done, 0 failures, 42m.

## Landed
- t-1 dead-process lead treated as lead-free (240f5049)
- t-2 cleanup debt degrades after five failed retries (31e7d685)
- t-3 stalled task auto-retried once with no lead; a busy worker's CPU counts as activity (d5169449)
- t-4 relaunch a dead lead from its lead-wake-failed row (b4ff9ee0)
- t-5 merge Verify output kept on pass and shown live in the DAG peek (91d71d49)
- t-6 failing Verify detail cut from the first failing stage (91d71d49, squashed with t-5: they shared a lane)
- t-7 dead run's worker no longer relaunches; live one resumes; a running task with no controller stalls (b4ff9ee0)
- t-8 Claude attribution lines kept out of worker commits (d5169449; NoAttributionRule in pkg/jarvis/leadprompt.go reaches the worker and lead prompts from one constant)

Lead commits: b4ff9ee0 (t-7 merge fixes), e8592ec5 (orchestrator-guide.md: removed the gaps this run closed).

## Not landed
- Plan Task 9 (a successful engine launch reports itself as a failure: `CreateRunCommand` has no RpcOpts timeout, so the 5s default binds the handler ctx) was never in the dag. The dag had 8 tasks.

## Verified (final tree)
- `go test ./pkg/orchestrate ./pkg/jarvis ./pkg/wshrpc/...` pass
- `npx vitest run frontend/app/view/orchestrate frontend/app/view/agents/session-models`: 259 pass
- `task check:ts` equivalent (tsc, stack-size 4000): exit 0
- Not run: the plan's full Verify (`go test ./pkg/... ./cmd/...`, full vitest) on the merged tree beyond the engine's own run; wsh linux cgo-free build (plan Check).

## Answered / forwarded
None.

## Merge conflict (t-7 lane, engine_test.go)
Kept both sides. Merged tests then failed from lane interaction, fixed in test code only: shared-DB `lead-tab` oid collision (cleanup added), `workerControllerGone` defaulted to false in TestMain (fixtures store worker tabs with no controller; outcome tests failed otherwise), and a live lead in the t-7 stall test (t-3 would otherwise auto-retry the stall).

## Needs a live check (unit-tested only)
- Kill the machine or the app mid-run: workers with no controller go stalled at once, are auto-retried once, then wait for a human.
- Relaunch lead button on a Lead wake failed row: replacement lead gets the missed events and wakes resume.
- Verify output visible live in the DAG peek and kept on pass; elapsed ticks.
- Reopen a live worker tab: resumes via `--resume`; a dead run's worker tab does not relaunch.
- Auto-retry: a stalled task with no live lead is retried once; a second stall is left alone.

## Open issues
1. Plan Task 9 (launch reported as failure) is unbuilt.
2. Resolved after the run: the "Orchestrator guide gaps and rough edges" effort (5d11f853) is in the packaged app's store, not the dev app's, which is why the lead could not see it — the two instances keep separate databases. Its eleven chunks were ticked by hand from a terminal routed to the packaged app (26/42 → 37/42). Effort b89f1411, created here for the open issues, lives in the dev store.
3. Live checks above.
4. `workerControllerGone` is a package var stubbed by TestMain; a future test that wants real controller state must restore it.
5. Docs: `docs/orchestrator-guide.md` may still describe the pre-run Check/Verify wording elsewhere; only the passages for closed gaps were edited.
6. Uncommitted, not mine: edits to `docs/superpowers/briefs/2026-09-18-orchestrator-cost-quality-control.md` and the plan file (the plan edit is Task 9, which folds into the commit that builds it).
7. The lane commit ids this report first cited for t-4 through t-7 (fc0b9760, 86415dff, 9e1b8d25, f196daa9) do not exist on `main` — the merge rewrote them. Corrected above to the commits that carry the work. This is chunk #37 on effort 5d11f853, "Arc's stored runs and this tracker cite pre-rewrite commit ids", recurring in the run's own report.
