// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// runAskFixture wires a channel and a run with no dag whose phase owns a worker tab, and a block for that
// tab: a lead's own session. Returns the channel, the run, and the block oref.
func runAskFixture(t *testing.T) (*waveobj.Channel, *waveobj.Run, string) {
	t.Helper()
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "runask", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tabId := uuid.NewString()
	blockId := uuid.NewString()
	if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: tabId, BlockIds: []string{blockId}}); err != nil {
		t.Fatal(err)
	}
	if err := wstore.DBInsert(ctx, &waveobj.Block{OID: blockId, ParentORef: "tab:" + tabId}); err != nil {
		t.Fatal(err)
	}
	run := waveobj.Run{ID: uuid.NewString(), Goal: "g", Status: "executing", Phases: []waveobj.RunPhase{{WorkerOrefs: []string{"tab:" + tabId}}}}
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatal(err)
	}
	return ch, &run, "block:" + blockId
}

func TestRunAsksAndAnswerReachTheRunsOwnSession(t *testing.T) {
	ch, run, blockORef := runAskFixture(t)
	ws := &WshServer{}
	agentask.GlobalRegistry = agentask.MakeRegistry()
	q := baseds.AgentAskQuestion{Question: "A or B?", Options: []baseds.AgentAskOption{{Label: "A"}, {Label: "B"}}}
	agentask.GlobalRegistry.Set(blockORef, agentask.PendingAsk{AskId: "ask-lead", Questions: []baseds.AgentAskQuestion{q}, Ts: 1})
	waiter := agentask.GlobalRegistry.RegisterWaiter("ask-lead")

	asks, err := ws.RunAsksCommand(context.Background(), wshrpc.CommandRunAskData{ChannelId: ch.OID, RunId: run.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(asks.Asks) != 1 || asks.Asks[0].Questions[0].Question != "A or B?" || asks.Asks[0].BlockORef != blockORef {
		t.Fatalf("asks = %+v, want the run's own question", asks.Asks)
	}
	if err := ws.RunAnswerCommand(context.Background(), wshrpc.CommandRunAnswerData{
		ChannelId: ch.OID, RunId: run.ID, Answers: []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}},
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case res := <-waiter:
		if len(res.Answers) != 1 || res.Answers[0].SelectedIndexes[0] != 1 {
			t.Fatalf("answer not delivered: %+v", res.Answers)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("waiter never resolved")
	}
	if err := ws.RunAnswerCommand(context.Background(), wshrpc.CommandRunAnswerData{
		ChannelId: ch.OID, RunId: run.ID, Answers: []baseds.AgentAnswerItem{{SelectedIndexes: []int{0}}},
	}); err == nil || !strings.Contains(err.Error(), "has no pending question") {
		t.Fatalf("second answer err = %v, want no pending question", err)
	}
}

func TestRunAsksWithNoPendingQuestionIsEmpty(t *testing.T) {
	ch, run, _ := runAskFixture(t)
	ws := &WshServer{}
	agentask.GlobalRegistry = agentask.MakeRegistry()
	asks, err := ws.RunAsksCommand(context.Background(), wshrpc.CommandRunAskData{ChannelId: ch.OID, RunId: run.ID})
	if err != nil {
		t.Fatal(err)
	}
	if asks.Asks == nil || len(asks.Asks) != 0 {
		t.Fatalf("asks = %#v, want an empty list", asks.Asks)
	}
	err = ws.RunAnswerCommand(context.Background(), wshrpc.CommandRunAnswerData{
		ChannelId: ch.OID, RunId: run.ID, Answers: []baseds.AgentAnswerItem{{SelectedIndexes: []int{0}}},
	})
	if err == nil || err.Error() != "run "+run.ID+" has no pending question" {
		t.Fatalf("answer err = %v, want run %s has no pending question", err, run.ID)
	}
}
