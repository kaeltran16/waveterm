// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"bytes"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func singleSelect(nOpts int) []baseds.AgentAskQuestion {
	opts := make([]baseds.AgentAskOption, nOpts)
	for i := range opts {
		opts[i] = baseds.AgentAskOption{Label: "opt"}
	}
	return []baseds.AgentAskQuestion{{Question: "q", Options: opts}}
}

func ans(idx int) []baseds.AgentAnswerItem {
	return []baseds.AgentAnswerItem{{SelectedIndexes: []int{idx}}}
}

func keysEqual(a, b [][]byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !bytes.Equal(a[i], b[i]) {
			return false
		}
	}
	return true
}

func TestEncodeIndex0IsJustEnter(t *testing.T) {
	got, err := EncodeAnswer(singleSelect(3), ans(0))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := [][]byte{{'\r'}}
	if !keysEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeIndex2IsTwoDownThenEnter(t *testing.T) {
	got, err := EncodeAnswer(singleSelect(3), ans(2))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := [][]byte{{0x1b, '[', 'B'}, {0x1b, '[', 'B'}, {'\r'}}
	if !keysEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeRejectsMultiSelect(t *testing.T) {
	qs := singleSelect(2)
	qs[0].MultiSelect = true
	if _, err := EncodeAnswer(qs, ans(0)); err == nil {
		t.Fatalf("expected error for multi-select, got nil")
	}
}

func TestEncodeRejectsMultiQuestion(t *testing.T) {
	qs := append(singleSelect(2), baseds.AgentAskQuestion{Question: "q2"})
	answers := []baseds.AgentAnswerItem{{SelectedIndexes: []int{0}}, {SelectedIndexes: []int{0}}}
	if _, err := EncodeAnswer(qs, answers); err == nil {
		t.Fatalf("expected error for multi-question, got nil")
	}
}

func TestEncodeRejectsIndexOutOfRange(t *testing.T) {
	if _, err := EncodeAnswer(singleSelect(2), ans(5)); err == nil {
		t.Fatalf("expected error for out-of-range index, got nil")
	}
}

func TestEncodeRejectsZeroSelections(t *testing.T) {
	answers := []baseds.AgentAnswerItem{{SelectedIndexes: []int{}}}
	if _, err := EncodeAnswer(singleSelect(2), answers); err == nil {
		t.Fatalf("expected error for empty selection, got nil")
	}
}
