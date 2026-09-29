// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
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
