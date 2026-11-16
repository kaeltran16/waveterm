// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/claudecmds"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) SetClaudeLiveCommandsCommand(ctx context.Context, data wshrpc.CommandSetClaudeLiveCommandsData) error {
	list := make([]claudecmds.LiveCommand, len(data.Commands))
	for i, c := range data.Commands {
		list[i] = claudecmds.LiveCommand{Name: c.Name, Description: c.Description, Source: c.Source, Plugin: c.Plugin}
	}
	return claudecmds.SetLive(data.BlockId, list)
}

// GetClaudeLiveCommandsCommand answers an empty list, not nil, for a block with none: the wire carries [] either way
// and the frontend falls back to its built-ins on empty.
func (ws *WshServer) GetClaudeLiveCommandsCommand(ctx context.Context, data wshrpc.CommandGetClaudeLiveCommandsData) ([]wshrpc.ClaudeCommandInfo, error) {
	list, _ := claudecmds.GetLive(data.BlockId)
	out := make([]wshrpc.ClaudeCommandInfo, len(list))
	for i, c := range list {
		out[i] = wshrpc.ClaudeCommandInfo{Name: c.Name, Description: c.Description, Source: c.Source, Plugin: c.Plugin}
	}
	return out, nil
}
