// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// notifyHarness is a dag whose tasks the test drives through their child runs, so status changes
// happen inside Schedule exactly as they do in production.
type notifyHarness struct {
	ctx     context.Context
	dagID   string
	channel string
	runID   string
}

func newNotifyHarness(t *testing.T, parallelism int, tasks []waveobj.TaskNode) *notifyHarness {
	t.Helper()
	allowWorkerHarnessForTest(t)
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "notify-gate", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "notify", parallelism, false, tasks, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	old := spawnWorker
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		return "tab:worker", nil
	}
	t.Cleanup(func() { spawnWorker = old })
	h := &notifyHarness{ctx: ctx, dagID: g.OID, channel: ch.OID, runID: owner.ID}
	if err := Schedule(ctx, g.OID); err != nil {
		t.Fatal(err)
	}
	return h
}

func (h *notifyHarness) loadDag(t *testing.T) *waveobj.TaskGroup {
	t.Helper()
	g, err := wstore.GetDag(h.ctx, h.dagID)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

// finishTask drives a dispatched task's child run to a terminal status, the way a real worker does.
func (h *notifyHarness) finishTask(t *testing.T, taskID, runStatus string) {
	t.Helper()
	idx := taskIdx(h.loadDag(t), taskID)
	if idx < 0 {
		t.Fatalf("no task %q", taskID)
	}
	runID := h.loadDag(t).Tasks[idx].RunID
	if runID == "" {
		t.Fatalf("task %q was never dispatched", taskID)
	}
	if err := wstore.UpdateRun(h.ctx, h.channel, runID, func(r *waveobj.Run) error {
		r.Status = runStatus
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func (h *notifyHarness) countLifecycle(t *testing.T, kind string) int {
	t.Helper()
	events, err := wstore.QueryRunEvents(h.ctx, h.channel, h.runID, 200)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range events {
		if e.Kind == kind {
			n++
		}
	}
	return n
}

func (h *notifyHarness) scheduleTimes(t *testing.T, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		if err := Schedule(h.ctx, h.dagID); err != nil {
			t.Fatal(err)
		}
	}
}

// The watchdog and every dag mutation re-enter Schedule. Emitting the dag's current status each time
// turns one blocking event into a lifecycle log full of identical rows and repeated lead wakeups.
func TestBlockedNotificationEmitsOncePerTransition(t *testing.T) {
	h := newNotifyHarness(t, 1, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})
	h.finishTask(t, "t-0", jarvis.RunStatus_Blocked)

	h.scheduleTimes(t, 3)

	if got := h.loadDag(t).Status; got != DagStatus_Blocked {
		t.Fatalf("dag status = %q, want %q", got, DagStatus_Blocked)
	}
	if n := h.countLifecycle(t, waveobj.RunEventKindDagBlocked); n != 1 {
		t.Fatalf("dag-blocked lifecycle events = %d, want exactly 1", n)
	}
}

func TestGateOpenNotificationEmitsOncePerTransition(t *testing.T) {
	h := newNotifyHarness(t, 1, []waveobj.TaskNode{{ID: "t-0", Label: "a", Gate: true}})
	h.finishTask(t, "t-0", jarvis.RunStatus_Done)

	h.scheduleTimes(t, 3)

	if got := h.loadDag(t).Status; got != DagStatus_AwaitingReview {
		t.Fatalf("dag status = %q, want %q", got, DagStatus_AwaitingReview)
	}
	if n := h.countLifecycle(t, waveobj.RunEventKindDagGateOpen); n != 1 {
		t.Fatalf("dag-gate-open lifecycle events = %d, want exactly 1", n)
	}
}

func TestDagDoneNotificationEmitsOncePerTransition(t *testing.T) {
	h := newNotifyHarness(t, 1, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})
	h.finishTask(t, "t-0", jarvis.RunStatus_Done)

	h.scheduleTimes(t, 3)

	if got := h.loadDag(t).Status; got != DagStatus_Done {
		t.Fatalf("dag status = %q, want %q", got, DagStatus_Done)
	}
	if n := h.countLifecycle(t, waveobj.RunEventKindDagDone); n != 1 {
		t.Fatalf("dag-done lifecycle events = %d, want exactly 1", n)
	}
}

// Suppressing repeats must not suppress a genuinely new gate. Two independent gates both complete;
// releasing the first leaves the dag awaiting review on the second — the status never changes, but
// the human is now being asked about a different task and has to be told.
func TestSecondGateNotifiesThoughStatusIsUnchanged(t *testing.T) {
	h := newNotifyHarness(t, 2, []waveobj.TaskNode{
		{ID: "t-0", Label: "a", Gate: true},
		{ID: "t-1", Label: "b", Gate: true},
	})
	h.finishTask(t, "t-0", jarvis.RunStatus_Done)
	h.finishTask(t, "t-1", jarvis.RunStatus_Done)
	h.scheduleTimes(t, 1)
	if got := h.loadDag(t); got.Status != DagStatus_AwaitingReview || gatedTaskID(got) != "t-0" {
		t.Fatalf("setup: status=%q gate=%q, want awaiting-review on t-0", got.Status, gatedTaskID(got))
	}

	if err := ApplyAction(h.ctx, h.dagID, "t-0", "approve", waveobj.RoutePin{}); err != nil {
		t.Fatal(err)
	}

	got := h.loadDag(t)
	if got.Status != DagStatus_AwaitingReview || gatedTaskID(got) != "t-1" {
		t.Fatalf("status=%q gate=%q, want awaiting-review on t-1", got.Status, gatedTaskID(got))
	}
	if n := h.countLifecycle(t, waveobj.RunEventKindDagGateOpen); n != 2 {
		t.Fatalf("dag-gate-open lifecycle events = %d, want 2 (one per gate the human must answer)", n)
	}
}
