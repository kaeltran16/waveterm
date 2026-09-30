// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// sealedDoneRun stores a done run shaped by shape and returns its channel.
func sealedDoneRun(t *testing.T, shape func(r *waveobj.Run)) (string, waveobj.Run) {
	t.Helper()
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "seal-schedule", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	run := jarvis.NewRun("task", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	run.Status = jarvis.RunStatus_Done
	shape(&run)
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatal(err)
	}
	return ch.OID, run
}

// recordScheduledDags replaces the scheduler poke with a recorder. sealedFirst reports whether the run's evidence was
// already persisted when its dag was poked.
func recordScheduledDags(t *testing.T, channelId, runId string) (dags *[]string, sealedFirst *bool) {
	t.Helper()
	dags, sealedFirst = &[]string{}, new(bool)
	orig := scheduleDag
	scheduleDag = func(dagID string) {
		*dags = append(*dags, dagID)
		if r, err := wstore.GetRun(context.Background(), channelId, runId); err == nil && r.Evidence != nil {
			*sealedFirst = true
		}
	}
	t.Cleanup(func() { scheduleDag = orig })
	return dags, sealedFirst
}

// a task's reviewer waits on its worker's evidence, so the seal pokes the dag rather than leaving the reviewer
// to the next watchdog tick
func TestSealingATaskWorkersEvidenceSchedulesItsDag(t *testing.T) {
	dagID := uuid.NewString()
	channelId, run := sealedDoneRun(t, func(r *waveobj.Run) { r.DagORef, r.TaskId = dagID, "t-1" })
	dags, sealedFirst := recordScheduledDags(t, channelId, run.ID)
	sealDoneRunEvidence(channelId, run.ID)
	if len(*dags) != 1 || (*dags)[0] != dagID {
		t.Fatalf("scheduled dags = %v, want [%s]", *dags, dagID)
	}
	if !*sealedFirst {
		t.Fatal("the dag was poked before the evidence its reviewer waits on was persisted")
	}
}

func TestSealingARunNoReviewerWaitsOnSchedulesNothing(t *testing.T) {
	dagID := uuid.NewString()
	for name, shape := range map[string]func(r *waveobj.Run){
		"no dag":        func(*waveobj.Run) {},
		"the dag's own": func(r *waveobj.Run) { r.DagORef = dagID },
		"a reviewer":    func(r *waveobj.Run) { r.DagORef, r.TaskId, r.Review = dagID, "t-1", true },
	} {
		t.Run(name, func(t *testing.T) {
			channelId, run := sealedDoneRun(t, shape)
			dags, _ := recordScheduledDags(t, channelId, run.ID)
			sealDoneRunEvidence(channelId, run.ID)
			if sealed, err := wstore.GetRun(context.Background(), channelId, run.ID); err != nil || sealed.Evidence == nil {
				t.Fatalf("the run was not sealed, so the test proves nothing: %v", err)
			}
			if len(*dags) != 0 {
				t.Fatalf("scheduled dags = %v, want none", *dags)
			}
		})
	}
}

// End to end: a finished task worker's seal pokes a real tick, and that tick starts the task's reviewer. The
// halves above and orchestrate's TestReviewWaitsForTheWorkersEvidence each stub the other side.
func TestSealingATaskWorkerStartsItsReviewer(t *testing.T) {
	ctx := context.Background()
	dir, git := newLandingRepo(t)
	base := git("rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(dir, "work.txt"), []byte("work\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", ".")
	git("commit", "-m", "t-1: work")
	end := git("rev-parse", "HEAD")

	ch, err := wstore.CreateChannel(ctx, "seal-starts-reviewer", dir)
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("ship it", "ws-1", dir, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(), 1)
	owner.Runtime = "claude"
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	dag, err := orchestrate.NewTaskGroup(owner.ID, ch.OID, "g", 1, false, []waveobj.TaskNode{{ID: "t-1", Label: "work"}}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &dag); err != nil {
		t.Fatal(err)
	}
	worker := jarvis.NewRun("work", "ws-1", dir, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	worker.Status = jarvis.RunStatus_Done
	worker.BaseCommit, worker.EndCommit = base, end
	worker.DagORef, worker.TaskId = dag.OID, "t-1"
	worker.Report = "Added work.txt."
	worker.Phases[0].DoneTs = time.Now().UnixMilli()
	if err := wstore.AppendRun(ctx, ch.OID, worker); err != nil {
		t.Fatal(err)
	}
	if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
		g.Tasks[0].State = orchestrate.TaskState_Running
		g.Tasks[0].RunID = worker.ID
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	spawned := stubDagSpawns(t)
	orig := scheduleDag
	scheduleDag = func(dagID string) {
		if err := orchestrate.Schedule(ctx, dagID); err != nil {
			t.Errorf("schedule %s: %v", dagID, err)
		}
	}
	t.Cleanup(func() { scheduleDag = orig })

	// before the seal the reviewer has no worker note to read, so a tick must not start it
	if err := orchestrate.Schedule(ctx, dag.OID); err != nil {
		t.Fatal(err)
	}
	if len(*spawned) != 0 {
		t.Fatalf("a reviewer started before the worker's evidence was sealed: %+v", *spawned)
	}

	sealDoneRunEvidence(ch.OID, worker.ID)

	if len(*spawned) != 1 || (*spawned)[0].TaskId != "t-1" || (*spawned)[0].Label != "review t-1" {
		t.Fatalf("the seal's tick must start t-1's reviewer, got %+v", *spawned)
	}
	got, err := wstore.GetDag(ctx, dag.OID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Tasks[0].ReviewRunID == "" {
		t.Fatal("the task does not record its reviewer's run")
	}
}

// an already-sealed run is the backfill's no-op; it must not poke the dag a second time
func TestResealingASealedWorkerSchedulesNothing(t *testing.T) {
	channelId, run := sealedDoneRun(t, func(r *waveobj.Run) {
		r.DagORef, r.TaskId = uuid.NewString(), "t-1"
		r.Evidence = &waveobj.RunEvidence{Summary: "done"}
	})
	dags, _ := recordScheduledDags(t, channelId, run.ID)
	sealDoneRunEvidence(channelId, run.ID)
	if len(*dags) != 0 {
		t.Fatalf("scheduled dags = %v, want none", *dags)
	}
}
