// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func gatedRun(t *testing.T, name string) (context.Context, *WshServer, *waveobj.Channel, waveobj.Run) {
	t.Helper()
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, name, t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("do the thing", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	run.Status = jarvis.RunStatus_Planning
	// a route the stub server will actually spawn on, so an approved plan dispatches instead of
	// blocking on a rejected capability — the tests below are about the gate, not about routing
	run.Runtime, run.Tier = "pi", "capable"
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}
	stubRunServer(t, "pi", nil)
	return ctx, &WshServer{}, ch, run
}

// Sending a plan back discards it: the run must be free to accept a revised submission, which
// CreateDagForRun only allows while the run holds no dag. The notes reach the lead through the run.
func TestSendBackPlanDiscardsItAndAcceptsARedraft(t *testing.T) {
	ctx, ws, ch, run := gatedRun(t, "plangate-sendback")
	first, err := ws.DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{
		ChannelId: ch.OID, RunId: run.ID, Title: "draft one", Parallelism: 1,
		Tasks: []waveobj.TaskNode{{ID: "t-0", Label: "one"}},
	})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}

	if err := ws.DagActionCommand(ctx, wshrpc.CommandDagActionData{
		ChannelId: ch.OID, RunId: run.ID, Action: "sendback-plan", Notes: "split t-0 in two",
	}); err != nil {
		t.Fatalf("sendback-plan: %v", err)
	}

	after, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.DagORef != "" {
		t.Fatalf("dag still linked after send back: %q", after.DagORef)
	}
	if after.PlanFeedback != "split t-0 in two" {
		t.Fatalf("plan feedback = %q", after.PlanFeedback)
	}
	if after.Status != jarvis.RunStatus_Planning {
		t.Fatalf("run status = %q, want planning", after.Status)
	}
	if _, err := wstore.GetDag(ctx, first.OID); err == nil {
		t.Fatal("the discarded group must be gone")
	}

	// the lead polls here, and needs the reason rather than "run has no dag"
	status, err := ws.DagStatusCommand(ctx, wshrpc.CommandDagStatusData{ChannelId: ch.OID, RunId: run.ID})
	if err != nil {
		t.Fatalf("status after send back: %v", err)
	}
	if status.Group != nil || status.PlanFeedback != "split t-0 in two" {
		t.Fatalf("status = %+v, want no group and the feedback", status)
	}

	// a *different* plan is now accepted — the one-dag-per-run invariant only binds a plan that ran
	second, err := ws.DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{
		ChannelId: ch.OID, RunId: run.ID, Title: "draft two", Parallelism: 1,
		Tasks: []waveobj.TaskNode{{ID: "t-0", Label: "one"}, {ID: "t-1", Label: "two"}},
	})
	if err != nil {
		t.Fatalf("redraft must be accepted: %v", err)
	}
	if second.OID == first.OID || len(second.Tasks) != 2 {
		t.Fatalf("redraft = %s with %d tasks", second.OID, len(second.Tasks))
	}
	redrafted, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if redrafted.PlanFeedback != "" {
		t.Fatalf("the redraft answers the notes; they must not survive it: %q", redrafted.PlanFeedback)
	}
}

// Once the engine owns a plan there are child runs and worktrees behind it, so "send the plan back"
// stops being available — the recovery there is a per-task action.
func TestSendBackPlanRefusedPastTheGate(t *testing.T) {
	ctx, ws, ch, run := gatedRun(t, "plangate-past")
	if _, err := ws.DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{
		ChannelId: ch.OID, RunId: run.ID, Title: "t", Parallelism: 1,
		Tasks: []waveobj.TaskNode{{ID: "t-0", Label: "one"}},
	}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	if err := ws.DagActionCommand(ctx, wshrpc.CommandDagActionData{ChannelId: ch.OID, RunId: run.ID, Action: "approve-plan"}); err != nil {
		t.Fatalf("approve-plan: %v", err)
	}
	err := ws.DagActionCommand(ctx, wshrpc.CommandDagActionData{ChannelId: ch.OID, RunId: run.ID, Action: "sendback-plan"})
	if err == nil || !strings.Contains(err.Error(), "not waiting at a plan gate") {
		t.Fatalf("err = %v, want a not-at-a-gate refusal", err)
	}
}

// A second approval races the modal against the gate card; it must be a no-op, not an error.
func TestApprovePlanIsIdempotent(t *testing.T) {
	ctx, ws, ch, run := gatedRun(t, "plangate-idempotent")
	if _, err := ws.DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{
		ChannelId: ch.OID, RunId: run.ID, Title: "t", Parallelism: 1,
		Tasks: []waveobj.TaskNode{{ID: "t-0", Label: "one"}},
	}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	for i := 0; i < 2; i++ {
		if err := ws.DagActionCommand(ctx, wshrpc.CommandDagActionData{ChannelId: ch.OID, RunId: run.ID, Action: "approve-plan"}); err != nil {
			t.Fatalf("approve %d: %v", i, err)
		}
	}
	rtn, err := ws.DagStatusCommand(ctx, wshrpc.CommandDagStatusData{ChannelId: ch.OID, RunId: run.ID})
	if err != nil {
		t.Fatal(err)
	}
	if rtn.Group.Status != orchestrate.DagStatus_Running {
		t.Fatalf("status = %q, want running", rtn.Group.Status)
	}
}

// A child's decomposition is not gated: its parent's plan already was, and a child that halted for
// review would strand a fan-out nobody is watching.
func TestChildPlanIsNotGated(t *testing.T) {
	ctx, ws, ch, _ := gatedRun(t, "plangate-child")
	child := jarvis.NewRun("child goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	child.Status = jarvis.RunStatus_Planning
	child.ParentLeadORef = "tab:" + waveobj.MakeORef(waveobj.OType_Tab, "00000000-0000-0000-0000-000000000001").OID
	if err := wstore.AppendRun(ctx, ch.OID, child); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}
	g, err := ws.DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{
		ChannelId: ch.OID, RunId: child.ID, Title: "t", Parallelism: 1,
		Tasks: []waveobj.TaskNode{{ID: "t-0", Label: "one"}},
	})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if g.PlanGate || g.Status == orchestrate.DagStatus_AwaitingPlan {
		t.Fatalf("child plan must not be gated: plangate=%v status=%q", g.PlanGate, g.Status)
	}
}
