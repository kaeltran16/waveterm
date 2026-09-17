// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func ch(name string, enabled bool, msgs ...waveobj.ChannelMessage) *waveobj.Channel {
	meta := waveobj.MetaMapType{}
	if enabled {
		meta[MetaKey_GatekeeperEnabled] = true
	}
	return &waveobj.Channel{OID: name, Name: name, Meta: meta, Messages: msgs}
}
func dispatch(oref, text string) waveobj.ChannelMessage {
	return waveobj.ChannelMessage{Kind: "dispatch", Author: "claude", Text: text, RefORef: oref}
}

func chWithRun(name string, enabled bool, run waveobj.Run) *waveobj.Channel {
	c := ch(name, enabled)
	c.Runs = []waveobj.Run{run}
	return c
}

func TestResolveRunWorker_MatchesPhaseWorker(t *testing.T) {
	run := waveobj.Run{ID: "r1", Goal: "ship coupons", Phases: []waveobj.RunPhase{
		{Kind: PhaseKind_Brainstorm, State: PhaseState_Done, WorkerOrefs: []string{"tab:t0"}},
		{Kind: PhaseKind_Plan, Skill: "superpowers:writing-plans", State: PhaseState_Running, WorkerOrefs: []string{"tab:t1"}},
	}}
	c := chWithRun("c1", true, run)
	m := ResolveRunWorker([]*waveobj.Channel{c}, "tab:t1")
	if m == nil || m.Channel.OID != "c1" || m.Run.ID != "r1" || m.PhaseIdx != 1 {
		t.Fatalf("want c1/r1/phase 1, got %+v", m)
	}
}

func TestResolveRunWorker_MatchesRegardlessOfToggle(t *testing.T) {
	run := waveobj.Run{ID: "r1", Goal: "g", Phases: []waveobj.RunPhase{
		{Kind: PhaseKind_Execute, State: PhaseState_Running, WorkerOrefs: []string{"tab:t1"}},
	}}
	c := chWithRun("c1", false, run) // gatekeeper toggle OFF
	if m := ResolveRunWorker([]*waveobj.Channel{c}, "tab:t1"); m == nil {
		t.Fatalf("run workers must resolve even with the gatekeeper toggle off")
	}
}

func TestResolveRunWorker_NilForUnknown(t *testing.T) {
	run := waveobj.Run{ID: "r1", Phases: []waveobj.RunPhase{{Kind: PhaseKind_Plan, WorkerOrefs: []string{"tab:t1"}}}}
	c := chWithRun("c1", true, run)
	if m := ResolveRunWorker([]*waveobj.Channel{c}, "tab:nope"); m != nil {
		t.Fatalf("want nil for unknown oref, got %+v", m)
	}
}

func TestRunWorkerTask_MentionsPhaseAndGoal(t *testing.T) {
	run := &waveobj.Run{Goal: "ship coupons", Phases: []waveobj.RunPhase{
		{Kind: PhaseKind_Plan, Skill: "superpowers:writing-plans"},
	}}
	task := runWorkerTask(run, 0)
	for _, want := range []string{"plan", "superpowers:writing-plans", "ship coupons"} {
		if !contains(task, want) {
			t.Fatalf("task missing %q: %s", want, task)
		}
	}
}

func TestResolve_EnabledOwner(t *testing.T) {
	c := ch("c1", true, dispatch("tab:t1", "harden webhooks"))
	got := ResolveGatekeeperChannel([]*waveobj.Channel{c}, "tab:t1")
	if got == nil || got.OID != "c1" {
		t.Fatalf("want c1, got %v", got)
	}
	if task := workerTaskFor(c, "tab:t1"); task != "harden webhooks" {
		t.Fatalf("want task, got %q", task)
	}
}

func TestResolve_NotEnabledIgnored(t *testing.T) {
	c := ch("c1", false, dispatch("tab:t1", "x"))
	if got := ResolveGatekeeperChannel([]*waveobj.Channel{c}, "tab:t1"); got != nil {
		t.Fatalf("want nil for disabled channel, got %v", got)
	}
}

func TestResolve_NoOwner(t *testing.T) {
	c := ch("c1", true, dispatch("tab:t1", "x"))
	if got := ResolveGatekeeperChannel([]*waveobj.Channel{c}, "tab:t2"); got != nil {
		t.Fatalf("want nil for unowned oref, got %v", got)
	}
}

func TestTierMeta(t *testing.T) {
	cases := []struct {
		tier           string
		wantGatekeeper bool
		wantDelegator  bool
	}{
		{"delegator", true, true},
		{"gatekeeper", true, false},
		{"concierge", false, false},
		{"", false, false},
		{"bogus", false, false},
	}
	for _, c := range cases {
		gk, del := TierMeta(c.tier)
		if gk != c.wantGatekeeper || del != c.wantDelegator {
			t.Errorf("TierMeta(%q) = (%v,%v), want (%v,%v)", c.tier, gk, del, c.wantGatekeeper, c.wantDelegator)
		}
	}
}

// A tab oref (what a dispatch records) and an unparseable oref pass through ChannelOwnerORef
// unchanged — only a block oref triggers the DB block→tab walk (covered by the live E2E).
func TestChannelOwnerORef_Passthrough(t *testing.T) {
	if got := ChannelOwnerORef(context.Background(), "tab:t1"); got != "tab:t1" {
		t.Fatalf("tab oref should pass through, got %q", got)
	}
	if got := ChannelOwnerORef(context.Background(), "not-an-oref"); got != "not-an-oref" {
		t.Fatalf("unparseable oref should pass through, got %q", got)
	}
}

func boolPtr(b bool) *bool    { return &b }
func strPtr(s string) *string { return &s }

func TestResolveProfile_DefaultMode(t *testing.T) {
	global := waveobj.JarvisProfile{DefaultMode: RunMode_Pipeline}

	// nil override inherits global
	got := ResolveProfile(global, nil)
	if got.DefaultMode != RunMode_Pipeline {
		t.Fatalf("nil override: got mode=%q", got.DefaultMode)
	}

	// override replaces the section
	ov := &waveobj.ProfileOverride{DefaultMode: strPtr(RunMode_Orchestrator)}
	got = ResolveProfile(global, ov)
	if got.DefaultMode != RunMode_Orchestrator {
		t.Fatalf("override: got mode=%q", got.DefaultMode)
	}
}

func TestResolveDispatchChannelFindsConciergeChannel(t *testing.T) {
	// concierge (gatekeeper OFF) channel still owns its dispatch
	c := ch("c1", false, dispatch("tab:w1", "do a thing"))
	got := ResolveDispatchChannel([]*waveobj.Channel{c}, "tab:w1")
	if got == nil || got.OID != "c1" {
		t.Fatalf("got %v, want c1", got)
	}
}

func TestResolveDispatchChannelNoMatch(t *testing.T) {
	c := ch("c1", false, waveobj.ChannelMessage{Kind: "human", RefORef: ""})
	if got := ResolveDispatchChannel([]*waveobj.Channel{c}, "tab:w1"); got != nil {
		t.Fatalf("got %v, want nil", got)
	}
}

func TestRunOwnsWorker(t *testing.T) {
	run := &waveobj.Run{ID: "r1", Phases: []waveobj.RunPhase{
		{Kind: PhaseKind_Plan, WorkerOrefs: []string{"tab:t1"}},
		{Kind: PhaseKind_Execute, WorkerOrefs: []string{"tab:t2", "tab:t3"}},
	}}
	if !RunOwnsWorker(run, "tab:t2") {
		t.Fatalf("expected run to own tab:t2")
	}
	if RunOwnsWorker(run, "tab:nope") {
		t.Fatalf("did not expect run to own tab:nope")
	}
	if RunOwnsWorker(nil, "tab:t1") {
		t.Fatalf("nil run owns nothing")
	}
}

// a lead works in the project checkout, which is also the project path of every other running dag run of that
// project, so the scan must resolve its tab to the run that lists it even when another run comes first.
func TestResolveRunWorker_ResolvesALeadToItsOwnRunBesideAnotherRunOfTheSameProject(t *testing.T) {
	const project = `C:\repo`
	tabOID := uuid.NewString()
	blockOID := uuid.NewString()
	other := waveobj.Run{ID: "r-other", DagORef: "g1", ProjectPath: project, Phases: []waveobj.RunPhase{
		{Kind: PhaseKind_Execute, State: PhaseState_Running, WorkerOrefs: []string{"tab:other-lead"}},
	}}
	own := waveobj.Run{ID: "r-own", DagORef: "g2", ProjectPath: project, Phases: []waveobj.RunPhase{
		{Kind: PhaseKind_Execute, State: PhaseState_Running, WorkerOrefs: []string{"tab:" + tabOID}},
	}}
	c := ch("c1", true)
	c.Runs = []waveobj.Run{other, own}
	// the lead tab's first block carries cmd:cwd = the project checkout (UUID ids: ParseORef validates)
	tab := &waveobj.Tab{OID: tabOID, BlockIds: []string{blockOID}}
	if err := wstore.DBInsert(context.Background(), tab); err != nil {
		t.Fatal(err)
	}
	block := &waveobj.Block{OID: blockOID, Meta: waveobj.MetaMapType{waveobj.MetaKey_CmdCwd: project}}
	if err := wstore.DBInsert(context.Background(), block); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		wstore.DBDelete(context.Background(), waveobj.OType_Tab, tabOID)
		wstore.DBDelete(context.Background(), waveobj.OType_Block, blockOID)
	})
	m := ResolveRunWorker([]*waveobj.Channel{c}, "tab:"+tabOID)
	if m == nil || m.Run.ID != "r-own" {
		t.Fatalf("lead must resolve to its own run, got %+v", m)
	}
}
