// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// dagAskFixture and the dag tests build owner runs with a dag and no lead worker. Their judgment events now
// launch a lead, and the real launch runs on a goroutine that outlives the test.
func init() {
	orchestrate.SetLaunchLeadForTest(func(context.Context, string, string, string) {})
}

func planLeadRun(t *testing.T, state string) (*waveobj.Channel, waveobj.Run) {
	t.Helper()
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "plan-lead", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	run := jarvis.NewRun("ship coupons", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	run.Runtime = "pi"
	run.Phases[0].State = state
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatal(err)
	}
	return ch, run
}

func TestLaunchPlanLeadStartsTheLeadWithTheGivenPrompt(t *testing.T) {
	ctx := context.Background()
	ch, run := planLeadRun(t, jarvis.PhaseState_Running)
	stubRunServer(t, "pi", nil)
	var prompt string
	var keep bool
	stubbed := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(_ context.Context, _ runroute.Capability, _, _, _, p string, opts jarvis.RunWorkerOptions) (string, error) {
		prompt, keep = p, opts.KeepOnExit
		return waveobj.MakeORef(waveobj.OType_Tab, "lead-tab").String(), nil
	}
	t.Cleanup(func() { jarvis.SpawnRunWorker = stubbed })

	if err := LaunchPlanLead(ctx, ch.OID, run.ID, "the rules, then the wake"); err != nil {
		t.Fatal(err)
	}

	if prompt != "the rules, then the wake" || !keep {
		t.Fatalf("the lead starts on the given prompt and outlives its process, prompt=%q keeponexit=%v", prompt, keep)
	}
	got, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if leadORef(got) != "tab:lead-tab" {
		t.Fatalf("the lead's tab is attached to the run, got %q", leadORef(got))
	}
}

func TestLaunchPlanLeadRefusesARunWithNoPhaseToStart(t *testing.T) {
	ch, run := planLeadRun(t, jarvis.PhaseState_Done)
	stubRunServer(t, "pi", nil)

	err := LaunchPlanLead(context.Background(), ch.OID, run.ID, "the rules")
	if err == nil || !strings.Contains(err.Error(), "no running phase") {
		t.Fatalf("a run with nothing running cannot take a lead, got %v", err)
	}
}
