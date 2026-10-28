// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
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

type designSpawn struct {
	oref, blockId, prompt string
	opts                  jarvis.RunWorkerOptions
}

// stubDesignSpawn records every spawn on top of stubRunServer, each a real tab with a block, as the design
// session is found by its block.
func stubDesignSpawn(t *testing.T) *[]designSpawn {
	t.Helper()
	stubRunServer(t, "pi", nil)
	var spawns []designSpawn
	old := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(ctx context.Context, _ runroute.Capability, _, _, _, prompt string, opts jarvis.RunWorkerOptions) (string, error) {
		tab := &waveobj.Tab{OID: uuid.NewString(), BlockIds: []string{uuid.NewString()}}
		if err := wstore.DBInsert(ctx, tab); err != nil {
			return "", err
		}
		oref := waveobj.MakeORef(waveobj.OType_Tab, tab.OID).String()
		spawns = append(spawns, designSpawn{oref: oref, blockId: tab.BlockIds[0], prompt: prompt, opts: opts})
		return oref, nil
	}
	t.Cleanup(func() { jarvis.SpawnRunWorker = old })
	return &spawns
}

func designChannel(t *testing.T, name string) *waveobj.Channel {
	t.Helper()
	// not a git project, so an orchestrator launch cuts no landing tree
	ch, err := wstore.CreateChannel(context.Background(), name, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return ch
}

func createDesignFirstRun(t *testing.T, ch *waveobj.Channel, kind string) *waveobj.Run {
	t.Helper()
	asking := false
	rtn, err := (&WshServer{}).CreateRunCommand(context.Background(), wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws", Goal: "Ship the auth flow", Runtime: "pi",
		Mode: jarvis.RunMode_Orchestrator, DesignFirst: kind, Autonomous: &asking,
	})
	if err != nil {
		t.Fatalf("create design-first run: %v", err)
	}
	return rtn.Run
}

func writeDesignFile(t *testing.T, name string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("# design\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRunDesignAttachStartsOneLead(t *testing.T) {
	ctx := context.Background()
	spawns := stubDesignSpawn(t)
	ch := designChannel(t, "design-attach")
	run := createDesignFirstRun(t, ch, waveobj.RunDesignKind_Brainstorm)
	session := (*spawns)[0].blockId
	spec := writeDesignFile(t, "spec.md")

	attach := wshrpc.CommandRunDesignAttachData{BlockId: session, Spec: spec}
	rtn, err := (&WshServer{}).RunDesignAttachCommand(ctx, attach)
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	if rtn.ChannelId != ch.OID || rtn.RunId != run.ID {
		t.Fatalf("attach named %+v, want run %s", rtn, run.ID)
	}
	if _, err := (&WshServer{}).RunDesignAttachCommand(ctx, attach); err == nil || !strings.Contains(err.Error(), "run "+run.ID+" already took this session's design") {
		t.Fatalf("a second attach from the same session: %v", err)
	}

	got, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Design != nil || got.DesignSession != session || got.Spec != spec || got.Status != jarvis.RunStatus_Executing {
		t.Fatalf("attached run: design %+v, session %q, spec %q, status %q", got.Design, got.DesignSession, got.Spec, got.Status)
	}
	if len(*spawns) != 2 {
		t.Fatalf("want the design session and one lead, got %d spawns", len(*spawns))
	}
	lead := (*spawns)[1]
	if lead.prompt != jarvis.BuildOrchestratePrompt(got) {
		t.Fatalf("the lead's prompt is not the attached run's:\n%s", lead.prompt)
	}
	if lead.opts.DesignSession || lead.opts.RunId != run.ID {
		t.Fatalf("the lead spawned as %+v", lead.opts)
	}
	if w := got.Phases[0].WorkerOrefs; len(w) != 1 || w[0] != lead.oref {
		t.Fatalf("phase 0 workers = %v, want the lead %s", w, lead.oref)
	}
	events, err := wstore.QueryRunEventsByKind(ctx, ch.OID, run.ID, []string{waveobj.RunEventKindDesignAttached}, 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("design-attached events = %+v, %v; want one", events, err)
	}
}

func TestRunDesignAttachNoWaitingRun(t *testing.T) {
	stubDesignSpawn(t)
	rtn, err := (&WshServer{}).RunDesignAttachCommand(context.Background(), wshrpc.CommandRunDesignAttachData{
		BlockId: uuid.NewString(), Prototype: writeDesignFile(t, "Main.dc.html"),
	})
	if err != nil {
		t.Fatalf("a normal session's approve is not an error: %v", err)
	}
	if rtn == nil || rtn.RunId != "" || rtn.ChannelId != "" {
		t.Fatalf("want an empty reply, got %+v", rtn)
	}
}

func TestDesignFirstRunStartsPhaseZero(t *testing.T) {
	ctx := context.Background()
	stubDesignSpawn(t)
	ch := designChannel(t, "design-phase-zero")
	run := createDesignFirstRun(t, ch, waveobj.RunDesignKind_Brainstorm)
	events, err := wstore.QueryRunEventsByKind(ctx, ch.OID, run.ID, []string{waveobj.RunEventKindPhaseStarted}, 10)
	if err != nil || len(events) != 1 || events[0].PhaseIdx == nil || *events[0].PhaseIdx != 0 {
		t.Fatalf("phase-started events = %+v, %v; want one for phase 0", events, err)
	}
}

func TestRunDesignAttachNormalSessionMissingFile(t *testing.T) {
	stubDesignSpawn(t)
	rtn, err := (&WshServer{}).RunDesignAttachCommand(context.Background(), wshrpc.CommandRunDesignAttachData{
		BlockId: uuid.NewString(), Spec: filepath.Join(t.TempDir(), "gone.md"),
	})
	if err != nil {
		t.Fatalf("a normal session's approve goes to the launcher whatever its files: %v", err)
	}
	if rtn == nil || rtn.RunId != "" {
		t.Fatalf("want an empty reply, got %+v", rtn)
	}
}

func TestRunDesignAttachMissingFileForWaitingRun(t *testing.T) {
	spawns := stubDesignSpawn(t)
	ch := designChannel(t, "design-missing-file")
	createDesignFirstRun(t, ch, waveobj.RunDesignKind_Brainstorm)
	_, err := (&WshServer{}).RunDesignAttachCommand(context.Background(), wshrpc.CommandRunDesignAttachData{
		BlockId: (*spawns)[0].blockId, Spec: filepath.Join(t.TempDir(), "gone.md"),
	})
	if err == nil || !strings.Contains(err.Error(), "gone.md") {
		t.Fatalf("a waiting run's missing spec: %v", err)
	}
}

func TestRunDesignAttachFailedLeadSpawnCanRetry(t *testing.T) {
	ctx := context.Background()
	spawns := stubDesignSpawn(t)
	ch := designChannel(t, "design-retry")
	run := createDesignFirstRun(t, ch, waveobj.RunDesignKind_Canvas)
	session := (*spawns)[0].blockId
	ok := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		return "", errors.New("spawn refused")
	}
	attach := wshrpc.CommandRunDesignAttachData{BlockId: session, Prototype: writeDesignFile(t, "Main.dc.html")}
	if _, err := (&WshServer{}).RunDesignAttachCommand(ctx, attach); err == nil || !strings.Contains(err.Error(), "spawn refused") {
		t.Fatalf("a failed lead spawn: %v", err)
	}
	got, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Design == nil || got.Design.BlockId != session || got.DesignSession != "" || got.Prototype != "" || got.Status != jarvis.RunStatus_Planning {
		t.Fatalf("after a failed spawn: design %+v, session %q, prototype %q, status %q", got.Design, got.DesignSession, got.Prototype, got.Status)
	}

	jarvis.SpawnRunWorker = ok
	if _, err := (&WshServer{}).RunDesignAttachCommand(ctx, attach); err != nil {
		t.Fatalf("retried approve: %v", err)
	}
	got, err = wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != jarvis.RunStatus_Executing || len(got.Phases[0].WorkerOrefs) != 1 {
		t.Fatalf("after the retry: status %q, phase 0 workers %v", got.Status, got.Phases[0].WorkerOrefs)
	}
	events, err := wstore.QueryRunEventsByKind(ctx, ch.OID, run.ID, []string{waveobj.RunEventKindDesignAttached}, 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("design-attached events = %+v, %v; want one, from the retry", events, err)
	}
}

func TestCancelDesigningRun(t *testing.T) {
	ctx := context.Background()
	spawns := stubDesignSpawn(t)
	ch := designChannel(t, "design-cancel")
	run := createDesignFirstRun(t, ch, waveobj.RunDesignKind_Canvas)
	if err := (&WshServer{}).CancelRunCommand(ctx, wshrpc.CommandCancelRunData{ChannelId: ch.OID, RunId: run.ID}); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	got, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil || got.Status != jarvis.RunStatus_Cancelled {
		t.Fatalf("run after cancel = %+v, %v", got, err)
	}
	sessionTab := strings.TrimPrefix((*spawns)[0].oref, "tab:")
	if tab, err := wstore.DBGet[*waveobj.Tab](ctx, sessionTab); err != nil || tab == nil {
		t.Fatalf("the design session's tab went with the run: %v", err)
	}
}

// leadRun is an asking orchestrator run with a live lead: a stamped tab whose block is the caller
func leadRun(t *testing.T, ch *waveobj.Channel, autonomous bool) (waveobj.Run, string, string) {
	t.Helper()
	ctx := context.Background()
	tab := &waveobj.Tab{OID: uuid.NewString()}
	block := &waveobj.Block{OID: uuid.NewString(), ParentORef: waveobj.MakeORef(waveobj.OType_Tab, tab.OID).String()}
	tab.BlockIds = []string{block.OID}
	for _, obj := range []waveobj.WaveObj{tab, block} {
		if err := wstore.DBInsert(ctx, obj); err != nil {
			t.Fatal(err)
		}
	}
	run := jarvis.NewRun("Ship the auth flow", "ws", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(), 1)
	run.Runtime, run.Autonomous = "pi", autonomous
	tabORef := waveobj.MakeORef(waveobj.OType_Tab, tab.OID).String()
	run.Phases[0].WorkerOrefs = []string{tabORef}
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatal(err)
	}
	if err := wstore.StampWorkerOwner(ctx, tabORef, waveobj.MakeORef(waveobj.OType_Run, run.ID).String(), waveobj.MakeORef(waveobj.OType_Channel, ch.OID).String()); err != nil {
		t.Fatal(err)
	}
	return run, tab.OID, waveobj.MakeORef(waveobj.OType_Block, block.OID).String()
}

func TestJarvisDesignSetsDesignAndClosesLead(t *testing.T) {
	ctx := context.Background()
	spawns := stubDesignSpawn(t)
	ch := designChannel(t, "design-lead")
	run, leadTab, leadBlock := leadRun(t, ch, false)
	var deleted []string
	old := deleteDesignLeadTab
	deleteDesignLeadTab = func(ctx context.Context, _, tabId string) error {
		deleted = append(deleted, tabId)
		// what the app does when the tab goes: a phase that still lists it fails
		orchestrate.HandleWorkerTabClose(ctx, tabId)
		return nil
	}
	t.Cleanup(func() { deleteDesignLeadTab = old })

	if err := (&WshServer{}).JarvisDesignCommand(ctx, wshrpc.CommandJarvisDesignData{ORef: leadBlock, Kind: waveobj.RunDesignKind_Brainstorm}); err != nil {
		t.Fatalf("design: %v", err)
	}
	if len(deleted) != 1 || deleted[0] != leadTab {
		t.Fatalf("deleted tabs = %v, want the lead's %s", deleted, leadTab)
	}
	if len(*spawns) != 1 || !(*spawns)[0].opts.DesignSession || (*spawns)[0].prompt != jarvis.DesignSessionPrompt(run.Goal, waveobj.RunDesignKind_Brainstorm) {
		t.Fatalf("spawns = %+v, want one brainstorm design session", *spawns)
	}
	got, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Design == nil || got.Design.Kind != waveobj.RunDesignKind_Brainstorm || got.Design.BlockId != (*spawns)[0].blockId {
		t.Fatalf("design = %+v, want the session's block %s", got.Design, (*spawns)[0].blockId)
	}
	if len(got.Phases[0].WorkerOrefs) != 0 {
		t.Fatalf("the lead is still on the run: %v", got.Phases[0].WorkerOrefs)
	}
	if got.Status != jarvis.RunStatus_Planning || got.Phases[0].State != jarvis.PhaseState_Running {
		t.Fatalf("run %q phase %q, want a planning run whose phase still runs", got.Status, got.Phases[0].State)
	}
}

func TestJarvisDesignRefusesAutonomous(t *testing.T) {
	ctx := context.Background()
	spawns := stubDesignSpawn(t)
	ch := designChannel(t, "design-autonomous")
	run, _, leadBlock := leadRun(t, ch, true)
	err := (&WshServer{}).JarvisDesignCommand(ctx, wshrpc.CommandJarvisDesignData{ORef: leadBlock, Kind: waveobj.RunDesignKind_Canvas})
	if err == nil || !strings.Contains(err.Error(), "autonomous") {
		t.Fatalf("an autonomous run's design: %v", err)
	}
	if len(*spawns) != 0 {
		t.Fatalf("a refused design started %d sessions", len(*spawns))
	}
	if got, _ := wstore.GetRun(ctx, ch.OID, run.ID); got.Design != nil || len(got.Phases[0].WorkerOrefs) != 1 {
		t.Fatalf("a refused design changed the run: %+v", got)
	}
}
