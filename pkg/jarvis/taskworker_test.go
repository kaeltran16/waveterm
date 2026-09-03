// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// seedTaskRun inserts a child run row for a task, mirroring how a spawned dag task looks in the store.
func seedTaskRun(t *testing.T, ch *waveobj.Channel, taskID, runID string, phases []waveobj.RunPhase) {
	t.Helper()
	row := &waveobj.Run{OID: runID, ID: runID, ChannelOID: ch.OID, Mode: "orchestrator",
		Status: "executing", CreatedTs: 1, Phases: phases}
	if err := wstore.DBInsert(context.Background(), row); err != nil {
		t.Fatalf("insert task run %s: %v", runID, err)
	}
}

func taskWithRun(taskID, runID string) *waveobj.TaskNode {
	return &waveobj.TaskNode{ID: taskID, State: "running", RunID: runID}
}

func TestResolveTaskWorker_RunMissing(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "tw-missing", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	// no run row for the task's run id -> not-dispatched (never spawned)
	w, err := ResolveTaskWorker(ctx, ch.OID, taskWithRun("t-0", uuid.NewString()))
	if err != nil {
		t.Fatal(err)
	}
	if w == nil || w.Resolved || w.Reason != TaskWorkerReasonNotDispatched {
		t.Fatalf("want unresolved not-dispatched, got %+v", w)
	}
	// empty run id also reads as not-dispatched
	w2, err := ResolveTaskWorker(ctx, ch.OID, &waveobj.TaskNode{ID: "t-1", State: "pending"})
	if err != nil {
		t.Fatal(err)
	}
	if w2 == nil || w2.Resolved || w2.Reason != TaskWorkerReasonNotDispatched {
		t.Fatalf("want unresolved not-dispatched for empty runid, got %+v", w2)
	}
}

func TestResolveTaskWorker_NoPhase(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "tw-nophase", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	runID := uuid.NewString()
	seedTaskRun(t, ch, "t-0", runID, nil)
	w, err := ResolveTaskWorker(ctx, ch.OID, taskWithRun("t-0", runID))
	if err != nil {
		t.Fatal(err)
	}
	if w == nil || w.Resolved || w.Reason != TaskWorkerReasonWorkerUnavailable {
		t.Fatalf("run without phase must be unresolved worker-unavailable, got %+v", w)
	}
}

func TestResolveTaskWorker_TabPhase(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "tw-tab", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	tabID := uuid.NewString()
	if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: tabID, Name: "w", Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("seed worker tab: %v", err)
	}
	runID := uuid.NewString()
	seedTaskRun(t, ch, "t-0", runID, []waveobj.RunPhase{
		{Kind: PhaseKind_Plan, State: PhaseState_Done},
		{Kind: PhaseKind_Execute, State: PhaseState_Running, WorkerOrefs: []string{waveobj.MakeORef(waveobj.OType_Tab, tabID).String()}},
	})
	w, err := ResolveTaskWorker(ctx, ch.OID, taskWithRun("t-0", runID))
	if err != nil {
		t.Fatal(err)
	}
	if w == nil || !w.Resolved || w.TabId != tabID || w.PhaseIdx != 1 || w.Run == nil {
		t.Fatalf("want resolved tab phase, got %+v", w)
	}
}

func TestResolveTaskWorker_NoTabOref(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "tw-notab", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	runID := uuid.NewString()
	seedTaskRun(t, ch, "t-0", runID, []waveobj.RunPhase{{Kind: PhaseKind_Execute, State: PhaseState_Running}})
	w, err := ResolveTaskWorker(ctx, ch.OID, taskWithRun("t-0", runID))
	if err != nil {
		t.Fatal(err)
	}
	if w == nil || w.Resolved || w.Reason != TaskWorkerReasonWorkerUnavailable {
		t.Fatalf("run without tab oref must be unresolved worker-unavailable, got %+v", w)
	}
}