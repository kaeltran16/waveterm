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
}

type CommandAskData struct {
	ORef      string                    `json:"oref"`
	Questions []baseds.AgentAskQuestion `json:"questions"`
}

type AskRtnData struct {
	AskId string `json:"askid"`
}

type CommandAnswerAgentData struct {
	ORef    string                   `json:"oref"`
	Answers []baseds.AgentAnswerItem `json:"answers"`
}
