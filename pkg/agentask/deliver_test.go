// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
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
	delivered, err := DeliverAnswer("tab:none", []baseds.AgentAnswerItem{{SelectedIndexes: []int{0}}})
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

	delivered, err := DeliverAnswer("tab:t1", []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}})
	if err != nil || !delivered {
		t.Fatalf("want (true,nil), got (%v,%v)", delivered, err)
	}
	// index 1 => one downArrow + enter
	if len(got) != 2 {
		t.Fatalf("want 2 keystrokes for index 1, got %d", len(got))
	}
}
