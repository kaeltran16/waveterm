// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentctl"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestAgentControlStreamsWhatIsSentUntilTheCallerLeaves(t *testing.T) {
	const blockId = "5f2b1c0e-8a41-4a6b-9d3e-0c7f6a1b2d34"
	ctx, cancel := context.WithCancel(context.Background())
	oref := waveobj.MakeORef(waveobj.OType_Block, blockId).String()
	ch := (&WshServer{}).AgentControlCommand(ctx, wshrpc.CommandAgentControlData{ORef: oref})
	if !agentctl.Send(blockId, agentctl.Msg{Text: "wake: task 1 done", MidTurn: true}) {
		t.Fatalf("the open stream did not take the text")
	}
	select {
	case msg := <-ch:
		if msg.Error != nil || msg.Response.Text != "wake: task 1 done" || !msg.Response.MidTurn {
			t.Fatalf("got %+v", msg)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("nothing streamed")
	}
	cancel()
	select {
	case _, open := <-ch:
		if open {
			t.Fatalf("a message after the caller left")
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("the stream stayed open after the caller left")
	}
	if agentctl.Has(blockId) {
		t.Fatalf("the block still has a stream after the caller left")
	}
}

func TestAgentControlPassesQueueAndTakeBackToTheStream(t *testing.T) {
	const blockId = "7c0d2e91-3b5a-4f68-8e1d-2a9b4c6d8e10"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	oref := waveobj.MakeORef(waveobj.OType_Block, blockId).String()
	ch := (&WshServer{}).AgentControlCommand(ctx, wshrpc.CommandAgentControlData{ORef: oref})
	if !agentctl.Send(blockId, agentctl.Msg{Text: "and the tests", MidTurn: true, Queue: true}) ||
		!agentctl.Send(blockId, agentctl.Msg{TakeBack: "r1"}) {
		t.Fatalf("the open stream did not take the messages")
	}
	read := func() wshrpc.AgentControlMsg {
		select {
		case msg := <-ch:
			if msg.Error != nil {
				t.Fatalf("stream error: %v", msg.Error)
			}
			return msg.Response
		case <-time.After(2 * time.Second):
			t.Fatalf("nothing streamed")
		}
		return wshrpc.AgentControlMsg{}
	}
	if got := read(); got.Text != "and the tests" || !got.MidTurn || !got.Queue || got.TakeBack != "" {
		t.Fatalf("queued text: got %+v", got)
	}
	if got := read(); got.TakeBack != "r1" || got.Text != "" || got.Queue {
		t.Fatalf("take-back: got %+v", got)
	}
}

// the mod's stream ending with no newer one is a session's end: nothing it held can reach the agent now
func TestAgentControlEndingLosesWhatTheModHeld(t *testing.T) {
	const blockId = "8d1e3f02-4c6b-4a79-9f2e-3b0c5d7e9f21"
	ctx, cancel := context.WithCancel(context.Background())
	ch := (&WshServer{}).AgentControlCommand(ctx, wshrpc.CommandAgentControlData{ORef: waveobj.MakeORef(waveobj.OType_Block, blockId).String()})
	held := []baseds.QueuedPrompt{{Id: "m1", Text: "and the tests", Ts: 10}}
	if err := (&WshServer{}).SetAgentQueueCommand(context.Background(), wshrpc.CommandSetAgentQueueData{BlockId: blockId, Held: held}); err != nil {
		t.Fatal(err)
	}
	cancel()
	for range ch {
	}
	got, _ := queueEvent(t, blockId)
	if len(got.Held) != 0 || !reflect.DeepEqual(got.Lost, held) {
		t.Fatalf("event after the stream ended = %+v, want held [] and lost %+v", got, held)
	}
}

func TestAgentControlRefusesAnORefThatIsNoBlock(t *testing.T) {
	ch := (&WshServer{}).AgentControlCommand(context.Background(), wshrpc.CommandAgentControlData{ORef: "tab:abc"})
	if msg := <-ch; msg.Error == nil {
		t.Fatalf("a tab oref opened a stream")
	}
}
