// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"fmt"
	"sort"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

// downArrow / enter are the only keystrokes needed to drive Claude Code's native
// AskUserQuestion picker for a single-select question. Verified against Claude Code
// v2.1.181 (2026-06-18): the picker starts highlighted at index 0, ESC[B moves the
// highlight down one option, and CR selects. Number-select is not offered, so we
// navigate with arrows only. CC appends its own "Type something"/"Chat about this"
// entries AFTER the agent's options, so the agent option indices map 1:1.
var downArrow = []byte{0x1b, '[', 'B'}

const enter = byte('\r')

// tab advances to the next question tab in Claude Code's multi-question AskUserQuestion picker. A
// single-select confirms + auto-advances on enter (needs no tab); a multi-select toggles on enter
// (staying on the tab) and needs an explicit tab to move on. Verified live against CC v2.1.205
// (2026-07-09).
const tab = byte('\t')

// KeystrokeDelay separates each keystroke the caller injects into the picker. Claude Code's
// Ink (React) TUI tracks the highlighted option as React state; keys delivered in one PTY
// write are handled in a single tick, so a later key reads the pre-update index (e.g. Enter
// confirms the still-default option, or a second arrow undershoots). A short gap lets React
// flush its state between keys. Verified live against CC v2.1.181 (2026-06-18).
const KeystrokeDelay = 60 * time.Millisecond

// EncodeAnswer returns the keystrokes that drive the native picker to the given answer, one
// keystroke per element so the caller delivers them with KeystrokeDelay between each. Supports one
// question (single- or multi-select) or a multi-question batch (see encodeMultiQuestion). Returns an
// error for shapes it cannot encode; callers then fall back to answering in the terminal.
func EncodeAnswer(questions []baseds.AgentAskQuestion, answers []baseds.AgentAnswerItem) ([][]byte, error) {
	if len(questions) == 0 {
		return nil, fmt.Errorf("no questions to answer")
	}
	if len(answers) != len(questions) {
		return nil, fmt.Errorf("expected %d answers, got %d", len(questions), len(answers))
	}
	if len(questions) == 1 {
		return encodeSingleQuestion(questions[0], answers[0].SelectedIndexes)
	}
	return encodeMultiQuestion(questions, answers)
}

// encodeSingleQuestion drives a standalone one-question picker: single-select confirms + closes on
// enter; multi-select uses its inline Submit row + review. Output is unchanged from the original.
func encodeSingleQuestion(q baseds.AgentAskQuestion, sel []int) ([][]byte, error) {
	if q.MultiSelect {
		return encodeMultiSelect(q, sel)
	}
	if len(sel) != 1 {
		return nil, fmt.Errorf("single-select expects exactly one selected index, got %d", len(sel))
	}
	idx := sel[0]
	if idx < 0 || idx >= len(q.Options) {
		return nil, fmt.Errorf("selected index %d out of range (%d options)", idx, len(q.Options))
	}
	return singleSelectKeys(idx), nil
}

// singleSelectKeys moves the highlight from option 0 down to idx and presses enter.
func singleSelectKeys(idx int) [][]byte {
	keys := make([][]byte, 0, idx+1)
	for i := 0; i < idx; i++ {
		keys = append(keys, downArrow)
	}
	return append(keys, []byte{enter})
}

// sortedUniqueIndexes validates sel against nOpts and returns it ascending + de-duplicated, so a
// double-toggle can't cancel a choice.
func sortedUniqueIndexes(sel []int, nOpts int) ([]int, error) {
	if len(sel) == 0 {
		return nil, fmt.Errorf("multi-select expects at least one selected index")
	}
	idxs := append([]int(nil), sel...)
	sort.Ints(idxs)
	uniq := make([]int, 0, len(idxs))
	for _, i := range idxs {
		if i < 0 || i >= nOpts {
			return nil, fmt.Errorf("selected index %d out of range (%d options)", i, nOpts)
		}
		if len(uniq) == 0 || uniq[len(uniq)-1] != i {
			uniq = append(uniq, i)
		}
	}
	return uniq, nil
}

// multiToggleKeys moves to each selected option and toggles it (enter), stopping after the last
// toggle. It returns the final highlight index so a caller can navigate onward. Assumes the tab's
// highlight starts at option 0.
func multiToggleKeys(sel []int, nOpts int) (keys [][]byte, last int, err error) {
	uniq, err := sortedUniqueIndexes(sel, nOpts)
	if err != nil {
		return nil, 0, err
	}
	cur := 0
	for _, i := range uniq {
		for d := 0; d < i-cur; d++ {
			keys = append(keys, downArrow)
		}
		keys = append(keys, []byte{enter}) // toggle this option
		cur = i
	}
	return keys, cur, nil
}

// encodeMultiSelect drives a standalone multi-select picker: toggle each option, descend to the
// Submit row (index nOpts+1, after CC's "Type something" row), enter to open the review, enter to
// confirm. Verified live against CC v2.1.199 (2026-07-03).
func encodeMultiSelect(q baseds.AgentAskQuestion, sel []int) ([][]byte, error) {
	n := len(q.Options)
	keys, last, err := multiToggleKeys(sel, n)
	if err != nil {
		return nil, err
	}
	for d := 0; d < (n+1)-last; d++ {
		keys = append(keys, downArrow)
	}
	return append(keys, []byte{enter}, []byte{enter}), nil
}

// encodeMultiQuestion drives Claude Code's multi-question tab bar (Q1..QN, Submit). Each tab's
// highlight starts at option 0. Single-select: downs + enter, where enter selects AND auto-advances
// to the next tab. Multi-select: toggle each choice, then tab to advance (enter only toggles). After
// the last question the auto-advance (single) or tab (multi) lands on the Submit tab, which shows a
// "Ready to submit your answers?" review defaulting to "Submit answers" -> the final enter confirms
// it. Verified live against CC v2.1.205 (2026-07-09) with a PTY harness driving both trailing types.
func encodeMultiQuestion(questions []baseds.AgentAskQuestion, answers []baseds.AgentAnswerItem) ([][]byte, error) {
	var keys [][]byte
	for i, q := range questions {
		sel := answers[i].SelectedIndexes
		if q.MultiSelect {
			toggles, _, err := multiToggleKeys(sel, len(q.Options))
			if err != nil {
				return nil, fmt.Errorf("question %d: %w", i, err)
			}
			keys = append(keys, toggles...)
			keys = append(keys, []byte{tab})
			continue
		}
		if len(sel) != 1 {
			return nil, fmt.Errorf("question %d: single-select expects exactly one selected index, got %d", i, len(sel))
		}
		idx := sel[0]
		if idx < 0 || idx >= len(q.Options) {
			return nil, fmt.Errorf("question %d: selected index %d out of range (%d options)", i, idx, len(q.Options))
		}
		keys = append(keys, singleSelectKeys(idx)...)
	}
	return append(keys, []byte{enter}), nil
}
