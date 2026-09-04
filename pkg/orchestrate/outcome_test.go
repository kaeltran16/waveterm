package orchestrate

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestChildOutcomeHookRegistered(t *testing.T) {
	if jarvis.ChildOutcomeHook == nil {
		t.Fatal("orchestrate must register the child outcome hook")
	}
}

type childOutcomeHarness struct {
	ctx     context.Context
	dagID   string
	channel string
	runID   string
	workers []string
}

func newChildOutcomeHarness(t *testing.T, taskCount int) *childOutcomeHarness {
	t.Helper()
	allowWorkerHarnessForTest(t)
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "child-outcome", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	owner.Runtime = "claude"
	owner.Tier = "mid"
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	tasks := make([]waveobj.TaskNode, taskCount)
	for i := range tasks {
		tasks[i] = waveobj.TaskNode{ID: fmt.Sprintf("t-%d", i), Label: fmt.Sprintf("task %d", i)}
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "outcomes", taskCount, false, tasks, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	h := &childOutcomeHarness{ctx: ctx, dagID: g.OID, channel: ch.OID, runID: owner.ID}
	oldSpawn := spawnWorker
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		tabID := uuid.NewString()
		blockID := uuid.NewString()
		worker := waveobj.MakeORef(waveobj.OType_Tab, tabID).String()
		if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: tabID, BlockIds: []string{blockID}, Meta: waveobj.MetaMapType{}}); err != nil {
			return "", err
		}
		if err := wstore.DBInsert(ctx, &waveobj.Block{OID: blockID, ParentORef: worker, Meta: waveobj.MetaMapType{}}); err != nil {
			return "", err
		}
		h.workers = append(h.workers, worker)
		return worker, nil
	}
	t.Cleanup(func() { spawnWorker = oldSpawn })
	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if len(h.workers) != taskCount {
		t.Fatalf("spawned workers = %d, want %d", len(h.workers), taskCount)
	}
	return h
}

func (h *childOutcomeHarness) loadDag(t *testing.T) *waveobj.TaskGroup {
	t.Helper()
	g, err := wstore.GetDag(h.ctx, h.dagID)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func TestHandleChildOutcomeImmediatelyRespawnsFirstToolFailure(t *testing.T) {
	h := newChildOutcomeHarness(t, 1)
	before := h.loadDag(t)
	oldRunID := before.Tasks[0].RunID
	if err := HandleChildOutcome(h.ctx, h.workers[0], jarvis.OutcomeData{Status: "failed", Summary: "tool call errored: invalid input", ExitCode: 2}); err != nil {
		t.Fatal(err)
	}
	got := h.loadDag(t)
	task := got.Tasks[0]
	if task.State != TaskState_Running || task.RunID == "" || task.RunID == oldRunID {
		t.Fatalf("replacement task = %+v, old run %q", task, oldRunID)
	}
	if taskByRunID(got, oldRunID) != nil {
		t.Fatalf("old child run %q still owns a task", oldRunID)
	}
	if task.Attempts != 1 || task.LastFailureKind != FailureKindToolError {
		t.Fatalf("failure state = attempts %d kind %q", task.Attempts, task.LastFailureKind)
	}
	if got.Status != DagStatus_Running || got.Failures != 0 {
		t.Fatalf("dag status=%q failures=%d", got.Status, got.Failures)
	}
}

func TestHandleChildOutcomeBlocksSecondConsecutiveToolFailure(t *testing.T) {
	h := newChildOutcomeHarness(t, 1)
	data := jarvis.OutcomeData{Status: "failed", Summary: "tool call errored", ExitCode: 2}
	if err := HandleChildOutcome(h.ctx, h.workers[0], data); err != nil {
		t.Fatal(err)
	}
	if len(h.workers) != 2 {
		t.Fatalf("first failure spawned %d workers, want 2", len(h.workers))
	}
	if err := HandleChildOutcome(h.ctx, h.workers[1], data); err != nil {
		t.Fatal(err)
	}
	got := h.loadDag(t)
	task := got.Tasks[0]
	if task.State != TaskState_Failed || task.Attempts != 2 || got.Status != DagStatus_Blocked {
		t.Fatalf("second failure task=%+v dag=%q", task, got.Status)
	}
}

func TestHandleChildOutcomeBlocksTimeoutOnFirstFailure(t *testing.T) {
	h := newChildOutcomeHarness(t, 1)
	if err := HandleChildOutcome(h.ctx, h.workers[0], jarvis.OutcomeData{Status: "failed", Summary: "request timed out", ExitCode: 1}); err != nil {
		t.Fatal(err)
	}
	got := h.loadDag(t)
	task := got.Tasks[0]
	if task.State != TaskState_Failed || task.Attempts != 1 || task.LastFailureKind != FailureKindTimeout || got.Status != DagStatus_Blocked {
		t.Fatalf("timeout outcome task=%+v dag=%q", task, got.Status)
	}
}

func TestHandleChildOutcomeNoOpsForStaleWorkerOwnership(t *testing.T) {
	h := newChildOutcomeHarness(t, 1)
	data := jarvis.OutcomeData{Status: "failed", Summary: "tool call errored", ExitCode: 2}
	if err := HandleChildOutcome(h.ctx, h.workers[0], data); err != nil {
		t.Fatal(err)
	}
	if len(h.workers) != 2 {
		t.Fatalf("first failure spawned %d workers, want 2", len(h.workers))
	}
	before := h.loadDag(t)
	if err := HandleChildOutcome(h.ctx, h.workers[0], data); err != nil {
		t.Fatal(err)
	}
	after := h.loadDag(t)
	if after.Tasks[0].RunID != before.Tasks[0].RunID || after.Tasks[0].Attempts != before.Tasks[0].Attempts || after.Failures != before.Failures || len(h.workers) != 2 {
		t.Fatalf("stale worker mutated dag: before=%+v after=%+v workers=%d", before.Tasks[0], after.Tasks[0], len(h.workers))
	}
}

func TestHandleChildOutcomeResetsAttemptCountWhenKindChanges(t *testing.T) {
	h := newChildOutcomeHarness(t, 1)
	if err := HandleChildOutcome(h.ctx, h.workers[0], jarvis.OutcomeData{Status: "failed", Summary: "request timed out", ExitCode: 1}); err != nil {
		t.Fatal(err)
	}
	if err := ApplyAction(h.ctx, h.dagID, "t-0", "retry", waveobj.RoutePin{}); err != nil {
		t.Fatal(err)
	}
	if len(h.workers) != 2 {
		t.Fatalf("human retry spawned %d workers, want 2", len(h.workers))
	}
	if err := HandleChildOutcome(h.ctx, h.workers[1], jarvis.OutcomeData{Status: "failed", Summary: "tool call errored", ExitCode: 2}); err != nil {
		t.Fatal(err)
	}
	got := h.loadDag(t)
	if got.Tasks[0].Attempts != 1 || got.Tasks[0].LastFailureKind != FailureKindToolError {
		t.Fatalf("changed kind did not reset count: %+v", got.Tasks[0])
	}
}

func TestHandleChildOutcomeUsesStampedUndispatchedRunWorker(t *testing.T) {
	h := newChildOutcomeHarness(t, 1)
	worker := h.workers[0]
	ch, err := wstore.DBMustGet[*waveobj.Channel](h.ctx, h.channel)
	if err != nil {
		t.Fatal(err)
	}
	for _, msg := range ch.Messages {
		if msg.RefORef == worker && msg.Kind == "dispatch" {
			t.Fatal("run worker unexpectedly has a dispatch message")
		}
	}
	if err := HandleChildOutcome(h.ctx, worker, jarvis.OutcomeData{Status: "failed", Summary: "request timed out", ExitCode: 1}); err != nil {
		t.Fatal(err)
	}
	if got := h.loadDag(t); got.Tasks[0].LastFailureKind != FailureKindTimeout {
		t.Fatalf("stamped undispatched worker was ignored: %+v", got.Tasks[0])
	}
}

func TestHandleChildOutcomePreservesCircuitBreakerCount(t *testing.T) {
	h := newChildOutcomeHarness(t, MaxConsecutiveFailures)
	for _, task := range h.loadDag(t).Tasks {
		if task.State != TaskState_Running {
			t.Fatalf("parallel task %s state = %q, want running", task.ID, task.State)
		}
	}
	for i := 0; i < MaxConsecutiveFailures; i++ {
		if err := HandleChildOutcome(h.ctx, h.workers[i], jarvis.OutcomeData{Status: "failed", Summary: "request timed out", ExitCode: 1}); err != nil {
			t.Fatal(err)
		}
	}
	got := h.loadDag(t)
	if got.Failures != MaxConsecutiveFailures {
		t.Fatalf("failures = %d, want %d", got.Failures, MaxConsecutiveFailures)
	}
}

func latestBlockedDetail(t *testing.T, h *childOutcomeHarness) struct {
	Failures int    `json:"failures"`
	Kind     string `json:"kind"`
} {
	t.Helper()
	events, err := wstore.QueryRunEvents(h.ctx, h.channel, h.runID, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.Kind != waveobj.RunEventKindDagBlocked {
			continue
		}
		var detail struct {
			Failures int    `json:"failures"`
			Kind     string `json:"kind"`
		}
		if err := json.Unmarshal(event.Detail, &detail); err != nil {
			t.Fatal(err)
		}
		return detail
	}
	t.Fatal("missing persisted dag-blocked event")
	return struct {
		Failures int    `json:"failures"`
		Kind     string `json:"kind"`
	}{}
}

func TestBlockedRunEventIncludesSingleFailureKind(t *testing.T) {
	h := newChildOutcomeHarness(t, 1)
	if err := HandleChildOutcome(h.ctx, h.workers[0], jarvis.OutcomeData{Status: "failed", Summary: "request timed out", ExitCode: 1}); err != nil {
		t.Fatal(err)
	}
	detail := latestBlockedDetail(t, h)
	if detail.Kind != FailureKindTimeout {
		t.Fatalf("blocked event kind = %q, want %q", detail.Kind, FailureKindTimeout)
	}
}

func TestBlockedRunEventUsesMixedForDistinctKinds(t *testing.T) {
	h := newChildOutcomeHarness(t, 2)
	if err := HandleChildOutcome(h.ctx, h.workers[0], jarvis.OutcomeData{Status: "failed", Summary: "request timed out", ExitCode: 1}); err != nil {
		t.Fatal(err)
	}
	if err := HandleChildOutcome(h.ctx, h.workers[1], jarvis.OutcomeData{Status: "failed", Summary: "tests: TestFoo still failing", ExitCode: 1}); err != nil {
		t.Fatal(err)
	}
	detail := latestBlockedDetail(t, h)
	if detail.Kind != "mixed" {
		t.Fatalf("blocked event kind = %q, want mixed", detail.Kind)
	}
}