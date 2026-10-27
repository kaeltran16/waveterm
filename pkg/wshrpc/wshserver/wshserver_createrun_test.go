// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// A run that was created but could not be read back has still launched, so the reply must name it rather
// than report a failure: the launcher treats a CreateRun error as "nothing started" and leaves its modal
// open over a run that is already running. Neither {run: null} nor an error is an acceptable answer here.
func TestCreateRunRepliesWithTheRunWhenTheReadBackFails(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "createrun-readback", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	stubRunServer(t, "pi", nil)
	var createdID string
	old := readCreatedRun
	readCreatedRun = func(_ context.Context, _ string, runID string) (*waveobj.Run, error) {
		createdID = runID
		return nil, errors.New("sql: transaction has already been committed or rolled back")
	}
	t.Cleanup(func() { readCreatedRun = old })

	rtn, err := (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws", Goal: "test", Runtime: "pi",
		Mode: jarvis.RunMode_Orchestrator, DeferStart: true,
	})
	if err != nil {
		t.Fatalf("a created run must not be reported as a failed launch: %v", err)
	}
	if rtn == nil || rtn.Run == nil {
		t.Fatalf("want the created run, got %+v", rtn)
	}
	// the identity the launcher opens the run on, which AppendRun stamped on its own copy
	if rtn.Run.OID != createdID || rtn.Run.ID != createdID {
		t.Fatalf("want the reply to name run %s, got oid=%s id=%s", createdID, rtn.Run.OID, rtn.Run.ID)
	}
	if rtn.Run.ChannelOID != ch.OID {
		t.Fatalf("want channeloid %s, got %s", ch.OID, rtn.Run.ChannelOID)
	}
	if _, gerr := wstore.GetRun(ctx, ch.OID, createdID); gerr != nil {
		t.Fatalf("the run itself must still exist: %v", gerr)
	}
}

// A run whose read-back failed only because the handler's own budget expired is still durable: an engine
// launch builds a worktree and a worker per lane before the read, so it can outlast the budget. Retrying
// off that dead ctx must return the run rather than report a working launch as a failure.
func TestCreateRunRetriesTheReadBackAfterABudgetExpiry(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "createrun-budget", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	stubRunServer(t, "pi", nil)
	calls := 0
	old := readCreatedRun
	readCreatedRun = func(rctx context.Context, chID string, runID string) (*waveobj.Run, error) {
		calls++
		if calls == 1 {
			return nil, context.DeadlineExceeded
		}
		return old(rctx, chID, runID)
	}
	t.Cleanup(func() { readCreatedRun = old })

	rtn, err := (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws", Goal: "test", Runtime: "pi",
		Mode: jarvis.RunMode_Orchestrator, DeferStart: true,
	})
	if err != nil {
		t.Fatalf("a read-back that succeeds on the retry must not fail the RPC: %v", err)
	}
	if rtn == nil || rtn.Run == nil {
		t.Fatalf("want the created run, got %+v", rtn)
	}
	if calls != 2 {
		t.Fatalf("want exactly two read attempts, got %d", calls)
	}
}

func TestCreateRunStoresSpec(t *testing.T) {
	ctx := context.Background()
	stubRunServer(t, "pi", nil)
	ch := designChannel(t, "createrun-spec")
	spec := writeDesignFile(t, "spec.md")
	rtn, err := (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws", Goal: "g", Runtime: "pi", Mode: jarvis.RunMode_Orchestrator, DeferStart: true, Spec: spec,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := wstore.GetRun(ctx, ch.OID, rtn.Run.ID); err != nil || got.Spec != spec {
		t.Fatalf("stored run = %+v, %v; want spec %q", got, err, spec)
	}
	for name, path := range map[string]string{"relative": "spec.md", "missing": filepath.Join(t.TempDir(), "gone.md")} {
		if _, err := (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
			ChannelId: ch.OID, WorkspaceId: "ws", Goal: "g", Runtime: "pi", Mode: jarvis.RunMode_Orchestrator, DeferStart: true, Spec: path,
		}); err == nil {
			t.Fatalf("a %s spec was accepted", name)
		}
	}
}

func TestCreateRunRefusesSpecOnQuick(t *testing.T) {
	ctx := context.Background()
	stubRunServer(t, "pi", nil)
	ch := designChannel(t, "createrun-spec-quick")
	_, err := (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws", Goal: "g", Runtime: "pi", Mode: jarvis.RunMode_Quick, DeferStart: true, Spec: writeDesignFile(t, "spec.md"),
	})
	if err == nil || !strings.Contains(err.Error(), "spec needs an orchestrator run") {
		t.Fatalf("error %v should refuse the spec", err)
	}
	if runs, _ := wstore.GetChannelRuns(ctx, ch.OID); len(runs) != 0 {
		t.Fatalf("a refused spec left runs behind: %+v", runs)
	}
}

func TestCreateRunDesignFirstStartsNoLead(t *testing.T) {
	ctx := context.Background()
	spawns := stubDesignSpawn(t)
	ch := designChannel(t, "createrun-design-first")
	run := createDesignFirstRun(t, ch, waveobj.RunDesignKind_Brainstorm)
	if len(*spawns) != 1 {
		t.Fatalf("want one spawn, the design session; got %d", len(*spawns))
	}
	s := (*spawns)[0]
	if !s.opts.DesignSession || s.opts.RunId != "" || s.prompt != jarvis.DesignSessionPrompt("Ship the auth flow", waveobj.RunDesignKind_Brainstorm) {
		t.Fatalf("spawned %+v, want the brainstorm design session", s)
	}
	got, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != jarvis.RunStatus_Planning || got.Design == nil || got.Design.Kind != waveobj.RunDesignKind_Brainstorm || got.Design.BlockId != s.blockId {
		t.Fatalf("run status %q design %+v, want planning on the session's block %s", got.Status, got.Design, s.blockId)
	}
	if len(got.Phases[0].WorkerOrefs) != 0 {
		t.Fatalf("a designing run has no lead, got %v", got.Phases[0].WorkerOrefs)
	}
	if events, err := wstore.QueryRunEventsByKind(ctx, ch.OID, run.ID, []string{waveobj.RunEventKindDesignStarted}, 10); err != nil || len(events) != 1 {
		t.Fatalf("design-started events = %+v, %v; want one", events, err)
	}
}

func TestCreateRunRefusesDesignFirstOnAutonomous(t *testing.T) {
	ctx := context.Background()
	spawns := stubDesignSpawn(t)
	ch := designChannel(t, "createrun-design-first-autonomous")
	autonomous := true
	_, err := (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws", Goal: "g", Runtime: "pi", Mode: jarvis.RunMode_Orchestrator,
		DesignFirst: waveobj.RunDesignKind_Canvas, Autonomous: &autonomous,
	})
	if err == nil || !strings.Contains(err.Error(), "design first needs a human: this run's approvals are autonomous") {
		t.Fatalf("error %v should refuse design first", err)
	}
	if runs, _ := wstore.GetChannelRuns(ctx, ch.OID); len(runs) != 0 || len(*spawns) != 0 {
		t.Fatalf("a refused design first left %d runs and %d spawns", len(runs), len(*spawns))
	}
}
