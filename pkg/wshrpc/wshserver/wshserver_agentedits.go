// pkg/wshrpc/wshserver/wshserver_agentedits.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) GitAgentEditsCommand(ctx context.Context, data wshrpc.CommandGitAgentEditsData) (*wshrpc.CommandGitAgentEditsRtnData, error) {
	return &wshrpc.CommandGitAgentEditsRtnData{Files: []wshrpc.GitAgentEditFile{}, Reason: "not built yet"}, nil
}
