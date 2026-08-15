// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestDagSubmitAndAction(t *testing.T) {
	ctx := context.Background()
	// the submit/action handlers schedule immediately; stub the spawn seam so the test
	// environment (no backend/harness) doesn't fail every spawn.
	oldSpawn := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(ctx context.Context, runtime, workspaceId, projectName, cwd, prompt string) (string, error) {
		return "tab:worker", nil
	}
	defer func() { jarvis.SpawnRunWorker = oldSpawn }()
	ch, err := wstore.CreateChannel(ctx, "dag-test", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("do the thing", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}
	ws := &WshServer{}
	g, err := ws.DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{
		ChannelId: ch.OID, RunId: run.ID, Title: "t", Parallelism: 2,
		Tasks: []waveobj.TaskNode{
			{ID: "t-0", Label: "a"},
			{ID: "t-1", Label: "b", Deps: []string{"t-0"}, Gate: true},
			{ID: "t-2", Label: "c", Deps: []string{"t-1"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if g.Status != "running" {
		t.Fatalf("want running, got %s", g.Status)
	}
	if g.Tasks[0].State != orchestrate.TaskState_Running || g.Tasks[0].RunID == "" {
		t.Fatalf("submit must schedule the first step: t-0 running with child run, got %+v", g.Tasks[0])
	}
	// approve on a non-gate task is a no-op (permissive), not an error:
	if err := ws.DagActionCommand(ctx, wshrpc.CommandDagActionData{ChannelId: ch.OID, RunId: run.ID, TaskId: "t-0", Action: "approve"}); err != nil {
		t.Fatalf("approve on non-gate must be a no-op: %v", err)
	}
	// gate flow: t-0 done -> running; gate (t-1) done -> awaiting-review; approve -> running
	if err := wstore.UpdateDag(ctx, g.ID, func(g *waveobj.TaskGroup) error {
		g.Tasks[0].State = orchestrate.TaskState_Done
		orchestrate.RecomputeDagStatus(g)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := wstore.UpdateDag(ctx, g.ID, func(g *waveobj.TaskGroup) error {
		g.Tasks[1].State = orchestrate.TaskState_Done
		orchestrate.RecomputeDagStatus(g)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	g2, err := ws.DagStatusCommand(ctx, wshrpc.CommandDagStatusData{ChannelId: ch.OID, RunId: run.ID})
	if err != nil {
		t.Fatal(err)
	}
	if g2.Status != "awaiting-review" {
		t.Fatalf("want awaiting-review, got %s", g2.Status)
	}
	if err := ws.DagActionCommand(ctx, wshrpc.CommandDagActionData{ChannelId: ch.OID, RunId: run.ID, TaskId: "t-1", Action: "approve"}); err != nil {
		t.Fatal(err)
	}
	g3, _ := ws.DagStatusCommand(ctx, wshrpc.CommandDagStatusData{ChannelId: ch.OID, RunId: run.ID})
	if g3.Status != "running" {
		t.Fatalf("want running after approve, got %s", g3.Status)
	}
	// cancel is terminal
	if err := ws.DagActionCommand(ctx, wshrpc.CommandDagActionData{ChannelId: ch.OID, RunId: run.ID, TaskId: "", Action: "cancel"}); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	g4, _ := ws.DagStatusCommand(ctx, wshrpc.CommandDagStatusData{ChannelId: ch.OID, RunId: run.ID})
	if g4.Status != "cancelled" {
		t.Fatalf("want cancelled, got %s", g4.Status)
	}
}
