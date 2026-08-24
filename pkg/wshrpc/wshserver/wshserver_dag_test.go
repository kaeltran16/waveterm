// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestDagSubmitAndAction(t *testing.T) {
	ctx := context.Background()
	oldSpawn := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(ctx context.Context, cap runroute.Capability, workspaceId, projectName, cwd, prompt string) (string, error) {
		tabId := uuid.NewString()
		blockId := uuid.NewString()
		tab := &waveobj.Tab{OID: tabId, BlockIds: []string{blockId}}
		_ = wstore.DBInsert(ctx, tab)
		block := &waveobj.Block{OID: blockId, ParentORef: "tab:" + tabId}
		_ = wstore.DBInsert(ctx, block)
		return "tab:" + tabId, nil
	}
	defer func() { jarvis.SpawnRunWorker = oldSpawn }()
	ch, err := wstore.CreateChannel(ctx, "dag-test", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("do the thing", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	run.Status = jarvis.RunStatus_Planning
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
	cancelledOwner, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if cancelledOwner.Status != jarvis.RunStatus_Cancelled {
		t.Fatalf("owner status = %q, want cancelled", cancelledOwner.Status)
	}
	for _, task := range g4.Tasks {
		if task.RunID == "" {
			continue
		}
		child, err := wstore.GetRun(ctx, ch.OID, task.RunID)
		if err != nil {
			t.Fatal(err)
		}
		if child.Status != jarvis.RunStatus_Cancelled {
			t.Fatalf("child %s status = %q, want cancelled", child.ID, child.Status)
		}
		for _, phase := range child.Phases {
			for _, workerORef := range phase.WorkerOrefs {
				tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, strings.TrimPrefix(workerORef, "tab:"))
				if err != nil {
					t.Fatal(err)
				}
				for _, blockID := range tab.BlockIds {
					block, err := wstore.DBMustGet[*waveobj.Block](ctx, blockID)
					if err != nil {
						t.Fatal(err)
					}
					if block.Meta[waveobj.MetaKey_CmdRunOnStart] != false {
						t.Fatalf("worker block %s runonstart = %#v, want false", blockID, block.Meta[waveobj.MetaKey_CmdRunOnStart])
					}
				}
			}
		}
	}
}

func TestDagSubmitDeferredRun(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "dag-deferred", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	stubRunServer(t, "pi", nil)
	ws := &WshServer{}
	rtn, err := ws.CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws", Goal: "test", Runtime: "pi", Tier: "capable",
		Mode: jarvis.RunMode_Orchestrator, DeferStart: true,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	g, err := ws.DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{
		ChannelId: ch.OID, RunId: rtn.Run.ID, Title: "g", Parallelism: 1,
		Tasks: []waveobj.TaskNode{{ID: "t-1", Label: "one"}},
	})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	got, err := wstore.GetRun(ctx, ch.OID, rtn.Run.ID)
	if err != nil {
		t.Fatalf("get run: %v", err)
	}
	if got.Status != "executing" {
		t.Fatalf("want executing, got %s", got.Status)
	}
	if got.DagORef != g.OID {
		t.Fatalf("dagoref not linked")
	}
	wantEvents := []string{waveobj.RunEventKindCreated, waveobj.RunEventKindPhaseStarted + "@0", waveobj.RunEventKindTaskSpawned}
	if gotEvents := mustSeq(t, ch.OID, rtn.Run.ID); !reflect.DeepEqual(gotEvents, wantEvents) {
		t.Fatalf("deferred lifecycle events = %v, want %v", gotEvents, wantEvents)
	}
	retry, err := ws.DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{
		ChannelId: ch.OID, RunId: rtn.Run.ID, Title: "g", Parallelism: 1,
		Tasks: []waveobj.TaskNode{{ID: "t-1", Label: "one"}},
	})
	if err != nil {
		t.Fatalf("identical retry: %v", err)
	}
	if retry.OID != g.OID {
		t.Fatalf("identical retry dag = %q, want %q", retry.OID, g.OID)
	}
	if gotEvents := mustSeq(t, ch.OID, rtn.Run.ID); !reflect.DeepEqual(gotEvents, wantEvents) {
		t.Fatalf("identical retry lifecycle events = %v, want unchanged %v", gotEvents, wantEvents)
	}
	if _, err := ws.DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{
		ChannelId: ch.OID, RunId: rtn.Run.ID, Title: "second", Parallelism: 1,
		Tasks: []waveobj.TaskNode{{ID: "t-2", Label: "two"}},
	}); err == nil {
		t.Fatalf("second different submit must be rejected")
	}
	if gotEvents := mustSeq(t, ch.OID, rtn.Run.ID); !reflect.DeepEqual(gotEvents, wantEvents) {
		t.Fatalf("repeated submit lifecycle events = %v, want unchanged %v", gotEvents, wantEvents)
	}
}

func TestDagSubmitRejectsEngineStateAndLimitsBeforePersistence(t *testing.T) {
	nineTasks := make([]waveobj.TaskNode, 9)
	for i := range nineTasks {
		nineTasks[i] = waveobj.TaskNode{ID: fmt.Sprintf("t-%d", i), Label: "task"}
	}
	cases := []struct {
		name        string
		title       string
		parallelism int
		tasks       []waveobj.TaskNode
	}{
		{name: "state", title: "g", parallelism: 1, tasks: []waveobj.TaskNode{{ID: "t", Label: "a", State: "running"}}},
		{name: "runid", title: "g", parallelism: 1, tasks: []waveobj.TaskNode{{ID: "t", Label: "a", RunID: "child"}}},
		{name: "released", title: "g", parallelism: 1, tasks: []waveobj.TaskNode{{ID: "t", Label: "a", Released: true}}},
		{name: "lastactivity", title: "g", parallelism: 1, tasks: []waveobj.TaskNode{{ID: "t", Label: "a", LastActivity: 1}}},
		{name: "too-many-tasks", title: "g", parallelism: 1, tasks: nineTasks},
		{name: "zero-parallelism", title: "g", parallelism: 0, tasks: []waveobj.TaskNode{{ID: "t", Label: "a"}}},
		{name: "excess-parallelism", title: "g", parallelism: 9, tasks: []waveobj.TaskNode{{ID: "t", Label: "a"}}},
	}
	oldValidate := validateHarness
	validateHarness = func(runtime string, _ harness.Operation) (harness.Spec, error) {
		spec, ok := harness.Lookup(runtime)
		if !ok {
			return harness.Spec{}, fmt.Errorf("unknown harness %q", runtime)
		}
		return spec, nil
	}
	t.Cleanup(func() { validateHarness = oldValidate })
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			ch, err := wstore.CreateChannel(ctx, "dag-invalid-"+tc.name, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			owner := jarvis.NewRun("owner", "ws", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
			owner.Status = jarvis.RunStatus_Planning
			owner.Runtime = "claude"
			owner.Tier = "capable"
			if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
				t.Fatal(err)
			}
			if _, err := (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{
				ChannelId: ch.OID, RunId: owner.ID, Title: tc.title, Parallelism: tc.parallelism, Tasks: tc.tasks,
			}); err == nil {
				t.Fatal("want submit validation error")
			}
			got, err := wstore.GetRun(ctx, ch.OID, owner.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.DagORef != "" || got.Status != jarvis.RunStatus_Planning {
				t.Fatalf("invalid submit mutated owner: %+v", got)
			}
		})
	}
}

func TestDagSubmitRejectsInvalidTaskRoutesBeforePersistence(t *testing.T) {
	cases := []struct {
		name        string
		task        waveobj.TaskNode
		unavailable bool
	}{
		{name: "runtime-only", task: waveobj.TaskNode{ID: "t", Label: "a", RunSpec: waveobj.RunSpec{Runtime: "pi"}}},
		{name: "tier-only", task: waveobj.TaskNode{ID: "t", Label: "a", RunSpec: waveobj.RunSpec{Tier: "cheap"}}},
		{name: "unknown-runtime", task: waveobj.TaskNode{ID: "t", Label: "a", RunSpec: waveobj.RunSpec{Runtime: "missing", Tier: "capable"}}},
		{name: "unknown-tier", task: waveobj.TaskNode{ID: "t", Label: "a", RunSpec: waveobj.RunSpec{Runtime: "pi", Tier: "missing"}}},
		{name: "unsupported-pair", task: waveobj.TaskNode{ID: "t", Label: "a", RunSpec: waveobj.RunSpec{Runtime: "codex", Tier: "cheap"}}},
		{name: "unavailable", task: waveobj.TaskNode{ID: "t", Label: "a", RunSpec: waveobj.RunSpec{Runtime: "pi", Tier: "cheap"}}, unavailable: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			ch, err := wstore.CreateChannel(ctx, "dag-route-"+tc.name, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
			owner.Runtime = "claude"
			owner.Tier = "capable"
			if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
				t.Fatal(err)
			}
			oldValidate := validateHarness
			validateHarness = func(runtime string, op harness.Operation) (harness.Spec, error) {
				if tc.unavailable && runtime == "pi" {
					return harness.Spec{}, fmt.Errorf("harness %q unavailable", runtime)
				}
				spec, ok := harness.Lookup(runtime)
				if !ok {
					return harness.Spec{}, fmt.Errorf("unknown harness %q", runtime)
				}
				return spec, nil
			}
			t.Cleanup(func() { validateHarness = oldValidate })
			runningBefore, err := wstore.GetDagsByStatus(ctx, orchestrate.DagStatus_Running)
			if err != nil {
				t.Fatal(err)
			}
			spawned := 0
			oldSpawn := jarvis.SpawnRunWorker
			jarvis.SpawnRunWorker = func(context.Context, runroute.Capability, string, string, string, string) (string, error) {
				spawned++
				return "tab:worker", nil
			}
			t.Cleanup(func() { jarvis.SpawnRunWorker = oldSpawn })

			ws := &WshServer{}
			if _, err := ws.DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{
				ChannelId: ch.OID, RunId: owner.ID, Title: "g", Parallelism: 1, Tasks: []waveobj.TaskNode{tc.task},
			}); err == nil {
				t.Fatal("invalid route must be rejected")
			}
			got, err := wstore.GetRun(ctx, ch.OID, owner.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.DagORef != "" {
				t.Fatalf("owner dagoref changed after rejected submit: %q", got.DagORef)
			}
			if spawned != 0 {
				t.Fatalf("rejected submit spawned %d workers", spawned)
			}
			runningAfter, err := wstore.GetDagsByStatus(ctx, orchestrate.DagStatus_Running)
			if err != nil {
				t.Fatal(err)
			}
			if len(runningAfter) != len(runningBefore) {
				t.Fatalf("running dag count changed from %d to %d", len(runningBefore), len(runningAfter))
			}
		})
	}
}

func TestDagSubmitAcceptsPinnedAndInheritedRoutes(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "dag-route-valid", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	owner.Runtime = "claude"
	owner.Tier = "mid"
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	oldValidate := validateHarness
	validateHarness = func(runtime string, op harness.Operation) (harness.Spec, error) {
		spec, ok := harness.Lookup(runtime)
		if !ok {
			return harness.Spec{}, fmt.Errorf("unknown harness %q", runtime)
		}
		return spec, nil
	}
	t.Cleanup(func() { validateHarness = oldValidate })
	oldSpawn := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(ctx context.Context, cap runroute.Capability, workspaceId, projectName, cwd, prompt string) (string, error) {
		tabId := uuid.NewString()
		blockId := uuid.NewString()
		tab := &waveobj.Tab{OID: tabId, BlockIds: []string{blockId}}
		_ = wstore.DBInsert(ctx, tab)
		block := &waveobj.Block{OID: blockId, ParentORef: "tab:" + tabId}
		_ = wstore.DBInsert(ctx, block)
		return "tab:" + tabId, nil
	}
	t.Cleanup(func() { jarvis.SpawnRunWorker = oldSpawn })

	owner.Status = jarvis.RunStatus_Planning
	if err := wstore.UpdateRun(ctx, ch.OID, owner.ID, func(r *waveobj.Run) error { r.Status = jarvis.RunStatus_Planning; return nil }); err != nil {
		t.Fatal(err)
	}
	g, err := (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{
		ChannelId: ch.OID, RunId: owner.ID, Title: "g", Parallelism: 1,
		Tasks: []waveobj.TaskNode{
			{ID: "pinned", Label: "pinned", RunSpec: waveobj.RunSpec{Runtime: "pi", Tier: "cheap"}},
			{ID: "inherited", Label: "inherited"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if g.OID == "" {
		t.Fatal("valid submit must persist a dag")
	}
}
