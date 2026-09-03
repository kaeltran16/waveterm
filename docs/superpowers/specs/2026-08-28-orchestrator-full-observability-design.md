# Orchestrator Full Observability — Design Spec

**Date:** 2026-08-28
**Status:** Design approved; implementation not started
**Scope:** Jarvis orchestrator execution visibility across the selected run body, DAG modal, Agent surface, and run lifecycle timeline

## 1. Context

The orchestrator already exposes several useful but disconnected views:

- the selected run body shows run status, the lead transcript, asks, and an **Open DAG** action;
- the DAG modal shows task dependencies, state, route, task actions, and a small selected-task detail rail;
- the Agent surface shows first-class worker sessions, live status, current activity, transcripts, and nested transcript subagents;
- the run timeline persists selected lifecycle events and supports live updates and event deep-links.

The missing product layer is a coherent answer to two questions while a DAG executes:

1. **Is this orchestration healthy and advancing?**
2. **What are the lead and workers doing now?**

Today a user must move among the run body, DAG, Agent surface, and raw worker sessions and mentally correlate `TaskNode.RunID`, child runs, and worker tabs. The DAG does not navigate to its worker. The run body does not summarize DAG health or dependency waits. The timeline omits several transitions needed to explain retries, gates, asks, merges, cleanup, and lead-control delivery.

## 2. Goals

1. Give the selected run an exception-first execution overview: health, progress, current workers, dependency waits, and the next engine move.
2. Reuse the Agent surface's existing worker identity, status, transcript projection, and navigation instead of creating a parallel activity model.
3. Make every dispatched DAG task navigable to its worker in the Agent surface.
4. Extend the existing `RunEvent` lifecycle history into a useful orchestration timeline with cross-selection among events, DAG tasks, and workers.
5. Keep health and next-step explanations deterministic and aligned with backend scheduler rules.
6. Degrade honestly when the DAG, worker session, transcript, digest, or timeline is unavailable.
7. Add lead-control delivery visibility without making telemetry or acknowledgements block scheduling.
8. Complete the already-approved durable-cleanup foundation required for cleanup state and lifecycle events to be authoritative.

## 3. Non-goals

- No new top-level navigation surface.
- No model-generated health or next-action classification.
- No persistence of individual tool calls or transcript narration into `RunEvent`.
- No generic log console, distributed tracing system, or compliance-grade audit log.
- No cross-run analytics dashboard or historical run comparison.
- No orchestrator engine rewrite and no duplicate frontend-owned engine state.
- No change to scheduling, retry, gate, merge-content, or worktree-isolation policy. This scope does absorb the already-approved separation of content integration from durable, retryable worktree cleanup in `2026-08-27-orchestrator-dogfood-reliability-design.md`; it must not invent a second cleanup policy.

## 4. Design principles

### 4.1 Three sources of truth

The feature composes three existing sources instead of inventing a fourth:

| Concern | Source of truth | Used for |
| --- | --- | --- |
| Current orchestration | `TaskGroup` via WOS | task state, dependencies, attempts, failures, gates, merge/cleanup, DAG status |
| Live worker activity | existing Agent roster and transcript streams | worker status, current activity, quiet age, narration, recent actions, Agent navigation |
| Lifecycle history | existing append-only `RunEvent` log | ordered transitions, duration spans, deep-links, lead-control delivery |

### 4.2 Lifecycle transitions, not duplicate transcripts

`RunEvent` records meaningful state transitions. Tool calls and narration remain in worker transcripts. The timeline may link to a worker but must not copy its tool stream into the run log.

### 4.3 Present state before history

The default hierarchy is:

1. health and attention;
2. current lead/worker activity;
3. next engine move;
4. lifecycle history;
5. detailed DAG structure.

History remains visible in the timeline rail, but it does not displace immediate intervention needs.

## 5. Architecture

Full observability is primarily a projection over persisted orchestration and agent state. The one absorbed engine change is the already-approved durable-cleanup foundation needed to make cleanup state observable without lying.

### 5.0 Durable-cleanup foundation

Before cleanup events or digest fields ship, finish the unfinished **Separate integration from cleanup** design in `2026-08-27-orchestrator-dogfood-reliability-design.md`:

1. persist the child end commit, merged marker, and `CleanupPending=true` after content integration succeeds and before cleanup starts;
2. remove the worktree through one idempotent cleanup helper;
3. clear cleanup state on success and retain a bounded `CleanupError` on failure;
4. retry pending cleanup through the same helper on an ordinary merge retry and once at server startup;
5. recompute and publish the DAG after each persisted cleanup transition;
6. never re-run content integration for a task already marked merged.

This section incorporates that existing cleanup decision into this feature's delivery scope; the earlier design remains the detailed source for junction safety, recovery patches, cancellation debt, and startup retry. Until these semantics land, the product must not emit `task-cleanup-*` events or claim cleanup state is authoritative.

### 5.1 Backend status digest

The frontend must not mirror `ReadyTasks`, `NextToSpawn`, gate blocking, merge-required dependency satisfaction, cleanup recovery, or human-action rules. Promote the existing DAG status path to return a typed digest built by pure Go logic that shares the scheduler's helpers.

A status response contains the current group and a digest tied to its version. These are the complete generated contract fields and enum values:

```go
type CommandDagStatusRtnData struct {
    Group  *waveobj.TaskGroup `json:"group"`
    Digest DagStatusDigest    `json:"digest"`
}

type DagStatusDigest struct {
    DagVersion int               `json:"dagversion"`
    Health     string            `json:"health"` // needs-you | stalled | healthy | done | cancelled
    Counts     DagStatusCounts   `json:"counts"`
    Next       DagNextStep       `json:"next"`
    Tasks      []DagTaskDigest   `json:"tasks"`
    Durations  DagDurationDigest `json:"durations"`
    Control    *ControlDigest    `json:"control,omitempty"`
}

type DagStatusCounts struct {
    Total             int `json:"total"`
    Done              int `json:"done"`
    Running           int `json:"running"`
    Stalled           int `json:"stalled"`
    DependencyWaiting int `json:"dependencywaiting"`
    Attention         int `json:"attention"`
    RecoveredRetry    int `json:"recoveredretry"`
    MergeReady        int `json:"mergeready"`
}

type DagNextStep struct {
    Kind            string   `json:"kind"` // human-action | merge-ready | dispatch | parallelism-wait | dependency-wait | terminal
    TaskIds         []string `json:"taskids,omitempty"`
    BlockingTaskIds []string `json:"blockingtaskids,omitempty"`
    Actions         []string `json:"actions,omitempty"` // answer | approve | sendback | resolve-merge | retry | skip | escalate | retry-cleanup
    TerminalStatus  string   `json:"terminalstatus,omitempty"`
}

type DagTaskDigest struct {
    TaskId          string   `json:"taskid"`
    WaitReason      string   `json:"waitreason"` // none | dependency | parallelism | gate | ask | failure | merge | cleanup | terminal
    BlockingTaskIds []string `json:"blockingtaskids,omitempty"`
    HumanActions    []string `json:"humanactions,omitempty"` // answer | approve | sendback | resolve-merge | retry | skip | escalate | retry-cleanup
    AskId           string   `json:"askid,omitempty"`
    AskSummary      string   `json:"asksummary,omitempty"`
    AskTs           int64    `json:"askts,omitempty"`
    FreshnessTs     int64    `json:"freshnessts,omitempty"`
    RecoveredRetry  bool     `json:"recoveredretry,omitempty"`
    MergeState      string   `json:"mergestate"`   // not-required | waiting | ready | blocked | merged
    CleanupState    string   `json:"cleanupstate"` // not-required | clear | pending | failed
}

type DagDurationDigest struct {
    ElapsedMs int64             `json:"elapsedms"`
    Partial   bool              `json:"partial,omitempty"`
    Tasks     []DagTaskDuration `json:"tasks,omitempty"`
}

type DagTaskDuration struct {
    TaskId      string `json:"taskid"`
    RunMs       int64  `json:"runms,omitempty"`
    MergeWaitMs int64  `json:"mergewaitms,omitempty"`
    CleanupMs   int64  `json:"cleanupms,omitempty"`
    Partial     bool   `json:"partial,omitempty"`
}

type ControlDigest struct {
    EventId        string `json:"eventid"`
    Kind           string `json:"kind"` // child_done | gate_open | dag_blocked | dag_complete | task_spawned | child_ask | child_stalled
    TaskId         string `json:"taskid,omitempty"`
    SessionId      string `json:"sessionid,omitempty"`
    Status         string `json:"status"` // acknowledged | unconfirmed | failed | unavailable
    SentTs         int64  `json:"sentts,omitempty"`
    AcknowledgedTs int64  `json:"acknowledgedts,omitempty"`
    Error          string `json:"error,omitempty"`
}
```

`DagStatusCounts` classifications may overlap; they are named indicators, not parts required to sum to `Total`. `Done` counts state `done` even while merge or cleanup remains; `MergeReady` and `Attention` explain the remaining work. `Running` and `Stalled` count only their exact task states. `DependencyWaiting` counts pending tasks with at least one unsatisfied dependency. `Attention` counts asks, unreleased gates, terminal failures, blocked merges, and failed cleanup—not ordinary stalls or cleanup currently in progress. `MergeReady` counts done, released-when-gated, unmerged tasks in a merge-required DAG. `RecoveredRetry` is true only when the task is currently successful and a retained `task-retried` event exists for that task ID. If the required retry or duration boundary was pruned or never persisted, the digest does not invent it and marks the affected duration and aggregate `Partial`.

`MergeState` is `not-required` for non-merge DAGs, `waiting` before a task becomes mergeable, `ready` for done and released-when-gated work, `blocked` for a merge conflict, and `merged` after content integration persists. `CleanupState` is `not-required` for non-merge DAGs, `pending` while cleanup has no error, `failed` when persisted cleanup debt carries an error, and `clear` whenever no cleanup debt exists, including before integration and after cleanup completes.

The pure builder receives one explicit snapshot containing the `TaskGroup`, child runs, pending asks, retained relevant `RunEvent` rows, and `now`. The RPC layer gathers those inputs; the builder performs no storage or clock reads. `DagVersion` identifies the source `TaskGroup.Version`, `Next` remains typed data rather than prose, and `Control` reports the latest lead-control attempt.

The CLI and frontend consume this same digest. Existing CLI-local action derivation moves into the shared backend projection.

### 5.2 Aggregate health

Health uses this deterministic precedence:

1. **needs-you** — a child ask, unreleased gate, terminal failure, blocked merge, failed cleanup, or blocked DAG requires human action;
2. **stalled** — at least one persisted stalled task and no higher-priority attention;
3. **healthy** — the scheduler can advance, workers are active, or a normal dependency/parallelism wait exists;
4. **done / cancelled** — terminal group state with no higher-priority persisted cleanup debt.

A cancelled DAG with failed cleanup remains **needs-you** until its cleanup debt clears; cancellation still prevents scheduling new work. “Quiet” is worker-level freshness, not aggregate DAG health. A long-running command may be quiet without being stalled.

### 5.3 Next-step semantics

`DagNextStep` reports the highest-priority current condition using typed task IDs and blockers:

1. required human action, ordered as answer, approve/send back, resolve merge, retry cleanup, then retry/skip/escalate;
2. merge-ready work that blocks successors when `MergeRequired` is true;
3. tasks the scheduler can dispatch now;
4. parallelism wait on active tasks;
5. dependency wait, including blocking task IDs;
6. terminal state.

Within one condition, task IDs use DAG order. `Actions` contains every valid action for the selected task condition; the frontend does not reconstruct alternatives from task state.

The frontend renders human text from this typed result. It does not infer scheduler policy independently.

### 5.4 Worker correlation

A DAG task resolves to its existing Agent entity through:

```text
TaskNode.RunID
  → child Run
  → running or recorded RunPhase.WorkerOrefs
  → tab ID
  → existing AgentVM
```

The observability projection combines:

- task metadata from `TaskNode`;
- run identity and fallback navigation from the child `Run`;
- live status/activity from `AgentVM`;
- latest meaningful transition from `RunEvent`.

The worker remains the same Agent entity everywhere. Orchestration adds task, dependency, attempt, gate, merge, and cleanup context; it does not create a second worker identity.

## 6. User interface

### 6.1 Selected run body

An orchestrator run gains an execution overview above the lead transcript:

1. **Health strip** — progress and exception counts, aggregate health, elapsed time.
2. **Next engine move** — a concise explanation from `DagNextStep`.
3. **Lead and workers** — compact parent/child rows using the Agent surface's status and activity treatment.
4. **Selected worker narration** — existing transcript projection and `NarrationTimeline` behavior.
5. **Attention and merge queue** — only actionable exceptions and merge-ready tasks.

Worker ordering is deterministic and exception-first:

1. asks, failed, stalled, blocked-merge, and cleanup-failed;
2. running;
3. ready and dependency-waiting;
4. completed, merged, skipped, and cancelled.

The overview reuses shared Agent presentation primitives. It does not render `AgentRow` directly because that component owns cockpit-grid geometry, resizing, backgrounding, asks, and context menus. Extract or reuse the status/activity/narration units behind it instead.

### 6.2 DAG modal

The DAG remains the structural view.

- A node click selects the task; it does not navigate away.
- The selected-task rail renders the existing worker-row treatment.
- A dispatched task exposes **Open in Agent ↗**.
- A pending task shows **Not dispatched yet** and no worker action.
- A missing or closed worker session shows **Worker session unavailable** and offers **View child run**.
- **Open in Agent** resolves the worker tab and calls the existing `jumpToAgent(model, tabId)` path.
- Task selection highlights the corresponding worker and filters relevant timeline events.

`DagModal` must receive the shared `AgentsViewModel`/worker context needed for navigation; it must not create a second navigation mechanism.

### 6.3 Lifecycle timeline rail

Refactor the existing `RunTimeline` projection into a reusable panel with two layouts:

- persistent right rail on wide DAG/run layouts;
- collapsible drawer on narrow layouts.

The rail provides:

- live event count and connection state;
- filters: all, task, attention;
- chronological event rows;
- selected-event detail;
- click targets to worker, DAG task, gate action, merge state, evidence, or child run.

Cross-selection is bidirectional:

- selecting a worker highlights its DAG task and filters events;
- selecting a DAG task selects the worker and relevant events;
- selecting an event selects or opens its best target.

The existing `selectedTaskIdAtom` remains the DAG task-selection source. Event selection may remain local to the timeline panel.

### 6.4 Responsive and accessible behavior

- Wide layouts show live work and timeline together.
- Narrow layouts keep health/current work visible and collapse history into a drawer.
- Status always includes text or an icon; color never carries meaning alone.
- Nodes, worker rows, filters, events, and actions are keyboard focusable.
- `aria-live` announces health/attention transitions only, not every activity update.
- Relative-age updates stay in leaf components so the graph and timeline are not recomputed every second.

## 7. Lifecycle event coverage

The current event log already covers run/phase creation, completion, holds, pipeline gates, triage, child creation/completion/cancellation, evidence sealing, task spawn/stall/retry, DAG block, and DAG completion.

Add the missing orchestration transitions below. Start/sent events append after the request is accepted or its delivery write succeeds; outcome events append only after the authoritative state mutation persists. Each writer attempts once at that boundary, and a successful append yields one row.

| Event kind | Required detail |
| --- | --- |
| `task-done` | task ID, child run ID |
| `task-failed` | task ID, child run ID, failure kind, attempt |
| `dag-cancelled` | cancellation source |
| `dag-gate-open` | task ID |
| `dag-gate-approved` / `dag-gate-sent-back` | task ID |
| `child-ask` / `child-answered` / `child-ask-cleared` | task ID, ask ID, question summary capped by a named writer constant; clear reason when applicable |
| `task-merge-started` / `task-merge-blocked` / `task-merge-continued` / `task-merged` | task ID, child run ID, commit when available |
| `task-cleanup-pending` / `task-cleanup-completed` / `task-cleanup-failed` | task ID, error capped by a named writer constant when failed |
| `lead-control-sent` / `lead-control-acknowledged` / `lead-control-failed` | control event ID, kind, task ID when applicable |

Event writes remain best-effort and non-blocking. Scheduling or merging must not fail because a lifecycle event could not be appended.

Ask lifecycle recording is centralized at the registry boundary. `AskCommand` passes its generated ask ID through child correlation and appends `child-ask` after the registry entry exists. A successful `DeliverAnswer` appends `child-answered`; dropping an unanswered ask because it was dismissed, cancelled, or its waiter ended appends `child-ask-cleared`. The shared helper resolves block → child run → task, so cockpit answers, Gatekeeper answers, and direct DAG answers cannot diverge. Duplicate answer/clear calls that find no matching pending ask append nothing.

Task durations use persisted boundaries only. `RunMs` sums complete child phase `[StartedTs, DoneTs]` spans. `MergeWaitMs` spans `task-done` to the first `task-merge-started`. `CleanupMs` spans `task-cleanup-pending` to `task-cleanup-completed` or `task-cleanup-failed`. A missing boundary yields no fabricated duration and sets `Partial=true`. Overall elapsed time is `now - TaskGroup.CreatedTs` while active and the `dag-done` or `dag-cancelled` timestamp minus `CreatedTs` after terminal transition.

### 7.1 Control acknowledgement

Every lead-control attempt gets a stable event ID before delivery. Its envelope carries `eventid`, `channelid`, `runid`, optional `taskid`, and the resolved `sessionid` in addition to the existing command content. The Pi extension parser preserves those fields.

Delivery has three authoritative outcomes:

1. a successful control-file write appends `lead-control-sent` with the event and session IDs;
2. an absent control directory or unresolved lead session appends `lead-control-failed` with failure kind `unavailable`;
3. a write error appends `lead-control-failed` with failure kind `write` and a bounded error.

After the Pi watcher successfully accepts the command through its dispatcher, it invokes:

```go
type CommandPiControlAckData struct {
    ChannelId string `json:"channelid"`
    RunId     string `json:"runid"`
    EventId   string `json:"eventid"`
    SessionId string `json:"sessionid"`
}
```

The server requires a matching `lead-control-sent` event for the same channel, run, event, and session before appending `lead-control-acknowledged`. Repeating a matching acknowledgement is an idempotent no-op. Unknown events, mismatched sessions, and acknowledgements for failed delivery return contextual errors and append nothing.

The status digest derives:

- **acknowledged** — one matching acknowledgement exists;
- **unconfirmed** — the control write succeeded and no matching acknowledgement exists yet;
- **failed** — the control-file write failed;
- **unavailable** — no control channel or lead session could be resolved.

A control file superseded before the watcher processes it remains unconfirmed; acknowledgements never transfer between event IDs. All four states are visibility-only and never block the engine because persisted cockpit state remains authoritative.

## 8. Error handling and degradation

Observability failures must be isolated from orchestration.

| Failure | UI behavior |
| --- | --- |
| DAG unavailable | retain normal run body; show “DAG status unavailable”; never infer healthy |
| worker unresolved | keep task visible; show unavailable state; offer child-run fallback |
| transcript unavailable | keep status/task metadata; show “Activity unavailable” |
| timeline load failure | explicit retry state; live health/workers continue |
| digest failure | show task facts; hide stale health/next claims behind “Refreshing status” |
| stale digest | accept only when `Digest.DagVersion == TaskGroup.Version` and the response belongs to the newest outstanding request |
| ask changes during digest load | the ask event schedules another refresh; newest-request ordering prevents an older same-version response from winning |
| action failure | retain state, clear pending indicator, show contextual inline error |
| control unconfirmed or unavailable | warning only; do not block scheduling |
| control history append failure | delivery proceeds; keep the prior control digest, log the omission, and allow acknowledgement to fail without affecting the engine |

Actions are non-optimistic. Retry, merge, gate, escalation, and cancel controls show pending state and wait for the persisted WOS update. Errors are never silently swallowed.

The UI calls `RunEvent` output **lifecycle history**, not an audit log. Best-effort writes mean the product must not claim complete forensic history.

## 9. State and performance

- WOS remains the current DAG state channel.
- The status digest loads initially and refreshes when the observed `TaskGroup.Version` changes or a child ask/answer/clear or lead-control sent/failed/acknowledged event arrives.
- Each frontend load receives a monotonically increasing local request token. Only the newest response with `Digest.DagVersion == observed TaskGroup.Version` may replace the current digest.
- The backend snapshot builder receives `now` explicitly and bulk-loads at most the DAG's bounded eight child runs. Relevant retained lifecycle boundaries are queried by run and event kind; the digest does not reuse the UI's 200-row window.
- Existing Agent atoms and transcript streams remain the only live worker activity channel.
- Existing run-event loading remains capped at 200 rows in the UI; storage remains capped at 1,000 rows per run.
- Event filtering is a pure function over the loaded 200-row window.
- Summary duration and retry facts come from the backend's retained-event query. Missing retained boundaries produce partial or absent values rather than inference.
- No new polling loop is introduced for worker activity or control acknowledgement.

## 10. Testing

### 10.1 Backend unit tests

- durable cleanup persists merge identity before cleanup, records bounded cleanup debt, retries idempotently, and never merges twice;
- health precedence: needs-you > stalled > healthy > terminal, including failed cleanup on cancelled DAGs;
- next-step derivation for dependencies, merge-required tasks, gates, asks, failures, cleanup, and parallelism;
- every digest contract field and enum value, including overlapping counts;
- digest version equals source `TaskGroup.Version`;
- same DAG version with changed ask state produces a new digest;
- recovered-retry derivation uses retained retry history plus current successful state;
- duration derivation marks absent or pruned boundaries partial;
- shared CLI/UI digest action semantics;
- ask raise, answer, and clear writers preserve one ask ID across every answer path;
- each new lifecycle writer attempts once at its defined authoritative boundary and produces one row on success;
- failed event writes never fail the engine action;
- control sent/acknowledged/unconfirmed/failed/unavailable derivation;
- acknowledgement is idempotent and rejects event/session ownership mismatches;
- existing run-event retention remains bounded.

### 10.2 Frontend pure tests

- task → child run → worker correlation;
- exception-first ordering;
- missing worker, transcript, timeline, and digest degradation;
- stale digest rejection and newest-request ordering for same-version ask races;
- child ask/answer/clear event refresh;
- timeline filtering and duration derivation;
- event click-target routing;
- DAG task, worker, and event cross-selection;
- pending tasks never expose **Open in Agent**;
- cleanup pending/failed actions use the digest action rather than frontend inference;
- acknowledged, unconfirmed, failed, and unavailable control presentation;
- narrow-layout rail/drawer decision.

### 10.3 Live UI verification

Add a focused `task verify:ui` scenario using a real orchestrator run. It must prove:

1. a real `TaskGroup` appears;
2. health and next-step output agree with persisted state;
3. a running task resolves the correct worker;
4. **Open in Agent** focuses that worker;
5. retry, gate, ask, merge, cleanup, and completion events appear in lifecycle history;
6. timeline events deep-link to the correct task or worker;
7. the narrow layout exposes the timeline drawer;
8. missing-session and failed-load states remain explicit.

No render snapshots are added. Pure logic tests plus CDP visual verification match repository conventions.

## 11. Delivery sequence

The implementation plan must keep each layer independently testable and preserve this dependency order:

0. finish the absorbed durable-cleanup foundation from `2026-08-27-orchestrator-dogfood-reliability-design.md`;
1. define the complete shared backend digest and typed RPC contract;
2. add task/run/Agent correlation and reusable worker presentation;
3. add the run-body overview and DAG **Open in Agent** navigation;
4. add missing lifecycle event coverage and the reusable timeline rail;
5. add stable lead-control envelopes and idempotent acknowledgement;
6. finish error states, race handling, responsive behavior, accessibility, and live CDP verification.

Phase 0 is part of this feature, not an external deferral. Cleanup observability work cannot begin before its persisted transitions pass their focused tests. The remaining phases may overlap only where they do not create a second source of truth or require a later phase's contract.

## 12. Success criteria

The feature is successful when a user can answer, without opening raw terminals:

- whether the DAG is healthy;
- what every active worker is doing;
- which task is waiting and why;
- what the engine or human must do next;
- what retry, gate, merge, durable cleanup, or control transition led to the current state;
- how to open the exact worker in the Agent surface.

The same answers must remain grounded in `TaskGroup`, existing Agent state, and `RunEvent`, with no competing observability store.
