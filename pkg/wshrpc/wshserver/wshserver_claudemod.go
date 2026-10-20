// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/claudemod"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) ClaudeModOptionsCommand(ctx context.Context, data wshrpc.CommandClaudeModOptionsData) (map[string]any, error) {
	return claudemod.Options(data.Plugin)
}

func (ws *WshServer) ClaudeModSetOptionCommand(ctx context.Context, data wshrpc.CommandClaudeModSetOptionData) error {
	return claudemod.SetOption(data.Plugin, data.Field, data.Value)
}
