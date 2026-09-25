// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// stubDagSpawns counts the sessions the engine starts and keeps them off the real terminal.
func stubDagSpawns(t *testing.T) *[]jarvis.RunWorkerOptions {
	t.Helper()
	var spawned []jarvis.RunWorkerOptions
	orig := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(_ context.Context, _ runroute.Capability, _, _, _, _ string, opts jarvis.RunWorkerOptions) (string, error) {
		spawned = append(spawned, opts)
		return waveobj.MakeORef(waveobj.OType_Tab, uuid.NewString()).String(), nil
	}
	t.Cleanup(func() { jarvis.SpawnRunWorker = orig })
	t.Cleanup(orchestrate.SetValidateWorkerHarnessForTest(func(string) error { return nil }))
	return &spawned
}

func TestDagSubmitReviewsThePlanBeforeAnyWorkerStarts(t *testing.T) {
	ctx := context.Background()
	newRun := func(t *testing.T) (string, string) {
		t.Helper()
		ch, err := wstore.CreateChannel(ctx, "dag-planreview-test", t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		run := jarvis.NewRun("ship coupons", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(), 1)
		run.Status = jarvis.RunStatus_Planning
		if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
			t.Fatal(err)
		}
		return ch.OID, run.ID
	}
	writePlan := func(t *testing.T, src string) string {
		t.Helper()
		path := filepath.Join(t.TempDir(), "plan.md")
		if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	const plan = "# Coupons\n\n### Task 1: input\nadd the field\n"
	const revised = "# Coupons\n\n### Task 1: input\nadd the field\n\n### Task 2: spec 4.1\n**Depends on:** Task 1\n"
	submit := func(channelId, runId, planPath string) (*waveobj.TaskGroup, error) {
		return (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{ChannelId: channelId, RunId: runId, PlanPath: planPath})
	}

	t.Run("a plan file opens round 1 and dispatches nothing but the reviewer", func(t *testing.T) {
		spawned := stubDagSpawns(t)
		channelId, runId := newRun(t)
		g, err := submit(channelId, runId, writePlan(t, plan))
		if err != nil {
			t.Fatal(err)
		}
		if g.PlanReview == nil || g.PlanReview.State != orchestrate.PlanReviewState_Reviewing || g.PlanReview.Round != 1 || g.Status != orchestrate.DagStatus_PlanReview {
			t.Fatalf("want round 1 reviewing, got status %s review %+v", g.Status, g.PlanReview)
		}
		if g.Tasks[0].RunID != "" || len(*spawned) != 1 || (*spawned)[0].TaskId != "" {
			t.Fatalf("only the plan reviewer may start, got %+v", *spawned)
		}
	})

	t.Run("a JSON dag has no plan review", func(t *testing.T) {
		stubDagSpawns(t)
		channelId, runId := newRun(t)
		g, err := (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{ChannelId: channelId, RunId: runId, Title: "t", Parallelism: 1, Tasks: []waveobj.TaskNode{{ID: "t-1", Label: "a"}}})
		if err != nil {
			t.Fatal(err)
		}
		if g.PlanReview != nil || g.Status == orchestrate.DagStatus_PlanReview {
			t.Fatalf("want no plan review, got status %s review %+v", g.Status, g.PlanReview)
		}
	})

	t.Run("a revised plan replaces one whose review failed, and is reviewed again", func(t *testing.T) {
		spawned := stubDagSpawns(t)
		channelId, runId := newRun(t)
		g, err := submit(channelId, runId, writePlan(t, plan))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := submit(channelId, runId, writePlan(t, revised)); err == nil || !strings.Contains(err.Error(), "dag conflict") {
			t.Fatalf("a resubmit while the plan is under review must conflict, got %v", err)
		}
		if err := (&WshServer{}).DagActionCommand(ctx, wshrpc.CommandDagActionData{ChannelId: channelId, RunId: runId, Action: "planreview-accept", Notes: "go"}); err == nil {
			t.Fatal("accept while the reviewer works must be refused")
		}
		if err := orchestrate.RecordPlanReviewVerdict(ctx, g.OID, g.PlanReview.RunID, orchestrate.ReviewVerdict_Fail, "spec 4.1 has no task"); err != nil {
			t.Fatal(err)
		}
		g2, err := submit(channelId, runId, writePlan(t, revised))
		if err != nil {
			t.Fatal(err)
		}
		if g2.OID != g.OID || len(g2.Tasks) != 2 || g2.PlanReview.Round != 2 || g2.PlanReview.State != orchestrate.PlanReviewState_Reviewing {
			t.Fatalf("want the same dag with the revised tasks in round 2, got %d tasks and %+v", len(g2.Tasks), g2.PlanReview)
		}
		if g2.PlanReview.RunID == "" || g2.PlanReview.RunID == g.PlanReview.RunID || len(*spawned) != 2 {
			t.Fatalf("round 2 gets a fresh reviewer, got %+v after %d spawns", g2.PlanReview, len(*spawned))
		}
	})

	t.Run("a resubmit after the plan passed keeps the conflict", func(t *testing.T) {
		stubDagSpawns(t)
		channelId, runId := newRun(t)
		g, err := submit(channelId, runId, writePlan(t, plan))
		if err != nil {
			t.Fatal(err)
		}
		if err := orchestrate.RecordPlanReviewVerdict(ctx, g.OID, g.PlanReview.RunID, orchestrate.ReviewVerdict_Pass, "fine"); err != nil {
			t.Fatal(err)
		}
		if _, err := submit(channelId, runId, writePlan(t, revised)); err == nil || !strings.Contains(err.Error(), "dag conflict") {
			t.Fatalf("want dag conflict, got %v", err)
		}
	})
}
