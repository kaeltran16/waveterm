// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

type askResolveClient struct {
	onEvent func(wps.WaveEvent)
}

func (c *askResolveClient) SendEvent(_ string, event wps.WaveEvent) {
	c.onEvent(event)
}

func askData(oref string, wait bool) wshrpc.CommandAskData {
	return wshrpc.CommandAskData{
		ORef: oref,
		Questions: []baseds.AgentAskQuestion{{
			Question: "A or B?",
			Options:  []baseds.AgentAskOption{{Label: "A"}, {Label: "B"}},
		}},
		Wait: wait,
	}
}

func TestAskCommandRegistersWaiterBeforePublishing(t *testing.T) {
	ws := &WshServer{}
	oref := waveobj.MakeORef(waveobj.OType_Block, uuid.NewString()).String()
	agentask.GlobalRegistry = agentask.MakeRegistry()
	originalClient := wps.Broker.GetClient()
	wps.Broker.SetClient(&askResolveClient{onEvent: func(event wps.WaveEvent) {
		data, ok := event.Data.(baseds.AgentAskData)
		if !ok || data.Cleared {
			return
		}
		pending, ok := agentask.GlobalRegistry.Claim(data.ORef, data.AskId)
		if ok {
			agentask.GlobalRegistry.ResolveWaiter(pending.AskId, agentask.WaitResult{Cancelled: true})
		}
	}})
	wps.Broker.Subscribe("ask-wait-order", wps.SubscriptionRequest{Event: wps.Event_AgentAsk, Scopes: []string{oref}})
	t.Cleanup(func() {
		wps.Broker.UnsubscribeAll("ask-wait-order")
		wps.Broker.SetClient(originalClient)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	rtn, err := ws.AskCommand(ctx, askData(oref, true))
	if err != nil {
		t.Fatalf("ask must resolve during publish: %v", err)
	}
	if !rtn.Cancelled {
		t.Fatalf("publish-time clear must cancel the waiter: %#v", rtn)
	}
}

func TestAskCommandWaitResolvesViaAnswer(t *testing.T) {
	ws := &WshServer{}
	// ParseORef requires a UUID oid, so fixtures use real UUIDs, not "w1".
	oref := waveobj.MakeORef("block", uuid.NewString()).String()
	agentask.GlobalRegistry = agentask.MakeRegistry()
	rtnCh := make(chan wshrpc.AskRtnData, 1)
	errCh := make(chan error, 1)
	go func() {
		rtn, err := ws.AskCommand(context.Background(), askData(oref, true))
		rtnCh <- rtn
		if err != nil {
			errCh <- err
		}
	}()
	// wait until the pending ask is registered, then answer it
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, ok := agentask.GlobalRegistry.Get(oref); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("pending ask never registered")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := ws.AnswerAgentCommand(context.Background(), wshrpc.CommandAnswerAgentData{
		ORef:    oref,
		Answers: []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}},
	}); err != nil {
		t.Fatalf("answer: %v", err)
	}
	select {
	case rtn := <-rtnCh:
		if rtn.Cancelled || len(rtn.Answers) != 1 || rtn.Answers[0].SelectedIndexes[0] != 1 {
			t.Fatalf("bad wait result: %#v", rtn)
		}
	case err := <-errCh:
		t.Fatalf("ask wait errored: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("wait RPC never returned")
	}
	if _, ok := agentask.GlobalRegistry.Get(oref); ok {
		t.Fatal("pending ask must be claimed after delivery")
	}
}

func TestAnswerAgentCommandPublishesClearedEvent(t *testing.T) {
	ws := &WshServer{}
	oref := waveobj.MakeORef("block", uuid.NewString()).String()
	agentask.GlobalRegistry = agentask.MakeRegistry()
	agentask.GlobalRegistry.Set(oref, agentask.PendingAsk{
		AskId:     "ask-answer-clear",
		BlockId:   uuid.NewString(),
		Questions: askData(oref, false).Questions,
	})
	agentask.GlobalRegistry.RegisterWaiter("ask-answer-clear")
	originalAnswerHook := agentask.AnswerHook
	agentask.AnswerHook = RecordAskAnswered
	t.Cleanup(func() { agentask.AnswerHook = originalAnswerHook })

	if err := ws.AnswerAgentCommand(context.Background(), wshrpc.CommandAnswerAgentData{
		ORef:    oref,
		Answers: []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}},
	}); err != nil {
		t.Fatalf("answer: %v", err)
	}

	events := wps.Broker.ReadEventHistory(wps.Event_AgentAsk, oref, 1)
	if len(events) != 1 {
		t.Fatalf("successful answer must publish one clear event, got %d", len(events))
	}
	got, ok := events[0].Data.(baseds.AgentAskData)
	if !ok || !got.Cleared || got.ORef != oref || got.AskId != "ask-answer-clear" {
		t.Fatalf("clear event = %#v", events[0].Data)
	}
}

func TestAskCommandWaitCancelCleansUp(t *testing.T) {
	ws := &WshServer{}
	oref := waveobj.MakeORef("block", uuid.NewString()).String()
	agentask.GlobalRegistry = agentask.MakeRegistry()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := ws.AskCommand(ctx, askData(oref, true))
		done <- err
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, ok := agentask.GlobalRegistry.Get(oref); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("pending ask never registered")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancel must return an error")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("wait RPC never returned after cancel")
	}
	if _, ok := agentask.GlobalRegistry.Get(oref); ok {
		t.Fatal("cancel must drop the pending ask")
	}
}

func TestAskCommandClearCancelsWaiter(t *testing.T) {
	ws := &WshServer{}
	oref := waveobj.MakeORef("block", uuid.NewString()).String()
	agentask.GlobalRegistry = agentask.MakeRegistry()
	rtnCh := make(chan wshrpc.AskRtnData, 1)
	go func() {
		rtn, _ := ws.AskCommand(context.Background(), askData(oref, true))
		rtnCh <- rtn
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, ok := agentask.GlobalRegistry.Get(oref); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("pending ask never registered")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := ws.AgentAskClearCommand(context.Background(), oref); err != nil {
		t.Fatalf("clear: %v", err)
	}
	select {
	case rtn := <-rtnCh:
		if !rtn.Cancelled || len(rtn.Answers) != 0 {
			t.Fatalf("clear must resolve the waiter cancelled: %#v", rtn)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("wait RPC never returned after clear")
	}
}

func TestAskCommandThreadsProse(t *testing.T) {
	ws := &WshServer{}
	oref := waveobj.MakeORef("block", uuid.NewString()).String()
	agentask.GlobalRegistry = agentask.MakeRegistry()
	data := askData(oref, false)
	data.Prose = true
	if _, err := ws.AskCommand(context.Background(), data); err != nil {
		t.Fatalf("ask: %v", err)
	}
	pending, ok := agentask.GlobalRegistry.Get(oref)
	if !ok || !pending.Prose {
		t.Fatalf("want prose pending ask, got %+v (ok=%v)", pending, ok)
	}
}
