// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestCreateRunFromPlanPath(t *testing.T) {
	ctx := context.Background()
	const plan = "# Coupon codes\n\n### Task 1: input\nadd the field\n\n### Task 2: totals\n**Depends on:** none\n"
	writePlan := func(t *testing.T, src string) string {
		t.Helper()
		path := filepath.Join(t.TempDir(), "plan.md")
		if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	newChannel := func(t *testing.T) *waveobj.Channel {
		t.Helper()
		ch, err := wstore.CreateChannel(ctx, "plan-start", t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		stubRunServer(t, "pi", nil)
		return ch
	}
	start := func(ch *waveobj.Channel, data wshrpc.CommandCreateRunData) (*wshrpc.CommandCreateRunRtnData, error) {
		data.ChannelId, data.WorkspaceId, data.Runtime = ch.OID, "ws", "pi"
		return (&WshServer{}).CreateRunCommand(ctx, data)
	}
	channelRuns := func(t *testing.T, ch *waveobj.Channel) []*waveobj.Run {
		t.Helper()
		runs, err := wstore.GetChannelRuns(ctx, ch.OID)
		if err != nil {
			t.Fatal(err)
		}
		return runs
	}

	t.Run("submits the plan at start, named by it, with no lead and no plan gate", func(t *testing.T) {
		ch := newChannel(t)
		planPath := writePlan(t, plan)
		rtn, err := start(ch, wshrpc.CommandCreateRunData{Mode: jarvis.RunMode_Orchestrator, PlanPath: planPath})
		if err != nil {
			t.Fatal(err)
		}
		run := rtn.Run
		if run.Goal != "Coupon codes" || run.Orchestration != jarvis.Orchestration_Engine {
			t.Fatalf("a plan start is an engine run named by its plan, goal %q orchestration %q", run.Goal, run.Orchestration)
		}
		if n := len(run.Phases[0].WorkerOrefs); n != 0 {
			t.Fatalf("a plan start spawns no lead, got %d workers", n)
		}
		if run.DagORef == "" {
			t.Fatal("the plan is submitted at start")
		}
		g, err := wstore.GetDag(ctx, run.DagORef)
		if err != nil {
			t.Fatal(err)
		}
		if g.PlanPath != planPath || len(g.Tasks) != 2 || orchestrate.PlanGatePending(g) {
			t.Fatalf("the dag is the plan, ungated: planpath %q, %d tasks, gated %v", g.PlanPath, len(g.Tasks), orchestrate.PlanGatePending(g))
		}
	})

	t.Run("a goal given with the plan names the run", func(t *testing.T) {
		ch := newChannel(t)
		rtn, err := start(ch, wshrpc.CommandCreateRunData{Mode: jarvis.RunMode_Orchestrator, Goal: "coupons, first cut", PlanPath: writePlan(t, plan)})
		if err != nil {
			t.Fatal(err)
		}
		if rtn.Run.Goal != "coupons, first cut" {
			t.Fatalf("goal = %q", rtn.Run.Goal)
		}
	})

	t.Run("a plan that cannot run is refused before a run exists", func(t *testing.T) {
		ch := newChannel(t)
		cases := []struct {
			name    string
			data    wshrpc.CommandCreateRunData
			errPart string
		}{
			{"unparseable plan", wshrpc.CommandCreateRunData{Mode: jarvis.RunMode_Orchestrator, PlanPath: writePlan(t, "just prose\n")}, "no tasks"},
			{"relative path", wshrpc.CommandCreateRunData{Mode: jarvis.RunMode_Orchestrator, PlanPath: "plan.md"}, "absolute"},
			{"quick shape", wshrpc.CommandCreateRunData{Mode: jarvis.RunMode_Quick, PlanPath: writePlan(t, plan)}, "orchestrator"},
			{"adaptive lead", wshrpc.CommandCreateRunData{Mode: jarvis.RunMode_Orchestrator, Orchestration: jarvis.Orchestration_Adaptive, PlanPath: writePlan(t, plan)}, "engine"},
		}
		for _, c := range cases {
			if _, err := start(ch, c.data); err == nil || !strings.Contains(err.Error(), c.errPart) {
				t.Fatalf("%s: error %v should name %q", c.name, err, c.errPart)
			}
		}
		if runs := channelRuns(t, ch); len(runs) != 0 {
			t.Fatalf("a refused plan leaves no run, got %d", len(runs))
		}
	})

	// the one submit-time refusal a parsed plan can still hit is the task cap; slice 5c deletes the cap, and
	// this case must then move to another refusal DagSubmitCommand still makes
	t.Run("a plan the engine refuses at submit cancels the run it started", func(t *testing.T) {
		ch := newChannel(t)
		var big strings.Builder
		for n := 1; n <= jarvis.MaxDagTasks+1; n++ {
			fmt.Fprintf(&big, "### Task %d: step %d\n**Depends on:** none\n\n", n, n)
		}
		_, err := start(ch, wshrpc.CommandCreateRunData{Mode: jarvis.RunMode_Orchestrator, PlanPath: writePlan(t, big.String())})
		if err == nil || !strings.Contains(err.Error(), "submitting plan") {
			t.Fatalf("want the submit refusal, got %v", err)
		}
		runs := channelRuns(t, ch)
		if len(runs) != 1 || runs[0].Status != jarvis.RunStatus_Cancelled {
			t.Fatalf("the started run is cancelled rather than left waiting for a dag, got %+v", runs)
		}
	})
}
