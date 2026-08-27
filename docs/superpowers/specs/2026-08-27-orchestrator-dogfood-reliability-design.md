# Orchestrator dogfood reliability gate design

**Date:** 2026-08-27
**Status:** approved; implementation plan written

## Problem

The persistent-lead orchestrator has the right architectural split: a model lead makes planning decisions while the persisted DAG engine owns deterministic scheduling, worktrees, merges, retries, and task state. The disposable preflight planner and mandatory draft approval path have been removed.

The current implementation is not yet proven trustworthy for personal unattended use:

- the available end-to-end capture did not observe a persisted multi-task DAG or child lifecycle;
- its driver and generated documentation still describe the removed preflight planner architecture;
- orchestrator lead `cmd:keeponexit` metadata is written after the worker controller starts, leaving a race and silently ignoring persistence failure;
- abandoned `.waveterm/worktrees` directories and a prunable Git worktree remain from a real run;
- Vitest excludes `.worktrees/**` but not `.waveterm/worktrees/**`, so stale runtime copies of tests are discovered and can produce misleading results;
- merge success and worktree cleanup are coupled, allowing a cleanup problem to obscure an already-landed merge;
- DAG dependencies currently enforce completion order but not code visibility: a successor becomes ready when its predecessor is merely `done`, while every child worktree starts from the owner run's original `BaseCommit`, so dependent work cannot see predecessor changes.

## Decision

Add a focused personal-dogfood reliability gate around the existing persistent-lead design. Do not redesign orchestration or add another planning path.

The gate hardens five boundaries:

1. orchestrator lead protection is persisted before process start;
2. Git-backed dependencies unblock only after predecessor changes are merged and visible;
3. content integration and resource cleanup have separate outcomes;
4. repository tests never discover runtime worktrees;
5. ship readiness requires one observed multi-task persistent-lead run through merge and cleanup.

Until that acceptance run passes, describe the orchestrator as experimental rather than proven end-to-end.

## Goals

- Prevent an orchestrator lead from starting without its required keep-on-exit metadata.
- Preserve correct merged task state even when Windows delays worktree cleanup.
- Ensure a Git-backed successor starts from a commit containing its merged predecessors.
- Make cleanup idempotent and retryable without re-merging content.
- Prevent stale runtime worktrees from contaminating frontend tests.
- Replace stale planner-era E2E claims with evidence from the current persistent-lead flow.
- Establish a bounded personal-dogfood acceptance bar.

## Non-goals

- Runtime-neutral typed DAG authoring.
- Durable acknowledged delivery for lead control events.
- Restoring preflight planning, fallback drafts, or mandatory approval.
- Adding an optional plan-review mode or countdown.
- Extending Pi task records with gates or exceptional routes.
- Redesigning the DAG engine, graph, retry policy, or worktree isolation model.
- Claiming public-release readiness across every runtime and machine.

For this gate, Pi-authored tasks inherit the exact run route. The product and documentation must not claim that the Pi task bridge authors task gates or exceptional routes.

## Architecture

### Atomic lead launch

The worker-spawn boundary accepts an explicit keep-on-exit option. It builds and persists the final block metadata before `ResyncController` starts the worker process.

`EnsureWorkers` enables the option only for the orchestrator lead. Pipeline, quick, and DAG child workers keep their current close-on-exit behavior.

Failure to persist required block or tab metadata aborts launch with context. There is no post-start best-effort metadata patch and no ignored persistence error.

### Merge-gated dependency visibility

For Git-backed owner projects, a dependency is satisfied only when its predecessor is skipped or both done and merged. A merely done predecessor remains visible with a merge action; its successors stay pending.

A completed gate has two explicit steps. Before approval it offers approve or send back. After approval it offers merge. Successors unblock only after both `Released` and `Merged` are true. Non-gate predecessors require only `Merged`.

Each newly spawned Git child worktree starts from the project's current `HEAD`, not the owner run's original `BaseCommit`. The engine records that exact spawn-time SHA as the child run's `BaseCommit`, preserving accurate `BaseCommit..EndCommit` evidence. Parallel siblings launched in one scheduler pass share the same observed base; later tasks include all merges already present when they spawn.

Non-Git projects retain completion-order dependencies because there is no worktree integration boundary.

The Pi lead prompt states that completed predecessors with dependents must be merged through `wsh jarvis dag merge <task-id>` before successors can start. The existing status digest exposes `merge` as the next action; this pass does not add automatic merging.

### Separate integration from cleanup

A DAG task merge has two outcomes:

1. **Content integration:** squash or continue the merge and return the resulting commit SHA.
2. **Resource cleanup:** remove the task worktree registration, task branch, and physical directory.

After content integration succeeds, `DagMergeCommand` records the child end commit, task merged marker, and evidence before resource cleanup. Cleanup failure cannot turn an already-landed merge into a failed or apparently unmerged task.

The cleanup helper is idempotent. Repeating it must not merge again or alter the recorded commit. Before recursive deletion it removes only verified junction/symlink entries for the shared `node_modules`, `src-tauri/target`, and `dist/bin` paths; it never treats a real directory as a shared link. It then removes Git registration, the task branch, and the physical worktree directory. This ordering prevents Windows cleanup from following a junction into the main checkout.

`TaskNode` persists `CleanupPending` and a bounded `CleanupError`. Content integration sets the merged marker, end commit, and `CleanupPending=true` atomically before cleanup begins. A merge-required DAG remains non-terminal while cleanup is pending, which keeps the lead and cleanup action available. Successful cleanup clears both cleanup fields and recomputes terminal state. Failure leaves them visible on the persisted DAG. A server-start sweep, wired alongside orchestrator watchdog startup, retries every pending cleanup through the same helper; ordinary merge retries may invoke it too.

Cancellation uses the same cleanup helper after preserving dirty work through the existing recovery-patch path. Cancellation cleanup debt uses the owning task when one exists. Cancelling an owner DAG attempts every remaining task worktree, persists any cleanup debt, and does not roll back the cancelled state when resource deletion is delayed.

### Test isolation

`vitest.config.ts` excludes `**/.waveterm/worktrees/**` in addition to the existing `.claude/**` and `.worktrees/**` exclusions.

Verification runs `vitest list` and fails if any selected path is below `.waveterm/worktrees`. Test reports must contain only files from the active checkout.

Existing runtime worktrees are cleaned separately after confirming that their branches are merged or that recoverable work has been preserved. Cleanup must not delete an unverified branch or dirty tree.

### Current-flow E2E proof

The orchestrator E2E driver exercises the application as a user:

1. create an isolated channel through the UI;
2. choose Orchestrator and a deterministic available Pi route;
3. submit a genuinely multi-part goal;
4. observe an immediate persistent lead and verify that no draft modal appears;
5. wait within a bounded planning window for more than one persisted DAG node;
6. verify every unpinned child inherits the selected route;
7. wait for at least one child to become terminal and merge it when required;
8. verify persisted merged state and task worktree cleanup;
9. remove the demo channel unless `KEEP=1` is set;
10. restore browser viewport state in `finally`.

The driver uses stable region/test attributes rather than position-based or global-body probes. Route selection is deterministic when the preferred dogfood route is available and otherwise reports the exact fallback route selected.

The script writes its contact sheet and documentation from one result model. Generated prose describes observed states only.

## Error handling

### Lead metadata failure

Abort before controller start and surface the contextual creation error. Preserve the composer goal so the user can retry.

### DAG publication failure

Keep current behavior: no `TaskGroup` is persisted and no child starts. The live lead receives bounded validation detail and can repair its task records.

### Merge conflict

Keep the existing blocked-merge state and explicit continue/resolve path. Do not mark the task merged before content integration succeeds. Dependent successors remain pending while the predecessor is blocked.

### Cleanup failure after merge

Keep the merged commit and persisted task state. Leave `CleanupPending=true` with bounded error detail on the task. The server-start sweep and an idempotent merge retry invoke cleanup independently. Do not run another squash merge.

### E2E timeout or mismatch

Exit non-zero when any required observation is absent, including:

- no live lead;
- a stale planner/draft surface;
- no multi-task DAG within the bounded window;
- route mismatch;
- no observed child lifecycle;
- merge state that does not survive another scheduler pass;
- remaining registered or physical worktree for the merged task;
- failed teardown or viewport restoration.

A screenshot of a pending or failed state is diagnostic evidence, not a passing result.

## Testing

### Go

- Orchestrator launch metadata contains `cmd:keeponexit` before controller start.
- Pipeline, quick, and DAG child workers do not inherit orchestrator keep-on-exit behavior.
- Metadata persistence failure prevents worker startup.
- Git-backed successors remain pending while a predecessor is done but unmerged.
- A released gate offers merge and does not unblock successors until merged.
- Parallel siblings share a spawn-time project HEAD; a later dependent child receives the post-merge HEAD as its `BaseCommit`.
- Non-Git DAG dependencies continue to unblock on done/skipped.
- A successful merge is persisted even when cleanup fails.
- Pending cleanup keeps a merge-required DAG non-terminal and the lead available.
- Retrying cleanup removes remaining resources without creating another merge commit.
- Pending cleanup and bounded error detail survive restart, and the startup sweep retries them.
- Cancellation writes recovery data before cleanup.
- Repeated merge and cleanup calls are idempotent.
- Worktree cleanup unlinks verified shared directory links before recursive removal and leaves their main-checkout targets intact.
- Existing scheduler, route inheritance, gate, retry, merge-conflict, and lead-close tests remain green.

### Frontend

- Vitest excludes `.waveterm/worktrees/**`.
- `vitest list` reports no tests below `.waveterm/worktrees`.
- Focused orchestrator tests report only active-checkout test files.
- A completed unreleased gate exposes approve/sendback; a released unmerged gate exposes merge.
- Existing direct orchestrator creation, exact route, live DAG state, route display, and action tests remain green.

### Commands

Run at minimum:

```bash
if npx vitest list | rg -q '\.waveterm[/\\]worktrees'; then exit 1; fi
npx vitest run frontend/app/view/agents/composercommand.test.ts frontend/app/view/orchestrate/dagstore.test.ts frontend/app/view/orchestrate/daglayout.test.ts frontend/app/view/orchestrate/dagmodalstate.test.ts frontend/app/view/orchestrate/escalate.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test ./pkg/jarvis ./pkg/orchestrate ./pkg/wshrpc/wshserver -count=1
task build:backend
node scripts/cdp/orchestrator-e2e.mjs
```

## Personal-dogfood acceptance bar

One clean run must demonstrate all of the following:

- the exact selected Pi model appears on the lead;
- no preflight planner or draft modal appears;
- the lead publishes a DAG with at least two tasks;
- a dependent successor stays pending until its predecessor is merged;
- the successor's recorded `BaseCommit` contains the predecessor merge;
- unpinned children inherit the exact run route;
- at least one child completes and merges;
- terminal persisted state survives another scheduler tick;
- no registered or physical worktree remains for the merged task;
- the lead remains available while the DAG is active and closes only after both Run and DAG are terminal;
- the E2E driver removes its demo channel and restores browser state;
- generated documentation contains no planner-era claims.

A failed criterion keeps the feature experimental and becomes a bounded follow-up finding. It does not justify silently weakening the acceptance script.

## Consequences

### Benefits

- Hardens the current design without introducing a second source of truth.
- Makes test output trustworthy again.
- Separates user work success from Windows cleanup behavior.
- Makes DAG dependency claims match the code a successor can actually read.
- Produces evidence for the actual architecture rather than historical implementation.
- Keeps the next step small enough for a single implementation plan.

### Costs

- `TaskNode` gains persisted cleanup status fields and the server gains a startup retry sweep.
- Dependent Git DAGs pause at explicit merge boundaries; the lead or human must merge before successors start.
- Child run evidence uses a per-task spawn base instead of the owner run's fixed base.
- The E2E scenario takes long enough to observe a real model and child lifecycle.
- Personal dogfood remains Pi-first.
- Gates and exceptional child routes remain available in the engine but are not authored through the Pi task import bridge in this scope.

## Rollout

1. Fix test isolation first so subsequent verification is credible.
2. Make lead launch metadata atomic.
3. Make Git dependency readiness merge-aware and record each child's spawn-time base.
4. Separate merge persistence from cleanup and add cleanup retries.
5. Rewrite the E2E driver and generated documentation.
6. Run the personal-dogfood acceptance scenario.
7. Record observed residual risks without expanding scope unless a failed criterion requires it.
