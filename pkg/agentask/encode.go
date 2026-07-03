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

// KeystrokeDelay separates each keystroke the caller injects into the picker. Claude Code's
// Ink (React) TUI tracks the highlighted option as React state; keys delivered in one PTY
// write are handled in a single tick, so a later key reads the pre-update index (e.g. Enter
// confirms the still-default option, or a second arrow undershoots). A short gap lets React
// flush its state between keys. Verified live against CC v2.1.181 (2026-06-18).
const KeystrokeDelay = 60 * time.Millisecond

// EncodeAnswer returns the keystrokes that drive the native picker to the given answer, one
// keystroke per element so the caller can deliver them with KeystrokeDelay between each.
// Supports exactly one question — single-select (one option index) or multi-select (see
// encodeMultiSelect). Multi-question batches still return an error (callers fall back to
// answering in the terminal); driving the picker's per-question tab bar is not yet implemented.
func EncodeAnswer(questions []baseds.AgentAskQuestion, answers []baseds.AgentAnswerItem) ([][]byte, error) {
	if len(questions) != 1 {
		return nil, fmt.Errorf("panel answering supports exactly one question, got %d", len(questions))
	}
	if len(answers) != 1 {
		return nil, fmt.Errorf("expected exactly one answer, got %d", len(answers))
	}
	q := questions[0]
	sel := answers[0].SelectedIndexes
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
	keys := make([][]byte, 0, idx+1)
	for i := 0; i < idx; i++ {
		keys = append(keys, downArrow)
	}
	keys = append(keys, []byte{enter})
	return keys, nil
}

// encodeMultiSelect drives Claude Code's multi-select picker. Verified live against CC v2.1.199
// (2026-07-03) with a PTY harness: the picker renders checkbox rows; Enter TOGGLES the highlighted
// option's checkbox (unlike single-select, where Enter confirms immediately); ESC[B/[A navigate.
// After the N agent options CC appends a "Type something" free-text row (index N) then a "Submit"
// row (index N+1). So: walk down from index 0 toggling each chosen option, descend to the Submit
// row and press Enter (which opens a "Ready to submit your answers?" review defaulting to
// "Submit answers"), then a final Enter finalizes. Selections are sorted + de-duplicated so a
// double-toggle can't cancel a choice.
func encodeMultiSelect(q baseds.AgentAskQuestion, sel []int) ([][]byte, error) {
	n := len(q.Options)
	if len(sel) == 0 {
		return nil, fmt.Errorf("multi-select expects at least one selected index")
	}
	idxs := append([]int(nil), sel...)
	sort.Ints(idxs)
	uniq := make([]int, 0, len(idxs))
	for _, i := range idxs {
		if i < 0 || i >= n {
			return nil, fmt.Errorf("selected index %d out of range (%d options)", i, n)
		}
		if len(uniq) == 0 || uniq[len(uniq)-1] != i {
			uniq = append(uniq, i)
		}
	}

	var keys [][]byte
	cur := 0
	for _, i := range uniq {
		for d := 0; d < i-cur; d++ {
			keys = append(keys, downArrow)
		}
		keys = append(keys, []byte{enter}) // toggle this option
		cur = i
	}
	// descend to the Submit row (index n+1), then Enter to open the review, Enter to confirm
	for d := 0; d < (n+1)-cur; d++ {
		keys = append(keys, downArrow)
	}
	keys = append(keys, []byte{enter}, []byte{enter})
	return keys, nil
}
