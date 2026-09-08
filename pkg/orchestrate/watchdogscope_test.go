// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// silentSiblingDag builds a two-task dag whose t-1 is running behind a silent child (a tracked
// runtime with no session to read, and a last-activity older than StallThreshold), and applies
// mutate to shape t-0 into whatever non-running condition the test needs. Returns the dag id and a
// spawn counter that must stay at zero: a dag parked for the human may be observed, never advanced.
func silentSiblingDag(t *testing.T, name string, mutate func(*waveobj.TaskGroup)) (context.Context, string, *int) {
	t.Helper()
	allowWorkerHarnessForTest(t)
	ctx := context.Background()
	oldRoot := sessionsRootFor
	sessionsRootFor = func(string) string { return t.TempDir() }
	t.Cleanup(func() { sessionsRootFor = oldRoot })

	ch, err := wstore.CreateChannel(ctx, name, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, name, 2, false, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b"},
	}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	child := jarvis.NewRun("child", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	child.Runtime = "pi" // tracked runtime: the probe has somewhere to look, so silence is a verdict
	child.DagORef = g.OID
	if err := wstore.AppendRun(ctx, ch.OID, child); err != nil {
		t.Fatal(err)
	}
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		cur.Tasks[1].State = TaskState_Running
		cur.Tasks[1].RunID = child.ID
		cur.Tasks[1].LastActivity = time.Now().Add(-StallThreshold - time.Minute).UnixMilli()
		mutate(cur)
		RecomputeDagStatus(cur)
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	spawns := 0
	old := spawnWorker
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		spawns++
		return "tab:worker", nil
	}
	t.Cleanup(func() { spawnWorker = old })
	return ctx, g.OID, &spawns
}

func assertSiblingStalled(t *testing.T, ctx context.Context, dagID string, spawns *int, wantStatus string) {
	t.Helper()
	got, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != wantStatus {
		t.Fatalf("dag status = %q, want %q", got.Status, wantStatus)
	}
	if got.Tasks[1].State != TaskState_Stalled {
		t.Fatalf("silent sibling = %q, want stalled: the watchdog is the only thing that notices", got.Tasks[1].State)
	}
	if *spawns != 0 {
		t.Fatalf("observing a parked dag spawned %d workers; it must not advance dispatch", *spawns)
	}
}

// A failed task parks the dag for the human, but its siblings keep running. Stall detection lives in
// the schedule tick, so a watchdog that only scans running dags stops watching those siblings the
// moment any one task fails — exactly when supervision matters most.
func TestWatchdogTickDetectsStallInBlockedDag(t *testing.T) {
	ctx, dagID, spawns := silentSiblingDag(t, "watchdog-blocked", func(g *waveobj.TaskGroup) {
		g.Tasks[0].State = TaskState_Failed
	})

	watchdogTick(ctx)

	assertSiblingStalled(t, ctx, dagID, spawns, DagStatus_Blocked)
}

func TestWatchdogTickDetectsStallInAwaitingReviewDag(t *testing.T) {
	ctx, dagID, spawns := silentSiblingDag(t, "watchdog-gate", func(g *waveobj.TaskGroup) {
		g.Tasks[0].State = TaskState_Done
		g.Tasks[0].Gate = true
		g.Tasks[0].Released = false
	})

	watchdogTick(ctx)

	assertSiblingStalled(t, ctx, dagID, spawns, DagStatus_AwaitingReview)
}

// Terminal dags are done being watched: re-scheduling them forever is pure noise.
func TestWatchdogTickSkipsTerminalDags(t *testing.T) {
	ctx, dagID, _ := silentSiblingDag(t, "watchdog-cancelled", func(g *waveobj.TaskGroup) {
		g.Tasks[0].State = TaskState_Cancelled
	})

	watchdogTick(ctx)

	got, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != DagStatus_Cancelled {
		t.Fatalf("dag status = %q, want %q", got.Status, DagStatus_Cancelled)
	}
	if got.Tasks[1].State == TaskState_Stalled {
		t.Fatal("a cancelled dag must not be advanced by the watchdog")
	}
}
