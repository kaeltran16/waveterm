// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"fmt"
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
// MVP supports exactly one single-select question answered by one option index. Anything
// else returns an error (callers fall back to answering in the terminal).
func EncodeAnswer(questions []baseds.AgentAskQuestion, answers []baseds.AgentAnswerItem) ([][]byte, error) {
	if len(questions) != 1 {
		return nil, fmt.Errorf("panel answering supports exactly one question, got %d", len(questions))
	}
	if len(answers) != 1 {
		return nil, fmt.Errorf("expected exactly one answer, got %d", len(answers))
	}
	q := questions[0]
	if q.MultiSelect {
		return nil, fmt.Errorf("panel answering does not support multi-select questions")
	}
	sel := answers[0].SelectedIndexes
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
