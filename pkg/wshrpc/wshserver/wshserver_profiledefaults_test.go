// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// A scheduler tick replaces the whole TaskGroup from a snapshot it read under the dag mutation lock. A
// settings write that skips the lock can be reverted by an overlapping tick and still report success, so
// the write has to wait for the lock the engine uses.
func TestSetRunSettingsSerializedWithSchedulerMutations(t *testing.T) {
	ctx := context.Background()
	ch, run := newEngineRun(t, ctx, "rs-lock", jarvis.Orchestration_Engine)
	g := submitPlan(t, ctx, ch, run.ID)

	locked := make(chan struct{})
	release := make(chan struct{})
	go func() {
		_ = orchestrate.WithDagMutation(g.OID, func() error {
			close(locked)
			<-release
			return nil
		})
	}()
	<-locked

	done := make(chan error, 1)
	go func() {
		done <- (&WshServer{}).SetRunSettingsCommand(ctx, wshrpc.CommandSetRunSettingsData{
			ChannelId: ch.OID, RunId: run.ID, Parallelism: intPtr(7),
		})
	}()
	select {
	case err := <-done:
		t.Fatalf("the settings write ran inside a live scheduler tick's window: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("SetRunSettingsCommand: %v", err)
	}
	got, err := wstore.GetDag(ctx, g.OID)
	if err != nil {
		t.Fatalf("GetDag: %v", err)
	}
	if got.Parallelism != 7 {
		t.Fatalf("group parallelism = %d, want 7", got.Parallelism)
	}
}

// The one window a test cannot reach from the outside: the RPC has decided the Run is the authority and a
// concurrent DagSubmit links a group before the write lands. The obsolete pending write must not be
// reported as success — the decision has to be redone against the group.
func TestSetRunSettingsRetriesAcrossDagSubmission(t *testing.T) {
	ctx := context.Background()
	ch, run := newEngineRun(t, ctx, "rs-handoff-race", jarvis.Orchestration_Engine)

	var once sync.Once
	orig := runSettingsAfterAuthorityRead
	runSettingsAfterAuthorityRead = func() {
		once.Do(func() { submitPlan(t, ctx, ch, run.ID) })
	}
	t.Cleanup(func() { runSettingsAfterAuthorityRead = orig })

	if err := (&WshServer{}).SetRunSettingsCommand(ctx, wshrpc.CommandSetRunSettingsData{
		ChannelId: ch.OID, RunId: run.ID, Parallelism: intPtr(4),
	}); err != nil {
		t.Fatalf("SetRunSettingsCommand: %v", err)
	}
	got := mustRun(t, ctx, ch.OID, run.ID)
	if got.DagORef == "" {
		t.Fatal("the interleave did not link a dag; the test no longer exercises the handoff")
	}
	group, err := wstore.GetDag(ctx, got.DagORef)
	if err != nil {
		t.Fatalf("GetDag: %v", err)
	}
	if group.Parallelism != 4 {
		t.Fatalf("group parallelism = %d, want 4 — the retry must land on the group", group.Parallelism)
	}
	if got.Parallelism != 0 {
		t.Fatalf("run parallelism = %d, want the untouched launch snapshot", got.Parallelism)
	}
}

// The application path end to end: a saved profile, launched the way the hydrated launcher launches it
// (shape explicit, the shape control's value having come from the profile), produces the saved machine,
// width and worker route.
func TestProfileDefaultsDriveNextEngineRun(t *testing.T) {
	ctx := context.Background()
	stubRunServer(t, "pi", nil)
	ch, err := wstore.CreateChannel(ctx, "profile-drives", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	route := &waveobj.RoutePin{Runtime: "pi"}
	if err := (&WshServer{}).SetChannelProfileCommand(ctx, wshrpc.CommandSetChannelProfileData{
		ChannelId: ch.OID,
		Override: &waveobj.ProfileOverride{
			Parallelism: intPtr(3),
			WorkerRoute: route,
		},
	}); err != nil {
		t.Fatalf("SetChannelProfileCommand: %v", err)
	}

	rtn, err := (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws", Goal: "g", Runtime: "pi",
		Mode: jarvis.RunMode_Orchestrator, DeferStart: true,
	})
	if err != nil {
		t.Fatalf("CreateRunCommand: %v", err)
	}
	run := rtn.Run
	if run.Mode != jarvis.RunMode_Orchestrator {
		t.Errorf("mode = %q, want the launched orchestrator shape", run.Mode)
	}
	if run.Orchestration != jarvis.Orchestration_Engine {
		t.Errorf("orchestration = %q, want the profile's engine machine", run.Orchestration)
	}
	if run.Parallelism != 3 {
		t.Errorf("parallelism = %d, want the profile's 3", run.Parallelism)
	}
	if run.WorkerRoute == nil || *run.WorkerRoute != *route {
		t.Errorf("worker route = %+v, want the profile's", run.WorkerRoute)
	}
}

// The engine dials belong to the engine: a quick or pipeline launch must not inherit a stored
// worker route (which can name a harness this machine does not have) or a width it will never use.
func TestEngineDefaultsNotHydratedOntoNonEngineRuns(t *testing.T) {
	ctx := context.Background()
	stubRunServer(t, "pi", nil)
	ch, err := wstore.CreateChannel(ctx, "profile-nonengine", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := (&WshServer{}).SetChannelProfileCommand(ctx, wshrpc.CommandSetChannelProfileData{
		ChannelId: ch.OID,
		Override: &waveobj.ProfileOverride{
			Parallelism: intPtr(5),
			WorkerRoute: &waveobj.RoutePin{Runtime: "pi"},
		},
	}); err != nil {
		t.Fatalf("SetChannelProfileCommand: %v", err)
	}
	launches := []struct {
		name          string
		mode          string
		orchestration string
	}{
		{"quick", jarvis.RunMode_Quick, ""},
		{"pipeline", jarvis.RunMode_Pipeline, ""},
	}
	for _, l := range launches {
		rtn, err := (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
			ChannelId: ch.OID, WorkspaceId: "ws", Goal: "g", Runtime: "pi",
			Mode: l.mode, Orchestration: l.orchestration, DeferStart: true,
		})
		if err != nil {
			t.Fatalf("%s: CreateRunCommand: %v", l.name, err)
		}
		if rtn.Run.Parallelism != 0 {
			t.Errorf("%s: parallelism = %d, want no engine default", l.name, rtn.Run.Parallelism)
		}
		if rtn.Run.WorkerRoute != nil {
			t.Errorf("%s: worker route = %+v, want no engine default", l.name, rtn.Run.WorkerRoute)
		}
	}
}

// The profile's engine sections validate before anything is written — a stored default is a promise the
// next launch will keep.
func TestSetChannelProfileRejectsZeroParallelism(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "profile-engine-zero", "/repo")
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := (&WshServer{}).SetChannelProfileCommand(ctx, wshrpc.CommandSetChannelProfileData{
		ChannelId: ch.OID, Override: &waveobj.ProfileOverride{Parallelism: intPtr(0)},
	}); err == nil {
		t.Fatal("expected an explicit parallelism of 0 to be rejected")
	}
	if channelHasProfileMeta(t, ctx, ch.OID) {
		t.Fatal("a rejected engine default must not write channel meta")
	}
}
