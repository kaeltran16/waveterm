// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/agentctl"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// SetAgentQueueCommand takes the arc mod's report of the person's messages it holds for a block.
func (ws *WshServer) SetAgentQueueCommand(ctx context.Context, data wshrpc.CommandSetAgentQueueData) error {
	if data.BlockId == "" {
		return fmt.Errorf("a queue report needs a block id")
	}
	left := make([]agentctl.Left, len(data.Left))
	for i, l := range data.Left {
		left[i] = agentctl.Left{Id: l.Id, How: l.How}
	}
	return agentctl.Report(data.BlockId, data.Held, left, data.TakeBack)
}

// AgentTakeBackCommand asks a block's mod for the messages it holds for the person, so the box can take them back.
func (ws *WshServer) AgentTakeBackCommand(ctx context.Context, data wshrpc.CommandAgentTakeBackData) (*wshrpc.CommandAgentTakeBackRtnData, error) {
	if data.BlockId == "" {
		return nil, fmt.Errorf("a take-back needs a block id")
	}
	items, err := agentctl.TakeBack(ctx, data.BlockId)
	if err != nil {
		return nil, err
	}
	if items == nil {
		items = []baseds.QueuedPrompt{}
	}
	return &wshrpc.CommandAgentTakeBackRtnData{Items: items}, nil
}
