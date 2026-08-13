// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func oneQuestion() []baseds.AgentAskQuestion {
	return []baseds.AgentAskQuestion{{
		Question: "A or B?",
		Options:  []baseds.AgentAskOption{{Label: "A"}, {Label: "B"}},
	}}
}

func TestDeliverAnswer_NoPending(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	delivered, err := DeliverAnswer("tab:none", "", []baseds.AgentAnswerItem{{SelectedIndexes: []int{0}}})
	if err != nil || delivered {
		t.Fatalf("want (false,nil), got (%v,%v)", delivered, err)
	}
}

func TestDeliverAnswer_Delivers(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	GlobalRegistry.Set("tab:t1", PendingAsk{AskId: "a1", BlockId: "b1", Questions: oneQuestion()})
	var got [][]byte
	orig := sendInput
	sendInput = func(blockId string, data []byte) error { got = append(got, data); return nil }
	defer func() { sendInput = orig }()

	delivered, err := DeliverAnswer("tab:t1", "", []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}})
	if err != nil || !delivered {
		t.Fatalf("want (true,nil), got (%v,%v)", delivered, err)
	}
	// index 1 => one downArrow + enter
	if len(got) != 2 {
		t.Fatalf("want 2 keystrokes for index 1, got %d", len(got))
	}
}

func TestDeliverAnswer_RestoresOnEncodeError(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	GlobalRegistry.Set("tab:t1", PendingAsk{AskId: "a1", BlockId: "b1", Questions: oneQuestion()})
	// index 5 is out of range for the 2-option question -> EncodeAnswer errors AFTER Claim.
	delivered, err := DeliverAnswer("tab:t1", "", []baseds.AgentAnswerItem{{SelectedIndexes: []int{5}}})
	if delivered || err == nil {
		t.Fatalf("want (false, err) on encode failure, got (%v, %v)", delivered, err)
	}
	if _, ok := GlobalRegistry.Get("tab:t1"); !ok {
		t.Fatalf("encode error must restore the pending ask (no keystrokes were sent)")
	}
}

func TestDeliverAnswer_NoRestoreOnInjectError(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	GlobalRegistry.Set("tab:t1", PendingAsk{AskId: "a1", BlockId: "b1", Questions: oneQuestion()})
	orig := sendInput
	sendInput = func(string, []byte) error { return errors.New("pty gone") }
	defer func() { sendInput = orig }()

	delivered, err := DeliverAnswer("tab:t1", "", []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}})
	if delivered || err == nil {
		t.Fatalf("want (false, err) on inject failure, got (%v, %v)", delivered, err)
	}
	if _, ok := GlobalRegistry.Get("tab:t1"); ok {
		t.Fatalf("mid-inject error must NOT restore (a retry would double-send); entry stays claimed")
	}
}

func TestDeliverAnswer_ConcurrentInjectsOnce(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	GlobalRegistry.Set("tab:t1", PendingAsk{AskId: "a1", BlockId: "b1", Questions: oneQuestion()})
	var mu sync.Mutex
	var writes int
	orig := sendInput
	sendInput = func(string, []byte) error { mu.Lock(); writes++; mu.Unlock(); return nil }
	defer func() { sendInput = orig }()

	const n = 16
	var delivers int32
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			if ok, _ := DeliverAnswer("tab:t1", "", []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}}); ok {
				atomic.AddInt32(&delivers, 1)
			}
		}()
	}
	wg.Wait()
	if delivers != 1 {
		t.Fatalf("delivered=true count = %d, want exactly 1", delivers)
	}
	// index 1 => exactly one full sequence (downArrow + enter = 2 writes), never doubled.
	if writes != 2 {
		t.Fatalf("keystroke writes = %d, want 2 (one full sequence)", writes)
	}
}

func TestDeliverAnswerResolvesWaiterWithoutKeystrokes(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	GlobalRegistry.Set("tab:t1", PendingAsk{AskId: "a1", BlockId: "b1", Questions: oneQuestion()})
	var writes int
	orig := sendInput
	sendInput = func(string, []byte) error { writes++; return nil }
	defer func() { sendInput = orig }()
	ch := GlobalRegistry.RegisterWaiter("a1")

	delivered, err := DeliverAnswer("tab:t1", "", []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}})
	if err != nil || !delivered {
		t.Fatalf("want (true,nil), got (%v,%v)", delivered, err)
	}
	if writes != 0 {
		t.Fatalf("waiter path must not inject keystrokes, got %d writes", writes)
	}
	select {
	case res := <-ch:
		if res.Cancelled || len(res.Answers) != 1 {
			t.Fatalf("bad waiter result: %#v", res)
		}
	default:
		t.Fatal("waiter must be resolved")
	}
	// claim semantics preserved: the pending ask is gone after delivery
	if _, ok := GlobalRegistry.Get("tab:t1"); ok {
		t.Fatal("pending ask must be claimed")
	}
}

func prosePending() PendingAsk {
	return PendingAsk{AskId: "p1", BlockId: "b1", Prose: true, Questions: oneQuestion()}
}

func TestDeliverAnswer_ProseTypesText(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	GlobalRegistry.Set("tab:t1", prosePending())
	var got [][]byte
	orig := sendInput
	sendInput = func(blockId string, data []byte) error { got = append(got, data); return nil }
	defer func() { sendInput = orig }()

	delivered, err := DeliverAnswer("tab:t1", "", []baseds.AgentAnswerItem{{Text: "B"}})
	if err != nil || !delivered {
		t.Fatalf("want (true,nil), got (%v,%v)", delivered, err)
	}
	// prose: raw text + enter, NO arrow prefix
	if len(got) != 2 || string(got[0]) != "B" || got[1][0] != enter {
		t.Fatalf("want [B, enter], got %q", got)
	}
}

func TestDeliverAnswer_ProseResolvesIndexToLabel(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	GlobalRegistry.Set("tab:t1", prosePending())
	var got [][]byte
	orig := sendInput
	sendInput = func(blockId string, data []byte) error { got = append(got, data); return nil }
	defer func() { sendInput = orig }()

	delivered, err := DeliverAnswer("tab:t1", "", []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}})
	if err != nil || !delivered {
		t.Fatalf("want (true,nil), got (%v,%v)", delivered, err)
	}
	if len(got) != 2 || string(got[0]) != "B" {
		t.Fatalf("want typed label B, got %q", got)
	}
}

func TestDeliverAnswer_ProseRejectsInvalidAnswers(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	GlobalRegistry.Set("tab:t1", prosePending())
	cases := [][]baseds.AgentAnswerItem{
		{{Text: ""}},                     // empty text, no index
		{{Text: "a\x01b"}},               // control char
		{{SelectedIndexes: []int{9}}},    // out of range
		{{SelectedIndexes: []int{0, 1}}}, // multi-select shape
		{},                              // no answers
	}
	for _, answers := range cases {
		GlobalRegistry = MakeRegistry()
		GlobalRegistry.Set("tab:t1", prosePending())
		if _, err := DeliverAnswer("tab:t1", "", answers); err == nil {
			t.Fatalf("want error for answers %+v", answers)
		}
	}
}
