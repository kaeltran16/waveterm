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

	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
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
		if g.PlanPath != planPath || len(g.Tasks) != 2 {
			t.Fatalf("the dag is the plan: planpath %q, %d tasks", g.PlanPath, len(g.Tasks))
		}
	})

	t.Run("a relative plan path is read from the channel's project and kept absolute", func(t *testing.T) {
		ch := newChannel(t)
		planPath := filepath.Join(ch.ProjectPath, "docs", "plan.md")
		if err := os.MkdirAll(filepath.Dir(planPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(planPath, []byte(plan), 0o644); err != nil {
			t.Fatal(err)
		}
		rtn, err := start(ch, wshrpc.CommandCreateRunData{Mode: jarvis.RunMode_Orchestrator, PlanPath: "docs/plan.md"})
		if err != nil {
			t.Fatal(err)
		}
		g, err := wstore.GetDag(ctx, rtn.Run.DagORef)
		if err != nil {
			t.Fatal(err)
		}
		// workers and the landing fold read this from their own cwd, so the dag must not keep it relative
		if g.PlanPath != planPath {
			t.Fatalf("dag planpath = %q, want %q", g.PlanPath, planPath)
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
			{"relative path missing from the project", wshrpc.CommandCreateRunData{Mode: jarvis.RunMode_Orchestrator, PlanPath: "missing.md"}, "missing.md"},
			{"quick shape", wshrpc.CommandCreateRunData{Mode: jarvis.RunMode_Quick, PlanPath: writePlan(t, plan)}, "orchestrator"},
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

	// The refusals above all happen before anything persists. This is the other half: the plan parses, the
	// run is created, and the engine then refuses the submission. A run with no dag and no lead would wait
	// in planning forever, so CreateRun has to take it back down.
	//
	// The refusal is staged through the harness seam because that is where create and submit genuinely
	// differ: CreateRun validates the lead's own route, then DagSubmit validates every task's pin. Failing
	// the pin — and only once a run exists to fail it against — is a refusal that can land no earlier.
	t.Run("a submit the engine refuses cancels the run it started", func(t *testing.T) {
		ch := newChannel(t)
		oldValidate := validateHarness
		validateHarness = func(runtime string, op harness.Operation) (harness.Spec, error) {
			runs, err := wstore.GetChannelRuns(ctx, ch.OID)
			if err != nil {
				t.Fatalf("GetChannelRuns: %v", err)
			}
			if len(runs) > 0 {
				return harness.Spec{}, fmt.Errorf("harness %q cannot run workers here", runtime)
			}
			spec, _ := harness.Lookup(runtime)
			return spec, nil
		}
		t.Cleanup(func() { validateHarness = oldValidate })

		if _, err := start(ch, wshrpc.CommandCreateRunData{Mode: jarvis.RunMode_Orchestrator, PlanPath: writePlan(t, plan)}); err == nil {
			t.Fatal("the engine refused the submission; the start must report it")
		} else if !strings.Contains(err.Error(), "submitting plan") {
			t.Fatalf("error %v should name the submission it failed", err)
		}
		runs := channelRuns(t, ch)
		if len(runs) != 1 {
			t.Fatalf("the run was created before the refusal, so it must still be on record: got %d", len(runs))
		}
		if runs[0].Status != jarvis.RunStatus_Cancelled {
			t.Fatalf("status = %q, want the run cancelled rather than waiting in planning forever", runs[0].Status)
		}
		if runs[0].DagORef != "" {
			t.Fatalf("a refused submission links no dag, got %q", runs[0].DagORef)
		}
	})
}
