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

func (ws *WshServer) ClaudeApiKeySaveCommand(ctx context.Context, data wshrpc.CommandClaudeApiKeyData) error {
	return jarvis.SaveClaudeApiKey(ctx, data.Key)
}

func (ws *WshServer) ClaudeApiKeySwitchCommand(ctx context.Context) error {
	return jarvis.SwitchToClaudeApiKey()
}

func (ws *WshServer) ClaudeApiKeyRemoveCommand(ctx context.Context) error {
	return jarvis.RemoveClaudeApiKey()
}
