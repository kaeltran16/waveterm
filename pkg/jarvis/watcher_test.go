// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func singleSelect(nOptions int) []baseds.AgentAskQuestion {
	opts := make([]baseds.AgentAskOption, nOptions)
	for i := range opts {
		opts[i] = baseds.AgentAskOption{Label: "opt"}
	}
	return []baseds.AgentAskQuestion{{Question: "q", Options: opts}}
}

// Guards the gatekeeper pre-filter: only a single single-select question may be auto-answered;
// anything else must reach a human.
func TestAskAutoAnswerable(t *testing.T) {
	cases := []struct {
		name      string
		questions []baseds.AgentAskQuestion
		want      bool
	}{
		{"single single-select", singleSelect(2), true},
		{"single multi-select", []baseds.AgentAskQuestion{{Question: "q", MultiSelect: true, Options: []baseds.AgentAskOption{{Label: "a"}}}}, false},
		{"multiple questions", []baseds.AgentAskQuestion{{Question: "q1"}, {Question: "q2"}}, false},
		{"no questions", nil, false},
	}
	for _, tc := range cases {
		if got := askAutoAnswerable(tc.questions); got != tc.want {
			t.Errorf("%s: askAutoAnswerable = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// Guards the delivery bounds check: a classifier index outside the option list must not be delivered.
func TestOptionIndexInRange(t *testing.T) {
	q := baseds.AgentAskQuestion{Options: []baseds.AgentAskOption{{Label: "a"}, {Label: "b"}}}
	cases := []struct {
		name string
		idx  int
		q    baseds.AgentAskQuestion
		want bool
	}{
		{"first option", 0, q, true},
		{"last option", 1, q, true},
		{"one past the end", 2, q, false},
		{"negative", -1, q, false},
		{"empty options", 0, baseds.AgentAskQuestion{}, false},
	}
	for _, tc := range cases {
		if got := optionIndexInRange(tc.idx, tc.q); got != tc.want {
			t.Errorf("%s: optionIndexInRange(%d) = %v, want %v", tc.name, tc.idx, got, tc.want)
		}
	}
}
