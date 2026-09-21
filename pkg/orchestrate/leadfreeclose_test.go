// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// sealedRuns records the runs handed to the evidence hook, the observable effect of closing a run.
func stubSealHook(t *testing.T) *[][2]string {
	t.Helper()
	var sealed [][2]string
	old := SealRunEvidenceHook
	SealRunEvidenceHook = func(channelId, runId string) {
		sealed = append(sealed, [2]string{channelId, runId})
	}
	t.Cleanup(func() { SealRunEvidenceHook = old })
	return &sealed
}

// stampLeadTab gives the owner run a lead worker with a live process, the thing that makes a run someone
// else's to close.
func stampLeadTab(t *testing.T, f *mergeFixture) {
	t.Helper()
	stubBlockShellStatus(t, blockcontroller.Status_Running)
	if err := wstore.DBInsert(f.ctx, &waveobj.Tab{OID: "lead-tab", BlockIds: []string{"lead-block"}, Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatal(err)
	}
	// the test store is shared across the package and the oid is fixed, so a later stamp would collide
	t.Cleanup(func() { _ = wstore.DBDelete(context.Background(), waveobj.OType_Tab, "lead-tab") })
	if err := wstore.UpdateRun(f.ctx, f.channel, f.ownerID, func(r *waveobj.Run) error {
		r.Phases[0].WorkerOrefs = []string{"tab:lead-tab"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func (f *mergeFixture) owner(t *testing.T) *waveobj.Run {
	t.Helper()
	run, err := wstore.GetRun(f.ctx, f.channel, f.ownerID)
	if err != nil {
		t.Fatal(err)
	}
	return run
}

// the defect: a human-planned run has no lead to run `wsh jarvis complete`, so its DAG finished and the
// run sat in planning forever with its evidence never sealed.
func TestScheduleClosesLeadFreeRunWhenDagCompletes(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "only"}})
	f.finish(t, "t-0")
	stubMerge(t, func(context.Context, string, string, string) (string, error) { return "sha-1", nil })
	sealed := stubSealHook(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}

	if g := f.dag(t); g.Status != DagStatus_Done {
		t.Fatalf("dag must be done for the run to close, got %s", g.Status)
	}
	run := f.owner(t)
	if run.Status != jarvis.RunStatus_Done {
		t.Fatalf("owner run status = %s, want done", run.Status)
	}
	if run.EndCommit == "" {
		t.Fatal("owner run must carry the head commit so the sealed diff is scoped to BaseCommit..EndCommit")
	}
	if len(*sealed) != 1 || (*sealed)[0] != [2]string{f.channel, f.ownerID} {
		t.Fatalf("evidence must be sealed once for the owner, got %v", *sealed)
	}
}

// a run with a lead is not the engine's to close: the lead reports the completion, and may still owe
// the human a summary after the last task lands.
func TestScheduleLeavesRunWithLeadToItsLead(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "only"}})
	f.finish(t, "t-0")
	stampLeadTab(t, f)
	stubMerge(t, func(context.Context, string, string, string) (string, error) { return "sha-1", nil })
	sealed := stubSealHook(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}

	if g := f.dag(t); g.Status != DagStatus_Done {
		t.Fatalf("dag must be done, got %s", g.Status)
	}
	if run := f.owner(t); run.Status == jarvis.RunStatus_Done {
		t.Fatal("a run with a lead must stay open for the lead to complete")
	}
	if len(*sealed) != 0 {
		t.Fatalf("no evidence seal without a completion, got %v", *sealed)
	}
}

// every later tick re-enters Schedule on the same done dag; closing is a one-time transition.
func TestScheduleClosesLeadFreeRunOnlyOnce(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "only"}})
	f.finish(t, "t-0")
	stubMerge(t, func(context.Context, string, string, string) (string, error) { return "sha-1", nil })
	sealed := stubSealHook(t)

	for i := 0; i < 2; i++ {
		if err := Schedule(f.ctx, f.dagID); err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
	}

	if len(*sealed) != 1 {
		t.Fatalf("want 1 seal across two ticks, got %d", len(*sealed))
	}
}
