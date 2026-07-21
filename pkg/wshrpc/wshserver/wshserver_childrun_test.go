// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestCreateChildRunCommand_InheritsAndStampsParent(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "backlog", "/repo")
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	parent := jarvis.NewRun("work the backlog", "ws-1", "/repo",
		waveobj.PrincipleList{{ID: "clean", Text: "be clean"}},
		jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(true), 1)
	leadORef := waveobj.MakeORef(waveobj.OType_Tab, "leadtab").String()
	parent.Phases[0].WorkerOrefs = []string{leadORef}
	if err := wstore.AppendRun(ctx, ch.OID, parent); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}

	origSpawn := jarvis.SpawnClaudeWorker
	jarvis.SpawnClaudeWorker = func(_ context.Context, _, _, _, _ string) (string, error) {
		return waveobj.MakeORef(waveobj.OType_Tab, "childtab").String(), nil
	}
	defer func() { jarvis.SpawnClaudeWorker = origSpawn }()

	ws := &WshServer{}
	rtn, err := ws.CreateChildRunCommand(ctx, wshrpc.CommandCreateChildRunData{ORef: leadORef, Goal: "fix issue 6a"})
	if err != nil {
		t.Fatalf("CreateChildRunCommand: %v", err)
	}
	child, err := wstore.GetRun(ctx, ch.OID, rtn.RunId)
	if err != nil {
		t.Fatalf("GetRun(child): %v", err)
	}
	if child.ParentLeadORef != leadORef {
		t.Errorf("ParentLeadORef = %q, want %q", child.ParentLeadORef, leadORef)
	}
	if child.Goal != "fix issue 6a" {
		t.Errorf("Goal = %q", child.Goal)
	}
	if child.ProjectPath != "/repo" || child.WorkspaceId != "ws-1" {
		t.Errorf("child did not inherit project/workspace: proj=%q ws=%q", child.ProjectPath, child.WorkspaceId)
	}
	if len(child.Principles) != 1 {
		t.Errorf("child did not inherit principles: %+v", child.Principles)
	}
	if child.Mode != jarvis.RunMode_Orchestrator {
		t.Errorf("child Mode = %q, want inherited orchestrator", child.Mode)
	}
	for i, p := range child.Phases {
		if p.Gate {
			t.Errorf("child phase %d is gated; child runs must be hands-off", i)
		}
	}
}

func TestCreateChildRunCommand_UnresolvedOrefFails(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	if _, err := ws.CreateChildRunCommand(ctx, wshrpc.CommandCreateChildRunData{ORef: "tab:nope", Goal: "x"}); err == nil {
		t.Fatal("want an error when the oref resolves to no run")
	}
}

func TestChildDoneNotifiesParentLead(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "notify-done", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	leadORef := waveobj.MakeORef(waveobj.OType_Tab, "leadtab").String()
	child := jarvis.NewRun("fix 6a", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	child.ParentLeadORef = leadORef
	if err := wstore.AppendRun(ctx, ch.OID, child); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}

	origSpawn := jarvis.SpawnClaudeWorker
	jarvis.SpawnClaudeWorker = func(_ context.Context, _, _, _, _ string) (string, error) {
		return waveobj.MakeORef(waveobj.OType_Tab, "x").String(), nil
	}
	defer func() { jarvis.SpawnClaudeWorker = origSpawn }()

	var gotORef, gotLine string
	origSteer := steerRunLead
	steerRunLead = func(_ context.Context, oref, text string) { gotORef, gotLine = oref, text }
	defer func() { steerRunLead = origSteer }()

	ws := &WshServer{}
	if err := ws.AdvanceRunCommand(ctx, wshrpc.CommandAdvanceRunData{
		ChannelId: ch.OID, RunId: child.ID, PhaseIdx: 0, Action: jarvis.RunAction_Complete,
	}); err != nil {
		t.Fatalf("AdvanceRunCommand: %v", err)
	}
	if gotORef != leadORef {
		t.Errorf("notified oref = %q, want %q", gotORef, leadORef)
	}
	if want := "-> done"; !strings.Contains(gotLine, want) {
		t.Errorf("notify line %q missing %q", gotLine, want)
	}
}

func TestChildCancelNotifiesParentLead(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "notify-cancel", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	leadORef := waveobj.MakeORef(waveobj.OType_Tab, "leadtab").String()
	child := jarvis.NewRun("fix 6b", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	child.ParentLeadORef = leadORef
	if err := wstore.AppendRun(ctx, ch.OID, child); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}

	var gotORef, gotLine string
	origSteer := steerRunLead
	steerRunLead = func(_ context.Context, oref, text string) { gotORef, gotLine = oref, text }
	defer func() { steerRunLead = origSteer }()

	ws := &WshServer{}
	if err := ws.CancelRunCommand(ctx, wshrpc.CommandCancelRunData{ChannelId: ch.OID, RunId: child.ID}); err != nil {
		t.Fatalf("CancelRunCommand: %v", err)
	}
	if gotORef != leadORef || !strings.Contains(gotLine, "-> cancelled") {
		t.Errorf("cancel notify: oref=%q line=%q", gotORef, gotLine)
	}
}

func TestParentlessRunDoesNotNotify(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "no-parent", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("solo", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}
	origSpawn := jarvis.SpawnClaudeWorker
	jarvis.SpawnClaudeWorker = func(_ context.Context, _, _, _, _ string) (string, error) {
		return waveobj.MakeORef(waveobj.OType_Tab, "x").String(), nil
	}
	defer func() { jarvis.SpawnClaudeWorker = origSpawn }()

	called := false
	origSteer := steerRunLead
	steerRunLead = func(_ context.Context, _, _ string) { called = true }
	defer func() { steerRunLead = origSteer }()

	ws := &WshServer{}
	if err := ws.AdvanceRunCommand(ctx, wshrpc.CommandAdvanceRunData{
		ChannelId: ch.OID, RunId: run.ID, PhaseIdx: 0, Action: jarvis.RunAction_Complete,
	}); err != nil {
		t.Fatalf("AdvanceRunCommand: %v", err)
	}
	if called {
		t.Error("steerRunLead must not fire for a run with no ParentLeadORef")
	}
}
