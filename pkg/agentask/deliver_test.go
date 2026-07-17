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
