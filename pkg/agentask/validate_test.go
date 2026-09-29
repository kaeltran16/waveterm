// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func vopts(n int) []baseds.AgentAskOption {
	out := make([]baseds.AgentAskOption, n)
	for i := range out {
		out[i] = baseds.AgentAskOption{Label: "o"}
	}
	return out
}

func TestValidateAnswers(t *testing.T) {
	single := baseds.AgentAskQuestion{Question: "s", Options: vopts(3)}
	multi := baseds.AgentAskQuestion{Question: "m", MultiSelect: true, Options: vopts(3)}
	preview := baseds.AgentAskQuestion{Question: "p", Options: []baseds.AgentAskOption{{Label: "a", Preview: "x"}, {Label: "b"}}}
	pick := func(i ...int) baseds.AgentAnswerItem { return baseds.AgentAnswerItem{SelectedIndexes: i} }
	text := func(s string) baseds.AgentAnswerItem { return baseds.AgentAnswerItem{Text: s} }
	qs := func(q ...baseds.AgentAskQuestion) []baseds.AgentAskQuestion { return q }
	as := func(a ...baseds.AgentAnswerItem) []baseds.AgentAnswerItem { return a }

	cases := []struct {
		name    string
		q       []baseds.AgentAskQuestion
		a       []baseds.AgentAnswerItem
		prose   bool
		wantErr bool
	}{
		{"single pick", qs(single), as(pick(2)), false, false},
		{"multi picks, unordered and duplicated", qs(multi), as(pick(2, 0, 2)), false, false},
		{"free text on a single-select", qs(single), as(text("hello")), false, false},
		{"batch mixing pick, picks and text", qs(single, multi, single), as(pick(0), pick(1, 2), text("x")), false, false},
		{"preview question takes free text alone", qs(preview), as(text("x")), false, false},
		{"no questions", nil, nil, false, true},
		{"too few answers", qs(single, multi), as(pick(0)), false, true},
		{"too many answers", qs(single), as(pick(0), pick(0)), false, true},
		{"single-select with two picks", qs(single), as(pick(0, 1)), false, true},
		{"single-select with none", qs(single), as(pick()), false, true},
		{"multi-select with none", qs(multi), as(pick()), false, true},
		{"index past the end", qs(single), as(pick(3)), false, true},
		{"negative index", qs(multi), as(pick(-1)), false, true},
		{"picks and text together", qs(single), as(baseds.AgentAnswerItem{SelectedIndexes: []int{0}, Text: "x"}), false, true},
		{"multi-line text", qs(single), as(text("a\nb")), false, true},
		{"control character in text", qs(single), as(text("a\tb")), false, true},
		{"bad answer in a later question", qs(single, single), as(pick(0), pick(9)), false, true},
		{"preview question in a batch has no text row", qs(single, preview), as(pick(0), text("x")), false, true},
		{"prose text", qs(single), as(text("go")), true, false},
		{"prose single pick", qs(single), as(pick(1)), true, false},
		{"prose two picks", qs(multi), as(pick(0, 1)), true, true},
		{"prose two questions", qs(single, single), as(pick(0), pick(0)), true, true},
		{"prose two answers", qs(single), as(pick(0), pick(0)), true, true},
		{"prose pick out of range", qs(single), as(pick(5)), true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateAnswers(tc.q, tc.a, tc.prose)
			if (err != nil) != tc.wantErr {
				t.Fatalf("ValidateAnswers err = %v, wantErr %v", err, tc.wantErr)
			}
			// the encoder enforces the same rules: whatever the validator rejects it must too
			if !tc.prose {
				if _, encErr := EncodeAnswer(tc.q, tc.a); (encErr != nil) != tc.wantErr {
					t.Fatalf("EncodeAnswer err = %v, wantErr %v", encErr, tc.wantErr)
				}
			}
		})
	}
}
