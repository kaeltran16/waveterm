# Orchestrator Full Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a running orchestrator DAG one coherent execution view — health, next engine move, live workers, and a full lifecycle timeline — by composing `TaskGroup`, the Agent roster, and the `RunEvent` log into a shared typed digest and reusable rails, instead of a new observability store.

**Architecture:** The backend promotes the existing DAG status RPC to return `{Group, Digest}`, where the digest is built by a pure Go function that shares the scheduler's helpers (`ReadyTasks`, `NextToSpawn`, `gateBlocked`, `depSatisfied`) and consumes one explicit snapshot (group + up to 8 child runs + pending asks + retained events + `now`). The frontend composes three existing sources — WOS `TaskGroup`, Agent atoms/transcripts, and `RunEvent` — with no engine-state mirror and no new worker identity. Durable cleanup is finished first (idempotent helper, startup retry, per-transition DAG publish) so cleanup state and events are authoritative before they ship.

**Tech Stack:** Go, SQLite (wstore json rows), wshrpc/waveobj codegen, React 19 + Vite + Tailwind 4 + jotai, Vitest (pure `.ts` logic), ReactFlow, Node CDP driver (`task verify:ui`), Pi task bridge.

## Execution progress (2026-08-28)

**Phase 0 — durable-cleanup foundation: COMPLETE and verified** (`go test` on `pkg/orchestrate`, `pkg/wshrpc/wshserver`, `pkg/wstore` green; `task build:backend` OK).

- 0.1 — `pkg/orchestrate/cleanup.go`: `PendingCleanupTasks`, `HasCleanupDebt`, `CleanupTaskWorktree`, `MaxCleanupErrorLen` (200), injectable remover. `merge.go` is now integration-only (all inline `RemoveRunWorktree` gone); the helper resolves project path via channel (`DBMustGet Channel`), keyed by `TaskWorktreeKey(g.RunID, taskID)`.
- 0.2 — both merge RPCs (`DagMergeCommand`, `DagMergeContinueCommand`) persist child end commit + `Merged=true` + `CleanupPending=true` and publish BEFORE cleanup; cleanup outcome (clear / bounded error) persists and publishes after; retry on a merged task short-circuits (no re-integration — proven via `git worktree list` + `rev-list` in `TestDagMergeCleanupFailurePersistsDebt`).
- 0.3 — `RetryPendingCleanup` (mixed-debt test); startup sweep `retryCleanupDebtAtStartup` in `main-server.go` after `InitWStore` (never fails startup); engine `scheduleLocked` retries debt via the helper before dispatch. `GetDagsWithPendingCleanup` now also matches error-only debt (`cleanuperror != ''`).
- 0.4 — `TestScheduleOncePublishesCleanupTransitions` locks the invariant that every persisted cleanup transition (pending→failed→clear) publishes a matching dag waveobj version; the engine end-tick persist+publish already satisfied it, so 0.4 added the regression net, no production change.

**Decisions / deviations (flagged for review):**
- The remover seam is exported (`orchestrate.RemoveTaskWorktree`), mirroring the existing `jarvis.SpawnRunWorker` test seam — a cross-package handler test must stub cleanup failure, and `git worktree remove --force` on a locked tree unregisters the entry, so the lock trick can never force a real error through `RemoveRunWorktree`'s tolerate-unregistered path.
- On failure the helper clears `CleanupPending` and keeps bounded `CleanupError` (per the 0.2 test contract). Debt is therefore error-carried: `RecomputeDagStatus` keeps a merge-required DAG non-terminal on `CleanupError != ""` (preserving the 08-27 "pending cleanup keeps the DAG non-terminal" acceptance), and the startup query matches error-only debt.
- The cancellation worktree sweep (`mutation.go cancelLocked → RemoveRunWorktree`) is NOT rewired in Phase 0 — out of the plan's four-task scope. Flagged as a follow-up (08-27 wanted cancellations through the same helper).

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-28-orchestrator-full-observability-design.md` as the source of truth; the plan's task order follows its §11 delivery sequence.
- Phase 0 is part of this feature, not a deferral: do not build cleanup events or digest cleanup/merge fields until the absorbed durable-cleanup work from `docs/superpowers/specs/2026-08-27-orchestrator-dogfood-reliability-design.md` passes its focused tests.
- No new top-level navigation surface. No model-generated health/next-action classification. No persistence of tool calls or narration into `RunEvent`. No new polling loop for worker activity or control acknowledgement.
- No change to scheduling, retry, gate, merge-content, or worktree-isolation policy. One cleanup path only (the absorbed 08-27 decision).
- Never hand-edit generated files. Run `task generate` after every change to `wshrpc` or `waveobj` types (regenerates `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`).
- The Pi extension under `pi/extensions/` is the source; `cmd/wsh/cmd/{pi-status-extension.ts,arc-theme.json}` are generated by `task sync:piartifacts` — never edit the generated copies.
- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`. Baseline is clean; any reported error is this feature's.
- Go tests: set `CGO_CFLAGS=-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc` before `go test ./pkg/...`.
- No SCSS; express UI with Tailwind utilities and `@theme` tokens only. No new npm dependencies.
- Pure logic in `.ts` files with `.test.ts` beside them; thin `.tsx` render. No render/snapshot tests; visuals via `task verify:ui`.
- Event writes are best-effort, non-blocking, and attempted once per authoritative boundary; a failed append never fails the engine action.
- Text caps (ask summaries, cleanup errors, control errors) use named writer constants in one shared place — no magic numbers.
- Actions are non-optimistic: pending state until the persisted WOS update lands; errors surfaced inline, never swallowed.
- Degrade honestly: digest failure keeps task facts and hides stale health/next claims behind "Refreshing status"; missing worker/transcript/timeline/DAG each have explicit fallback states; status never inferred as healthy.
- The 200-row UI event window and 1,000-row storage cap per run stay unchanged; the digest uses its own bounded retained-event query, not the UI window.
- Health precedence (needs-you > stalled > healthy > done/cancelled), digest enums, and next-step ordering are deterministic and copied verbatim from spec §5.1–§5.3 — never re-derived in the frontend.
- Do not commit or push without explicit approval. Use diff checkpoints after each task; the spec and this plan fold into the eventual feature commit.
- Working tree currently carries unrelated modified files (`cmd/wsh/cmd/pi-simplify-gate-core-extension.ts`, `cmd/wsh/cmd/wshcmd-installhooks_test.go`, `pi/extensions/waveterm-simplify-gate-core.ts`). Do not stage or touch them.

---

## File map

### Phase 0 — durable-cleanup foundation (absorbed from 08-27)

- Create `pkg/orchestrate/cleanup.go` — the single idempotent worktree-cleanup helper + debt queries.
- Create `pkg/orchestrate/cleanup_test.go` — idempotency, bounded debt, never-merges-twice proofs.
- Modify `pkg/orchestrate/merge.go` + `merge_test.go` — delegate worktree removal to the helper; keep content integration separate; never re-run integration for a merged task.
- Modify `pkg/orchestrate/engine.go` + `engine_test.go` — run cleanup through the helper on ordinary merge retry; publish DAG after each persisted cleanup transition.
- Modify `cmd/server/main-server.go` — retry pending cleanup debt once at startup.
- Modify `pkg/wshrpc/wshserver/wshserver_dag.go` (+ test) — persist merge identity + `CleanupPending=true` before cleanup starts; clear on success; retain bounded `CleanupError` on failure.

### Phase 1 — backend digest contract

- Create `pkg/orchestrate/digest.go` — pure snapshot-fed digest builder (counts, health, next, task digests, durations, control).
- Create `pkg/orchestrate/digest_test.go` — contract enum coverage, health precedence, next-step derivation, partial durations.
- Create `pkg/orchestrate/digest_test_helpers_test.go` — shared snapshot fixtures for digest tests (only this phase; not part of the production build).
- Modify `pkg/wshrpc/wshrpctypes_dag.go` — digest contract types verbatim from spec §5.1 + `CommandDagStatusRtnData`.
- Modify `pkg/wshrpc/wshserver/wshserver_dag.go` (+ test) — DagStatus gathers snapshot inputs, returns `{Group, Digest}`.
- Modify `pkg/wstore/wstore_runevent.go` (+ test) — bounded query of retained events by run + kind set.
- Modify `cmd/wsh/cmd/wshcmd-jarvisdag.go` (+ test) — CLI consumes the shared digest instead of local action derivation.
- Run `task generate` after the contract change.

### Phase 2 — correlation and reusable worker presentation

- Create `pkg/jarvis/taskworker.go` (+ test) — TaskNode.RunID → child Run → WorkerOrefs → tab resolution with explicit unavailable outcomes.
- Create `frontend/app/view/orchestrate/taskcorrelate.ts` (+ test) — frontend task → run → worker → AgentVM resolution + fallback states.
- Create `frontend/app/view/agents/statusline.tsx` — extracted status/activity presentation unit (from `AgentRow`).
- Create `frontend/app/view/agents/activityline.tsx` — extracted current-activity + relative-age unit (from `AgentRow`/`NarrationTimeline`).
- Modify `frontend/app/view/agents/agentrow.tsx` — consume the extracted units; behavior unchanged.
- Modify `frontend/app/view/agents/insightblocks.tsx` if it shares status presentation (only where duplication is proven).

### Phase 3 — run-body overview and DAG navigation

- Create `frontend/app/view/orchestrate/dagdigest.ts` (+ test) — stale-digest guard, newest-request token, refresh triggers (pure).
- Create `frontend/app/view/orchestrate/dagoverview.tsx` — health strip, next-engine-move line, counts, workers list, attention/merge queue.
- Create `frontend/app/view/orchestrate/workertasksort.ts` (+ test) — exception-first worker ordering (pure).
- Modify `frontend/app/view/agents/runbody.tsx` (+ test where logic extracts) — mount the overview above the lead transcript.
- Modify `frontend/app/view/orchestrate/dagmodal.tsx` — selected-task rail worker treatment, **Open in Agent ↗**, "Not dispatched yet", "Worker session unavailable" + **View child run**.
- Modify `frontend/app/view/orchestrate/dagmodalstate.ts` (+ test) — carry the AgentsViewModel context for navigation; `selectedTaskIdAtom` stays the task-selection source.

### Phase 4 — lifecycle events and reusable timeline rail

- Modify `pkg/waveobj/runevent.go` — new RunEventKind constants + spec table docs (start/sent vs outcome boundary rule).
- Modify `pkg/orchestrate/engine.go` (+ test) — `task-done`, `task-failed`, `dag-cancelled`, `dag-gate-open` writers at authoritative boundaries.
- Create `pkg/orchestrate/askevents.go` (+ test) — centralized ask lifecycle writers at the `pkg/agentask` registry boundary (child-ask / child-answered / child-ask-cleared), one ask ID preserved across every answer path.
- Modify `pkg/orchestrate/merge.go` + `pkg/orchestrate/cleanup.go` (+ tests) — `task-merge-*` and `task-cleanup-*` writers at persisted boundaries.
- Create `frontend/app/view/orchestrate/timelinerail.tsx` (+ pure `timelinefilter.ts` test) — reusable rail (wide) / drawer (narrow), filters, event rows, selected-event detail, click targets, bidirectional cross-selection.
- Modify `frontend/app/view/agents/runtimeline.ts` + `runtimelineview.tsx` — refactor into the shared rail component; behavior preserved.

### Phase 5 — lead-control envelopes and acknowledgement

- Modify `pkg/orchestrate/control.go` (+ test) — stable event IDs, enriched envelope, `lead-control-sent`/`lead-control-failed` writers with bounded errors.
- Modify `pkg/wshrpc/wshrpctypes_dag.go` — `CommandPiControlAckData`.
- Modify `pkg/wshrpc/wshserver/wshserver_dag.go` (+ test) — ack handler: requires matching sent event, idempotent, ownership-mismatch rejection; `lead-control-acknowledged` writer.
- Modify `pi/extensions/waveterm-tools.ts` — preserve envelope fields; invoke the ack command after the watcher accepts the command. Run `task sync:piartifacts`.
- Modify `pkg/orchestrate/digest.go` (+ test) — `ControlDigest` derivation (acknowledged/unconfirmed/failed/unavailable).

### Phase 6 — hardening, responsive, accessibility, live E2E

- Modify `frontend/app/view/orchestrate/dagoverview.tsx` + `dagdigest.ts` / `taskcorrelate.ts` — all degradation states, ask-changes-during-load race.
- Modify `frontend/app/view/orchestrate/timelinerail.tsx` — narrow-layout drawer decision, keyboard focus, `aria-live` health/attention only, leaf-level relative-age timers.
- Create `scripts/cdp/orchestrator-observability-e2e.mjs` — live E2E scenario per spec §10.3 (also used to extend `task verify:ui`).

---

## Phase 0 — Durable-cleanup foundation

### Task 0.1: Extract the single idempotent cleanup helper

**Files:**
- Create: `pkg/orchestrate/cleanup.go`
- Test: `pkg/orchestrate/cleanup_test.go`
- Modify: `pkg/orchestrate/merge.go`

**Interfaces:**
- Consumes: `waveobj.TaskNode{CleanupPending, CleanupError, Merged, ID, RunID}`; `waveobj.TaskGroup{ChannelId, RunID}`; existing worktree removal in `pkg/orchestrate/worktree.go` (read it first).
- Produces:
  - `func PendingCleanupTasks(g *waveobj.TaskGroup) []*waveobj.TaskNode` — tasks with `Merged && (CleanupPending || CleanupError != "")`, in DAG order.
  - `func HasCleanupDebt(g *waveobj.TaskGroup) bool` — any pending/failed cleanup, or `Status`-terminal with debt (used by digest health).
  - `func CleanupTaskWorktree(ctx context.Context, g *waveobj.TaskGroup, taskID string) error` — idempotent: resets `CleanupPending=false`, on success clears `CleanupError`; on failure sets bounded `CleanupError` and returns the error.

- [x] **Step 1: Read before writing.** Read `pkg/orchestrate/merge.go`, `worktree.go`, `dag.go` and `cmd/wsh/wshserver/wshserver_dag.go` to find where worktree removal currently happens inline (merge outcome path) and how `CleanupPending`/`CleanupError` are currently set and cleared (it is known some persistence shipped on 2026-08-27; the plan does not re-derive). Note what exists so the helper replaces only the removal half.
- [x] **Step 2: Write the failing test.** `pkg/orchestrate/cleanup_test.go` using DAG fixtures from `dag_test.go` (reuse its helper constructors):

```go
func TestCleanupTaskWorktreeIdempotent(t *testing.T) {
    // task merged, CleanupPending=true, worktree dir already removed
    // call CleanupTaskWorktree twice -> second call nil, no error,
    // TaskNode.CleanupPending==false && CleanupError==""
}

func TestCleanupTaskWorktreeBoundedError(t *testing.T) {
    // removal fails (stub the remove fn) -> CleanupError set and
    // len(CleanupError) <= MaxCleanupErrorLen; status retained
}

func TestPendingCleanupTasksOrder(t *testing.T) {
    // two debt tasks out of a five-task group -> returned in DAG order, others excluded
}
```

- [x] **Step 3: Run to verify it fails.** `go test ./pkg/orchestrate/ -run 'TestCleanupTaskWorktree|TestPendingCleanupTasks'`. Expected: FAIL, `undefined: CleanupTaskWorktree`.
- [x] **Step 4: Implement.** `cleanup.go` with an injectable removal function (package var, mirroring `notifyLeadFn` in `control.go`), the three functions above, and the named constants `MaxCleanupErrorLen` (pick 200, one named source) + `CleanupErrorMsgPrefix` if needed. Reuse the existing remove logic from `worktree.go` rather than rewriting it.
- [x] **Step 5: Verify pass.** Same command. Expected: PASS.
- [x] **Step 6: Rewire `merge.go`.** Replace its inline worktree-removal residue with `CleanupTaskWorktree`. Confirm no second removal path remains in the package: `rg -n 'os.RemoveAll|RemoveWorktree|WorktreeRemove' pkg/orchestrate/`.
- [x] **Step 7: Checkpoint.** `go test ./pkg/orchestrate/` green; `task build:backend` builds. Show diff; no commit without approval.

### Task 0.2: Persist merge identity and cleanup state at the right boundaries

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` + `wshserver_dag_test.go`

**Interfaces:**
- Consumes: merge path in `wshserver_dag.go` (merge/merge-continue RPCs) as it exists today.
- Produces: unchanged RPC surface; the merge handler now guarantees the ordering in spec §5.0.1-3: persist child end commit + merged marker + `CleanupPending=true` → cleanup through `CleanupTaskWorktree` → clear state on success / bounded `CleanupError` on failure.

- [x] **Step 1: Write the failing test.** Add to `wshserver_dag_test.go` a scenario proving: after one merge RPC, a merged task that would fail cleanup retains `CleanupPending==false`, `CleanupError != ""` (bounded), `Merged==true`, and the merge content is NOT re-integrated on a second retry-merge (assert the integration stub is called once).
- [x] **Step 2: Run to verify it fails.** `go test ./pkg/wshrpc/wshserver/ -run 'TestDag.*Cleanup'`. Expected: FAIL (current order does not persist pending-before-cleanup or dedupe re-integration).
- [x] **Step 3: Implement.** Reorder the merge handler per §5.0.1-3: record identity + `CleanupPending=true` + persist, then run `CleanupTaskWorktree`, then persist the outcome. Never re-run content integration when `task.Merged` is already true.
- [x] **Step 4: Verify pass.** Same command. Expected: PASS.
- [x] **Step 5: Checkpoint.** `go test ./pkg/...` (with CGO_CFLAGS), `task build:backend`. Show diff.

### Task 0.3: Retry cleanup debt at startup and on merge retry

**Files:**
- Modify: `cmd/server/main-server.go`
- Modify: `pkg/orchestrate/engine.go` + `engine_test.go`

**Interfaces:**
- Consumes: `PendingCleanupTasks`, `CleanupTaskWorktree` (0.1).
- Produces: a `func RetryPendingCleanup(ctx context.Context, g *waveobj.TaskGroup) error` in `cleanup.go` (calls the helper for each `PendingCleanupTasks` entry, collects the first error).

- [x] **Step 1: Add `RetryPendingCleanup` to `cleanup.go`** with a unit test (mixed debt: one clears, one still fails → first error returned, cleared one cleared).
- [x] **Step 2: Startup retry.** In `main-server.go`, after DB open, load groups with pending cleanup (`wstore_dag.go` already has the query from 08-27 — verify its name in `pkg/wstore/wstore_dag.go`) and call `RetryPendingCleanup` once. Log outcomes; never fail startup.
- [x] **Step 3: Merge-retry path.** In `engine.go`, where a retried task's merge is handled, route through `RetryPendingCleanup` before dispatch when debt exists.
- [x] **Step 4: Checkpoint.** `go test ./pkg/orchestrate/ ./pkg/wstore/`, `task build:backend`. Show diff.

### Task 0.4: Publish the DAG after every persisted cleanup transition

**Files:**
- Modify: `pkg/orchestrate/engine.go` (or the mutation helper it uses) + `engine_test.go`

**Interfaces:**
- Consumes: the existing WOS publish path used after DAG mutations (find `DebugUpdateDag`/publish call in `engine.go`).
- Produces: no new API; every cleanup state change (pending→clear, pending→failed, retry outcome) triggers the same publish the DAG already uses.

- [x] **Step 1: Failing test.** A group whose cleanup goes pending→failed→clear across retry must emit matching WOS versions through the existing publish mechanism (assert the subscriber received each transition).
- [x] **Step 2: Run to verify it fails** (`go test ./pkg/orchestrate/ -run TestCleanupPublish`).
- [x] **Step 3: Implement** — call the existing publish after each persisted cleanup transition in 0.1/0.3 paths.
- [x] **Step 4: Verify pass + full phase checkpoint.** All Phase 0 tests green: `go test ./pkg/orchestrate/ ./pkg/wshrpc/wshserver/ ./pkg/wstore/`. `task build:backend`. Show diff. **Phase 0 gates every later phase.**

---

## Phase 1 — Backend digest contract

### Task 1.1: Digest contract types and RPC signature change

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_dag.go`
- Modify: `pkg/wshrpc/wshclient/wshclient.go` (generated — do not hand-edit)
- Run `task generate`.

**Interfaces:**
- Consumes: everything in spec §5.1 verbatim (copy the complete contract below into `wshrpctypes_dag.go`, no field renames, no `omitempty` or enum value changes).
- Produces: `CommandDagStatusRtnData{Group *waveobj.TaskGroup; Digest DagStatusDigest}` returned by `DagStatusCommand`, and the full digest type block:

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

- [ ] **Step 1: Add the contract types** verbatim to `wshrpctypes_dag.go` (the block above). Change `DagStatusCommand` return to `(*CommandDagStatusRtnData, error)`.
- [ ] **Step 2: Run `task generate`.** Verify generated `wshclient.go` `DagStatusCommand` returns `*wshrpc.CommandDagStatusRtnData` and `frontend/app/store/wshclientapi.ts`/`frontend/types/gotypes.d.ts` carry the new types.
- [ ] **Step 3: Typecheck both sides.** `go vet ./pkg/wshrpc/` and `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`. Expected: Go compiles (handler still returns `*TaskGroup`? — that breaks; see T1.3); TS clean (FE currently ignores return shape or uses `.Tasks` — fix in T3.1, keep tsc green here only if trivial; otherwise defer FE consumption to T3.1 and accept an intentionally typed cast in the interim — no: if tsc is red, land a minimal FE type update here: `dagstore.ts` status calls cast to the new return and read `.group`).
- [ ] **Step 4: Checkpoint.** `task build:backend`, tsc green. Show diff.

### Task 1.2: Pure digest builder

**Files:**
- Create: `pkg/orchestrate/digest.go`
- Test: `pkg/orchestrate/digest_test.go`
- Create: `pkg/orchestrate/digest_test_helpers_test.go`

**Interfaces:**
- Consumes: `waveobj.TaskGroup`, `waveobj.Run`, `waveobj.RunEvent`, `DagAskItem` (wshrpctypes_dag.go), and scheduler helpers `gateBlocked(g)`, `ReadyTasks(g)`, `depSatisfied(g,id)`, `NextToSpawn(g)` (scheduler.go); `HasCleanupDebt` (0.1). The retained event rows passed in were gathered by the RPC layer (T1.3).
- Produces:
  - `type DagDigestSnapshot struct { Group *waveobj.TaskGroup; Runs []*waveobj.Run; Asks []DagAskItem; Retained []waveobj.RunEvent; Now time.Time }`
  - `func BuildDigest(sn DagDigestSnapshot) DagStatusDigest` — pure: no storage, no clock reads, no log writes. `DagVersion == sn.Group.Version`.
  - Internal sub-builders kept in the same file: `buildCounts`, `buildHealth`, `buildNext`, `buildTaskDigest`, `buildDurations` (each unit-testable via the exported `BuildDigest`). `Control` stays nil here — the owner group has no control rows yet; T5.4 adds `buildControl` and populates it.

- [ ] **Step 1: Write failing tests for health precedence.** Copy the exact semantics of spec §5.2. Fixtures via `digest_test_helpers_test.go` (builder funcs returning a `TaskGroup` with N tasks in chosen states, a fake child `Run`, retained `RunEvent` rows, asks):

```go
func TestHealthNeedsYouAsk(t *testing.T)       // child ask present -> "needs-you"
func TestHealthNeedsYouBlockedMerge(t *testing.T) // task state blocked-merge -> "needs-you"
func TestHealthNeedsYouFailedCleanupCancelled(t *testing.T) // terminal group + retained task-failed cleanup -> "needs-you"
func TestHealthStalled(t *testing.T)           // stalled task, no attention -> "stalled"
func TestHealthHealthyWait(t *testing.T)       // dependency/parallelism wait only -> "healthy"
func TestHealthDone(t *testing.T)              // group status done, no debt -> "done"
func TestHealthCancelled(t *testing.T)         // group status cancelled, no debt -> "cancelled"
```

- [ ] **Step 2: Run to verify they fail** (`go test ./pkg/orchestrate/ -run 'TestHealth'`).
- [ ] **Step 3: Implement `buildCounts` + `buildHealth`.** Use the scheduler helpers; `RecoveredRetry` counts `done` tasks with a retained `task-retried` event for the same task id (spec §5.1); `MergeReady` counts done + (released-when-gated) + unmerged in merge-required DAGs; `Attention` per spec §5.1 (asks, unreleased gates, terminal failures, blocked merges, failed cleanup — not ordinary stalls or cleanup in progress).
- [ ] **Step 4: Verify pass.** `go test ./pkg/orchestrate/ -run 'TestHealth|Test.*Digest'`. Expected: PASS.
- [ ] **Step 5: Next-step tests.** Spec §5.3 ordering (answer → approve/sendback → resolve-merge → retry-cleanup → retry/skip/escalate → merge-ready → dispatch → parallelism-wait → dependency-wait → terminal). Assert `TaskIds` in DAG order within one condition, `BlockingTaskIds` populated for dependency waits, `Actions` complete and valid for the condition.
- [ ] **Step 6: Implement `buildNext` + `buildTaskDigest`.** `WaitReason` per task; `FreshnessTs` from `TaskNode.LastActivity`; `CleanupState`/`MergeState` per spec §5.1 (cleanup `clear` whenever no debt, including before integration and after completion; `pending` while no error; `failed` when debt carries an error).
- [ ] **Step 7: Duration tests** — `RunMs` = Σ complete child phase `[StartedTs, DoneTs]`; `MergeWaitMs` = `task-done`→first `task-merge-started`; `CleanupMs` = `task-cleanup-pending`→completed/failed; missing boundary → `Partial:true` and zero duration, never fabricated; elapsed = `Now-CreatedTs` while active, terminal timestamp minus `CreatedTs` after `dag-done`/`dag-cancelled`; a pruned required boundary marks the aggregate `Partial`.
- [ ] **Step 8: Implement `buildDurations`.** Run child phase time-stamp fields live on `waveobj.RunPhase` (read `pkg/waveobj/wtype.go` Run/RunPhase first).
- [ ] **Step 9: Version + stability tests** — `Digest.DagVersion == Group.Version`; same version with changed ask state → different `Next`/task `AskId` (spec §10.1: "same DAG version with changed ask state produces a new digest"); recoverd-retry derivation uses retained history + current success.
- [ ] **Step 10: Full phase test + checkpoint.** `go test ./pkg/orchestrate/ -run 'Digest|Health'` green. Show diff.

### Task 1.3: RPC input gathering and handler rewire

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` + `wshserver_dag_test.go`
- Modify: `pkg/wstore/wstore_runevent.go` + `wstore_runevent_test.go`

**Interfaces:**
- Consumes: `BuildDigest` + `DagDigestSnapshot` (1.2); `QueryRunEvents`; `DagAsksCommand` ask source.
- Produces:
  - `func QueryRunEventsByKind(ctx context.Context, channelId, runId string, kinds []string, limit int) ([]waveobj.RunEvent, error)` in `wstore_runevent.go` (bounded; used only by the digest, not the 200-row UI path).
  - DagStatus handler now: loads `*TaskGroup`; loads ≤ 8 child runs (`TaskNode.RunID` unique set, channel-scoped `wstore.GetRun`); loads pending asks (reuse the existing ask list path); loads retained kinds for durations/retries/control (kind set: `task-retried`, `task-done`, `task-merge-started`, `task-cleanup-pending`, `task-cleanup-completed`, `task-cleanup-failed`, `dag-done`, `dag-cancelled`, `lead-control-sent`, `lead-control-failed`, `lead-control-acknowledged`); `Now: time.Now()`; returns `CommandDagStatusRtnData`.

- [ ] **Step 1: `wstore_runevent_test.go` fails for the new query** (assert it returns only requested kinds, bounded limit, newest-first).
- [ ] **Step 2: Implement `QueryRunEventsByKind`** (filter on `QueryRunEvents` output or a dedicated sql query — read `wstore_runevent.go` first; pick the smaller change).
- [ ] **Step 3: Rewire DagStatus** to assemble the snapshot and call `BuildDigest`. `DagStatusCommand` now returns `{Group, Digest}`. Keep `DagActionCommand`/`DagMergeCommand` unchanged.
- [ ] **Step 4: Handler test.** An existing dag test's status assertions are updated to read `.Group`; add an assertion that `Digest.Counts.Total == len(Group.Tasks)`.
- [ ] **Step 5: Checkpoint.** `go test ./pkg/wshrpc/wshserver/ ./pkg/wstore/`, `task build:backend`, `task generate` if the type moved (it did not in this task). Show diff.

### Task 1.4: CLI consumes the shared digest

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` + its test file

**Interfaces:**
- Consumes: `DagStatusCommand` → `CommandDagStatusRtnData` (1.1/1.3), digest fields.
- Produces: CLI next-action output derived only from `Digest.Next.Actions`/`TaskIds` + `Group` state. No CLI-local schedule derivation survives.

- [ ] **Step 1: Failing test** — CLI status output for a needs-you digest shows the digest action set for the task, not a locally reconstructed alternative.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — replace the CLI-local action derivation with the digest fields.
- [ ] **Step 4: Checkpoint.** `go test ./cmd/wsh/...`, `task build:backend`. Show diff. **Phase 1 complete: shared digest is the single contract for CLI and UI.**

---

## Phase 2 — Correlation and reusable worker presentation

### Task 2.1: Backend task → worker correlation helper

**Files:**
- Create: `pkg/jarvis/taskworker.go`
- Test: `pkg/jarvis/taskworker_test.go`

**Interfaces:**
- Consumes: `waveobj.TaskNode.RunID`, `wstore.GetRun` (channel-scoped), `RunPhase.WorkerOrefs`, tab chain (as in `pkg/jarvis/resolve.go` `ResolveRunWorker`).
- Produces: `type TaskWorker struct { Run *waveobj.Run; PhaseIdx int; TabId string; Resolved bool }` and `func ResolveTaskWorker(ctx context.Context, channelId string, task *waveobj.TaskNode) (*TaskWorker, error)` — `Resolved==false` + explicit reason when run missing, no running/recorded phase, or no tab (matches the degradation cases in spec §6.2: Not dispatched / Worker session unavailable).

- [ ] **Step 1: Failing test** covering: run missing → unresolved (not-dispatched); run with no phase → unresolved; run with tab phase → resolved TabId; run whose recorded phase has no tab oref but a run exists → unresolved with worker-session-unavailable reason.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** (`ResolveTaskWorker`; reuse `ResolveRunWorker`'s phase-walk pattern — do not copy tab-footgun logic, prefer the existing walk).
- [ ] **Step 4: Verify pass + checkpoint.**

### Task 2.2: Frontend correlation module

**Files:**
- Create: `frontend/app/view/orchestrate/taskcorrelate.ts`
- Test: `frontend/app/view/orchestrate/taskcorrelate.test.ts`

**Interfaces:**
- Consumes: `selectedTaskIdAtom`/`dagstore` task run ids, Agent roster (the atoms behind the Agents view — read `frontend/app/view/agents/` store file first), `jumpToAgent(model, tabId)` from `channelsprimitives.tsx`/`runbody.tsx` callers.
- Produces:
  - `type TaskWorkerView = { state: "dispatched" | "pending" | "unavailable"; tabId?: string; runId?: string; agent?: AgentVM; }`
  - `function resolveTaskWorker(task: TaskNodeView, agents: AgentsViewModel): TaskWorkerView` (pure)
  - `function openTaskWorker(view: TaskWorkerView, model: AgentsViewModel): void` — routes to `jumpToAgent` or the run-fallback.

- [ ] **Step 1: Failing test** — dispatched-with-tab, pending, missing-session, closed-session cases; `openTaskWorker` never called for pending.
- [ ] **Step 2-4: TDD cycle.** Implement; run; pass.

### Task 2.3: Extract reusable worker presentation

**Files:**
- Create: `frontend/app/view/agents/statusline.tsx`, `frontend/app/view/agents/activityline.tsx`
- Modify: `frontend/app/view/agents/agentrow.tsx` (consume the units; visual behavior unchanged)

**Interfaces:**
- Consumes: `AgentVM`'s status/activity fields and the NarrationTimeline's relative-age machinery (read `agentrow.tsx` + `narrationtimeline.tsx` first; extract only the units the orchestrator overview needs — status pill/line, current-activity line with leaf-level aging).
- Produces: `StatusLine({agent})`, `ActivityLine({agent})` props typed from `AgentVM`. `AgentRow` renders them; the overview (Phase 3) reuses the same components per spec §6.1 ("does not render `AgentRow` directly").

- [ ] **Step 1: Extract `StatusLine` + `ActivityLine` as pure presentational components** with exports matching the row's current markup (colors from `@theme` tokens, status always text-or-icon, never color alone).
- [ ] **Step 2: Rewire `AgentRow`** to compose them. No test for the row (rendering); rely on `task verify:ui` (Phase 6.3).
- [ ] **Step 3: tsc + lint checkpoint.** `node --stack-size=4000 ...tsc --noEmit -p tsconfig.json` and `npx eslint frontend/app/view/agents/`. Show diff.

---

## Phase 3 — Run-body overview and DAG navigation

### Task 3.1: Digest hook with staleness and newest-request guard

**Files:**
- Create: `frontend/app/view/orchestrate/dagdigest.ts`
- Test: `frontend/app/view/orchestrate/dagdigest.test.ts`

**Interfaces:**
- Consumes: `CommandDagStatusRtnData` from generated `wshclientapi.ts`; `TaskGroup.Version` from WOS.
- Produces: `function useDagDigest(channelId: string, runId: string): DigestState` where `DigestState = { digest?: DagStatusDigest; loading: boolean; stale: boolean; error?: string }`. Pure helpers exported for tests: `acceptDigest(candidate, current, observedVersion, requestToken, newestToken)` — accepts only when `candidate.DagVersion == observedVersion` AND candidate belongs to the newest outstanding request (spec §9 + §8 stale table); `shouldRefreshDigest(prev, next, event)` — refresh on observed `TaskGroup.Version` change or child ask/answer/clear or lead-control sent/failed/acknowledged events (spec §9).

- [ ] **Step 1: Failing tests** — stale version rejected; same-version older-response-loses (ask-changes-during-load race, spec §10.2); refresh triggers from events; loading/error states.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** (pure functions + a thin hook over the existing wshclient call used by `dagstore.ts` today).
- [ ] **Step 4: Verify pass + checkpoint.**

### Task 3.2: Overview component

**Files:**
- Create: `frontend/app/view/orchestrate/dagoverview.tsx`
- Create: `frontend/app/view/orchestrate/workertasksort.ts` + `workertasksort.test.ts`
- Modify: `frontend/app/view/agents/runbody.tsx` (mount above the lead transcript, spec §6.1)

**Interfaces:**
- Consumes: `useDagDigest`, `StatusLine`/`ActivityLine` (2.3), `resolveTaskWorker` (2.2), `CommandDagStatusRtnData`.
- Produces: `workertasksort.ts`: `type WorkerSortBucket = "attention" | "running" | "waiting" | "done"` and `function workerSortKey(task: DagTaskDigest, node: TaskNodeView): number` — exception-first order per spec §6.1 (asks, failed, stalled, blocked-merge, cleanup-failed → running → ready/dependency-waiting → completed/merged/skipped/cancelled). Overview renders: health strip (`Health` + `Counts` + boilerplate from durations), next-engine-move line from `Next` (typed → text via a pure `nextStepText` helper in `dagdigest.ts`), workers list, attention/merge queue (only actionable exceptions + merge-ready tasks), selected-worker narration via the transcript projection used by `NarrationTimeline`.

- [ ] **Step 1: `workertasksort.test.ts` fails** — ordering per spec §6.1 buckets.
- [ ] **Step 2: Implement `workertasksort.ts` + `nextStepText`** (pure).
- [ ] **Step 3: Build `dagoverview.tsx`** composing health strip, next move, workers, queue; all text-or-icon status; `aria-live="polite"` only on health/attention transitions (spec §6.4).
- [ ] **Step 4: Mount in `runbody.tsx`** above the lead transcript for orchestrator runs (`run.dagoref` present — reuse the same guard as the existing "Open DAG" button at runbody.tsx:~210).
- [ ] **Step 5: tsc + tests checkpoint.**

### Task 3.3: DAG modal Open in Agent navigation

**Files:**
- Modify: `frontend/app/view/orchestrate/dagmodal.tsx`
- Modify: `frontend/app/view/orchestrate/dagmodalstate.ts` (+ `dagmodalstate.test.ts`)

**Interfaces:**
- Consumes: `resolveTaskWorker`/`openTaskWorker` (2.2); the run body must pass an AgentsViewModel down (find where runbody's model lives and thread it through `DagModal` — read `dagmodal.tsx` caller first).
- Produces: in the selected-task rail: the existing worker-row treatment via `StatusLine`/`ActivityLine`; a "Not dispatched yet" state for `TaskNode.RunID == ""`; "Worker session unavailable" + **View child run** for `state == "unavailable"`; **Open in Agent ↗** for `state == "dispatched"` calling `openTaskWorker`; `selectedTaskIdAtom` remains the selection source; node click still selects, never navigates.

- [ ] **Step 1: Extend `dagmodalstate.test.ts`** — pending tasks never expose Open in Agent; dispatched tasks resolve and route through `jumpToAgent`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement modal changes** — thread the model, render the rail states.
- [ ] **Step 4: tsc + tests checkpoint.** Show diff.

---

## Phase 4 — Lifecycle events and reusable timeline rail

### Task 4.1: New RunEvent kinds and boundary docs

**Files:**
- Modify: `pkg/waveobj/runevent.go`

**Interfaces:**
- Consumes: existing kind constants (17 kinds — see the `RunEventKind*` block in `runevent.go`).
- Produces: new constants — `RunEventKindTaskDone`, `RunEventKindTaskFailed`, `RunEventKindDagCancelled`, `RunEventKindDagGateOpen`, `RunEventKindChildAsk`, `RunEventKindChildAnswered`, `RunEventKindChildAskCleared`, `RunEventKindTaskMergeStarted`, `RunEventKindTaskMergeBlocked`, `RunEventKindTaskMergeContinued`, `RunEventKindTaskMerged`, `RunEventKindTaskCleanupPending`, `RunEventKindTaskCleanupCompleted`, `RunEventKindTaskCleanupFailed`, `RunEventKindLeadControlSent`, `RunEventKindLeadControlFailed`, `RunEventKindLeadControlAcknowledged`. Gate approved/sent-back stay on the existing `RunEventKindGateApproved`/`RunEventKindGateSentBack`; run cancellation stays `RunEventKindRunCancelled`. Add the spec §7 comment block stating the boundary rule (start/sent after delivery-write succeeds; outcome only after the authoritative state mutation persists; one attempt per boundary; one row on success).

- [ ] **Step 1: Add constants + docs.** No behavior yet.
- [ ] **Step 2: Checkpoint** — compile only (`go build ./pkg/waveobj/`); the FE gets the new kinds via `task generate` at the end of this phase.

### Task 4.2: Task-level writers in the engine

**Files:**
- Modify: `pkg/orchestrate/engine.go` + `engine_test.go`

**Interfaces:**
- Consumes: `AppendRunEvent(ctx, channelId, runId, kind, nil, detail)` (wstore_runevent.go:34).
- Produces: writers at boundaries: `task-done` (task id + child run id) when a child completes; `task-failed` (task id, child run id, `lastfailurekind`, `attempts`) when a task fails terminally; `dag-cancelled` (cancellation source) in the cancel mutation; `dag-gate-open` (task id) when a gated task reaches completion and halts the DAG. Appends are best-effort goroutine-free attempts (spec §7: one attempt at the boundary; failure logged, never returned as engine error).

- [ ] **Step 1: Failing tests** in `engine_test.go` — each new kind appears exactly once at its boundary; a stubbed append failure does not fail the engine action.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement writers** at the existing spawn/stall/retry-event sites (read `engine.go` lines ~200-320 where `RunEventKindTaskSpawned`/`TaskStalled`/`TaskRetried` are appended; the completion/cancel paths are nearby).
- [ ] **Step 4: Verify pass + retry-event tests still green** (`retryevent_test.go`).

### Task 4.3: Centralized ask lifecycle writers

**Files:**
- Create: `pkg/orchestrate/askevents.go`
- Test: `pkg/orchestrate/askevents_test.go`
- Modify: `pkg/agentask/deliver.go` or the ask list/deliver path in `pkg/wshrpc/wshserver/wshserver_dag.go` (read both first; centralize at the registry boundary per spec §7).

**Interfaces:**
- Consumes: ask registry (`pkg/agentask/agentask.go`), `DagAskItem{TaskId, Question, Options, BlockORef, Ts}`, `AppendRunEvent`.
- Produces: a shared helper `recordAskLifecycle(ctx, channelId, runId, eventKind, taskId, askId, summaryOrReason)` with a named writer constant `MaxAskSummaryLen` (256) capping the stored question summary. One ask id (the registry's generated id passed through child correlation, spec §7 "AskCommand passes its generated ask ID") survives across: `child-ask` (after registry entry exists), `child-answered` (on successful `DeliverAnswer`), `child-ask-cleared` (dismiss/cancel/waiter-end, with clear reason). Resolves block → child run → task through one helper so cockpit answers, Gatekeeper answers, and direct DAG answers cannot diverge. Duplicate answer/clear calls that find no pending ask append nothing.

- [ ] **Step 1: Failing tests** — raise appends `child-ask` with cap; answer appends `child-answered` preserving ask id; clear appends `child-ask-cleared` with reason; duplicate clear appends nothing; summary > cap is truncated to exactly the cap.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement `askevents.go` + wire the three call sites** (ask raise in the DagAsk/child correlation path; deliver in `deliver.go`; clear in the ask-clear/dismiss path).
- [ ] **Step 4: Verify pass + existing dagask tests green** (`wshserver_dagask_test.go`).

### Task 4.4: Merge and cleanup writers

**Files:**
- Modify: `pkg/orchestrate/merge.go` + `merge_test.go`
- Modify: `pkg/orchestrate/cleanup.go` + `cleanup_test.go`

**Interfaces:**
- Consumes: `AppendRunEvent`, `CleanupTaskWorktree` (0.1).
- Produces: `task-merge-started` before integration; `task-merge-blocked` on conflict; `task-merge-continued` when a blocked merge resumes; `task-merged` (task id, child run id, commit when available) after content integration persists; `task-cleanup-pending` when `CleanupPending=true` persists; `task-cleanup-completed` after clear persists; `task-cleanup-failed` (bounded error via a named `MaxCleanupErrEventLen` constant, 200) when debt persists with an error. All at the persisted boundaries from Phase 0, never at transient in-memory points.

- [ ] **Step 1: Failing tests** — each new kind written exactly once at its boundary; cleanup phases emit pending → completed/failed matching the persisted transitions; a failed `AppendRunEvent` never fails the merge or cleanup.
- [ ] **Step 2-4: TDD cycle.**
- [ ] **Step 5: Run `task generate` and typecheck TS** (new kinds now visible to the FE); `node --stack-size=4000 ... tsc --noEmit -p tsconfig.json` stays clean.

### Task 4.5: Reusable timeline rail with cross-selection

**Files:**
- Create: `frontend/app/view/orchestrate/timelinerail.tsx`
- Create: `frontend/app/view/orchestrate/timelinefilter.ts` + `timelinefilter.test.ts`
- Modify: `frontend/app/view/agents/runtimeline.ts` + `runtimelineview.tsx` — refactor into the shared rail; behavior preserved.

**Interfaces:**
- Consumes: `QueryRunEvents`-backed FE loading (the existing 200-row cap), `selectedTaskIdAtom` (task-selection source stays there), `resolveTaskWorker`, event detail shapes (`RunEvent.Detail` json).
- Produces: `timelinefilter.ts`: `type TimelineFilter = "all" | "task" | "attention"` + `function filterEvents(events: RunEventView[], filter: TimelineFilter, selectedTaskId?: string): RunEventView[]` (pure; attention = kinds in the ask/gate/failure/merge-blocked/cleanup-failed/control-failed set). Rail: live count + connection state, chronological rows, selected-event detail, click targets (worker via `openTaskWorker`, DAG task via `selectedTaskIdAtom`, gate/merge/evidence/child-run via event kind routing — a pure `eventClickTarget(event)` helper), bidirectional cross-selection (worker select → highlight task + filter; task select → select worker + filter; event select → best target).

- [ ] **Step 1: `timelinefilter.test.ts` fails** — filters, task-scoped, attention set, and cross-selection routing.
- [ ] **Step 2: Implement pure helpers** (`filterEvents`, `eventClickTarget`).
- [ ] **Step 3: Refactor `runtimelineview.tsx` into the shared rail** with wide/drawer layout hooks (drawer decision implemented in Phase 6; here the component takes `layout: "rail" | "drawer"` prop).
- [ ] **Step 4: Mount the rail** in the DAG/run layout; keep `runtimelineview.tsx` as the run body's thin wrapper.
- [ ] **Step 5: tsc + tests checkpoint.** Show diff.

---

## Phase 5 — Lead-control envelopes and acknowledgement

### Task 5.1: Stable control envelopes and sent/failed writers

**Files:**
- Modify: `pkg/orchestrate/control.go` + `control_test.go`

**Interfaces:**
- Consumes: `NotifyLead`, `controlMessage`, `resolveLeadSessionID` (control.go today).
- Produces: `func NewControlEventID() string` (uuid); envelope now carries `eventid`, `channelid`, `runid`, `taskid` (when applicable), `sessionid` in addition to `cmd`/`content`/`ts`; writers via `AppendRunEvent`: `lead-control-sent` (event id + kind + session id) only after the control-file write succeeds; `lead-control-failed` with bounded error (named `MaxControlErrEventLen`, 200) and failure kind `unavailable` (no control dir / unresolved lead session) or `write` (write error) — spec §7.1.

- [ ] **Step 1: Failing tests** — envelope contains the six fields in order; sent write succeeds → `lead-control-sent` row with event/session ids; missing control dir → `lead-control-failed` kind `unavailable`; write error → kind `write` + bounded error; append failure does not fail delivery.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** — extend `controlMessage`, thread `taskid` from the DAG event call sites, add the writers.
- [ ] **Step 4: Verify pass + checkpoint.**

### Task 5.2: Acknowledgement RPC and idempotent handler

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` — add `CommandPiControlAckData`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` + `wshserver_dag_test.go`

**Interfaces:**
- Consumes: `lead-control-sent` rows; `AppendRunEvent`.
- Produces: ``type CommandPiControlAckData struct { ChannelId string `json:"channelid"`; RunId string `json:"runid"`; EventId string `json:"eventid"`; SessionId string `json:"sessionid"` }`` (exact spec §7.1). Handler: requires a matching `lead-control-sent` for the same channel+run+event+session before appending `lead-control-acknowledged` (id + ack ts); matching repeat ack = idempotent no-op; unknown event / mismatched session / ack for failed delivery → contextual error, nothing appended.

- [ ] **Step 1: Failing tests** — ack for a real sent event appends acknowledged once; repeat ack appends nothing; unknown event rejects; mismatched session rejects; ack for a failed-delivery event rejects.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** — RPC type (then `task generate`), handler, writer.
- [ ] **Step 4: Verify pass + checkpoint.**

### Task 5.3: Pi extension acknowledgement call

**Files:**
- Modify: `pi/extensions/waveterm-tools.ts` (the control watcher/dispatcher referenced by control.go's `controlFileName` comment)
- Run `task sync:piartifacts`.

**Interfaces:**
- Consumes: envelope fields (`eventid`, `channelid`, `runid`, `sessionid`) preserved by the parser.
- Produces: after the watcher successfully accepts the command through its dispatcher, the extension calls the ack RPC with the exact `CommandPiControlAckData` fields. Preserves all envelope fields through the parser (spec §7.1 "The Pi extension parser preserves those fields").

- [ ] **Step 1: Read `pi/extensions/waveterm-tools.ts`** control-watcher section (find where `content`/`cmd` are parsed and dispatched).
- [ ] **Step 2: Implement** — field preservation + ack invocation after successful dispatch; failure to ack is logged, never blocks the command.
- [ ] **Step 3: Run `task sync:piartifacts`** and diff the generated artifacts minimally.
- [ ] **Step 4: Checkpoint** — `go build ./...` and `npx eslint pi/extensions/`.

### Task 5.4: Control digest derivation

**Files:**
- Modify: `pkg/orchestrate/digest.go` + `digest_test.go`

**Interfaces:**
- Consumes: retained `lead-control-*` rows (query from T1.3 kind set), parsed envelope fields.
- Produces: `ControlDigest` in `DagStatusDigest` — `acknowledged` (matching ack exists), `unconfirmed` (sent, no ack), `failed` (write failed), `unavailable` (no channel/session); `SentTs`/`AcknowledgedTs`; latest attempt only; a superseded control file stays unconfirmed; acknowledgements never transfer between event ids.

- [ ] **Step 1: Failing tests** — the four states; latest-attempt-wins; id mismatch never transfers ack.
- [ ] **Step 2-4: TDD cycle + checkpoint** — `go test ./pkg/orchestrate/ ./pkg/wshrpc/wshserver/`, `task build:backend`.

---

## Phase 6 — Hardening, responsiveness, accessibility, live E2E

### Task 6.1: Degradation states and race handling

**Files:**
- Modify: `frontend/app/view/orchestrate/dagoverview.tsx`, `dagdigest.ts`, `taskcorrelate.ts` (+ their tests)

**Interfaces:**
- Consumes: Phase 3-4 components, `useDagDigest` state.
- Produces: per spec §8 table — DAG unavailable → "DAG status unavailable" (never inferred healthy); worker unresolved → task visible + unavailable + child-run fallback; transcript unavailable → "Activity unavailable"; timeline load failure → explicit retry, health/workers continue; digest failure → task facts shown, stale health/next hidden behind "Refreshing status"; action failure → retain state, clear pending, inline contextual error; control unconfirmed/unavailable → warning only. Actions non-optimistic (pending until persisted WOS update).

- [ ] **Step 1: Failing tests** — each degradation maps to the right rendered state (pure render-decision helpers in `dagdigest.ts`/`taskcorrelate.ts`).
- [ ] **Step 2-4: TDD cycle** + full frontend suite.
- [ ] **Step 5: Checkpoint** — `npx vitest run frontend/app/view/orchestrate frontend/app/view/agents`, tsc, eslint.

### Task 6.2: Responsive and accessible behavior

**Files:**
- Modify: `frontend/app/view/orchestrate/timelinerail.tsx`, `dagoverview.tsx`

**Interfaces:**
- Consumes: the layout prop from 4.5.
- Produces: wide layouts show live work + timeline rail together; narrow layouts keep health/current work and collapse history into a drawer; nodes/worker rows/filters/events/actions keyboard-focusable; `aria-live` announces health/attention transitions only (not activity ticks); relative-age updates in leaf components only (no per-second graph/timeline recompute).

- [ ] **Step 1: Pure drawer-decision test** — `timelineLayout(width)` returns `"rail" | "drawer"` at the repo's breakpoint(s).
- [ ] **Step 2: Implement drawer + focus + aria-live** (leaf-only aging mirrors `NarrationTimeline`'s existing approach — read it first).
- [ ] **Step 3: tsc + eslint + vitest checkpoint.**

### Task 6.3: Live E2E scenario

**Files:**
- Create: `scripts/cdp/orchestrator-observability-e2e.mjs`
- Modify: `frontend/package.json` or the verify scripts only if the existing `task verify:ui -- <scenario>` driver needs a scenario registration (read `scripts/cdp/` driver first).

**Interfaces:**
- Consumes: the live dev app via CDP (WebView2 :9222 / `CDP_PORT`), a real orchestrator run with a `TaskGroup`.
- Produces: proof per spec §10.3 items 1-8: real `TaskGroup` appears; health + next agree with persisted state; running task resolves correct worker; **Open in Agent** focuses it; retry/gate/ask/merge/cleanup/completion events appear in lifecycle history; timeline events deep-link; narrow layout exposes the drawer; missing-session and failed-load states stay explicit. Uses a temporary registered Git project (never the waveterm checkout) and obtains explicit user approval for engine-managed commits inside it before running.

- [ ] **Step 1: Read the existing orchestrator E2E driver** (`scripts/cdp/orchestrator-e2e.mjs` from the 08-27 plan) and port its scaffolding.
- [ ] **Step 2: Write the scenario** asserting items 1-8; run it via `task verify:ui -- orchestrator-observability` (or the driver's equivalent invocation).
- [ ] **Step 3: Fix what it surfaces.** No contact sheet claim until the scenario passes end-to-end.
- [ ] **Step 4: Checkpoint** — full frontend + backend suites, tsc, eslint, and the E2E pass.

---

## Final task: complete pass and feature commit

- [ ] **Step 1: Full verification.** `task build:backend`; `go test ./pkg/...` (CGO_CFLAGS set); `npx vitest run`; `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`; `npx eslint .`; `npx prettier --check .`.
- [ ] **Step 2: Self-review the diff.** No commented-out code, no debug statements, no generated-file hand-edits, no unrelated files staged (working-tree leftovers from before this feature stay out).
- [ ] **Step 3: Simplify review of changed lines** (pi-simplify): naming, redundancy, dead code.
- [ ] **Step 4: Re-run the spec §12 success criteria** as a checklist against the running UI.
- [ ] **Step 5: Present the feature commit** for explicit approval: files with status (M/A/D), change summary per phase, message as `feat(orchestrate): full observability digest, events, and timeline` (subject < 72 chars). Await approval before committing. Spec + this plan fold into the same commit.

---

## Self-review notes (run before execution handoff)

- Spec coverage cross-check lives in the plan's task headers; each spec section maps to at least one task: §5.0 → Phase 0; §5.1-5.3 → T1.1-1.4; §5.4/6.1-6.2 → Phase 2-3; §6.3-6.4 → T4.5/T6.2; §7 → Phase 4; §7.1 → Phase 5; §8 → T6.1; §9 → T3.1/T1.2; §10.1-10.3 → per-phase tests + T6.3.
- Placeholder scan: no TBD/TODO steps; every code step has concrete assertions and signatures; production code bodies are delegated to the referenced existing files the implementer reads first.
- Type consistency: `CommandDagStatusRtnData`, `DagStatusDigest` (and all nested types), `DagDigestSnapshot`, `BuildDigest`, `QueryRunEventsByKind`, `CleanupTaskWorktree`, `PendingCleanupTasks`, `HasCleanupDebt`, `RetryPendingCleanup`, `ResolveTaskWorker`, `TaskWorker`, `resolveTaskWorker`/`openTaskWorker`/`TaskWorkerView`, `useDagDigest`/`acceptDigest`/`shouldRefreshDigest`, `workerSortKey`, `filterEvents`/`eventClickTarget`/`TimelineFilter`, `CommandPiControlAckData`, `RecordAskLifecycle`, and the RunEvent kind constants are each defined once and referenced consistently.