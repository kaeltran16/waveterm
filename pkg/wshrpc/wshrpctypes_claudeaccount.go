// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

// ClaudeAccountCommands lists the Claude.ai logins Arc has saved and switches the active one.
type ClaudeAccountCommands interface {
	ClaudeAccountsCommand(ctx context.Context) (*ClaudeAccountsRtnData, error)
	ClaudeAccountSwitchCommand(ctx context.Context, data CommandClaudeAccountData) error
	ClaudeAccountRemoveCommand(ctx context.Context, data CommandClaudeAccountData) error
}

type CommandClaudeAccountData struct {
	AccountUuid string `json:"accountuuid"`
}

// ClaudeAccountsRtnData: LoggedIn reports whether a live Claude.ai login exists.
type ClaudeAccountsRtnData struct {
	LoggedIn bool                `json:"loggedin"`
	Accounts []ClaudeAccountInfo `json:"accounts"`
}

// ClaudeAccountInfo: LastUsedTs is unix ms.
type ClaudeAccountInfo struct {
	AccountUuid string `json:"accountuuid"`
	Email       string `json:"email"`
	OrgName     string `json:"orgname"`
	Plan        string `json:"plan"`
	Active      bool   `json:"active"`
	Expired     bool   `json:"expired"`
	LastUsedTs  int64  `json:"lastusedts"`
}
