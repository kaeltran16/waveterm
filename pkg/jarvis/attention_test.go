// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
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

func TestGatherAttentionDropsAskForDeletedBlock(t *testing.T) {
	oref := waveobj.MakeORef(waveobj.OType_Block, uuid.NewString()).String()
	agentask.GlobalRegistry = agentask.MakeRegistry()
	agentask.GlobalRegistry.Set(oref, agentask.PendingAsk{AskId: "orphan", Ts: 42})

	items, err := GatherAttentionFromLedger(context.Background(), nil, map[string][]*waveobj.Run{})
	if err != nil {
		t.Fatalf("gather attention: %v", err)
	}
	events := wps.Broker.ReadEventHistory(wps.Event_AgentAsk, oref, 1)
	if len(events) != 1 {
		t.Fatalf("deleted block must publish one clear event, got %d", len(events))
	}
	cleared, ok := events[0].Data.(baseds.AgentAskData)
	if !ok || !cleared.Cleared || cleared.AskId != "orphan" {
		t.Fatalf("clear event = %#v", events[0].Data)
	}
	if len(items) != 0 {
		t.Fatalf("deleted block must not remain in attention: %+v", items)
	}
	if _, ok := agentask.GlobalRegistry.Get(oref); ok {
		t.Fatal("deleted block's pending ask must be claimed")
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

// The three fields F8 added to a queue row: the initiative it belongs to, one derived sentence of
// context, and the concrete artifacts the decision accepts. All three are composed from facts the
// server already holds — a row that summarised itself with a language model would be an unverifiable
// claim on the one surface whose promise is that every number is derived.

func TestGateItemCarriesItsInitiativeAndWhatStaysStopped(t *testing.T) {
	run := gatedRun("r1", "refactor auth", 500)
	run.EffortRef = &waveobj.RunEffortRef{EffortOID: "e-7", ChunkLabel: "rebase and squash"}
	run.Phases[0].Artifacts = []string{"docs/plans/auth.md", "  ", "pkg/auth/plan.go"}

	items := BuildAttention(AttentionInput{Channels: []AttentionChannel{
		{OID: "c1", Name: "alpha", Runs: []*waveobj.Run{run}},
	}})
	if len(items) != 1 {
		t.Fatalf("want 1 item, got %+v", items)
	}
	got := items[0]
	if got.EffortOID != "e-7" || got.ChunkLabel != "rebase and squash" {
		t.Fatalf("want the run's effort attribution, got %q/%q", got.EffortOID, got.ChunkLabel)
	}
	want := "The plan phase finished — 1 of 2 done. The execute phase starts only when you approve."
	if got.Why != want {
		t.Fatalf("why-line:\n got %q\nwant %q", got.Why, want)
	}
	// the blank artifact is dropped: a numbered citation chip with nothing in it names nothing
	if len(got.Cites) != 2 || got.Cites[0] != "docs/plans/auth.md" || got.Cites[1] != "pkg/auth/plan.go" {
		t.Fatalf("wrong cites: %+v", got.Cites)
	}
}

func TestGateItemLeavesAttributionEmptyWhenTheRunHasNoInitiative(t *testing.T) {
	items := BuildAttention(AttentionInput{Channels: []AttentionChannel{
		{OID: "c1", Runs: []*waveobj.Run{gatedRun("r1", "g", 1)}},
	}})
	if items[0].EffortOID != "" || items[0].ChunkLabel != "" {
		t.Fatalf("an unattributed run must name no initiative: %+v", items[0])
	}
	if len(items[0].Cites) != 0 {
		t.Fatalf("a phase that recorded nothing cites nothing: %+v", items[0].Cites)
	}
}

func TestGateWhySaysTheRunSealsWhenNothingFollowsTheGate(t *testing.T) {
	run := &waveobj.Run{ID: "r1", Status: "awaiting-review", Phases: []waveobj.RunPhase{
		{Kind: "execute", State: "done", Gate: true, DoneTs: 5},
	}}
	items := BuildAttention(AttentionInput{Channels: []AttentionChannel{{OID: "c1", Runs: []*waveobj.Run{run}}}})
	want := "The execute phase finished — 1 of 1 done. The run seals only when you approve."
	if items[0].Why != want {
		t.Fatalf("why-line:\n got %q\nwant %q", items[0].Why, want)
	}
}

func TestGateWhyNamesAHeldLeadRatherThanAFinishedPhase(t *testing.T) {
	run := &waveobj.Run{ID: "r1", Status: "awaiting-review", Phases: []waveobj.RunPhase{
		{Kind: "orchestrate", State: "running", Held: true},
		{Kind: "execute", State: "pending"},
	}}
	items := BuildAttention(AttentionInput{Channels: []AttentionChannel{{OID: "c1", Runs: []*waveobj.Run{run}}}})
	want := "The lead paused itself in the orchestrate phase — 0 of 2 done. It resumes only when you approve."
	if items[0].Why != want {
		t.Fatalf("why-line:\n got %q\nwant %q", items[0].Why, want)
	}
}

// a custom phase's kind says nothing, so the skill is what names it
func TestGateWhyNamesACustomPhaseByItsSkill(t *testing.T) {
	run := &waveobj.Run{ID: "r1", Status: "awaiting-review", Phases: []waveobj.RunPhase{
		{Kind: "custom", Skill: "superpowers:writing-plans", State: "done", Gate: true, DoneTs: 5},
		{Kind: "custom", State: "pending"},
	}}
	items := BuildAttention(AttentionInput{Channels: []AttentionChannel{{OID: "c1", Runs: []*waveobj.Run{run}}}})
	want := "The superpowers:writing-plans phase finished — 1 of 2 done. The custom phase starts only when you approve."
	if items[0].Why != want {
		t.Fatalf("why-line:\n got %q\nwant %q", items[0].Why, want)
	}
}

func TestGateCitesAreCappedAndTheRemainderIsCounted(t *testing.T) {
	run := gatedRun("r1", "g", 1)
	run.Phases[0].Artifacts = []string{"a", "b", "c", "d", "e", "f"}
	items := BuildAttention(AttentionInput{Channels: []AttentionChannel{{OID: "c1", Runs: []*waveobj.Run{run}}}})
	cites := items[0].Cites
	if len(cites) != attentionCiteMax+1 || cites[attentionCiteMax] != "+2 more" {
		t.Fatalf("want 4 artifacts plus a counted remainder, got %+v", cites)
	}
	if cites[0] != "a" || cites[3] != "d" {
		t.Fatalf("the cap must keep the first artifacts in order: %+v", cites)
	}
}

func TestAskAndEscalationCarryTheWorkerRunsInitiative(t *testing.T) {
	run := &waveobj.Run{
		ID:        "r9",
		EffortRef: &waveobj.RunEffortRef{EffortOID: "e-2", ChunkLabel: "backfill"},
		Phases:    []waveobj.RunPhase{{State: "running", WorkerOrefs: []string{"tab:w"}}},
	}
	in := AttentionInput{
		Channels: []AttentionChannel{{OID: "c1", Name: "alpha", Runs: []*waveobj.Run{run},
			Messages: []*waveobj.ChannelMessage{escalationMsg("m1", "block:a", "tab:w", "Which order?", 900)}}},
		PendingAsks: map[string]agentask.PendingAsk{
			"block:a": {AskId: "1", Ts: 900},
			"block:b": {AskId: "2", Ts: 950, Questions: []baseds.AgentAskQuestion{{Question: "Which DB?"}}},
		},
		AskChannel:    map[string]string{"block:a": "c1", "block:b": "c1"},
		AskWorker:     map[string]string{"block:a": "worker-3", "block:b": "worker-3"},
		AskWorkerORef: map[string]string{"block:a": "tab:w", "block:b": "tab:w"},
	}
	items := BuildAttention(in)
	if len(items) != 2 {
		t.Fatalf("want an escalation and an ask, got %+v", items)
	}
	esc, ask := items[0], items[1]
	if esc.Kind != AttentionEscalation || ask.Kind != AttentionAsk {
		t.Fatalf("wrong order: %+v", items)
	}
	for _, it := range items {
		if it.EffortOID != "e-2" || it.ChunkLabel != "backfill" || it.RunId != "r9" {
			t.Fatalf("%s lost its worker run's attribution: %+v", it.Kind, it)
		}
	}
	if esc.Why != "Jarvis escalated this instead of answering it; worker-3 is paused until it is decided." {
		t.Fatalf("escalation why-line: %q", esc.Why)
	}
	if ask.Why != "worker-3 is paused until you answer." {
		t.Fatalf("ask why-line: %q", ask.Why)
	}
}

func TestPlanGateWhyCountsTheTasksItWouldSpawn(t *testing.T) {
	run := &waveobj.Run{ID: "r1", EffortRef: &waveobj.RunEffortRef{EffortOID: "e-1", ChunkLabel: "ship it"}}
	g := &waveobj.TaskGroup{ID: "d1", RunID: "r1", ChannelId: "c1", PlanGate: true, UpdatedTs: 10,
		Tasks: []waveobj.TaskNode{{ID: "t-1", State: "pending"}}}
	items := BuildAttention(AttentionInput{
		Channels: []AttentionChannel{{OID: "c1", Runs: []*waveobj.Run{run}}},
		Dags:     []*waveobj.TaskGroup{g},
	})
	if len(items) != 1 || items[0].Kind != AttentionPlanGate {
		t.Fatalf("want one plan gate, got %+v", items)
	}
	// singular at one: "1 tasks planned" would read as a bug in the number
	want := "1 task planned, none dispatched. Approving is what spawns the first worker."
	if items[0].Why != want {
		t.Fatalf("why-line:\n got %q\nwant %q", items[0].Why, want)
	}
	if items[0].EffortOID != "e-1" || items[0].ChunkLabel != "ship it" {
		t.Fatalf("a dag item is attributed through its owning run: %+v", items[0])
	}
}

func TestDagGateAndBlockedWhyCountSkippedTasksAsFinished(t *testing.T) {
	tasks := []waveobj.TaskNode{
		{ID: "t-1", State: "done"},
		{ID: "t-2", State: "skipped"},
		{ID: "t-3", Label: "merge", State: "done", Gate: true, LastActivity: 40},
		{ID: "t-4", State: "pending"},
	}
	gate := BuildAttention(AttentionInput{Dags: []*waveobj.TaskGroup{
		{ID: "d1", RunID: "r1", ChannelId: "c1", Status: "awaiting-review", Tasks: tasks, UpdatedTs: 40},
	}})
	if len(gate) != 1 || gate[0].Kind != AttentionDagGate {
		t.Fatalf("want one dag gate, got %+v", gate)
	}
	want := "3 of 4 tasks done. Everything downstream stays queued until this one is released."
	if gate[0].Why != want {
		t.Fatalf("dag-gate why-line:\n got %q\nwant %q", gate[0].Why, want)
	}

	blocked := BuildAttention(AttentionInput{Dags: []*waveobj.TaskGroup{
		{ID: "d1", RunID: "r1", ChannelId: "c1", Status: "blocked", Failures: 3, Tasks: tasks, UpdatedTs: 40},
	}})
	wantBlocked := "3 of 4 tasks done. The group stays stopped until you retry or skip."
	if blocked[0].Why != wantBlocked {
		t.Fatalf("dag-blocked why-line:\n got %q\nwant %q", blocked[0].Why, wantBlocked)
	}
}

func TestTriageWhySplitsNewFromRecurring(t *testing.T) {
	dismissed := &waveobj.RadarDisposition{}
	items := BuildAttention(AttentionInput{Radar: []*waveobj.RadarReport{{
		OID: uuid.NewString(), ProjectPath: "/p", ProjectName: "p", Status: radarStatusCompleted, CompletedTs: 7,
		Findings: []waveobj.RadarFinding{
			{Group: radarGroupNew},
			{Group: radarGroupRecurring},
			{Group: radarGroupRecurring},
			{Group: radarGroupNew, Disposition: dismissed},
		},
	}}})
	if len(items) != 1 {
		t.Fatalf("want one triage row, got %+v", items)
	}
	if items[0].Text != "3 findings need triage." {
		t.Fatalf("the total must still exclude the decided finding: %q", items[0].Text)
	}
	if items[0].Why != "1 new and 2 recurring, none of them ruled on yet." {
		t.Fatalf("triage why-line: %q", items[0].Why)
	}
}
