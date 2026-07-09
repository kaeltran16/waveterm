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

func multiSelectQ(nOpts int) []baseds.AgentAskQuestion {
	qs := singleSelect(nOpts)
	qs[0].MultiSelect = true
	return qs
}

func multiAns(idxs ...int) []baseds.AgentAnswerItem {
	return []baseds.AgentAnswerItem{{SelectedIndexes: idxs}}
}

// Verified live against CC v2.1.199: Enter toggles the highlighted checkbox; ESC[B navigates; the
// "Submit" row sits at index N+1 (after N options + a "Type something" row); Enter on Submit opens a
// review whose default confirms with one more Enter. Target Alpha(0)+Charlie(2) of 4 options.
func TestEncodeMultiSelectTogglesNavigatesAndConfirms(t *testing.T) {
	got, err := EncodeAnswer(multiSelectQ(4), multiAns(0, 2))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	down := []byte{0x1b, '[', 'B'}
	want := [][]byte{
		{'\r'},                    // toggle Alpha (idx0, already highlighted)
		down, down, {'\r'},        // -> Charlie (idx2), toggle
		down, down, down, {'\r'},  // -> Submit (idx N+1=5), open review
		{'\r'},                    // confirm "Submit answers"
	}
	if !keysEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeMultiSelectSingleOption(t *testing.T) {
	got, err := EncodeAnswer(multiSelectQ(3), multiAns(1))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	down := []byte{0x1b, '[', 'B'}
	want := [][]byte{
		down, {'\r'},             // -> Bravo (idx1), toggle
		down, down, down, {'\r'}, // -> Submit (idx N+1=4), open review
		{'\r'},                   // confirm
	}
	if !keysEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeMultiSelectDedupesAndSorts(t *testing.T) {
	a, err := EncodeAnswer(multiSelectQ(4), multiAns(2, 0, 2))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	b, _ := EncodeAnswer(multiSelectQ(4), multiAns(0, 2))
	if !keysEqual(a, b) {
		t.Fatalf("out-of-order/duplicate selection should equal sorted-unique: %v vs %v", a, b)
	}
}

func TestEncodeMultiSelectRejectsEmpty(t *testing.T) {
	if _, err := EncodeAnswer(multiSelectQ(3), multiAns()); err == nil {
		t.Fatalf("expected error for empty multi-select selection, got nil")
	}
}

func TestEncodeMultiSelectRejectsOutOfRange(t *testing.T) {
	if _, err := EncodeAnswer(multiSelectQ(3), multiAns(5)); err == nil {
		t.Fatalf("expected error for out-of-range multi-select index, got nil")
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

func qn(nOpts int, multi bool) baseds.AgentAskQuestion {
	opts := make([]baseds.AgentAskOption, nOpts)
	for i := range opts {
		opts[i] = baseds.AgentAskOption{Label: "opt"}
	}
	return baseds.AgentAskQuestion{Question: "q", Options: opts, MultiSelect: multi}
}

func item(idxs ...int) baseds.AgentAnswerItem {
	return baseds.AgentAnswerItem{SelectedIndexes: idxs}
}

// Confirmed protocol: single-select = downs + enter (enter auto-advances); multi-select = toggle
// each choice then Tab; the run ends on the Submit tab -> one final enter, no review.
func TestEncodeMultiQuestionTwoSingleSelects(t *testing.T) {
	got, err := EncodeAnswer(
		[]baseds.AgentAskQuestion{qn(2, false), qn(2, false)},
		[]baseds.AgentAnswerItem{item(1), item(0)},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	down := []byte{0x1b, '[', 'B'}
	want := [][]byte{down, {'\r'}, {'\r'}, {'\r'}} // Q1: down,enter(advance) | Q2: enter(advance) | submit
	if !keysEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeMultiQuestionSingleThenMulti(t *testing.T) {
	got, err := EncodeAnswer(
		[]baseds.AgentAskQuestion{qn(2, false), qn(3, true)},
		[]baseds.AgentAnswerItem{item(0), item(0, 2)},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	down := []byte{0x1b, '[', 'B'}
	tabk := []byte{'\t'}
	// Q1 single idx0: enter(advance) | Q2 multi {0,2}: toggle0, down,down, toggle2, Tab | submit
	want := [][]byte{{'\r'}, {'\r'}, down, down, {'\r'}, tabk, {'\r'}}
	if !keysEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeMultiQuestionMultiThenSingle(t *testing.T) {
	got, err := EncodeAnswer(
		[]baseds.AgentAskQuestion{qn(3, true), qn(2, false)},
		[]baseds.AgentAnswerItem{item(1), item(0)},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	down := []byte{0x1b, '[', 'B'}
	tabk := []byte{'\t'}
	// Q1 multi {1}: down, toggle, Tab | Q2 single idx0: enter(advance) | submit
	want := [][]byte{down, {'\r'}, tabk, {'\r'}, {'\r'}}
	if !keysEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeMultiQuestionThreeSingleSelects(t *testing.T) {
	got, err := EncodeAnswer(
		[]baseds.AgentAskQuestion{qn(2, false), qn(2, false), qn(2, false)},
		[]baseds.AgentAnswerItem{item(0), item(1), item(0)},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	down := []byte{0x1b, '[', 'B'}
	// no Tab anywhere; N+1 = 4 enters total
	want := [][]byte{{'\r'}, down, {'\r'}, {'\r'}, {'\r'}}
	if !keysEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeMultiQuestionRejectsAnswerCountMismatch(t *testing.T) {
	_, err := EncodeAnswer(
		[]baseds.AgentAskQuestion{qn(2, false), qn(2, false)},
		[]baseds.AgentAnswerItem{item(0)},
	)
	if err == nil {
		t.Fatalf("expected error for answer/question count mismatch, got nil")
	}
}

func TestEncodeMultiQuestionRejectsOutOfRange(t *testing.T) {
	_, err := EncodeAnswer(
		[]baseds.AgentAskQuestion{qn(2, false), qn(2, false)},
		[]baseds.AgentAnswerItem{item(0), item(5)},
	)
	if err == nil {
		t.Fatalf("expected error for out-of-range index in question 2, got nil")
	}
}

func TestEncodeMultiQuestionRejectsEmptyMultiSelect(t *testing.T) {
	_, err := EncodeAnswer(
		[]baseds.AgentAskQuestion{qn(2, false), qn(3, true)},
		[]baseds.AgentAnswerItem{item(0), item()},
	)
	if err == nil {
		t.Fatalf("expected error for empty multi-select selection in a batch, got nil")
	}
}
