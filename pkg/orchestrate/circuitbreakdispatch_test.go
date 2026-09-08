// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// breakerHarness is a two-independent-task dag with a spawn counter, for asserting what the dispatch
// boundary does once the failure streak has reached the circuit-break.
type breakerHarness struct {
	ctx     context.Context
	dagID   string
	channel string
	spawns  int
}

func newBreakerHarness(t *testing.T, parallelism int) *breakerHarness {
	t.Helper()
	allowWorkerHarnessForTest(t)
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "circuit-break", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "breaker", parallelism, false, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b"},
	}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	h := &breakerHarness{ctx: ctx, dagID: g.OID, channel: ch.OID}
	old := spawnWorker
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		h.spawns++
		return "tab:worker", nil
	}
	t.Cleanup(func() { spawnWorker = old })
	return h
}

func (h *breakerHarness) loadDag(t *testing.T) *waveobj.TaskGroup {
	t.Helper()
	g, err := wstore.GetDag(h.ctx, h.dagID)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func (h *breakerHarness) armBreaker(t *testing.T, mutate func(*waveobj.TaskGroup)) {
	t.Helper()
	if err := wstore.UpdateDag(h.ctx, h.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Failures = MaxConsecutiveFailures
		if mutate != nil {
			mutate(cur)
		}
		RecomputeDagStatus(cur)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

// The breaker is a dispatch guard, not only a derived status: deriving "blocked" while the scheduler
// keeps handing out work spends the whole DAG on a fault the human was supposed to be asked about.
func TestNextToSpawnHaltsAtCircuitBreaker(t *testing.T) {
	g := groupWith(TaskState_Done) // t-1 and t-2 ready, two free slots
	g.Failures = MaxConsecutiveFailures
	RecomputeDagStatus(g)
	if got := NextToSpawn(g); len(got) != 0 {
		t.Fatalf("circuit break must stop dispatch, got %v", got)
	}
	g.Failures = MaxConsecutiveFailures - 1
	if got := NextToSpawn(g); len(got) == 0 {
		t.Fatal("below the threshold the scheduler must still dispatch")
	}
}

func TestScheduleDoesNotSpawnAfterCircuitBreak(t *testing.T) {
	h := newBreakerHarness(t, 2)
	h.armBreaker(t, nil)

	if err := Schedule(h.ctx, h.dagID); err != nil {
		t.Fatal(err)
	}

	if h.spawns != 0 {
		t.Fatalf("spawned %d workers past the circuit break, want 0", h.spawns)
	}
	got := h.loadDag(t)
	for _, task := range got.Tasks {
		if task.State != TaskState_Pending {
			t.Fatalf("task %s = %q, want pending", task.ID, task.State)
		}
	}
	if got.Status != DagStatus_Blocked {
		t.Fatalf("dag status = %q, want %q", got.Status, DagStatus_Blocked)
	}
}

// The breaker says "stop and ask a human". The human's answer is a dag action — and it must actually
// re-arm the engine, or the fix above deadlocks the DAG: nothing dispatches, so no fresh success can
// ever clear the streak that is blocking dispatch.
func TestHumanActionClearsFailureStreak(t *testing.T) {
	h := newBreakerHarness(t, 2)
	h.armBreaker(t, func(g *waveobj.TaskGroup) {
		g.Tasks[0].State = TaskState_Failed
		g.Tasks[0].RunID = ""
	})

	if err := ApplyAction(h.ctx, h.dagID, "t-0", "retry", waveobj.RoutePin{}); err != nil {
		t.Fatal(err)
	}

	got := h.loadDag(t)
	if got.Failures != 0 {
		t.Fatalf("a human dag action must clear the streak, failures=%d", got.Failures)
	}
	if h.spawns == 0 {
		t.Fatal("dispatch must resume once the human has answered the breaker")
	}
	if got.Status != DagStatus_Running {
		t.Fatalf("dag status = %q, want %q", got.Status, DagStatus_Running)
	}
}

// With the breaker armed and no task individually needing attention, the digest must still name a
// human action — the engine has stopped, and reporting "cleanup-wait" or "dispatch" would tell the
// lead to keep waiting for a move that will never come.
func TestBuildNextReportsCircuitBreakerAsHumanAction(t *testing.T) {
	g := digestGroup(t, false, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b"},
	})
	g.Failures = MaxConsecutiveFailures
	RecomputeDagStatus(g)

	next := buildNext(g, map[string]wshrpc.DagAskItem{})

	if next.Kind != "human-action" {
		t.Fatalf("next.kind = %q, want human-action", next.Kind)
	}
	if len(next.Actions) == 0 {
		t.Fatal("a human-action step must name the actions that clear it")
	}
}
