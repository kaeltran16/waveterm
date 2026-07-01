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

// DeliverAnswer injects answers into the pending ask's native picker for oref. It returns
// delivered=false with no error when no ask is pending (already answered in the terminal or
// cleared) — the idempotent no-op both AnswerAgentCommand and the Gatekeeper actuator rely on.
// It delivers one keystroke per PTY write with KeystrokeDelay between each (a single combined
// write races the picker's React state and confirms the wrong option).
func DeliverAnswer(oref string, answers []baseds.AgentAnswerItem) (bool, error) {
	pending, ok := GlobalRegistry.Get(oref)
	if !ok {
		return false, nil
	}
	keys, err := EncodeAnswer(pending.Questions, answers)
	if err != nil {
		return false, err
	}
	for i, k := range keys {
		if i > 0 {
			time.Sleep(KeystrokeDelay)
		}
		if err := sendInput(pending.BlockId, k); err != nil {
			return false, err
		}
	}
	return true, nil
}
