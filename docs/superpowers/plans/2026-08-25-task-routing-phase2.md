# Task-Routing Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the DAG engine one automatic same-tier recovery for a transient tool failure, persisted typed failure state, and an explicit human/lead-judged `escalate` verb that re-queues a failed task on a strictly higher tier.

**Architecture:** `jarvis.OnWorkerExit` derives `OutcomeData` and invokes a child-outcome hook before the existing `PostOutcome` dispatch gate; this is required because DAG run workers intentionally have no dispatch message. `pkg/orchestrate` resolves the stamped worker owner, mutates the DAG under its existing keyed lock, records same-kind attempts, and calls `scheduleLocked` while still holding that lock. A permitted retry is therefore respawned immediately and returns in `Running` state with a new child `RunID`. Escalation resolves and validates the complete target route before stopping anything, persists both runtime and tier, and permits one strictly upward judged hop.

**Tech Stack:** Go (`pkg/jarvis`, `pkg/orchestrate`, `pkg/wshrpc`, `pkg/wstore`, `cmd/wsh`); waveobj JSON persistence; generated Go/TypeScript bindings; Cobra CLI.

## Global Constraints

- Repo: `C:/Users/kael02/IdeaProjects/waveterm`.
- Never hand-edit generated files: `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`. Edit Go types, then run `task generate`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.
- Go tests use `CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc"`.
- Engine tests stay in package `orchestrate`; reuse its existing wstore `TestMain` and worker-harness seams.
- Repository rule: no per-task commits in this session. Each checkpoint summarizes its diff; one commit is proposed at the end and requires explicit user approval.
- Do not modify `docs/lead-authored-task-routing-roadmap.md`.
- Design source: `docs/superpowers/specs/2026-08-25-task-routing-phase2-design.md`. Approved correction from plan review: the hook fires from `OnWorkerExit`, not from inside `PostOutcome`, because `PostOutcome` intentionally excludes run workers.
- The frontend is untouched except generated optional type fields.
- Comments explain why, use lower case, and remain minimal.

---

### Task 1: Add engine-owned failure fields to `TaskNode`

**Files:**
- Modify: `pkg/waveobj/wtype.go` (`TaskNode`)
- Modify: `pkg/orchestrate/dag.go` (`NewTaskGroup` author validation)
- Test: `pkg/orchestrate/dag_test.go`
- Test: `pkg/wshrpc/wshserver/wshserver_dag_test.go`

**Interfaces:**
- Produces `TaskNode.Attempts int`, `TaskNode.LastFailureKind string`, and `TaskNode.Escalations int`, all persisted with `omitempty`.
- These fields are engine-owned and excluded from `SameDagProposal`, which already compares author fields explicitly.

- [ ] **Step 1: Add the fields so rejection tests compile**

Add after `LastActivity` in `pkg/waveobj/wtype.go`:

```go
// Attempts is the consecutive count for LastFailureKind.
Attempts int `json:"attempts,omitempty"`
// LastFailureKind is the classifier output for the latest failed attempt.
LastFailureKind string `json:"lastfailurekind,omitempty"`
// Escalations is the judged-hop count; one is the terminal cap for this phase.
Escalations int `json:"escalations,omitempty"`
```

- [ ] **Step 2: Write failing author-time rejection tests**

Extend the existing engine-field cases in `pkg/orchestrate/dag_test.go` and `pkg/wshrpc/wshserver/wshserver_dag_test.go`:

```go
{name: "attempts", task: waveobj.TaskNode{ID: "t", Label: "a", Attempts: 1}},
{name: "lastfailurekind", task: waveobj.TaskNode{ID: "t", Label: "a", LastFailureKind: "timeout"}},
{name: "escalations", task: waveobj.TaskNode{ID: "t", Label: "a", Escalations: 1}},
```

Run:

```bash
CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc" go test ./pkg/orchestrate/ ./pkg/wshrpc/wshserver/ -run "TestNewTaskGroup|TestDagSubmitRejectsEngineState" -count=1
```

Expected: FAIL because `NewTaskGroup` still accepts the new fields.

- [ ] **Step 3: Reject non-default authored values**

Add beside the existing `LastActivity` validation in `NewTaskGroup`:

```go
if t.Attempts != 0 {
	return waveobj.TaskGroup{}, fmt.Errorf("task %q attempts must be zero", t.ID)
}
if t.LastFailureKind != "" {
	return waveobj.TaskGroup{}, fmt.Errorf("task %q lastfailurekind must be empty", t.ID)
}
if t.Escalations != 0 {
	return waveobj.TaskGroup{}, fmt.Errorf("task %q escalations must be zero", t.ID)
}
```

- [ ] **Step 4: Verify Task 1**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Regenerate bindings and typecheck**

```bash
task generate
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: generation succeeds and typecheck exits zero.

- [ ] **Step 6: Checkpoint** — summarize changed files; do not commit.

---

### Task 2: Add pure failure policy and strict tier helpers

**Files:**
- Create: `pkg/orchestrate/retry.go`
- Create: `pkg/orchestrate/retry_test.go`

**Interfaces:**
- Produces failure-kind constants.
- Produces `classifyFailure(summary string, exitCode int) string`.
- Produces `retryDecision(kind string, attempts int) bool`.
- Produces `nextTier(tier string) (string, error)`.
- Produces `isHigherTier(current, target string) bool`.

- [ ] **Step 1: Write failing table tests**

Create `pkg/orchestrate/retry_test.go` with these required cases:

```go
package orchestrate

import "testing"

func TestClassifyFailure(t *testing.T) {
	cases := []struct {
		summary string
		exit    int
		want    string
	}{
		{"context window exceeded", 1, FailureKindContextWindow},
		{"request timed out after 300s", 1, FailureKindTimeout},
		{"lead sendback: out of scope", 1, FailureKindGateSendback},
		{"tests: TestFoo still failing", 1, FailureKindTestFailed},
		{"tool call errored: invalid input schema", 2, FailureKindToolError},
		{"mcp tool returned an error", 2, FailureKindToolError},
		{"mcp server initialized before process exit", 1, FailureKindUnknown},
		{"assert calls=2, got calls=3", 1, FailureKindUnknown},
		{"", 1, FailureKindUnknown},
	}
	for _, tc := range cases {
		if got := classifyFailure(tc.summary, tc.exit); got != tc.want {
			t.Errorf("classifyFailure(%q, %d) = %q, want %q", tc.summary, tc.exit, got, tc.want)
		}
	}
}

func TestRetryDecision(t *testing.T) {
	if !retryDecision(FailureKindToolError, 0) {
		t.Fatal("first tool failure must retry")
	}
	if retryDecision(FailureKindToolError, 1) {
		t.Fatal("second consecutive tool failure must block")
	}
	for _, kind := range []string{FailureKindContextWindow, FailureKindTimeout, FailureKindGateSendback, FailureKindTestFailed, FailureKindUnknown} {
		if retryDecision(kind, 0) {
			t.Fatalf("%s must block on its first failure", kind)
		}
	}
}

func TestTierPolicy(t *testing.T) {
	if got, err := nextTier("cheap"); err != nil || got != "mid" {
		t.Fatalf("cheap -> %q, %v", got, err)
	}
	if got, err := nextTier("mid"); err != nil || got != "capable" {
		t.Fatalf("mid -> %q, %v", got, err)
	}
	if _, err := nextTier("capable"); err == nil {
		t.Fatal("capable must have no next tier")
	}
	if !isHigherTier("cheap", "mid") || !isHigherTier("cheap", "capable") || !isHigherTier("mid", "capable") {
		t.Fatal("valid upward hops rejected")
	}
	if isHigherTier("mid", "mid") || isHigherTier("mid", "cheap") || isHigherTier("capable", "capable") {
		t.Fatal("same-tier or downward escalation accepted")
	}
}
```

- [ ] **Step 2: Verify the tests fail to compile**

```bash
CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc" go test ./pkg/orchestrate/ -run "TestClassifyFailure|TestRetryDecision|TestTierPolicy" -count=1
```

Expected: FAIL with undefined symbols.

- [ ] **Step 3: Implement the policy**

Create `pkg/orchestrate/retry.go`. Keep the classifier conservative: generic `mcp` is not enough; it must include error/failure wording before becoming retryable.

```go
package orchestrate

import (
	"fmt"
	"strings"
)

const (
	FailureKindToolError     = "tool_call_error"
	FailureKindContextWindow = "context-window"
	FailureKindTimeout       = "timeout"
	FailureKindGateSendback  = "gate-sendback"
	FailureKindTestFailed    = "test-failed"
	FailureKindUnknown       = "unknown"
)

func classifyFailure(summary string, exitCode int) string {
	s := strings.ToLower(summary)
	switch {
	case strings.Contains(s, "context window"), strings.Contains(s, "context limit"), strings.Contains(s, "length of your submission exceeds"):
		return FailureKindContextWindow
	case strings.Contains(s, "timeout"), strings.Contains(s, "timed out"):
		return FailureKindTimeout
	case strings.Contains(s, "sendback"), strings.Contains(s, "too hard"), strings.Contains(s, "out of scope"):
		return FailureKindGateSendback
	case strings.Contains(s, "test failed"), strings.Contains(s, "tests:"), strings.Contains(s, "not passing"), strings.Contains(s, "check failed"):
		return FailureKindTestFailed
	case strings.Contains(s, "tool call"), strings.Contains(s, "function call"), strings.Contains(s, "tool errored"):
		return FailureKindToolError
	case strings.Contains(s, "mcp") && (strings.Contains(s, "error") || strings.Contains(s, "failed")):
		return FailureKindToolError
	default:
		_ = exitCode
		return FailureKindUnknown
	}
}

func retryDecision(kind string, attempts int) bool {
	return kind == FailureKindToolError && attempts == 0
}

func nextTier(tier string) (string, error) {
	switch tier {
	case "cheap":
		return "mid", nil
	case "mid":
		return "capable", nil
	case "capable":
		return "", fmt.Errorf("tier %q is already the top tier", tier)
	default:
		return "", fmt.Errorf("unknown tier %q", tier)
	}
}

func isHigherTier(current, target string) bool {
	return current == "cheap" && (target == "mid" || target == "capable") || current == "mid" && target == "capable"
}
```

- [ ] **Step 4: Verify Task 2**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Checkpoint** — summarize changed files; do not commit.

---

### Task 3: Add the child-outcome hook at the real worker-exit boundary

**Files:**
- Modify: `pkg/jarvis/outcome.go` (hook declaration only)
- Modify: `pkg/jarvis/onexit.go` (invoke hook before channel-outcome resolution)
- Test: `pkg/jarvis/outcome_test.go`
- Create: `pkg/orchestrate/outcome.go` (registration and temporary no-op handler)
- Create: `pkg/orchestrate/outcome_test.go` (registration test; expanded in Task 4)

**Interfaces:**
- Produces `jarvis.ChildOutcomeHook func(context.Context, string, OutcomeData) error`.
- Produces `orchestrate.HandleChildOutcome(context.Context, string, jarvis.OutcomeData) error`.
- The hook does not include runtime because DAG policy does not consume it.
- `PostOutcome` and `TestPostOutcomeOnlyForDispatchedWorker` remain unchanged.

- [ ] **Step 1: Write failing hook tests**

In `pkg/jarvis/outcome_test.go`, add a test for a small helper called by `OnWorkerExit`:

```go
func TestNotifyChildOutcomeCallsHookAndContainsError(t *testing.T) {
	old := ChildOutcomeHook
	t.Cleanup(func() { ChildOutcomeHook = old })
	called := false
	ChildOutcomeHook = func(_ context.Context, worker string, data OutcomeData) error {
		called = true
		if worker != "tab:worker" || data.Status != "failed" {
			t.Fatalf("unexpected hook data: %q %+v", worker, data)
		}
		return errors.New("engine unavailable")
	}
	notifyChildOutcome(context.Background(), "tab:worker", OutcomeData{Status: "failed"})
	if !called {
		t.Fatal("child outcome hook was not called")
	}
}
```

In `pkg/orchestrate/outcome_test.go`:

```go
func TestChildOutcomeHookRegistered(t *testing.T) {
	if jarvis.ChildOutcomeHook == nil {
		t.Fatal("orchestrate must register the child outcome hook")
	}
}
```

- [ ] **Step 2: Verify the tests fail**

```bash
CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc" go test ./pkg/jarvis/ ./pkg/orchestrate/ -run "TestNotifyChildOutcome|TestChildOutcomeHookRegistered" -count=1
```

Expected: FAIL with undefined hook/helper.

- [ ] **Step 3: Add the exact hook signature and error-containing wrapper**

In `pkg/jarvis/outcome.go`:

```go
var ChildOutcomeHook func(context.Context, string, OutcomeData) error
```

In `pkg/jarvis/onexit.go`:

```go
func notifyChildOutcome(ctx context.Context, workerORef string, data OutcomeData) {
	if ChildOutcomeHook == nil {
		return
	}
	if err := ChildOutcomeHook(ctx, workerORef, data); err != nil {
		log.Printf("jarvis child outcome for %s: %v", workerORef, err)
	}
}
```

Construct `data` once after transcript extraction, invoke the hook before `resolveDispatchChannelForWorker`, then preserve the existing message path:

```go
data := OutcomeData{
	Status:     OutcomeStatus(sess.Status),
	Summary:    outcomeSummary(sess),
	DurationMs: sess.DurationMs,
	ExitCode:   exitCode,
}
notifyChildOutcome(ctx, workerORef, data)
ch := resolveDispatchChannelForWorker(ctx, workerORef)
if ch == nil {
	log.Printf("jarvis onexit: no dispatch channel for worker %s; outcome not posted", workerORef)
	return
}
PostOutcome(ch, workerORef, runtime, data)
```

This order is intentional: DAG run workers are engine-owned but do not earn channel outcome messages.

- [ ] **Step 4: Register a compiling handler seam**

Create `pkg/orchestrate/outcome.go`:

```go
package orchestrate

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

var workerOwnerOf = wstore.GetWorkerOwner

func init() {
	jarvis.ChildOutcomeHook = HandleChildOutcome
}

func HandleChildOutcome(context.Context, string, jarvis.OutcomeData) error {
	return nil
}
```

- [ ] **Step 5: Verify Task 3 and preserve the dispatch gate**

```bash
CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc" go test ./pkg/jarvis/ ./pkg/orchestrate/ -run "TestNotifyChildOutcome|TestChildOutcomeHookRegistered|TestPostOutcomeOnlyForDispatchedWorker" -count=1
```

Expected: PASS.

- [ ] **Step 6: Checkpoint** — summarize changed files; do not commit.

---

### Task 4: Apply failed outcomes atomically and respawn the allowed retry

**Files:**
- Modify: `pkg/orchestrate/outcome.go`
- Test: `pkg/orchestrate/outcome_test.go`

**Interfaces:**
- Consumes Task 1 fields and Task 2 policy.
- Calls private `scheduleLocked` while already inside `withDagMutation`; it must never call public `Schedule` from inside that lock.
- A first retryable tool failure returns with the replacement task `Running`, a new `RunID`, `Attempts == 1`, and `LastFailureKind == FailureKindToolError`.

- [ ] **Step 1: Build a real stamped-worker harness**

In `pkg/orchestrate/outcome_test.go`, add helpers that:

1. create a channel, orchestrator run, and one-task DAG;
2. stub `spawnWorker` to create a real UUID tab plus block in wstore and return a distinct tab oref on every spawn;
3. leave `stampSpawnedWorker` and `workerOwnerOf` on their production implementations;
4. call `ScheduleOnce` and return the first worker oref from the persisted child run's phase.

The harness must record every spawned worker so the second failure is posted for the replacement worker, never the stale first worker.

- [ ] **Step 2: Write failing behavior tests**

Add these tests with persisted-state assertions:

```go
func TestHandleChildOutcomeImmediatelyRespawnsFirstToolFailure(t *testing.T)
func TestHandleChildOutcomeBlocksSecondConsecutiveToolFailure(t *testing.T)
func TestHandleChildOutcomeBlocksTimeoutOnFirstFailure(t *testing.T)
func TestHandleChildOutcomeNoOpsForStaleWorkerOwnership(t *testing.T)
func TestHandleChildOutcomeResetsAttemptCountWhenKindChanges(t *testing.T)
func TestHandleChildOutcomeUsesStampedUndispatchedRunWorker(t *testing.T)
func TestHandleChildOutcomePreservesCircuitBreakerCount(t *testing.T)
```

Required assertions:

- first tool failure: old child run is no longer owned; task is `Running` with a different non-empty `RunID`; attempts is 1; kind is tool error; DAG remains running; failures is 1;
- second tool failure uses the replacement worker and leaves task `Failed`, attempts 2, DAG blocked;
- timeout leaves task failed and DAG blocked on its first attempt;
- replaying the old worker after replacement is a no-op;
- after a human retry, a changed kind resets the count before recording its first attempt;
- the worker needs a stamped run/channel owner but no channel dispatch message;
- three failed outcomes across already-running parallel tasks leave `g.Failures == MaxConsecutiveFailures`, preserving the global circuit-break count.

Run:

```bash
CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc" go test ./pkg/orchestrate/ -run "TestHandleChildOutcome" -count=1 -timeout 180s
```

Expected: FAIL because the handler is still a no-op.

- [ ] **Step 3: Implement resolution and guarded mutation**

Implement `HandleChildOutcome` with this order:

```go
func HandleChildOutcome(ctx context.Context, workerORef string, data jarvis.OutcomeData) error {
	if data.Status != "failed" {
		return nil
	}
	runORef, channelORef, err := workerOwnerOf(ctx, workerORef)
	if err != nil {
		return fmt.Errorf("resolving owner for worker %s: %w", workerORef, err)
	}
	if runORef == "" || channelORef == "" {
		return nil
	}
	runRef, err := waveobj.ParseORef(runORef)
	if err != nil || runRef.OType != waveobj.OType_Run {
		return fmt.Errorf("worker %s has invalid run oref %q", workerORef, runORef)
	}
	channelRef, err := waveobj.ParseORef(channelORef)
	if err != nil || channelRef.OType != waveobj.OType_Channel {
		return fmt.Errorf("worker %s has invalid channel oref %q", workerORef, channelORef)
	}
	run, err := wstore.GetRun(ctx, channelRef.OID, runRef.OID)
	if err != nil {
		return fmt.Errorf("loading child run %s: %w", runRef.OID, err)
	}
	if run.DagORef == "" {
		return nil
	}
	return withDagMutation(run.DagORef, func() error {
		g, err := wstore.GetDag(ctx, run.DagORef)
		if err != nil {
			return fmt.Errorf("loading dag for child outcome: %w", err)
		}
		task := taskByRunID(g, run.ID)
		if task == nil || task.State != TaskState_Running {
			return nil
		}
		kind := classifyFailure(data.Summary, data.ExitCode)
		if task.LastFailureKind != kind {
			task.Attempts = 0
		}
		task.LastFailureKind = kind
		mayRetry := retryDecision(kind, task.Attempts)
		task.Attempts++
		task.State = TaskState_Failed
		g.Failures++
		if mayRetry {
			if err := RetryTask(g, task.ID); err != nil {
				return err
			}
		}
		g.UpdatedTs = time.Now().UnixMilli()
		RecomputeDagStatus(g)
		if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
			*cur = *g
			return nil
		}); err != nil {
			return err
		}
		return scheduleLocked(ctx, g.OID)
	})
}
```

Add this helper in the same file:

```go
func taskByRunID(g *waveobj.TaskGroup, runID string) *waveobj.TaskNode {
	for i := range g.Tasks {
		if g.Tasks[i].RunID == runID {
			return &g.Tasks[i]
		}
	}
	return nil
}
```

Log malformed owner data before returning only if existing package logging conventions make the message actionable; absent ownership is a normal no-op for non-DAG workers.

The first persistence is required because `scheduleLocked` authoritatively reloads the DAG. Do not send a waveobj update before `scheduleLocked`; it sends the final update after either respawning or blocking.

- [ ] **Step 4: Verify Task 4**

Run the command from Step 2. Expected: PASS with no timeout, proving there is no recursive lock acquisition.

- [ ] **Step 5: Run the existing serialization tests**

```bash
CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc" go test ./pkg/orchestrate/ -run "TestScheduleSerializesSameDag|TestCancelHoldsDagAuthorityThroughWorkerCleanup|TestHandleChildOutcome" -count=1 -timeout 180s
```

Expected: PASS.

- [ ] **Step 6: Checkpoint** — summarize changed files; do not commit.

---

### Task 5: Reset all successful tasks and add typed blocked detail

**Files:**
- Modify: `pkg/orchestrate/engine.go`
- Test: `pkg/orchestrate/outcome_test.go`
- Test: `pkg/orchestrate/engine_test.go`

**Interfaces:**
- Every task making a fresh `Running -> Done` transition resets `Attempts` and `LastFailureKind`.
- Any fresh success clears the DAG-wide failure streak once.
- A blocked run event includes `kind`; multiple distinct blocking kinds produce `"mixed"`.

- [ ] **Step 1: Write failing parallel-reset and event-detail tests**

Add:

```go
func TestScheduleResetsFailureStateForEveryParallelSuccess(t *testing.T)
func TestBlockedRunEventIncludesSingleFailureKind(t *testing.T)
func TestBlockedRunEventUsesMixedForDistinctKinds(t *testing.T)
```

The parallel test must start two tasks with non-zero attempts/kinds, mark both child runs done before one scheduler tick, and assert both tasks are cleared afterward. The event tests must read the persisted owner run events rather than relying on code review.

- [ ] **Step 2: Verify the tests fail**

```bash
CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc" go test ./pkg/orchestrate/ -run "TestScheduleResetsFailureState|TestBlockedRunEvent" -count=1
```

Expected: FAIL because success fields and blocked kind are not yet emitted.

- [ ] **Step 3: Reset every fresh success**

Replace the existing one-success loop with:

```go
freshSuccess := false
for i := range g.Tasks {
	if prevStates[g.Tasks[i].ID] != TaskState_Running || g.Tasks[i].State != TaskState_Done {
		continue
	}
	freshSuccess = true
	g.Tasks[i].Attempts = 0
	g.Tasks[i].LastFailureKind = ""
}
if freshSuccess && g.Failures > 0 {
	g.Failures = 0
}
```

Keep the existing failed-transition accounting after this block.

- [ ] **Step 4: Add the blocking kind to the run event**

In the `DagStatus_Blocked` branch, derive `blockingKind` from failed tasks with non-empty kinds. Preserve one kind if all are equal; use `"mixed"` if they differ. Persist:

```go
map[string]any{"failures": failures, "kind": blockingKind}
```

- [ ] **Step 5: Verify Task 5**

Run the command from Step 2 plus Task 4 tests. Expected: PASS.

- [ ] **Step 6: Checkpoint** — summarize changed files; do not commit.

---

### Task 6: Add validated, strictly upward escalation

**Files:**
- Modify: `pkg/orchestrate/mutation.go`
- Test: `pkg/orchestrate/mutation_test.go`
- Modify: `pkg/wshrpc/wshrpctypes_dag.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go`
- Test: `pkg/wshrpc/wshserver/wshserver_dag_test.go`

**Interfaces:**
- `CommandDagActionData` gains `Tier string` with JSON tag `json:"tier,omitempty"`.
- `ApplyAction` becomes `ApplyAction(ctx context.Context, dagID, taskID, action, tier string) error`.
- `applyActionLocked` receives the same tier argument.
- Escalation validates all state and route conditions before `cancelAndStopTaskRun`.

- [ ] **Step 1: Write failing mutation tests**

Add concrete tests for:

```go
func TestEscalateDefaultsToNextTierAndPreservesInheritedRuntime(t *testing.T)
func TestEscalateAcceptsExplicitHigherTier(t *testing.T)
func TestEscalateRejectsSameOrLowerTierWithoutCancellingRun(t *testing.T)
func TestEscalateRejectsSecondHopWithoutCancellingRun(t *testing.T)
func TestEscalateRejectsUnsupportedRouteWithoutCancellingRun(t *testing.T)
func TestEscalateRejectsPendingTask(t *testing.T)
```

For every rejected case, read the child run afterward and assert its status and worker remain unchanged. The inherited-runtime case must use an owner route of `pi/mid` and an empty task `RunSpec`; after escalation the task must persist `RunSpec.Runtime == "pi"` and `RunSpec.Tier == "capable"`.

- [ ] **Step 2: Verify mutation tests fail**

```bash
CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc" go test ./pkg/orchestrate/ -run "TestEscalate" -count=1
```

Expected: FAIL because the action does not exist.

- [ ] **Step 3: Add a pure target resolver**

In `mutation.go`, add:

```go
func escalationTarget(task *waveobj.TaskNode, owner *waveobj.Run, requestedTier string) (waveobj.RoutePin, error) {
	if task == nil {
		return waveobj.RoutePin{}, fmt.Errorf("task is required")
	}
	if task.State != TaskState_Failed && task.State != TaskState_Stalled && task.State != TaskState_BlockedMerge {
		return waveobj.RoutePin{}, fmt.Errorf("task %q cannot be escalated from state %q", task.ID, task.State)
	}
	if task.Escalations >= 1 {
		return waveobj.RoutePin{}, fmt.Errorf("task %q is already escalated; it is blocked for the human", task.ID)
	}
	current := effectiveTaskRoute(task, owner)
	targetTier := requestedTier
	var err error
	if targetTier == "" {
		targetTier, err = nextTier(current.Tier)
		if err != nil {
			return waveobj.RoutePin{}, fmt.Errorf("escalating %q: %w", task.ID, err)
		}
	}
	if !isHigherTier(current.Tier, targetTier) {
		return waveobj.RoutePin{}, fmt.Errorf("task %q tier %q is not higher than %q", task.ID, targetTier, current.Tier)
	}
	target := waveobj.RoutePin{Runtime: current.Runtime, Tier: targetTier}
	if _, err := runroute.Resolve(target); err != nil {
		return waveobj.RoutePin{}, fmt.Errorf("escalating %q: %w", task.ID, err)
	}
	return target, nil
}
```

This function performs every user-input and state check before any persistent side effect.

- [ ] **Step 4: Wire the mutation without post-cancellation validation**

Change `ApplyAction`/`applyActionLocked` to carry `tier`. In the `"escalate"` case:

```go
task := taskByID(g, taskID)
if task == nil {
	return fmt.Errorf("no task %q", taskID)
}
owner, err := wstore.GetRun(ctx, g.ChannelId, g.RunID)
if err != nil {
	return fmt.Errorf("loading owner run: %w", err)
}
target, err := escalationTarget(task, owner, tier)
if err != nil {
	return err
}
if err := cancelAndStopTaskRun(ctx, g, taskID); err != nil {
	return err
}
task.RunSpec.Runtime = target.Runtime
task.RunSpec.Tier = target.Tier
task.Attempts = 0
task.LastFailureKind = ""
task.Escalations++
task.State = TaskState_Pending
task.RunID = ""
RecomputeDagStatus(g)
```

Do not call a second fallible route/state validator after cancellation.

Update existing `ApplyAction` calls to pass `""` for tier.

- [ ] **Step 5: Add the RPC field and server plumbing**

Add to `CommandDagActionData`:

```go
Tier string `json:"tier,omitempty"`
```

Update the interface comment to include `escalate`. Pass `data.Tier` into `orchestrate.ApplyAction` from `DagActionCommand`.

Add an RPC test that successfully escalates an inherited `pi/mid` task and a rejected same-tier case that leaves the child uncancelled.

- [ ] **Step 6: Regenerate and verify Task 6**

```bash
task generate
CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc" go test ./pkg/orchestrate/ ./pkg/wshrpc/wshserver/ -run "TestEscalate|TestDagAction" -count=1 -timeout 180s
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: PASS and clean typecheck.

- [ ] **Step 7: Checkpoint** — summarize changed files; do not commit.

---

### Task 7: Add the `wsh jarvis dag escalate` command

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go`
- Test: `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`

**Interfaces:**
- Produces `wsh jarvis dag escalate <task-id> [--tier mid|capable]`.
- Empty `--tier` requests the next tier; server validation remains authoritative.

- [ ] **Step 1: Write a failing command-data test**

Add `TestDagEscalateData` that creates a Cobra command with `channel`, `runid`, and `tier` flags, sets them to `ch`, `run`, and `capable`, then calls a pure `dagEscalateData(cmd, []string{"t-1"})` helper. Assert the result is:

```go
wshrpc.CommandDagActionData{
	ChannelId: "ch",
	RunId:     "run",
	TaskId:    "t-1",
	Action:    "escalate",
	Tier:      "capable",
}
```

Also assert `dagEscalateCmd.PreRunE != nil`. This tests flag plumbing without introducing a mutable RPC runner seam solely for the test.

- [ ] **Step 2: Verify the CLI test fails**

```bash
CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc" go test ./cmd/wsh/cmd/ -run TestDagEscalate -count=1
```

Expected: FAIL because the command does not exist.

- [ ] **Step 3: Implement the data helper and command**

Add the helper used by both the test and production `RunE`:

```go
func dagEscalateData(cmd *cobra.Command, args []string) (wshrpc.CommandDagActionData, error) {
	channelID, runID, err := dagIds(cmd)
	if err != nil {
		return wshrpc.CommandDagActionData{}, err
	}
	tier, _ := cmd.Flags().GetString("tier")
	return wshrpc.CommandDagActionData{
		ChannelId: channelID,
		RunId:     runID,
		TaskId:    args[0],
		Action:    "escalate",
		Tier:      tier,
	}, nil
}
```

The production command must include:

```go
Use:     "escalate <task-id>",
Short:   "re-queue a failed or stalled task on a higher tier",
Args:    cobra.ExactArgs(1),
PreRunE: preRunSetupRpcClient,
```

Its `RunE` calls `dagEscalateData`, returns any error, then sends the returned data through `wshclient.DagActionCommand` with the existing ten-second timeout.

Register the command beside the existing DAG actions and add:

```go
dagEscalateCmd.Flags().String("tier", "", "target tier: mid|capable (default: next tier)")
```

Do not add `escalate` through the generic `dagAction` factory because only this action owns `--tier`.

- [ ] **Step 4: Verify Task 7**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Checkpoint** — summarize changed files; do not commit.

---

### Task 8: Full verification, simplify review, and commit proposal

**Files:**
- No new implementation files.

- [ ] **Step 1: Run focused and full Go suites**

```bash
CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc" go test ./pkg/orchestrate/ ./pkg/jarvis/ ./pkg/wshrpc/wshserver/ ./cmd/wsh/cmd/ -count=1 -timeout 600s
```

Expected: PASS.

- [ ] **Step 2: Run generation-sensitive and static checks**

```bash
task generate
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
go vet ./pkg/orchestrate/ ./pkg/jarvis/ ./pkg/wshrpc/wshserver/ ./cmd/wsh/cmd/
gofmt -l pkg/orchestrate pkg/jarvis pkg/wshrpc cmd/wsh/cmd
```

Expected: generation succeeds, typecheck/vet exit zero, and `gofmt -l` prints nothing.

- [ ] **Step 3: Run the simplify review on changed lines**

Check specifically for:

- duplicate failure-kind literals outside `retry.go`;
- any public `Schedule` call made while a DAG mutation lock is held;
- partial task route pins (`Tier` without `Runtime`);
- cancellation or worker stopping before escalation validation;
- tests that reuse a stale worker after retry;
- debug statements, commented-out code, placeholders, or unrelated formatting.

Fix findings and rerun affected tests.

- [ ] **Step 4: Review the final diff**

```bash
git status --short
git diff --check
git diff --stat
git diff -- docs/superpowers/plans/2026-08-25-task-routing-phase2.md pkg/waveobj/wtype.go pkg/orchestrate pkg/jarvis pkg/wshrpc cmd/wsh/cmd frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts
```

Confirm no roadmap edit and no unrelated file changes.

- [ ] **Step 5: Present one commit proposal**

Show files with status and a brief summary. Proposed message:

```text
feat(orchestrate): add typed task failure recovery and escalation
```

Explain that the change gives DAG failures a deterministic engine input, one immediate same-tier tool retry, and a validated judged hop. Ask: `Awaiting approval. Proceed? (yes/no)` Do not commit without explicit approval.

---

## Self-review checklist

- **Failure input:** Task 3 hooks `OnWorkerExit` before the `PostOutcome` dispatch gate; the dispatched-worker-only outcome test remains unchanged.
- **Locking:** Task 4 calls `scheduleLocked`, never `Schedule`, while holding `withDagMutation`.
- **State transition:** every failed outcome sets `TaskState_Failed` before policy; permitted retry changes it to pending and `scheduleLocked` immediately respawns it.
- **Retry contract:** handler returns with the replacement task running and a new `RunID`.
- **Attempt semantics:** a changed failure kind resets attempts before recording the new failure.
- **Escalation safety:** full route and state validation occurs before cancellation; runtime is persisted with tier; same/downward tiers are rejected.
- **Parallel success:** every fresh success clears its task failure fields.
- **Behavioral tests:** real stamped non-dispatched workers, distinct workers per attempt, blocked event details, rejected-action non-mutation, inherited runtime, and CLI plumbing are all asserted.
- **Verification:** final suite includes `./cmd/wsh/cmd/` and generated TypeScript typechecking.
