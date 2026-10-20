// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

// ClaudeModCommands read and write the options of the Claude Code mods Arc installs, in ~/.claude/settings.json.
type ClaudeModCommands interface {
	ClaudeModOptionsCommand(ctx context.Context, data CommandClaudeModOptionsData) (map[string]any, error)
	ClaudeModSetOptionCommand(ctx context.Context, data CommandClaudeModSetOptionData) error
}

type CommandClaudeModOptionsData struct {
	Plugin string `json:"plugin"`
}

type CommandClaudeModSetOptionData struct {
	Plugin string `json:"plugin"`
	Field  string `json:"field"`
	Value  bool   `json:"value"`
}
