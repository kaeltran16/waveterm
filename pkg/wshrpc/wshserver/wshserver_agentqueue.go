// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

var errAgentQueueNotBuilt = errors.New("the agent message queue is not built yet")

// SetAgentQueueCommand takes the arc mod's report of the person's messages it holds for a block.
func (ws *WshServer) SetAgentQueueCommand(ctx context.Context, data wshrpc.CommandSetAgentQueueData) error {
	return errAgentQueueNotBuilt
}

// AgentTakeBackCommand asks a block's mod for the messages it holds for the person, so the box can take them back.
func (ws *WshServer) AgentTakeBackCommand(ctx context.Context, data wshrpc.CommandAgentTakeBackData) (*wshrpc.CommandAgentTakeBackRtnData, error) {
	return nil, errAgentQueueNotBuilt
}
