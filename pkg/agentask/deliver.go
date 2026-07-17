// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
)

// sendInput is indirected so tests can capture keystrokes without a live block PTY.
var sendInput = func(blockId string, data []byte) error {
	return blockcontroller.SendInput(blockId, &blockcontroller.BlockInputUnion{InputData: data})
}

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
	keys, err := EncodeAnswer(pending.Questions, answers)
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
