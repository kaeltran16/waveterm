package orchestrate

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// toolFlakeOutcome is the canonical transient failure: classified tool_call_error, the one
// kind the phase-2 policy auto-retries once.
func toolFlakeOutcome() jarvis.OutcomeData {
	return jarvis.OutcomeData{Status: "failed", Summary: "tool call errored: connection refused", ExitCode: 2}
}

// Pins the deliberate streak semantics: auto-retried flakes still count toward the
// circuit-break, so MaxConsecutiveFailures concurrent one-shot flakes block the DAG even
// though every task was respawned and none remains Failed. The retried tasks end Running
// again (HandleChildOutcome's trailing scheduleLocked respawns them), which is the point:
// the breaker trips on the failure streak alone, not on any lingering failed task.
func TestConcurrentAutoRetriedFlakesStillTripCircuitBreaker(t *testing.T) {
	h := newChildOutcomeHarness(t, MaxConsecutiveFailures)
	for i := 0; i < MaxConsecutiveFailures; i++ {
		if err := HandleChildOutcome(h.ctx, h.workers[i], toolFlakeOutcome()); err != nil {
			t.Fatal(err)
		}
	}
	got := h.loadDag(t)
	if got.Failures != MaxConsecutiveFailures || got.Status != DagStatus_Blocked {
		t.Fatalf("failures=%d status=%q, want %d/blocked", got.Failures, got.Status, MaxConsecutiveFailures)
	}
	for _, task := range got.Tasks {
		if task.State == TaskState_Failed {
			t.Fatalf("task %s stayed failed; breaker must trip on the streak alone", task.ID)
		}
	}
}

// A single auto-retried flake never blocks: the DAG stays running and no dag-blocked run
// event may be persisted for it.
func TestSingleAutoRetriedFlakeDoesNotBlock(t *testing.T) {
	h := newChildOutcomeHarness(t, 1)
	if err := HandleChildOutcome(h.ctx, h.workers[0], toolFlakeOutcome()); err != nil {
		t.Fatal(err)
	}
	got := h.loadDag(t)
	if got.Failures != 1 || got.Status != DagStatus_Running || got.Tasks[0].State != TaskState_Running {
		t.Fatalf("single flake failures=%d status=%q task=%q", got.Failures, got.Status, got.Tasks[0].State)
	}
	events, err := wstore.QueryRunEvents(h.ctx, h.channel, h.runID, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.Kind == waveobj.RunEventKindDagBlocked {
			t.Fatal("single auto-retried flake published a dag-blocked event")
		}
	}
}

// A fresh success clears both the dag-wide failure streak and the finished task's attempt
// bookkeeping, so later failures start counting from zero instead of inheriting earlier flakes.
func TestFreshSuccessResetsFailureStreakAndAttempts(t *testing.T) {
	h := newChildOutcomeHarness(t, 2)
	if err := HandleChildOutcome(h.ctx, h.workers[0], toolFlakeOutcome()); err != nil {
		t.Fatal(err)
	}
	retried := h.loadDag(t)
	runID := retried.Tasks[0].RunID
	if runID == "" || retried.Tasks[0].Attempts != 1 {
		t.Fatalf("expected retried task with attempts=1, got %+v", retried.Tasks[0])
	}
	if err := wstore.UpdateRun(h.ctx, h.channel, runID, func(r *waveobj.Run) error {
		r.Status = jarvis.RunStatus_Done
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := ScheduleOnce(h.ctx, retried); err != nil {
		t.Fatal(err)
	}
	done := h.loadDag(t)
	if done.Failures != 0 || done.Tasks[0].State != TaskState_Done || done.Tasks[0].Attempts != 0 || done.Tasks[0].LastFailureKind != "" {
		t.Fatalf("success did not clear streak/attempts: failures=%d task=%+v", done.Failures, done.Tasks[0])
	}
	if err := HandleChildOutcome(h.ctx, h.workers[1], toolFlakeOutcome()); err != nil {
		t.Fatal(err)
	}
	got := h.loadDag(t)
	if got.Failures != 1 || got.Status != DagStatus_Running {
		t.Fatalf("post-success streak = %d/%q, want fresh count 1/running", got.Failures, got.Status)
	}
}
