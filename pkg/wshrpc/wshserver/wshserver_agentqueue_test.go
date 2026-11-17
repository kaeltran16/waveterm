// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// queueEvent is the newest agent:queue event for blockId; ok is false when none was published.
func queueEvent(t *testing.T, blockId string) (data baseds.AgentQueueData, ok bool) {
	t.Helper()
	events := wps.Broker.ReadEventHistory(wps.Event_AgentQueue, blockORef(blockId), 1)
	if len(events) == 0 {
		return data, false
	}
	data, ok = events[0].Data.(baseds.AgentQueueData)
	if !ok {
		t.Fatalf("agent:queue data is %T", events[0].Data)
	}
	return data, true
}

// openControl opens blockId's mod stream as `wsh agentctl` does; it closes when the test ends.
func openControl(t *testing.T, blockId string) chan wshrpc.RespOrErrorUnion[wshrpc.AgentControlMsg] {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return (&WshServer{}).AgentControlCommand(ctx, wshrpc.CommandAgentControlData{ORef: blockORef(blockId)})
}

func TestSetAgentQueuePublishesTheReport(t *testing.T) {
	const blockId = "e1000000-0000-4000-8000-000000000001"
	openControl(t, blockId)
	ws := &WshServer{}
	m1, m2 := baseds.QueuedPrompt{Id: "m1", Text: "one", Ts: 10}, baseds.QueuedPrompt{Id: "m2", Text: "two", Ts: 11}
	if err := ws.SetAgentQueueCommand(context.Background(), wshrpc.CommandSetAgentQueueData{BlockId: blockId, Held: []baseds.QueuedPrompt{m1, m2}}); err != nil {
		t.Fatal(err)
	}
	if got, _ := queueEvent(t, blockId); !reflect.DeepEqual(got.Held, []baseds.QueuedPrompt{m1, m2}) {
		t.Fatalf("event = %+v, want held [m1 m2]", got)
	}
	// m1 was sent at the turn's end; m2 vanished
	if err := ws.SetAgentQueueCommand(context.Background(), wshrpc.CommandSetAgentQueueData{BlockId: blockId, Held: []baseds.QueuedPrompt{}, Left: []wshrpc.QueueLeft{{Id: "m1", How: "sent"}}}); err != nil {
		t.Fatal(err)
	}
	if got, _ := queueEvent(t, blockId); len(got.Held) != 0 || !reflect.DeepEqual(got.Lost, []baseds.QueuedPrompt{m2}) {
		t.Fatalf("event = %+v, want held [] and lost [m2]", got)
	}
}

func TestSetAgentQueueRefusesAReportItCannotPlace(t *testing.T) {
	ws := &WshServer{}
	for _, data := range []wshrpc.CommandSetAgentQueueData{
		{Held: []baseds.QueuedPrompt{{Id: "m1", Text: "one"}}},
		{BlockId: "e1000000-0000-4000-8000-000000000002", Left: []wshrpc.QueueLeft{{Id: "m1", How: "eaten"}}},
		{BlockId: "e1000000-0000-4000-8000-000000000002", TakeBack: "nobody-asked"},
	} {
		if err := ws.SetAgentQueueCommand(context.Background(), data); err == nil {
			t.Errorf("%+v: want a refusal", data)
		}
	}
	if _, ok := queueEvent(t, "e1000000-0000-4000-8000-000000000002"); ok {
		t.Fatalf("a refused report published")
	}
}

func TestAgentTakeBackWithNoStreamErrorsAtOnce(t *testing.T) {
	start := time.Now()
	if _, err := (&WshServer{}).AgentTakeBackCommand(context.Background(), wshrpc.CommandAgentTakeBackData{BlockId: "e1000000-0000-4000-8000-000000000003"}); err == nil {
		t.Fatalf("a take-back with no stream succeeded")
	}
	if time.Since(start) > time.Second {
		t.Fatalf("a take-back with no stream waited %v", time.Since(start))
	}
	if _, err := (&WshServer{}).AgentTakeBackCommand(context.Background(), wshrpc.CommandAgentTakeBackData{}); err == nil {
		t.Fatalf("a take-back naming no block succeeded")
	}
}

func TestAgentTakeBackReturnsWhatTheModHandsBack(t *testing.T) {
	const blockId = "e1000000-0000-4000-8000-000000000004"
	ch := openControl(t, blockId)
	ws := &WshServer{}
	m1, m2 := baseds.QueuedPrompt{Id: "m1", Text: "one", Ts: 10}, baseds.QueuedPrompt{Id: "m2", Text: "/compact", Ts: 11}
	if err := ws.SetAgentQueueCommand(context.Background(), wshrpc.CommandSetAgentQueueData{BlockId: blockId, Held: []baseds.QueuedPrompt{m1, m2}}); err != nil {
		t.Fatal(err)
	}
	modErr := make(chan error, 1)
	go func() {
		// the mod: read the request off the stream and report everything handed back, naming it
		msg := <-ch
		if msg.Error != nil || msg.Response.TakeBack == "" {
			modErr <- fmt.Errorf("the stream got %+v, want a take-back request", msg)
			return
		}
		modErr <- ws.SetAgentQueueCommand(context.Background(), wshrpc.CommandSetAgentQueueData{
			BlockId:  blockId,
			Held:     []baseds.QueuedPrompt{},
			Left:     []wshrpc.QueueLeft{{Id: "m1", How: "takenback"}, {Id: "m2", How: "takenback"}},
			TakeBack: msg.Response.TakeBack,
		})
	}()
	rtn, err := ws.AgentTakeBackCommand(context.Background(), wshrpc.CommandAgentTakeBackData{BlockId: blockId})
	if err != nil {
		t.Fatal(err)
	}
	if err := <-modErr; err != nil {
		t.Fatalf("the mod's answering report: %v", err)
	}
	if !reflect.DeepEqual(rtn.Items, []baseds.QueuedPrompt{m1, m2}) {
		t.Fatalf("taken back %+v, want [m1 m2]", rtn.Items)
	}
	if got, _ := queueEvent(t, blockId); len(got.Held) != 0 || len(got.Lost) != 0 {
		t.Fatalf("event after take-back = %+v, want nothing held or lost", got)
	}
}
