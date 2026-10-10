// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) ClaudeAccountsCommand(ctx context.Context) (*wshrpc.ClaudeAccountsRtnData, error) {
	return jarvis.ListClaudeAccounts()
}

func (ws *WshServer) ClaudeAccountSwitchCommand(ctx context.Context, data wshrpc.CommandClaudeAccountData) error {
	return jarvis.SwitchClaudeAccount(data.AccountUuid)
}

func (ws *WshServer) ClaudeAccountRemoveCommand(ctx context.Context, data wshrpc.CommandClaudeAccountData) error {
	return jarvis.RemoveClaudeAccount(data.AccountUuid)
}
