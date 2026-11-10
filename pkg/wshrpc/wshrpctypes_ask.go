// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

type AskCommands interface {
	// agent ask
	AskCommand(ctx context.Context, data CommandAskData) (AskRtnData, error)
	AnswerAgentCommand(ctx context.Context, data CommandAnswerAgentData) error
	AgentAskClearCommand(ctx context.Context, oref string) error
	// agent permission: a Claude Code permission prompt projected by the PermissionRequest hook
	// (returns the permid) and answered by typing keys into Claude's own prompt
	AgentPermissionCommand(ctx context.Context, data CommandAgentPermissionData) (string, error)
	AnswerAgentPermissionCommand(ctx context.Context, data CommandAnswerAgentPermissionData) error
}

type CommandAgentPermissionData struct {
	ORef     string `json:"oref"`
	ToolName string `json:"toolname"`
	// ToolInput is the raw JSON text of the hook's tool_input
	ToolInput string `json:"toolinput"`
	// ToolKey is the wsh-computed hash of the tool call, matched against a later PostToolUse status
	ToolKey string `json:"toolkey"`
	// HasSuggestions is whether the request carried a non-empty permission_suggestions, which adds
	// the middle "don't ask again" option to Claude's prompt
	HasSuggestions bool `json:"hassuggestions,omitempty"`
}

type CommandAnswerAgentPermissionData struct {
	ORef   string `json:"oref"`
	PermId string `json:"permid"`
	Choice int    `json:"choice"`
}

type CommandAskData struct {
	ORef      string                    `json:"oref"`
	Questions []baseds.AgentAskQuestion `json:"questions"`
	// Wait blocks the RPC until the ask is answered (Answers) or cleared/cancelled
	// (Cancelled=true). Fire-and-forget when false (Claude Code hook path).
	Wait bool `json:"wait,omitempty"`
	// Prose marks a projected bare-prose question (pi prose bridge): the answer is typed
	// into the block terminal as text (no native picker to drive with arrow keys).
	Prose bool `json:"prose,omitempty"`
}

type AskRtnData struct {
	AskId     string                   `json:"askid"`
	Answers   []baseds.AgentAnswerItem `json:"answers,omitempty"`
	Cancelled bool                     `json:"cancelled,omitempty"`
}

type CommandAnswerAgentData struct {
	ORef    string                   `json:"oref"`
	Answers []baseds.AgentAnswerItem `json:"answers"`
}
