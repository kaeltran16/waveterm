// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// stallTask forces a spawned task into the stalled state, as the liveness pass does when its child
// goes silent past StallThreshold. The child process is still alive — stalling is an observation,
// not a transition — so the task keeps its RunID.
func (h *childOutcomeHarness) stallTask(t *testing.T, taskID string) {
	t.Helper()
	if err := wstore.UpdateDag(h.ctx, h.dagID, func(cur *waveobj.TaskGroup) error {
		idx := taskIdx(cur, taskID)
		if idx < 0 {
			t.Fatalf("no task %q", taskID)
		}
		if cur.Tasks[idx].RunID == "" {
			t.Fatalf("task %q was never dispatched", taskID)
		}
		cur.Tasks[idx].State = TaskState_Stalled
		RecomputeDagStatus(cur)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

// A stalled task's worker exit is the same terminal event as a running one's: nothing else in the
// system turns a worker exit into a task failure, so dropping it strands the task forever.
func TestStalledWorkerRetryableExitIsRetried(t *testing.T) {
	h := newChildOutcomeHarness(t, 1)
	h.stallTask(t, "t-0")
	oldRunID := h.loadDag(t).Tasks[0].RunID

	if err := HandleChildOutcome(h.ctx, h.workers[0], jarvis.OutcomeData{Status: "failed", Summary: "tool call errored: invalid input", ExitCode: 2}); err != nil {
		t.Fatal(err)
	}

	task := h.loadDag(t).Tasks[0]
	if task.State != TaskState_Running || task.RunID == "" || task.RunID == oldRunID {
		t.Fatalf("stalled worker's retryable exit must re-dispatch the task: state=%q runid=%q old=%q", task.State, task.RunID, oldRunID)
	}
	if task.Attempts != 1 || task.LastFailureKind != FailureKindToolError {
		t.Fatalf("failure state = attempts %d kind %q, want 1 / %s", task.Attempts, task.LastFailureKind, FailureKindToolError)
	}
	if got := h.loadDag(t); got.Failures != 0 {
		t.Fatalf("an auto-retried flake must not push the streak: failures=%d", got.Failures)
	}
}

func TestStalledWorkerTerminalExitRecordedOnce(t *testing.T) {
	h := newChildOutcomeHarness(t, 1)
	h.stallTask(t, "t-0")

	data := jarvis.OutcomeData{Status: "failed", Summary: "worker died", ExitCode: 1}
	if err := HandleChildOutcome(h.ctx, h.workers[0], data); err != nil {
		t.Fatal(err)
	}

	got := h.loadDag(t)
	if got.Tasks[0].State != TaskState_Failed {
		t.Fatalf("stalled worker's terminal exit must fail the task, got %q", got.Tasks[0].State)
	}
	if got.Failures != 1 {
		t.Fatalf("failures = %d, want 1", got.Failures)
	}
	if got.Status != DagStatus_Blocked {
		t.Fatalf("dag status = %q, want %q", got.Status, DagStatus_Blocked)
	}

	// a duplicate exit notification must not double-count: the task is no longer active.
	if err := HandleChildOutcome(h.ctx, h.workers[0], data); err != nil {
		t.Fatal(err)
	}
	if again := h.loadDag(t); again.Failures != 1 || again.Tasks[0].Attempts != got.Tasks[0].Attempts {
		t.Fatalf("repeat exit re-recorded the failure: failures=%d attempts=%d", again.Failures, again.Tasks[0].Attempts)
	}
}

// A stalled child that goes on to finish still crossed the done boundary — the lead needs the
// child-done wakeup, and the streak accounting needs the fresh success, exactly as for a task that
// never went silent.
func TestStalledTaskCompletionPublishesChildDone(t *testing.T) {
	h := newChildOutcomeHarness(t, 1)
	h.stallTask(t, "t-0")
	childRunID := h.loadDag(t).Tasks[0].RunID

	cc := &captureClient{}
	prevClient := wps.Broker.GetClient()
	wps.Broker.SetClient(cc)
	defer wps.Broker.SetClient(prevClient)
	wps.Broker.Subscribe("stalled-done-test", wps.SubscriptionRequest{Event: DagEventChildDone, AllScopes: true})
	defer wps.Broker.Unsubscribe("stalled-done-test", DagEventChildDone)

	if err := wstore.UpdateRun(h.ctx, h.channel, childRunID, func(r *waveobj.Run) error {
		r.Status = jarvis.RunStatus_Done
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := Schedule(h.ctx, h.dagID); err != nil {
		t.Fatal(err)
	}

	got := h.loadDag(t)
	if got.Tasks[0].State != TaskState_Done {
		t.Fatalf("task must derive done from its child run, got %q", got.Tasks[0].State)
	}
	scope := waveobj.MakeORef(waveobj.OType_Dag, h.dagID).String()
	if !cc.saw(DagEventChildDone, scope) {
		t.Fatal("stalled->done must publish child-done; the lead is never woken otherwise")
	}
	events, err := wstore.QueryRunEvents(h.ctx, h.channel, h.runID, 50)
	if err != nil {
		t.Fatal(err)
	}
	var doneEvents int
	for _, e := range events {
		if e.Kind == waveobj.RunEventKindTaskDone {
			doneEvents++
		}
	}
	if doneEvents != 1 {
		t.Fatalf("task-done lifecycle events = %d, want exactly 1", doneEvents)
	}
}

// The streak counter must see a stalled task's outcome too: a success that never clears it, or a
// failure that never counts, silently mis-arms the circuit breaker.
func TestStalledTaskCompletionClearsFailureStreak(t *testing.T) {
	h := newChildOutcomeHarness(t, 1)
	h.stallTask(t, "t-0")
	if err := wstore.UpdateDag(h.ctx, h.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Failures = 2
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	childRunID := h.loadDag(t).Tasks[0].RunID
	if err := wstore.UpdateRun(h.ctx, h.channel, childRunID, func(r *waveobj.Run) error {
		r.Status = jarvis.RunStatus_Done
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if err := Schedule(h.ctx, h.dagID); err != nil {
		t.Fatal(err)
	}

	if got := h.loadDag(t); got.Failures != 0 {
		t.Fatalf("a stalled task's fresh success must clear the streak, failures=%d", got.Failures)
	}
}
