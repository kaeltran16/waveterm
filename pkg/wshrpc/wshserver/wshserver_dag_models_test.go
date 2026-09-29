// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
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

// stubModelSubmit makes every known harness installed and every spawn a fresh tab, so a submit can dispatch.
func stubModelSubmit(t *testing.T) {
	t.Helper()
	oldValidate := validateHarness
	validateHarness = func(runtime string, _ harness.Operation) (harness.Spec, error) {
		spec, ok := harness.Lookup(runtime)
		if !ok {
			return harness.Spec{}, fmt.Errorf("unknown harness %q", runtime)
		}
		return spec, nil
	}
	t.Cleanup(func() { validateHarness = oldValidate })
	t.Cleanup(orchestrate.SetValidateWorkerHarnessForTest(func(string) error { return nil }))
	oldSpawn := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(ctx context.Context, _ runroute.Capability, _, _, _, _ string, _ jarvis.RunWorkerOptions) (string, error) {
		tabId, blockId := uuid.NewString(), uuid.NewString()
		_ = wstore.DBInsert(ctx, &waveobj.Tab{OID: tabId, BlockIds: []string{blockId}})
		_ = wstore.DBInsert(ctx, &waveobj.Block{OID: blockId, ParentORef: "tab:" + tabId})
		return "tab:" + tabId, nil
	}
	t.Cleanup(func() { jarvis.SpawnRunWorker = oldSpawn })
}

// seedModelRun stores a planning orchestrator run on claude that edit may change first.
func seedModelRun(t *testing.T, edit func(run *waveobj.Run)) (context.Context, string, string) {
	t.Helper()
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "dag-models", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	run := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(), 1)
	run.Status = jarvis.RunStatus_Planning
	run.Runtime = "claude"
	if edit != nil {
		edit(&run)
	}
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatal(err)
	}
	return ctx, ch.OID, run.ID
}

func writeModelPlan(t *testing.T, src string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "plan.md")
	if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDagSubmitCarriesReviewerSettings(t *testing.T) {
	stubModelSubmit(t)
	tasks := []waveobj.TaskNode{{ID: "t-1", Label: "a"}}

	t.Run("the run's reviewer picks and reviewer route go onto the group", func(t *testing.T) {
		route := &waveobj.RoutePin{Runtime: "claude", Model: "haiku"}
		ctx, channelId, runId := seedModelRun(t, func(run *waveobj.Run) {
			run.ReviewerPicks = true
			run.ReviewerRoute = route
		})
		g, err := (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{ChannelId: channelId, RunId: runId, Title: "g", Parallelism: 1, Tasks: tasks})
		if err != nil {
			t.Fatal(err)
		}
		if !g.ReviewerPicks || g.ReviewerRoute == nil || *g.ReviewerRoute != *route {
			t.Fatalf("group reviewerpicks %v, reviewerroute %+v", g.ReviewerPicks, g.ReviewerRoute)
		}
	})

	t.Run("a run with neither leaves the group as today", func(t *testing.T) {
		ctx, channelId, runId := seedModelRun(t, nil)
		g, err := (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{ChannelId: channelId, RunId: runId, Title: "g", Parallelism: 1, Tasks: tasks})
		if err != nil {
			t.Fatal(err)
		}
		if g.ReviewerPicks || g.ReviewerRoute != nil {
			t.Fatalf("group reviewerpicks %v, reviewerroute %+v", g.ReviewerPicks, g.ReviewerRoute)
		}
	})

	t.Run("a worker route on a Reviewer picks run is refused", func(t *testing.T) {
		ctx, channelId, runId := seedModelRun(t, func(run *waveobj.Run) { run.ReviewerPicks = true })
		_, err := (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{
			ChannelId: channelId, RunId: runId, Title: "g", Parallelism: 1, Tasks: tasks,
			WorkerRoute: &waveobj.RoutePin{Runtime: "claude", Model: "sonnet"},
		})
		if err == nil || !strings.Contains(err.Error(), "Reviewer picks") || !strings.Contains(err.Error(), "worker route") {
			t.Fatalf("err = %v, want one naming Reviewer picks and the worker route", err)
		}
		run, err := wstore.GetRun(ctx, channelId, runId)
		if err != nil {
			t.Fatal(err)
		}
		if run.DagORef != "" {
			t.Fatalf("a refused submit stored a dag: %q", run.DagORef)
		}
	})
}

func TestDagSubmitRefusesUnrunnableModelLine(t *testing.T) {
	stubModelSubmit(t)
	plan := writeModelPlan(t, "# Models\n\n### Task 1: input\nadd the field\n\n### Task 2: totals\n**Model:** no-such-model\nsum them\n")
	for _, picks := range []bool{false, true} {
		t.Run(fmt.Sprintf("reviewer picks %v", picks), func(t *testing.T) {
			ctx, channelId, runId := seedModelRun(t, func(run *waveobj.Run) { run.ReviewerPicks = picks })
			_, err := (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{ChannelId: channelId, RunId: runId, PlanPath: plan})
			if err == nil || !strings.Contains(err.Error(), `task "t-2"`) || !strings.Contains(err.Error(), "no-such-model") {
				t.Fatalf("err = %v, want one naming t-2 and its model", err)
			}
			run, err := wstore.GetRun(ctx, channelId, runId)
			if err != nil {
				t.Fatal(err)
			}
			if run.DagORef != "" {
				t.Fatalf("a refused submit stored a dag: %q", run.DagORef)
			}
		})
	}
}

func TestDagPlanPreviewTasks(t *testing.T) {
	// Task 2 runs after Task 1 in its lane; Task 3 forks off on its own
	src := "# Fork\n\n### Task 1: input\nadd the field\n\n### Task 2: totals\n**Model:** sonnet\nsum them\n\n### Task 3: docs\n**Depends on:** none\nwrite it up\n"
	got, err := (&WshServer{}).DagPlanPreviewCommand(context.Background(), wshrpc.CommandDagPlanPreviewData{PlanPath: writeModelPlan(t, src)})
	if err != nil {
		t.Fatal(err)
	}
	want := []wshrpc.DagPlanPreviewTask{
		{Id: "t-1", Title: "input", Lane: 1},
		{Id: "t-2", Title: "totals", Lane: 1, Deps: []string{"t-1"}, Model: "sonnet"},
		{Id: "t-3", Title: "docs", Lane: 2},
	}
	if !reflect.DeepEqual(got.Tasks, want) {
		t.Fatalf("preview tasks = %+v, want %+v", got.Tasks, want)
	}
}
