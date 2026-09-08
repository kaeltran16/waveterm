# Jarvis orchestrator reliability review

Status: reliability findings 1-4 fixed and verified (2026-09-08); visibility findings 5-9 confirmed real at
source but not implemented. Tracked as Wave effort `ade867bd` (project `waveterm`).

## Verification boundary

- Reviewed the current scheduling, task-state derivation, outcome handling, and watchdog code in `pkg/orchestrate/`.
- `go test ./pkg/orchestrate` passed during the review.
- The findings below come from code inspection, not dedicated reproductions. Add regression tests to confirm each failure path before implementing fixes.
- Source line numbers refer to the reviewed snapshot and may drift.

## 1. Circuit breaker does not prevent dispatch

**Priority:** high

**Sources:** `pkg/orchestrate/scheduler.go:69` (`NextToSpawn`), `pkg/orchestrate/engine.go:310`, `pkg/orchestrate/dag.go:304`.

`NextToSpawn` checks available slots and dependencies but not the consecutive-failure threshold. `Schedule` can dispatch pending independent tasks even when the circuit breaker should stop execution; deriving a blocked status is not itself a dispatch guard.

**Suggested improvement:** enforce the breaker at the dispatch boundary while preserving observation of already-running workers.

**Fixed.** `NextToSpawn` returns nothing at `MaxConsecutiveFailures`. Gating dispatch alone would have deadlocked the DAG - nothing spawns, so no fresh success can arrive to clear the counter that is stopping the spawns - so `applyActionLocked` now clears the streak: the breaker asks a human, and a dag action is the answer. `buildNext` reports the armed breaker as a human action instead of falling through to `cleanup-wait`. Tests: `circuitbreakdispatch_test.go`.

**Regression test:** reach `MaxConsecutiveFailures` with an independent pending task and a free slot; scheduling must not spawn that task.

## 2. Stalled workers lose outcome handling

**Priority:** high

**Sources:** `pkg/orchestrate/outcome.go:63`, `pkg/orchestrate/engine.go:256`.

The child exit handler accepts only tasks in `running`. A task already marked `stalled` bypasses failure classification, retry, and escalation when its worker subsequently exits. A stalled task that completes also misses the child-done notification because that transition requires the previous state to be `running`.

**Suggested improvement:** account for terminal outcomes from both running and stalled states, preserving idempotency and cancellation guards.

**Fixed.** A `taskActive` predicate (running or stalled) now gates `HandleChildOutcome` and the three accounting paths in `Schedule` that were keyed on a `running` previous state: the child-done notification, the fresh-success streak reset, and the terminal-failure count. Severity was higher than recorded: `jarvis.OnWorkerExit` is the only path that turns a worker exit into a task failure, so a stalled task's exit was dropped permanently - child run stuck `executing`, task stuck `stalled`, DAG never terminating. Tests: `stalledoutcome_test.go`.

**Regression tests:**

- A stalled worker exits with a retryable failure and receives the expected retry policy.
- A stalled worker exits with a terminal failure and records it once.
- A stalled worker completes successfully and emits its child-done notification once.

## 3. Watchdog stops observing partially active DAGs

**Priority:** medium

**Source:** `pkg/orchestrate/watchdog.go:24`.

The watchdog scans only DAGs with `running` status. A failed task or completed gate can move a DAG to `blocked` or `awaiting-review` while sibling workers remain active. Those siblings no longer receive periodic stall detection through this watchdog.

**Suggested improvement:** monitor nonterminal DAGs with active workers independently of whether they are eligible to dispatch more work. Do not simply broaden scheduling without preserving dispatch guards.

**Fixed.** The tick now scans running, blocked and awaiting-review DAGs. Parked DAGs are ticked only while they still hold a live child, so a permanently blocked DAG is not rewritten every 30s into a version bump the UI reads as a change. No dispatch guard was relaxed: they all live inside `NextToSpawn`, so observation cannot spawn. Tests: `watchdogscope_test.go`.

**Regression tests:** blocked and awaiting-review DAGs with silent running siblings still detect stalls, without launching prohibited work.

## 4. Status notifications are not transition-gated

**Priority:** medium

**Source:** `pkg/orchestrate/engine.go:375`.

The status notification switch emits blocked, awaiting-review, or complete events according to current status on every schedule call, even when the status has not changed. Repeated calls can duplicate lifecycle records and lead wakeup attempts.

**Suggested improvement:** emit on actual status transitions or changes to the relevant gate identity, rather than on unchanged snapshots.

**Fixed, but not by comparing against the previous status.** Both `HandleChildOutcome` and `applyActionLocked` recompute *and persist* the new status before calling `Schedule`, so the row `Schedule` loads already reads the new condition - gating on it suppressed the first, real notification (two existing tests caught this). What the lead was last told is its own fact, so the DAG records it: `TaskGroup.NotifiedCondition` holds the status plus the gate task or blocking kind. A new gate, or a blocker that turns mixed, still notifies; an unchanged condition never repeats. Tests: `notifygate_test.go`.

**Regression tests:** repeated scheduling of an unchanged blocked, awaiting-review, or done DAG produces no duplicate lifecycle notifications; a newly relevant gate still emits its notification.

## Recommended order

1. Confirm and fix the dispatch breaker and stalled-worker outcomes.
2. Expand watchdog observation with explicit dispatch safeguards.
3. Make status notifications transition-based.

Findings 1-4 were implemented 2026-09-08, test-first, each regression test watched failing before its fix. `go test ./pkg/...` and the TypeScript check both pass.

## Visibility improvement suggestions

These are source-level observations and proposals, not a live visual audit. Frontend tests were not run for this visibility review. The current implementation already provides a health strip, next-step summary, worker activity, attention queue, and lifecycle timeline; improve these existing surfaces rather than introducing another dashboard or competing state store.

### 5. Make the attention queue actionable

**Source:** `frontend/app/view/orchestrate/dagoverview.tsx` (`Queue`, `TaskRowSignal`).

Queue entries are informational text, while human-action names appear as badges. Make each entry open the relevant task, question, or review. Identify whether the next action belongs to the human, lead, or worker, using authoritative state rather than inferred responsibility.

**Verification:** each actionable exception navigates to the correct context; keyboard access works; unavailable actions are not presented as executable.

### 6. Explain the specific blocker

**Source:** `frontend/app/view/orchestrate/dagdigest.ts` (`nextStepText`).

Generic summaries such as “waiting on dependencies” do not identify what must change. Show the blocking task and required transition, with a link to its details. For example: “Task C waits for A’s merge. Lead action required.” This is illustrative copy, not an observed run state.

Distinguish work still executing from completed work awaiting integration. Reuse or extend the backend digest rather than duplicating scheduler policy in the frontend.

**Verification:** dependency, parallelism, gate, merge, and cleanup waits describe their actual cause without inventing an owner or action when evidence is unavailable.

### 7. Make freshness visible and accurate

**Source:** `frontend/app/view/orchestrate/dagdigest.ts` (`useDagDigest`).

Starting a refresh sets `loading` without immediately marking the previous digest stale. Health and counts from an older DAG version can therefore remain presented as current while a newer version loads.

Mark outdated results immediately. Show the last successful update and provide retry after a failed refresh; distinguish stale data from unavailable data.

**Regression tests:** a DAG version change hides outdated health/counts while loading; failed requests retain only explicitly stale facts; retry restores fresh status; out-of-order responses cannot replace newer results.

### 8. Preserve task identity beside worker activity

**Source:** `frontend/app/view/orchestrate/dagoverview.tsx` (`WorkerRow`).

Dispatched rows render `StatusLine` instead of the explicit task label used by other rows. Keep the assignment label consistently visible, with worker/model/activity information underneath, so users do not have to infer which task an agent is executing.

**Verification:** task identity remains readable across pending, dispatched, unavailable, and terminal worker states, including narrow layouts and long labels.

### 9. Summarize recovery inline

**Sources:** `frontend/app/view/orchestrate/dagoverview.tsx`, `frontend/app/view/orchestrate/timelinerail.tsx`.

Offer a compact per-task recovery summary, such as “Retried once · tool failure · now running,” with expansion into the existing lifecycle history. This is proposed copy, not an observed event sequence. Do not create a separate recovery-history store or invent counts when retained evidence is incomplete.

**Verification:** summaries agree with persisted events, identify partial history, and link to the relevant task/attempt details.

### Visibility priorities

1. Actionable attention.
2. Explicit blockers.
3. Trustworthy freshness.
4. Persistent task identity and inline recovery context.

The reliability findings above are prerequisites for trustworthy visibility: missing terminal events and duplicate notifications undermine the UI regardless of presentation quality. These suggestions are recorded for consideration, not approved implementation scope.
