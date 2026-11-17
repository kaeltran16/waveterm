// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentctl

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

func prompt(id, text string) baseds.QueuedPrompt {
	return baseds.QueuedPrompt{Id: id, Text: text, Ts: 1}
}

// lastQueueEvent is the newest agent:queue event published for blockId, and whether there is one.
func lastQueueEvent(t *testing.T, blockId string) (baseds.AgentQueueData, bool) {
	t.Helper()
	oref := waveobj.MakeORef(waveobj.OType_Block, blockId).String()
	events := wps.Broker.ReadEventHistory(wps.Event_AgentQueue, oref, 1)
	if len(events) == 0 {
		return baseds.AgentQueueData{}, false
	}
	data, ok := events[0].Data.(baseds.AgentQueueData)
	if !ok {
		t.Fatalf("agent:queue data is %T", events[0].Data)
	}
	if data.ORef != oref {
		t.Fatalf("event oref %q, want %q", data.ORef, oref)
	}
	return data, true
}

func TestAReportPublishesTheHeldList(t *testing.T) {
	const block = "q-report"
	_, done := Register(block)
	defer done()
	held := []baseds.QueuedPrompt{prompt("m1", "and the tests"), prompt("m2", "/compact")}
	if err := Report(block, held, nil, ""); err != nil {
		t.Fatal(err)
	}
	got, ok := lastQueueEvent(t, block)
	if !ok || !reflect.DeepEqual(got.Held, held) || len(got.Lost) != 0 {
		t.Fatalf("event = %+v, want held %+v and nothing lost", got, held)
	}
}

func TestAnItemDroppedWithoutLeavingIsLost(t *testing.T) {
	const block = "q-lost"
	_, done := Register(block)
	defer done()
	m1, m2, m3 := prompt("m1", "one"), prompt("m2", "two"), prompt("m3", "three")
	if err := Report(block, []baseds.QueuedPrompt{m1, m2, m3}, nil, ""); err != nil {
		t.Fatal(err)
	}
	// m1 joined; m2 vanished with no word of how; m3 stays
	if err := Report(block, []baseds.QueuedPrompt{m3}, []Left{{Id: "m1", How: LeftJoined}}, ""); err != nil {
		t.Fatal(err)
	}
	got, _ := lastQueueEvent(t, block)
	if !reflect.DeepEqual(got.Held, []baseds.QueuedPrompt{m3}) || !reflect.DeepEqual(got.Lost, []baseds.QueuedPrompt{m2}) {
		t.Fatalf("event = %+v, want held [m3] and lost [m2]", got)
	}
}

// a reload's new mod reports empty at session.start: what the old one held never reached the agent
func TestAnEmptyReportFromANewStreamLosesWhatTheOldHeld(t *testing.T) {
	const block = "q-reload"
	_, oldDone := Register(block)
	m1 := prompt("m1", "one")
	if err := Report(block, []baseds.QueuedPrompt{m1}, nil, ""); err != nil {
		t.Fatal(err)
	}
	_, done := Register(block)
	defer done()
	oldDone()
	if err := Report(block, nil, nil, ""); err != nil {
		t.Fatal(err)
	}
	got, _ := lastQueueEvent(t, block)
	if len(got.Held) != 0 || got.Held == nil || !reflect.DeepEqual(got.Lost, []baseds.QueuedPrompt{m1}) {
		t.Fatalf("event = %+v, want held [] and lost [m1]", got)
	}
}

func TestEndingTheOnlyStreamLosesEveryHeldItem(t *testing.T) {
	const block = "q-end"
	_, done := Register(block)
	held := []baseds.QueuedPrompt{prompt("m1", "one"), prompt("m2", "two")}
	if err := Report(block, held, nil, ""); err != nil {
		t.Fatal(err)
	}
	done()
	got, _ := lastQueueEvent(t, block)
	if len(got.Held) != 0 || !reflect.DeepEqual(got.Lost, held) {
		t.Fatalf("event = %+v, want held [] and lost %+v", got, held)
	}
	// the next stream starts from nothing: its first report loses nothing again
	_, done2 := Register(block)
	defer done2()
	if err := Report(block, nil, nil, ""); err != nil {
		t.Fatal(err)
	}
	if got, _ := lastQueueEvent(t, block); len(got.Lost) != 0 {
		t.Fatalf("a held list already lost was lost again: %+v", got)
	}
}

func TestEndingAReplacedStreamPublishesNothing(t *testing.T) {
	const block = "q-replaced"
	_, oldDone := Register(block)
	_, done := Register(block)
	defer done()
	m1 := prompt("m1", "one")
	if err := Report(block, []baseds.QueuedPrompt{m1}, nil, ""); err != nil {
		t.Fatal(err)
	}
	oldDone()
	got, _ := lastQueueEvent(t, block)
	if !reflect.DeepEqual(got.Held, []baseds.QueuedPrompt{m1}) || len(got.Lost) != 0 {
		t.Fatalf("the replaced stream's end published %+v", got)
	}
}

func TestTakeBackWithNoStreamErrorsAtOnce(t *testing.T) {
	start := time.Now()
	if _, err := TakeBack(context.Background(), "q-nostream"); err == nil {
		t.Fatalf("a take-back with no stream succeeded")
	}
	if time.Since(start) > time.Second {
		t.Fatalf("a take-back with no stream waited %v", time.Since(start))
	}
}

// answer reads the take-back request off the stream and reports it answered, the mod's part
func answer(t *testing.T, msgs <-chan Msg, block string, held []baseds.QueuedPrompt, left []Left) error {
	t.Helper()
	var req Msg
	select {
	case req = <-msgs:
	case <-time.After(2 * time.Second):
		t.Fatalf("no take-back request reached the stream")
	}
	if req.TakeBack == "" || req.Text != "" || req.Queue {
		t.Fatalf("stream got %+v, want a take-back request alone", req)
	}
	return Report(block, held, left, req.TakeBack)
}

func TestTakeBackReturnsTheItemsOfTheReportNamingIt(t *testing.T) {
	const block = "q-takeback"
	msgs, done := Register(block)
	defer done()
	m1, m2 := prompt("m1", "one"), prompt("m2", "two")
	if err := Report(block, []baseds.QueuedPrompt{m1, m2}, nil, ""); err != nil {
		t.Fatal(err)
	}
	errc := make(chan error, 1)
	go func() {
		errc <- answer(t, msgs, block, nil, []Left{{Id: "m1", How: LeftTakenBack}, {Id: "m2", How: LeftTakenBack}})
	}()
	items, err := TakeBack(context.Background(), block)
	if err != nil {
		t.Fatal(err)
	}
	if err := <-errc; err != nil {
		t.Fatalf("the answering report: %v", err)
	}
	if !reflect.DeepEqual(items, []baseds.QueuedPrompt{m1, m2}) {
		t.Fatalf("taken back %+v, want [m1 m2]", items)
	}
	if got, _ := lastQueueEvent(t, block); len(got.Held) != 0 || len(got.Lost) != 0 {
		t.Fatalf("event after take-back = %+v, want nothing held or lost", got)
	}
	if len(msgs) != 0 {
		t.Fatalf("the take-back sent %d more messages", len(msgs))
	}
}

func TestTakeBackWithNoAnswerErrorsAndKeepsTheHeldList(t *testing.T) {
	const block = "q-noanswer"
	msgs, done := Register(block)
	defer done()
	m1 := prompt("m1", "one")
	if err := Report(block, []baseds.QueuedPrompt{m1}, nil, ""); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := TakeBack(ctx, block); err == nil {
		t.Fatalf("a take-back nobody answered succeeded")
	}
	req := <-msgs
	if got, _ := lastQueueEvent(t, block); !reflect.DeepEqual(got.Held, []baseds.QueuedPrompt{m1}) {
		t.Fatalf("held after an unanswered take-back = %+v, want [m1]", got.Held)
	}
	// the mod's answer arrives late: it is refused, and the held list stays as it was
	if err := Report(block, nil, []Left{{Id: "m1", How: LeftTakenBack}}, req.TakeBack); err == nil {
		t.Fatalf("a report naming a take-back no longer awaited was taken")
	}
	if got, _ := lastQueueEvent(t, block); !reflect.DeepEqual(got.Held, []baseds.QueuedPrompt{m1}) || len(got.Lost) != 0 {
		t.Fatalf("a refused report changed the queue: %+v", got)
	}
}

func TestAReportWithAnUnknownHowIsRefused(t *testing.T) {
	const block = "q-badhow"
	if err := Report(block, nil, []Left{{Id: "m1", How: "eaten"}}, ""); err == nil {
		t.Fatalf("a left entry with an unknown how was taken")
	}
	if _, ok := lastQueueEvent(t, block); ok {
		t.Fatalf("a refused report published")
	}
}
