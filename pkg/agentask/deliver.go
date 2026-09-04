// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
)

// sendInput is indirected so tests can capture keystrokes without a live block PTY.
var sendInput = func(blockId string, data []byte) error {
	return blockcontroller.SendInput(blockId, &blockcontroller.BlockInputUnion{InputData: data})
}

// AnswerHook runs after a delivered answer, whichever path delivered it — the cockpit panel, the
// server-side Gatekeeper actuator, or the dag lead's `wsh jarvis dag answer`. All three claim through
// DeliverAnswer, so hooking here is what stops them recording the ask lifecycle three different ways
// (or, for two of them, not at all). Wired once at server startup; nil = no-op.
var AnswerHook func(oref, askId string)

// DeliverAnswer atomically claims the pending ask for oref, then injects its answers into the native
// picker. It returns delivered=false with no error when no ask is pending (already answered in the
// terminal or cleared), or when askid != "" and no longer matches the pending ask — the idempotent no-op
// both AnswerAgentCommand and the Gatekeeper actuator rely on. Claiming makes concurrent deliveries
// mutually exclusive: exactly one caller injects; the rest see delivered=false. It delivers one keystroke
// per PTY write with KeystrokeDelay between each (a single combined write races the picker's React state
// and confirms the wrong option).
//
// Error recovery mirrors what has already been sent: an EncodeAnswer failure sends no keystrokes, so the
// pending ask is restored and a retry is safe; a mid-inject sendInput failure has already put a partial
// keystroke prefix into the picker, so the entry stays claimed (dropped) — restoring would risk a
// double-send on retry.
func DeliverAnswer(oref, askid string, answers []baseds.AgentAnswerItem) (bool, error) {
	pending, ok := GlobalRegistry.Claim(oref, askid)
	if !ok {
		return false, nil
	}
	delivered, err := injectAnswer(oref, pending, answers)
	if delivered && AnswerHook != nil {
		AnswerHook(oref, pending.AskId)
	}
	return delivered, err
}

// injectAnswer delivers a claimed ask's answers, returning whether the agent actually received them.
func injectAnswer(oref string, pending PendingAsk, answers []baseds.AgentAnswerItem) (bool, error) {
	// waiter path (pi ask bridge): a --wait caller registered on this ask — resolve it
	// directly. pi has no native picker to drive, so keystrokes would type into the
	// session; the waiter is the delivery. No waiter -> CC path (keystroke injection).
	if GlobalRegistry.ResolveWaiter(pending.AskId, WaitResult{Answers: answers}) {
		return true, nil
	}
	var keys [][]byte
	var err error
	if pending.Prose {
		keys, err = deliverProseAnswer(pending, answers)
	} else {
		keys, err = EncodeAnswer(pending.Questions, answers)
	}
	if err != nil {
		GlobalRegistry.Set(oref, pending) // nothing sent yet — safe to restore for retry
		return false, err
	}
	for i, k := range keys {
		if i > 0 {
			time.Sleep(KeystrokeDelay)
		}
		if err := sendInput(pending.BlockId, k); err != nil {
			return false, err // partial prefix already sent — do NOT restore
		}
	}
	return true, nil
}

// deliverProseAnswer encodes a prose ask's answer as plain terminal text. Prose asks have
// no native picker, so an index answer resolves to the option label and the text is typed
// verbatim (text + enter). Error semantics match EncodeAnswer: no keystrokes are produced
// on failure, so the caller can restore the pending ask and retry safely.
func deliverProseAnswer(pending PendingAsk, answers []baseds.AgentAnswerItem) ([][]byte, error) {
	if len(pending.Questions) != 1 {
		return nil, fmt.Errorf("prose ask expects exactly one question, got %d", len(pending.Questions))
	}
	if len(answers) != 1 {
		return nil, fmt.Errorf("prose ask expects exactly one answer, got %d", len(answers))
	}
	a := answers[0]
	text := a.Text
	if text == "" {
		if len(a.SelectedIndexes) != 1 {
			return nil, fmt.Errorf("prose answer must be text or a single option index")
		}
		idx := a.SelectedIndexes[0]
		opts := pending.Questions[0].Options
		if idx < 0 || idx >= len(opts) {
			return nil, fmt.Errorf("selected index %d out of range (%d options)", idx, len(opts))
		}
		text = opts[idx].Label
	}
	if err := validateFreeText(text); err != nil {
		return nil, err
	}
	return proseTextKeys(text), nil
}
