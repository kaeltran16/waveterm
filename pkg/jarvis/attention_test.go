// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func gatedRun(id, goal string, doneTs int64) *waveobj.Run {
	return &waveobj.Run{
		ID:     id,
		Goal:   goal,
		Status: "awaiting-review",
		Phases: []waveobj.RunPhase{
			{Kind: "plan", State: "done", Gate: true, DoneTs: doneTs},
			{Kind: "execute", State: "pending"},
		},
	}
}

func escalationMsg(id, askORef, workerORef, question string, ts int64) *waveobj.ChannelMessage {
	data, _ := json.Marshal(JarvisCardData{AskORef: askORef, WorkerORef: workerORef, Question: question})
	return &waveobj.ChannelMessage{ID: id, Kind: "jarvis-escalation", Ts: ts, Data: string(data)}
}

func TestBuildAttentionFindsAGateInANonActiveChannel(t *testing.T) {
	in := AttentionInput{Channels: []AttentionChannel{
		{OID: "c1", Name: "alpha", Runs: []*waveobj.Run{gatedRun("r1", "refactor auth", 500)}},
	}}
	items := BuildAttention(in)
	if len(items) != 1 {
		t.Fatalf("want 1 item, got %d: %+v", len(items), items)
	}
	got := items[0]
	if got.Kind != AttentionGate || got.RunId != "r1" || got.ChannelId != "c1" ||
		got.ChannelName != "alpha" || got.Source != "refactor auth" ||
		got.Action != "Review" || got.WaitingSince != 500 {
		t.Fatalf("wrong gate item: %+v", got)
	}
}

func TestBuildAttentionIgnoresARunThatIsNotAtAGate(t *testing.T) {
	run := &waveobj.Run{ID: "r1", Goal: "g", Status: "executing",
		Phases: []waveobj.RunPhase{{State: "running"}}}
	items := BuildAttention(AttentionInput{Channels: []AttentionChannel{{OID: "c1", Runs: []*waveobj.Run{run}}}})
	if len(items) != 0 {
		t.Fatalf("want none, got %+v", items)
	}
}

func TestBuildAttentionCountsAnEscalationOnlyWhileItsAskIsPending(t *testing.T) {
	ch := AttentionChannel{OID: "c1", Name: "alpha",
		Messages: []*waveobj.ChannelMessage{escalationMsg("m1", "block:a", "tab:w", "Which order?", 900)}}

	none := BuildAttention(AttentionInput{Channels: []AttentionChannel{ch}})
	if len(none) != 0 {
		t.Fatalf("an answered escalation must not wait on anyone: %+v", none)
	}

	live := BuildAttention(AttentionInput{
		Channels:    []AttentionChannel{ch},
		PendingAsks: map[string]agentask.PendingAsk{"block:a": {AskId: "1", Ts: 900}},
		AskWorker:   map[string]string{"block:a": "worker-3"},
		AskChannel:  map[string]string{"block:a": "c1"},
	})
	if len(live) != 1 || live[0].Kind != AttentionEscalation || live[0].Text != "Which order?" ||
		live[0].Source != "worker-3" || live[0].WaitingSince != 900 {
		t.Fatalf("wrong escalation item: %+v", live)
	}
}

// An escalated ask is ONE thing waiting, not two. See "Deviation from the spec" in the plan.
func TestBuildAttentionDoesNotCountAnEscalatedAskTwice(t *testing.T) {
	items := BuildAttention(AttentionInput{
		Channels: []AttentionChannel{{OID: "c1", Name: "alpha",
			Messages: []*waveobj.ChannelMessage{escalationMsg("m1", "block:a", "tab:w", "Q?", 900)}}},
		PendingAsks: map[string]agentask.PendingAsk{"block:a": {AskId: "1", Ts: 900}},
		AskChannel:  map[string]string{"block:a": "c1"},
		AskWorker:   map[string]string{"block:a": "worker-3"},
	})
	if len(items) != 1 || items[0].Kind != AttentionEscalation {
		t.Fatalf("want one escalation, got %+v", items)
	}
}

func TestBuildAttentionYieldsAStandaloneAskWithNoChannel(t *testing.T) {
	items := BuildAttention(AttentionInput{
		PendingAsks: map[string]agentask.PendingAsk{"block:z": {AskId: "9", Ts: 42}},
		AskWorker:   map[string]string{"block:z": "solo"},
	})
	if len(items) != 1 {
		t.Fatalf("want 1, got %+v", items)
	}
	if items[0].ChannelId != "" || items[0].Kind != AttentionAsk ||
		items[0].Action != "Answer" || items[0].WaitingSince != 42 {
		t.Fatalf("wrong standalone ask: %+v", items[0])
	}
}

func TestBuildAttentionOrdersByKindThenOldestFirst(t *testing.T) {
	in := AttentionInput{
		Channels: []AttentionChannel{{OID: "c1", Name: "alpha", Runs: []*waveobj.Run{
			gatedRun("newer", "b", 800),
			gatedRun("older", "a", 100),
		}}},
		PendingAsks: map[string]agentask.PendingAsk{"block:z": {AskId: "9", Ts: 50}},
		AskWorker:   map[string]string{"block:z": "solo"},
	}
	items := BuildAttention(in)
	if len(items) != 3 {
		t.Fatalf("want 3, got %+v", items)
	}
	// gates before asks even though the ask is the oldest thing here
	if items[0].RunId != "older" || items[1].RunId != "newer" || items[2].Kind != AttentionAsk {
		t.Fatalf("wrong order: %+v", items)
	}
}

func TestBuildAttentionResolvesAnAskToItsOwningRun(t *testing.T) {
	run := &waveobj.Run{ID: "r1", Goal: "g", Status: "executing",
		Phases: []waveobj.RunPhase{{State: "running", WorkerOrefs: []string{"tab:w"}}}}
	items := BuildAttention(AttentionInput{
		Channels:      []AttentionChannel{{OID: "c1", Name: "alpha", Runs: []*waveobj.Run{run}}},
		PendingAsks:   map[string]agentask.PendingAsk{"block:a": {AskId: "1", Ts: 5}},
		AskChannel:    map[string]string{"block:a": "c1"},
		AskWorker:     map[string]string{"block:a": "worker-3"},
		AskWorkerORef: map[string]string{"block:a": "tab:w"},
	})
	if len(items) != 1 || items[0].RunId != "r1" {
		t.Fatalf("ask should carry its owning run: %+v", items)
	}
}

// The frontend must be able to resolve a gate without re-deriving which phase it is: reviewGateIdx encodes
// a precedence rule, and a second implementation in TypeScript is how the two drift. The gate sits at index
// 1 here on purpose — index 0 would pass against a hardcoded zero.
func TestBuildAttentionCarriesTheGatePhaseIndex(t *testing.T) {
	run := &waveobj.Run{
		ID:     "r1",
		Goal:   "refactor the parser",
		Status: "awaiting-review",
		Phases: []waveobj.RunPhase{
			{Kind: "scope", State: "done", DoneTs: 400},
			{Kind: "plan", State: "done", Gate: true, DoneTs: 1000},
			{Kind: "execute", State: "pending"},
		},
	}
	items := BuildAttention(AttentionInput{Channels: []AttentionChannel{
		{OID: "c1", Name: "wave", Runs: []*waveobj.Run{run}},
	}})
	if len(items) != 1 {
		t.Fatalf("expected one gate item, got %d: %+v", len(items), items)
	}
	if items[0].PhaseIdx != 1 {
		t.Errorf("PhaseIdx = %d, want 1 (the gate phase reviewGateIdx found)", items[0].PhaseIdx)
	}
}
