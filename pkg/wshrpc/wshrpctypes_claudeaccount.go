// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

// ClaudeAccountCommands lists the Claude.ai logins Arc has saved and switches the active one.
type ClaudeAccountCommands interface {
	ClaudeAccountsCommand(ctx context.Context) (*ClaudeAccountsRtnData, error)
	ClaudeAccountSwitchCommand(ctx context.Context, data CommandClaudeAccountData) error
	ClaudeAccountRemoveCommand(ctx context.Context, data CommandClaudeAccountData) error
	ClaudeApiKeySaveCommand(ctx context.Context, data CommandClaudeApiKeyData) error
	ClaudeApiKeySwitchCommand(ctx context.Context) error
	ClaudeApiKeyRemoveCommand(ctx context.Context) error
}

type CommandClaudeAccountData struct {
	AccountUuid string `json:"accountuuid"`
}

type CommandClaudeApiKeyData struct {
	Key string `json:"key"`
}

// ClaudeAccountsRtnData: LoggedIn reports whether a live Claude.ai login exists. ApiKey is always set
// by the server.
type ClaudeAccountsRtnData struct {
	LoggedIn bool                `json:"loggedin"`
	Accounts []ClaudeAccountInfo `json:"accounts"`
	ApiKey   *ClaudeApiKeyInfo   `json:"apikey,omitempty"`
}

// ClaudeAccountInfo: LastUsedTs is unix ms. Live is the Claude.ai login in .credentials.json whether or
// not the API key is active; Active is Live and the API key is not.
type ClaudeAccountInfo struct {
	AccountUuid string `json:"accountuuid"`
	Email       string `json:"email"`
	OrgName     string `json:"orgname"`
	Plan        string `json:"plan"`
	Live        bool   `json:"live,omitempty"`
	Active      bool   `json:"active"`
	Expired     bool   `json:"expired"`
	LastUsedTs  int64  `json:"lastusedts"`
}

// ClaudeApiKeyInfo: Saved is a key in the secret store, Active is Claude Code's apiKeyHelper naming
// Arc's helper, SettingsPath is the settings.json Switch writes.
type ClaudeApiKeyInfo struct {
	Saved        bool   `json:"saved"`
	Last4        string `json:"last4"`
	Active       bool   `json:"active"`
	SettingsPath string `json:"settingspath"`
}
