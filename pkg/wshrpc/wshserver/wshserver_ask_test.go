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
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

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
		errCh <- err
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
