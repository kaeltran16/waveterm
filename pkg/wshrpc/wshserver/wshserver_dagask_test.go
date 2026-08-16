// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// dagAskFixture wires a channel, an orchestrator owner run with a dag, a child run whose phase owns a
// worker tab, and a block for that tab. Returns the dag, child run, and block oref.
func dagAskFixture(t *testing.T) (*waveobj.TaskGroup, *waveobj.Run, string) {
	t.Helper()
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "dagask", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	owner.ID = uuid.NewString()
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := orchestrate.NewTaskGroup(owner.ID, ch.OID, "g", 2, []waveobj.TaskNode{{ID: "t-0", Label: "a"}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if err := wstore.UpdateRun(ctx, ch.OID, owner.ID, func(r *waveobj.Run) error {
		r.DagORef = g.OID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	tabId := uuid.NewString()
	blockId := uuid.NewString()
	child := jarvis.NewRun("child goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	child.ID = uuid.NewString()
	child.DagORef = g.OID
	child.Phases[0].WorkerOrefs = []string{"tab:" + tabId}
	if err := wstore.AppendRun(ctx, ch.OID, child); err != nil {
		t.Fatal(err)
	}
	tab := &waveobj.Tab{OID: tabId, BlockIds: []string{blockId}}
	if err := wstore.DBInsert(ctx, tab); err != nil {
		t.Fatal(err)
	}
	block := &waveobj.Block{OID: blockId, ParentORef: "tab:" + tabId}
	if err := wstore.DBInsert(ctx, block); err != nil {
		t.Fatal(err)
	}
	childORef := "block:" + blockId
	// the child run is running for this dag
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		for i := range cur.Tasks {
			cur.Tasks[i].RunID = child.ID
			cur.Tasks[i].State = orchestrate.TaskState_Running
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return &g, &child, childORef
}

// wsCaptureClient records broker events so tests can assert event publishing (mirrors the capture
// client in pkg/orchestrate's engine tests).
type wsCaptureClient struct {
	mu     sync.Mutex
	events []wps.WaveEvent
}

func (c *wsCaptureClient) SendEvent(_ string, event wps.WaveEvent) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, event)
}

func (c *wsCaptureClient) saw(kind, scope string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, e := range c.events {
		if e.Event == kind && e.HasScope(scope) {
			return true
		}
	}
	return false
}

func TestAskCommandForwardsDagChildAsk(t *testing.T) {
	cc := &wsCaptureClient{}
	prevClient := wps.Broker.GetClient()
	wps.Broker.SetClient(cc)
	defer wps.Broker.SetClient(prevClient)
	wps.Broker.Subscribe("dagask-events", wps.SubscriptionRequest{Event: orchestrate.DagEventChildAsk, AllScopes: true})
	defer wps.Broker.Unsubscribe("dagask-events", orchestrate.DagEventChildAsk)

	g, _, blockORef := dagAskFixture(t)
	scope := waveobj.MakeORef(waveobj.OType_Dag, g.OID).String()

	ws := &WshServer{}
	agentask.GlobalRegistry = agentask.MakeRegistry()
	rtn, err := ws.AskCommand(context.Background(), askData(blockORef, false))
	if err != nil {
		t.Fatal(err)
	}
	if rtn.AskId == "" {
		t.Fatal("ask not registered")
	}
	if !cc.saw(orchestrate.DagEventChildAsk, scope) {
		t.Fatal("dag:child-ask event not published for a dag child's ask")
	}
	if !cc.saw(orchestrate.DagEventChildAsk, waveobj.MakeORef(waveobj.OType_Run, g.RunID).String()) {
		t.Fatal("dag:child-ask event not scoped to the owning run")
	}
}

func TestAskCommandNotForwardedForPlainBlock(t *testing.T) {
	cc := &wsCaptureClient{}
	prevClient := wps.Broker.GetClient()
	wps.Broker.SetClient(cc)
	defer wps.Broker.SetClient(prevClient)

	ws := &WshServer{}
	agentask.GlobalRegistry = agentask.MakeRegistry()
	oref := waveobj.MakeORef("block", uuid.NewString()).String()
	if _, err := ws.AskCommand(context.Background(), askData(oref, false)); err != nil {
		t.Fatal(err)
	}
	if cc.saw(orchestrate.DagEventChildAsk, "") {
		t.Fatal("plain block ask must not publish a dag event")
	}
}

func TestDagAsksAndAnswerRoundTrip(t *testing.T) {
	g, _, blockORef := dagAskFixture(t)
	ws := &WshServer{}
	agentask.GlobalRegistry = agentask.MakeRegistry()

	// seed a pending ask with a registered waiter deterministically (AskCommand's set-then-wait order
	// races an eager answer into the keystroke path)
	q := baseds.AgentAskQuestion{
		Question: "A or B?",
		Options:  []baseds.AgentAskOption{{Label: "A"}, {Label: "B"}},
	}
	agentask.GlobalRegistry.Set(blockORef, agentask.PendingAsk{
		AskId:     "ask-roundtrip",
		BlockId:   "",
		Questions: []baseds.AgentAskQuestion{q},
		Ts:        1,
	})
	waiter := agentask.GlobalRegistry.RegisterWaiter("ask-roundtrip")

	asks, err := ws.DagAsksCommand(context.Background(), wshrpc.CommandDagStatusData{ChannelId: g.ChannelId, RunId: g.RunID})
	if err != nil {
		t.Fatal(err)
	}
	if len(asks.Asks) != 1 || asks.Asks[0].TaskId != "t-0" || asks.Asks[0].Question != "A or B?" {
		t.Fatalf("asks mismatch: %+v", asks.Asks)
	}
	if len(asks.Asks[0].Options) != 2 || asks.Asks[0].Options[1].Label != "B" {
		t.Fatalf("options not carried: %+v", asks.Asks[0].Options)
	}

	if err := ws.DagAnswerCommand(context.Background(), wshrpc.CommandDagAnswerData{
		ChannelId: g.ChannelId, RunId: g.RunID, TaskId: "t-0",
		Answers: []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}},
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case res := <-waiter:
		if len(res.Answers) != 1 || len(res.Answers[0].SelectedIndexes) != 1 || res.Answers[0].SelectedIndexes[0] != 1 {
			t.Fatalf("answer not delivered: %+v", res.Answers)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("waiter never resolved")
	}
	// the ask is gone: asks now empty
	asks2, err := ws.DagAsksCommand(context.Background(), wshrpc.CommandDagStatusData{ChannelId: g.ChannelId, RunId: g.RunID})
	if err != nil {
		t.Fatal(err)
	}
	if len(asks2.Asks) != 0 {
		t.Fatalf("ask should be consumed, got %+v", asks2.Asks)
	}
}
